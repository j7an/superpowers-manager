#!/usr/bin/env python3
from __future__ import annotations

import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[1]
VALIDATOR = ROOT / "scripts/core/validate-adapter-response.py"


def envelope(operation: str, result: object, *, ok: bool = True) -> dict[str, object]:
    return {
        "protocol": 1,
        "operation": operation,
        "ok": ok,
        "messages": [],
        "result": result if ok else None,
        "error": None if ok else {
            "code": "controlled-failure",
            "message": "controlled failure",
            "hints": [],
        },
    }


def validate(
    payload: object,
    operation: str,
    adapter_exit: int = 0,
    inspect_view: str | None = None,
) -> subprocess.CompletedProcess[str]:
    with tempfile.TemporaryDirectory() as tmp:
        response = Path(tmp) / "response.json"
        result = Path(tmp) / "result.json"
        response.write_text(json.dumps(payload) + "\n", encoding="utf-8")
        process = _run_validator(
            response, result, operation, adapter_exit, inspect_view=inspect_view
        )
        process.validated_result = (
            json.loads(result.read_text(encoding="utf-8")) if result.exists() else None
        )
        return process


def validate_raw(
    raw_payload: str,
    operation: str,
    adapter_exit: int = 0,
    inspect_view: str | None = None,
) -> subprocess.CompletedProcess[str]:
    with tempfile.TemporaryDirectory() as tmp:
        response = Path(tmp) / "response.json"
        result = Path(tmp) / "result.json"
        response.write_text(raw_payload, encoding="utf-8")
        process = _run_validator(
            response, result, operation, adapter_exit, inspect_view=inspect_view
        )
        process.validated_result = (
            json.loads(result.read_text(encoding="utf-8")) if result.exists() else None
        )
        return process


def validate_binary(
    payload: object,
    operation: str,
    adapter_exit: int = 0,
    inspect_view: str | None = None,
) -> subprocess.CompletedProcess[bytes]:
    with tempfile.TemporaryDirectory() as tmp:
        response = Path(tmp) / "response.json"
        result = Path(tmp) / "result.json"
        response.write_text(json.dumps(payload) + "\n", encoding="utf-8")
        command = [
            sys.executable,
            "-S",
            str(VALIDATOR),
            "--operation",
            operation,
            "--adapter-exit",
            str(adapter_exit),
            "--response",
            str(response),
            "--result",
            str(result),
        ]
        if inspect_view is not None:
            command.extend(["--inspect-view", inspect_view])
        return subprocess.run(command, capture_output=True, check=False)


def _run_validator(
    response: Path,
    result: Path,
    operation: str,
    adapter_exit: int,
    *,
    inspect_view: str | None,
) -> subprocess.CompletedProcess[str]:
    command = [
        sys.executable,
        "-S",
        str(VALIDATOR),
        "--operation",
        operation,
        "--adapter-exit",
        str(adapter_exit),
        "--response",
        str(response),
        "--result",
        str(result),
    ]
    if inspect_view is not None:
        command.extend(["--inspect-view", inspect_view])
    return subprocess.run(command, text=True, capture_output=True, check=False)


