#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

ENVELOPE_KEYS = {"protocol", "operation", "ok", "messages", "result", "error"}
MESSAGE_KEYS = {"channel", "text"}
ERROR_KEYS = {"code", "message", "hints"}
OWNERSHIP_KEYS = {"plugin", "marketplace"}
VERIFICATION_HINT_KEYS = {"mismatch", "missing"}
OPERATIONS = {"build", "inspect", "install", "uninstall"}
FINGERPRINT_RE = re.compile(r"(?:[0-9a-fA-F]{7}|[0-9a-fA-F]{40})\Z")
MAX_NESTING = 64
MAX_RESPONSE_BYTES = 1_048_576


class ProtocolError(ValueError):
    pass


def reject_constant(value: str) -> None:
    raise ProtocolError(f"non-standard JSON constant: {value}")


def reject_duplicate_keys(
    pairs: list[tuple[str, object]],
) -> dict[str, object]:
    obj: dict[str, object] = {}
    for key, value in pairs:
        if key in obj:
            raise ProtocolError("duplicate object key")
        obj[key] = value
    return obj


def nesting_exceeds_limit(value: object) -> bool:
    stack = [(value, 0)]
    while stack:
        current, depth = stack.pop()
        if isinstance(current, dict):
            next_depth = depth + 1
            if next_depth > MAX_NESTING:
                return True
            stack.extend((child, next_depth) for child in current.values())
        elif isinstance(current, list):
            next_depth = depth + 1
            if next_depth > MAX_NESTING:
                return True
            stack.extend((child, next_depth) for child in current)
    return False


def require_object(value: object, label: str) -> dict[str, object]:
    if not isinstance(value, dict):
        raise ProtocolError(f"{label} must be an object")
    return value


def require_exact_keys(value: dict[str, object], expected: set[str], label: str) -> None:
    actual = set(value)
    if actual != expected:
        raise ProtocolError(
            f"{label} keys must be {sorted(expected)}, got {sorted(actual)}"
        )


def contains_terminal_control(value: str) -> bool:
    return any(
        ord(character) < 0x20
        or 0x7F <= ord(character) <= 0x9F
        or 0xD800 <= ord(character) <= 0xDFFF
        for character in value
    )


def require_non_empty_string(value: object, label: str) -> str:
    if not isinstance(value, str) or not value or "\n" in value or "\r" in value:
        raise ProtocolError(f"{label} must be a non-empty single-line string")
    if contains_terminal_control(value):
        raise ProtocolError(f"{label} must not contain terminal control characters")
    return value


def validate_messages(value: object) -> list[dict[str, str]]:
    if not isinstance(value, list):
        raise ProtocolError("messages must be an array")
    messages: list[dict[str, str]] = []
    for index, item in enumerate(value):
        message = require_object(item, f"messages[{index}]")
        require_exact_keys(message, MESSAGE_KEYS, f"messages[{index}]")
        channel = message.get("channel")
        if channel not in {"stdout", "stderr"}:
            raise ProtocolError(f"messages[{index}].channel is invalid")
        text = require_non_empty_string(message.get("text"), f"messages[{index}].text")
        messages.append({"channel": str(channel), "text": text})
    return messages


def validate_error(value: object) -> dict[str, object]:
    error = require_object(value, "error")
    require_exact_keys(error, ERROR_KEYS, "error")
    code = require_non_empty_string(error.get("code"), "error.code")
    message = require_non_empty_string(error.get("message"), "error.message")
    hints_value = error.get("hints")
    if not isinstance(hints_value, list):
        raise ProtocolError("error.hints must be an array")
    hints = [
        require_non_empty_string(hint, f"error.hints[{index}]")
        for index, hint in enumerate(hints_value)
    ]
    return {"code": code, "message": message, "hints": hints}


