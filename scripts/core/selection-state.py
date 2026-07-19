#!/usr/bin/env python3
from __future__ import annotations

import argparse
import errno
import json
import os
from pathlib import Path
import re
import secrets
import stat
import sys
from urllib.parse import urlsplit


PINNED_KEYS = {
    "schema_version", "mode", "source", "requested_ref", "resolved_ref", "commit"
}
TRACK_LATEST_KEYS = {"schema_version", "mode", "source"}
TAG_RE = re.compile(
    r"v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)"
    r"(?:-((?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*)"
    r"(?:\.(?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*))*))?\Z"
)
COMMIT_RE = re.compile(r"[0-9a-f]{40}\Z")
COMMIT_INPUT_RE = re.compile(r"[0-9a-fA-F]{40}\Z")
MAX_JSON_NESTING = 256


class SelectionError(Exception):
    """A controlled selection-state validation or persistence failure."""


def require_object(raw: object, label: str) -> dict[str, object]:
    if not isinstance(raw, dict):
        raise SelectionError(f"{label} must be a JSON object")
    return raw


def require_exact_keys(record: dict[str, object], expected: set[str]) -> None:
    actual = set(record)
    if actual != expected:
        missing = sorted(expected - actual)
        unknown = sorted(actual - expected)
        details = []
        if missing:
            details.append("missing " + ", ".join(missing))
        if unknown:
            details.append("unknown " + ", ".join(unknown))
        raise SelectionError("selection state keys are invalid: " + "; ".join(details))


def require_single_line_string(value: object, label: str) -> str:
    if not isinstance(value, str) or not value or any(char in value for char in "\r\n\0"):
        raise SelectionError(f"{label} must be a non-empty single-line string")
    return value


def validate_source(raw: object) -> str:
    source = require_single_line_string(raw, "source")
    try:
        parsed = urlsplit(source)
    except (UnicodeError, ValueError) as exc:
        raise SelectionError("source URL is malformed") from exc
    if parsed.scheme.lower() in ("http", "https") and parsed.username is not None:
        raise SelectionError("HTTP(S) source must not include userinfo")
    return source


def validate_pinned_record(
    record: dict[str, object], source: str
) -> dict[str, object]:
    requested_ref = require_single_line_string(record["requested_ref"], "requested_ref")
    resolved_ref = require_single_line_string(record["resolved_ref"], "resolved_ref")
    commit = require_single_line_string(record["commit"], "commit")
    if not COMMIT_RE.fullmatch(commit):
        raise SelectionError("commit must be a lowercase 40-hex value")
    if TAG_RE.fullmatch(requested_ref):
        if resolved_ref != requested_ref:
            raise SelectionError("tag resolved_ref must equal requested_ref")
    elif COMMIT_RE.fullmatch(requested_ref):
        if resolved_ref != requested_ref or commit != requested_ref:
            raise SelectionError(
                "raw commit requested_ref, resolved_ref, and commit must be equal"
            )
    else:
        raise SelectionError("requested_ref must be an exact tag or full commit")
    return {
        "schema_version": 1,
        "mode": "pinned",
        "source": source,
        "requested_ref": requested_ref,
        "resolved_ref": resolved_ref,
        "commit": commit,
    }


def validate_record(raw: object) -> dict[str, object]:
    record = require_object(raw, "selection state")
    version = record.get("schema_version")
    if type(version) is not int or version != 1:
        raise SelectionError("schema_version must equal integer 1")
    mode = record.get("mode")
    expected = (
        PINNED_KEYS if mode == "pinned"
        else TRACK_LATEST_KEYS if mode == "track-latest"
        else None
    )
    if expected is None:
        raise SelectionError("mode must be pinned or track-latest")
    require_exact_keys(record, expected)
    source = validate_source(record["source"])
    if mode == "track-latest":
        return {"schema_version": 1, "mode": mode, "source": source}
    return validate_pinned_record(record, source)


def normalize(record: dict[str, object] | None) -> dict[str, str]:
    if record is None:
        return {
            "saved_mode": "none",
            "saved_source": "",
            "saved_requested_ref": "",
            "saved_resolved_ref": "",
            "saved_commit": "",
        }
    return {
        "saved_mode": str(record["mode"]),
        "saved_source": str(record["source"]),
        "saved_requested_ref": str(record.get("requested_ref", "")),
        "saved_resolved_ref": str(record.get("resolved_ref", "")),
        "saved_commit": str(record.get("commit", "")),
    }