class AdapterProtocolValidatorTests(unittest.TestCase):
    def assert_valid(
        self,
        payload: object,
        *,
        operation: str,
        expected_result: object,
        adapter_exit: int = 0,
        inspect_view: str | None = None,
        stdout: str = "",
        stderr: str = "",
    ) -> None:
        result = validate(
            payload, operation, adapter_exit=adapter_exit, inspect_view=inspect_view
        )
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(result.stdout, stdout)
        self.assertEqual(result.stderr, stderr)
        self.assertEqual(result.validated_result, expected_result)

    def assert_invalid(
        self,
        payload: object,
        *,
        operation: str,
        fragment: str,
        adapter_exit: int = 0,
        inspect_view: str | None = None,
    ) -> None:
        result = validate(
            payload, operation, adapter_exit=adapter_exit, inspect_view=inspect_view
        )
        self.assertEqual(result.returncode, 2, result.stdout + result.stderr)
        self.assertIn(fragment, result.stderr)
        self.assertNotIn("Traceback", result.stderr)
        self.assertEqual(result.stdout, "")
        self.assertIsNone(result.validated_result)

    def test_build_and_uninstall_accept_exact_empty_results(self) -> None:
        for operation in ("build", "uninstall"):
            with self.subTest(operation=operation):
                self.assert_valid(
                    envelope(operation, {}),
                    operation=operation,
                    expected_result={},
                )

    def test_inspect_fingerprint_accepts_full_sha_short_sha_and_null(self) -> None:
        for fingerprint in (
            "0123456789abcdef0123456789abcdef01234567",
            "89abcde",
            None,
        ):
            with self.subTest(fingerprint=fingerprint):
                payload = envelope(
                    "inspect",
                    {"view": "fingerprint", "fingerprint": fingerprint},
                )
                self.assert_valid(
                    payload,
                    operation="inspect",
                    inspect_view="fingerprint",
                    expected_result={
                        "view": "fingerprint",
                        "fingerprint": fingerprint,
                    },
                )

    def test_inspect_ownership_requires_exactly_two_boolean_resources(self) -> None:
        payload = envelope(
            "inspect",
            {
                "view": "ownership",
                "resources": {"plugin": True, "marketplace": False},
            },
        )
        self.assert_valid(
            payload,
            operation="inspect",
            inspect_view="ownership",
            expected_result={
                "view": "ownership",
                "resources": {"plugin": True, "marketplace": False},
            },
        )

    def test_install_accepts_empty_one_and_both_verification_hints(self) -> None:
        for hints in (
            {},
            {"missing": "plugin metadata missing"},
            {
                "mismatch": "installed commit differs",
                "missing": "plugin metadata missing",
            },
        ):
            with self.subTest(hints=hints):
                payload = envelope("install", {"verification_hints": hints})
                self.assert_valid(
                    payload,
                    operation="install",
                    expected_result={"verification_hints": hints},
                )

    def test_messages_replay_by_channel_in_order(self) -> None:
        payload = envelope("build", {})
        payload["messages"] = [
            {"channel": "stdout", "text": "build-start"},
            {"channel": "stderr", "text": "warn-1"},
            {"channel": "stdout", "text": "build-done"},
            {"channel": "stderr", "text": "warn-2"},
        ]
        self.assert_valid(
            payload,
            operation="build",
            expected_result={},
            stdout="build-start\nbuild-done\n",
            stderr="warn-1\nwarn-2\n",
        )

    def test_controlled_failure_replays_messages_error_and_hints(self) -> None:
        payload = envelope("install", {}, ok=False)
        payload["messages"] = [
            {"channel": "stdout", "text": "before-failure"},
            {"channel": "stderr", "text": "pre-error-warning"},
        ]
        payload["error"] = {
            "code": "controlled-failure",
            "message": "controlled failure",
            "hints": ["retry later", "inspect wrapper state"],
        }
        result = validate(payload, "install", adapter_exit=1)
        self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
        self.assertEqual(result.stdout, "before-failure\n")
        self.assertEqual(
            result.stderr,
            "pre-error-warning\n"
            "error: controlled failure\n"
            "hint: retry later\n"
            "hint: inspect wrapper state\n",
        )
        self.assertIsNone(result.validated_result)
        self.assertNotIn("Traceback", result.stderr)

    def test_rejects_terminal_controls_in_terminal_facing_protocol_strings(self) -> None:
        failure = envelope("install", {}, ok=False)
        invalid_cases = (
            (
                "messages[0].text",
                {
                    **envelope("build", {}),
                    "messages": [{"channel": "stdout", "text": "unsafe\x1b"}],
                },
                "build",
                0,
            ),
            (
                "error.code",
                {
                    **failure,
                    "error": {
                        "code": "unsafe\x9b",
                        "message": "controlled failure",
                        "hints": [],
                    },
                },
                "install",
                1,
            ),
            (
                "error.message",
                {
                    **failure,
                    "error": {
                        "code": "controlled-failure",
                        "message": "unsafe\x1b",
                        "hints": [],
                    },
                },
                "install",
                1,
            ),
            (
                "error.hints[0]",
                {
                    **failure,
                    "error": {
                        "code": "controlled-failure",
                        "message": "controlled failure",
                        "hints": ["unsafe\x85"],
                    },
                },
                "install",
                1,
            ),
            (
                "verification_hints.missing",
                envelope(
                    "install",
                    {"verification_hints": {"missing": "unsafe\x1b"}},
                ),
                "install",
                0,
            ),
        )
        for label, payload, operation, adapter_exit in invalid_cases:
            with self.subTest(label=label):
                self.assert_invalid(
                    payload,
                    operation=operation,
                    adapter_exit=adapter_exit,
                    fragment=f"{label} must not contain terminal control characters",
                )

    def test_rejects_surrogate_escapes_in_terminal_facing_protocol_strings(self) -> None:
        surrogate = "\udc9b"
        failure = envelope("install", {}, ok=False)
        invalid_cases = (
            (
                {
                    **envelope("build", {}),
                    "messages": [{"channel": "stdout", "text": f"unsafe{surrogate}"}],
                },
                "build",
                0,
            ),
            (
                {
                    **failure,
                    "error": {
                        "code": f"unsafe{surrogate}",
                        "message": "controlled failure",
                        "hints": [],
                    },
                },
                "install",
                1,
            ),
            (
                {
                    **failure,
                    "error": {
                        "code": "controlled-failure",
                        "message": f"unsafe{surrogate}",
                        "hints": [],
                    },
                },
                "install",
                1,
            ),
            (
                {
                    **failure,
                    "error": {
                        "code": "controlled-failure",
                        "message": "controlled failure",
                        "hints": [f"unsafe{surrogate}"],
                    },
                },
                "install",
                1,
            ),
            (
                envelope(
                    "install",
                    {"verification_hints": {"missing": f"unsafe{surrogate}"}},
                ),
                "install",
                0,
            ),
        )
        for payload, operation, adapter_exit in invalid_cases:
            with self.subTest(payload=payload):
                result = validate_binary(payload, operation, adapter_exit)
                self.assertEqual(result.returncode, 2, result.stdout + result.stderr)
                self.assertIn(b"terminal control characters", result.stderr)
                self.assertEqual(result.stdout, b"")
                self.assertNotIn(b"\x9b", result.stdout + result.stderr)

    def test_rejects_empty_malformed_non_object_and_extra_fields(self) -> None:
        invalid_json_cases = (
            ("", "Expecting value"),
            ("{", "Expecting property name enclosed in double quotes"),
        )
        for raw_payload, fragment in invalid_json_cases:
            with self.subTest(raw_payload=raw_payload or "<empty>"):
                result = validate_raw(raw_payload, "build")
                self.assertEqual(result.returncode, 2, result.stdout + result.stderr)
                self.assertIn(fragment, result.stderr)
                self.assertNotIn("Traceback", result.stderr)

        self.assert_invalid([], operation="build", fragment="response must be an object")

        payload = envelope("build", {})
        payload["extra"] = True
        self.assert_invalid(
            payload,
            operation="build",
            fragment="response keys must be",
        )

    def test_rejects_deeply_nested_raw_json_without_traceback(self) -> None:
        result = validate_raw("[" * 2000 + "]" * 2000, "build")
        self.assertEqual(result.returncode, 2, result.stdout + result.stderr)
        self.assertIn("error: invalid adapter response:", result.stderr)
        self.assertNotIn("Traceback", result.stderr)
        self.assertEqual(result.stdout, "")
        self.assertIsNone(result.validated_result)

    def test_rejects_wrong_protocol_operation_types_and_views(self) -> None:
        invalid_cases = (
            (
                {"protocol": True},
                "build",
                None,
                "protocol must equal integer 1",
            ),
            (
                {"protocol": 1.0},
                "build",
                None,
                "protocol must equal integer 1",
            ),
            (
                {"protocol": 2},
                "build",
                None,
                "protocol must equal integer 1",
            ),
            (
                {"operation": "install"},
                "build",
                None,
                "response operation does not match invocation",
            ),
            (
                {"ok": "yes"},
                "build",
                None,
                "ok must be Boolean",
            ),
            (
                {"messages": "nope"},
                "build",
                None,
                "messages must be an array",
            ),
            (
                {"messages": [{"channel": "side", "text": "bad"}]},
                "build",
                None,
                "messages[0].channel is invalid",
            ),
            (
                {"messages": [{"channel": "stdout", "text": ""}]},
                "build",
                None,
                "messages[0].text must be a non-empty single-line string",
            ),
            (
                {"error": {"code": "x", "message": "y", "hints": "bad"}},
                "install",
                None,
                "successful response error must be null",
            ),
            (
                {"result": {"view": "fingerprint", "fingerprint": None}},
                "inspect",
                "ownership",
                "inspect result keys must be ['resources', 'view'], got ['fingerprint', 'view']",
            ),
            (
                {"result": {"view": "other", "fingerprint": None}},
                "inspect",
                "fingerprint",
                "inspect result view must be fingerprint",
            ),
        )
        for changes, operation, inspect_view, fragment in invalid_cases:
            with self.subTest(changes=changes, operation=operation, inspect_view=inspect_view):
                payload = envelope(operation, {} if operation != "inspect" else {"view": "fingerprint", "fingerprint": None})
                payload.update(changes)
                self.assert_invalid(
                    payload,
                    operation=operation,
                    inspect_view=inspect_view,
                    fragment=fragment,
                )

        payload = envelope("inspect", {"view": "fingerprint", "fingerprint": None})
        self.assert_invalid(
            payload,
            operation="inspect",
            fragment="inspect view must be fingerprint or ownership",
        )

    def test_rejects_invalid_fingerprint_and_result_schema_keys(self) -> None:
        invalid_cases = (
            (
                "inspect",
                {"view": "fingerprint", "fingerprint": "123456"},
                "fingerprint",
                "fingerprint must be null, 7 hex, or 40 hex",
            ),
            (
                "inspect",
                {"view": "ownership", "resources": {"plugin": True}},
                "ownership",
                "resources keys must be ['marketplace', 'plugin'], got ['plugin']",
            ),
            (
                "inspect",
                {"view": "ownership", "resources": {"plugin": True, "marketplace": "no"}},
                "ownership",
                "owned resources must be Boolean",
            ),
            (
                "install",
                {"verification_hints": {"extra": "nope"}},
                None,
                "unknown verification hint keys: ['extra']",
            ),
            (
                "install",
                {"verification_hints": {"mismatch": ""}},
                None,
                "verification_hints.mismatch must be a non-empty single-line string",
            ),
            (
                "build",
                {"unexpected": True},
                None,
                "build result keys must be [], got ['unexpected']",
            ),
            (
                "uninstall",
                {"unexpected": True},
                None,
                "uninstall result keys must be [], got ['unexpected']",
            ),
        )
        for operation, result_object, inspect_view, fragment in invalid_cases:
            with self.subTest(operation=operation, result_object=result_object):
                payload = envelope(operation, result_object)
                self.assert_invalid(
                    payload,
                    operation=operation,
                    inspect_view=inspect_view,
                    fragment=fragment,
                )

    def test_rejects_exit_envelope_mismatches_and_null_cross_rules(self) -> None:
        invalid_cases = (
            (
                envelope("build", {}),
                "build",
                1,
                None,
                "successful response requires adapter exit 0",
            ),
            (
                envelope("build", {}, ok=False),
                "build",
                0,
                None,
                "failure response requires nonzero adapter exit",
            ),
            (
                {
                    **envelope("build", {}),
                    "error": {"code": "x", "message": "y", "hints": []},
                },
                "build",
                0,
                None,
                "successful response error must be null",
            ),
            (
                {
                    **envelope("install", {}, ok=False),
                    "result": {},
                },
                "install",
                1,
                None,
                "failure response result must be null",
            ),
            (
                {
                    **envelope("install", {}, ok=False),
                    "error": None,
                },
                "install",
                1,
                None,
                "error must be an object",
            ),
        )
        for payload, operation, adapter_exit, inspect_view, fragment in invalid_cases:
            with self.subTest(fragment=fragment):
                self.assert_invalid(
                    payload,
                    operation=operation,
                    adapter_exit=adapter_exit,
                    inspect_view=inspect_view,
                    fragment=fragment,
                )


if __name__ == "__main__":
    unittest.main()