def validate_result(
    operation: str, value: object, inspect_view: str | None
) -> dict[str, object]:
    result = require_object(value, "result")
    if operation in {"build", "uninstall"}:
        require_exact_keys(result, set(), f"{operation} result")
        return {}
    if operation == "inspect":
        if inspect_view == "fingerprint":
            require_exact_keys(result, {"view", "fingerprint"}, "inspect result")
            if result.get("view") != "fingerprint":
                raise ProtocolError("inspect result view must be fingerprint")
            fingerprint = result.get("fingerprint")
            if fingerprint is not None and (
                not isinstance(fingerprint, str)
                or FINGERPRINT_RE.fullmatch(fingerprint) is None
            ):
                raise ProtocolError("fingerprint must be null, 7 hex, or 40 hex")
            return {"view": "fingerprint", "fingerprint": fingerprint}
        if inspect_view == "ownership":
            require_exact_keys(
                result,
                {"view", "resources", "legacy_resources", "identity_state"},
                "inspect result",
            )
            if result.get("view") != "ownership":
                raise ProtocolError("inspect result view must be ownership")
            resources = require_object(result.get("resources"), "resources")
            legacy_resources = require_object(
                result.get("legacy_resources"), "legacy_resources"
            )
            for label, group in (
                ("resources", resources),
                ("legacy_resources", legacy_resources),
            ):
                require_exact_keys(group, OWNERSHIP_KEYS, label)
                if not all(isinstance(group[key], bool) for key in OWNERSHIP_KEYS):
                    raise ProtocolError(f"{label} values must be Boolean")
            manager_present = any(resources.values())
            legacy_present = any(legacy_resources.values())
            expected_state = {
                (False, False): "neither",
                (True, False): "manager",
                (False, True): "legacy",
                (True, True): "both",
            }[(manager_present, legacy_present)]
            identity_state = result.get("identity_state")
            if identity_state != expected_state:
                raise ProtocolError(
                    f"identity_state must be {expected_state} for the reported resources"
                )
            return {
                "view": "ownership",
                "resources": resources,
                "legacy_resources": legacy_resources,
                "identity_state": identity_state,
            }
        if inspect_view == "update-control":
            require_exact_keys(
                result,
                {"view", "update_control"},
                "update-control inspect result",
            )
            if result.get("view") != "update-control":
                raise ProtocolError("inspect result view must be update-control")
            value = result.get("update_control")
            if value not in {"managed", "unsupported"}:
                raise ProtocolError(
                    "update-control value must be managed or unsupported"
                )
            return {"view": "update-control", "update_control": value}
        raise ProtocolError(
            "inspect view must be fingerprint or ownership, or update-control"
        )
    if operation == "install":
        require_exact_keys(result, {"verification_hints"}, "install result")
        hints = require_object(result.get("verification_hints"), "verification_hints")
        unknown = set(hints) - VERIFICATION_HINT_KEYS
        if unknown:
            raise ProtocolError(f"unknown verification hint keys: {sorted(unknown)}")
        normalized = {
            key: require_non_empty_string(value, f"verification_hints.{key}")
            for key, value in hints.items()
        }
        return {"verification_hints": normalized}
    raise ProtocolError(f"unsupported operation: {operation}")


def validate_envelope(
    raw: object, operation: str, adapter_exit: int, inspect_view: str | None
) -> tuple[list[dict[str, str]], dict[str, object] | None, dict[str, object] | None]:
    envelope = require_object(raw, "response")
    require_exact_keys(envelope, ENVELOPE_KEYS, "response")
    protocol = envelope.get("protocol")
    if type(protocol) is not int or protocol != 1:
        raise ProtocolError("protocol must equal integer 1")
    if envelope.get("operation") != operation:
        raise ProtocolError("response operation does not match invocation")
    ok = envelope.get("ok")
    if not isinstance(ok, bool):
        raise ProtocolError("ok must be Boolean")
    messages = validate_messages(envelope.get("messages"))
    if ok:
        if adapter_exit != 0:
            raise ProtocolError("successful response requires adapter exit 0")
        if envelope.get("error") is not None:
            raise ProtocolError("successful response error must be null")
        result = validate_result(operation, envelope.get("result"), inspect_view)
        return messages, result, None
    if adapter_exit == 0:
        raise ProtocolError("failure response requires nonzero adapter exit")
    if envelope.get("result") is not None:
        raise ProtocolError("failure response result must be null")
    error = validate_error(envelope.get("error"))
    return messages, None, error


def replay(messages: list[dict[str, str]]) -> None:
    for message in messages:
        stream = sys.stdout if message["channel"] == "stdout" else sys.stderr
        print(message["text"], file=stream)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--operation", choices=sorted(OPERATIONS), required=True)
    parser.add_argument("--adapter-exit", type=int, required=True)
    parser.add_argument("--response", type=Path, required=True)
    parser.add_argument("--result", type=Path, required=True)
    parser.add_argument(
        "--inspect-view", choices=("fingerprint", "ownership", "update-control")
    )
    args = parser.parse_args()
    try:
        response_size = args.response.stat().st_size
        if response_size > MAX_RESPONSE_BYTES:
            raise ProtocolError(
                f"response exceeds {MAX_RESPONSE_BYTES}-byte limit"
            )
        with args.response.open(encoding="utf-8") as handle:
            raw = json.load(
                handle,
                parse_constant=reject_constant,
                object_pairs_hook=reject_duplicate_keys,
            )
        if nesting_exceeds_limit(raw):
            raise ProtocolError("response JSON nesting exceeds limit")
        messages, result, error = validate_envelope(
            raw, args.operation, args.adapter_exit, args.inspect_view
        )
        replay(messages)
        if error is not None:
            print(f"error: {error['message']}", file=sys.stderr)
            for hint in error["hints"]:
                print(f"hint: {hint}", file=sys.stderr)
            return 1
        with args.result.open("w", encoding="utf-8") as handle:
            json.dump(result, handle, allow_nan=False, separators=(",", ":"))
            handle.write("\n")
        return 0
    except (OSError, UnicodeError, json.JSONDecodeError, ProtocolError, RecursionError) as exc:
        print(f"error: invalid adapter response: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