def reject_duplicate_keys(pairs: list[tuple[str, object]]) -> dict[str, object]:
    result: dict[str, object] = {}
    for key, value in pairs:
        if key in result:
            raise SelectionError(f"duplicate JSON key: {key}")
        result[key] = value
    return result


def reject_constant(constant: str) -> None:
    raise SelectionError(f"non-standard numeric constant: {constant}")


def nesting_exceeds_limit(value: object) -> bool:
    stack = [(value, 0)]
    while stack:
        current, depth = stack.pop()
        if isinstance(current, dict):
            next_depth = depth + 1
            if next_depth > MAX_JSON_NESTING:
                return True
            stack.extend((child, next_depth) for child in current.values())
        elif isinstance(current, list):
            next_depth = depth + 1
            if next_depth > MAX_JSON_NESTING:
                return True
            stack.extend((child, next_depth) for child in current)
    return False


def describe_path_type(path: Path, label: str) -> os.stat_result | None:
    try:
        info = path.lstat()
    except FileNotFoundError:
        return None
    except OSError as exc:
        raise SelectionError(f"cannot inspect {label} {path}: {exc}") from exc
    if stat.S_ISLNK(info.st_mode):
        raise SelectionError(f"{label} must not be a symlink: {path}")
    return info


def load_json(path: Path) -> object:
    flags = os.O_RDONLY
    if hasattr(os, "O_NOFOLLOW"):
        flags |= os.O_NOFOLLOW
    try:
        fd = os.open(path, flags)
    except OSError as exc:
        raise SelectionError(f"cannot read selection state {path}: {exc}") from exc
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode):
            raise SelectionError(f"selection state must be a regular file: {path}")
        with os.fdopen(fd, "r", encoding="utf-8") as handle:
            fd = -1
            raw = json.load(
                handle,
                object_pairs_hook=reject_duplicate_keys,
                parse_constant=reject_constant,
            )
    except RecursionError as exc:
        raise SelectionError(f"JSON nesting exceeds limit in {path}") from exc
    except json.JSONDecodeError as exc:
        raise SelectionError(
            f"invalid JSON in {path}: line {exc.lineno} column {exc.colno}: {exc.msg}"
        ) from exc
    except ValueError as exc:
        raise SelectionError(f"invalid JSON in {path}: {exc}") from exc
    except (OSError, UnicodeError) as exc:
        raise SelectionError(f"cannot read selection state {path}: {exc}") from exc
    finally:
        if fd >= 0:
            os.close(fd)
    if nesting_exceeds_limit(raw):
        raise SelectionError(f"JSON nesting exceeds limit in {path}")
    return raw


def load_record(path: Path) -> dict[str, object] | None:
    parent_info = describe_path_type(path.parent, "selection state directory")
    if parent_info is not None and not stat.S_ISDIR(parent_info.st_mode):
        raise SelectionError(
            f"selection state directory must be a directory: {path.parent}"
        )
    info = describe_path_type(path, "selection state")
    if info is None:
        return None
    if not stat.S_ISREG(info.st_mode):
        raise SelectionError(f"selection state must be a regular file: {path}")
    return validate_record(load_json(path))


def write_json_output(path: Path, value: object) -> None:
    try:
        with path.open("w", encoding="utf-8") as handle:
            json.dump(value, handle, indent=2, allow_nan=False)
            handle.write("\n")
    except (OSError, UnicodeError, ValueError) as exc:
        raise SelectionError(f"cannot write normalized selection output {path}: {exc}") from exc


def ensure_state_directory(path: Path) -> None:
    info = describe_path_type(path, "selection state directory")
    if info is not None:
        if not stat.S_ISDIR(info.st_mode):
            raise SelectionError(f"selection state directory must be a directory: {path}")
        return
    old_umask = os.umask(0o077)
    try:
        path.mkdir(mode=0o700, parents=True, exist_ok=True)
    except OSError as exc:
        raise SelectionError(f"cannot create selection state directory {path}: {exc}") from exc
    finally:
        os.umask(old_umask)
    info = describe_path_type(path, "selection state directory")
    if info is None or not stat.S_ISDIR(info.st_mode):
        raise SelectionError(f"selection state directory is not usable: {path}")


