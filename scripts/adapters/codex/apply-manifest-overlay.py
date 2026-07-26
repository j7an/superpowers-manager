#!/usr/bin/env python3
import json
import sys


path, version = sys.argv[1:]
MAX_JSON_NESTING = 256


def reject_constant(constant):
    raise ValueError(f"non-standard numeric constant: {constant}")


def nesting_exceeds_limit(value):
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


try:
    with open(path, "r", encoding="utf-8") as handle:
        data = json.load(handle, parse_constant=reject_constant)
except RecursionError:
    sys.exit(f"JSON nesting exceeds limit in {path}")
except json.JSONDecodeError as exc:
    sys.exit(
        f"invalid manifest JSON in {path}: "
        f"line {exc.lineno} column {exc.colno}: {exc.msg}"
    )
except (OSError, UnicodeError) as exc:
    sys.exit(f"cannot read manifest JSON in {path}: {exc}")
except ValueError as exc:
    sys.exit(f"invalid manifest JSON in {path}: {exc}")

if nesting_exceeds_limit(data):
    sys.exit(f"JSON nesting exceeds limit in {path}")

if not isinstance(data, dict):
    sys.exit(f"manifest must be a JSON object: {path}")

data["version"] = version
data["skills"] = "./skills/"

try:
    with open(path, "w", encoding="utf-8") as handle:
        json.dump(data, handle, indent=2, allow_nan=False)
        handle.write("\n")
except RecursionError as exc:
    sys.exit(f"manifest JSON nesting exceeds limit while writing {path}: {exc}")
except (OSError, UnicodeError, ValueError) as exc:
    sys.exit(f"cannot write manifest JSON in {path}: {exc}")