def create_temp_file(path: Path) -> tuple[int, Path]:
    for _ in range(100):
        candidate = path.parent / f".{path.name}.tmp.{os.getpid()}.{secrets.token_hex(8)}"
        try:
            fd = os.open(candidate, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            os.fchmod(fd, 0o600)
            return fd, candidate
        except FileExistsError:
            continue
        except OSError as exc:
            raise SelectionError(f"cannot create selection state temporary file: {exc}") from exc
    raise SelectionError("cannot create unique selection state temporary file")


def fsync_directory_best_effort(directory: Path) -> None:
    flags = os.O_RDONLY
    if hasattr(os, "O_DIRECTORY"):
        flags |= os.O_DIRECTORY
    try:
        fd = os.open(directory, flags)
    except OSError:
        return
    try:
        try:
            os.fsync(fd)
        except OSError as exc:
            if exc.errno not in (errno.EINVAL, errno.ENOTSUP, errno.EBADF):
                return
    finally:
        os.close(fd)


def final_state_diagnostic(path: Path) -> str:
    try:
        record = load_record(path)
    except SelectionError as exc:
        return f"final selection state cannot be validated: {exc}"
    if record is None:
        return "selection state is now absent"
    return f"selection state is now {record['mode']}"


def write_record(path: Path, proposed: dict[str, object]) -> None:
    ensure_state_directory(path.parent)
    load_record(path)
    record = validate_record(proposed)
    fd = -1
    temporary: Path | None = None
    replacement_started = False
    try:
        fd, temporary = create_temp_file(path)
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            fd = -1
            json.dump(record, handle, indent=2, allow_nan=False)
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        validate_record(load_json(temporary))
        replacement_started = True
        os.replace(temporary, path)
        temporary = None
        fsync_directory_best_effort(path.parent)
    except SelectionError:
        raise
    except (OSError, UnicodeError, ValueError) as exc:
        if replacement_started:
            raise SelectionError(
                f"cannot complete selection state write: {exc}; {final_state_diagnostic(path)}"
            ) from exc
        raise SelectionError(f"cannot write selection state: {exc}") from exc
    finally:
        if fd >= 0:
            os.close(fd)
        if temporary is not None:
            try:
                temporary.unlink()
            except FileNotFoundError:
                pass
            except OSError:
                pass


def normalized_pinned_arguments(arguments: argparse.Namespace) -> dict[str, object]:
    requested_ref = arguments.requested_ref
    resolved_ref = arguments.resolved_ref
    commit = arguments.commit.lower()
    if COMMIT_INPUT_RE.fullmatch(requested_ref):
        requested_ref = requested_ref.lower()
    if COMMIT_INPUT_RE.fullmatch(resolved_ref):
        resolved_ref = resolved_ref.lower()
    return {
        "schema_version": 1,
        "mode": "pinned",
        "source": arguments.source,
        "requested_ref": requested_ref,
        "resolved_ref": resolved_ref,
        "commit": commit,
    }


def parser() -> argparse.ArgumentParser:
    result = argparse.ArgumentParser(description="Strict persistent selection-state helper")
    subparsers = result.add_subparsers(dest="command", required=True)

    read = subparsers.add_parser("read")
    read.add_argument("--path", required=True)
    read.add_argument("--output", required=True)

    pinned = subparsers.add_parser("write-pinned")
    pinned.add_argument("--path", required=True)
    pinned.add_argument("--source", required=True)
    pinned.add_argument("--requested-ref", required=True)
    pinned.add_argument("--resolved-ref", required=True)
    pinned.add_argument("--commit", required=True)

    latest = subparsers.add_parser("write-track-latest")
    latest.add_argument("--path", required=True)
    latest.add_argument("--source", required=True)

    validate = subparsers.add_parser("validate-source")
    validate.add_argument("--source", required=True)

    display = subparsers.add_parser("display-source")
    display.add_argument("--source", required=True)
    return result


def dispatch(arguments: argparse.Namespace) -> None:
    if arguments.command == "read":
        write_json_output(Path(arguments.output), normalize(load_record(Path(arguments.path))))
    elif arguments.command == "write-pinned":
        write_record(Path(arguments.path), normalized_pinned_arguments(arguments))
    elif arguments.command == "write-track-latest":
        write_record(Path(arguments.path), {
            "schema_version": 1,
            "mode": "track-latest",
            "source": arguments.source,
        })
    elif arguments.command == "validate-source":
        validate_source(arguments.source)
    elif arguments.command == "display-source":
        try:
            print(validate_source(arguments.source))
        except SelectionError:
            print("<redacted-source>")


def main() -> int:
    arguments = parser().parse_args()
    try:
        dispatch(arguments)
    except SelectionError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
