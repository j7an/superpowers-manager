#!/bin/sh
# Sourced module; callers own set -eu.

spw_json_get() {
  file="$1"
  key="$2"
  if ! value=$(
    python3 - "$file" "$key" 2>&1 <<'PY'
import json
import sys

path, dotted_key = sys.argv[1:]
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
    with open(path, "r", encoding="utf-8") as f:
        data = json.load(f, parse_constant=reject_constant)
except RecursionError:
    sys.exit(f"JSON nesting exceeds limit in {path}")
except json.JSONDecodeError as exc:
    sys.exit(
        f"invalid JSON in {path}: "
        f"line {exc.lineno} column {exc.colno}: {exc.msg}"
    )
except (OSError, UnicodeError) as exc:
    sys.exit(f"cannot read JSON in {path}: {exc}")
except ValueError as exc:
    sys.exit(f"invalid JSON in {path}: {exc}")

if nesting_exceeds_limit(data):
    sys.exit(f"JSON nesting exceeds limit in {path}")

if not isinstance(data, dict):
    sys.exit(f"JSON value must be an object in {path}")

value = data
for part in dotted_key.split("."):
    if not isinstance(value, dict):
        value = ""
        break
    value = value.get(part, "")
try:
    print(value if value is not None else "")
except (OSError, UnicodeError) as exc:
    sys.exit(f"cannot output JSON value from {path}: {exc}")
PY
  ); then
    spw_die "$value"
  fi
  printf '%s\n' "$value"
}

spw_write_metadata_json() {
  file="$1"
  source="$2"
  requested_ref="$3"
  resolved_ref="$4"
  commit="$5"
  upstream_manifest_version="$6"
  python3 - "$file" "$source" "$requested_ref" "$resolved_ref" "$commit" "$upstream_manifest_version" <<'PY'
import json, sys
path, source, requested, resolved, commit, version = sys.argv[1:]
data = {
    "source": source,
    "requested_ref": requested,
    "resolved_ref": resolved,
    "commit": commit,
    "upstream_manifest_version": version,
}
try:
    with open(path, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2, allow_nan=False)
        f.write("\n")
except RecursionError as exc:
    sys.exit(f"JSON nesting exceeds limit while writing {path}: {exc}")
except (OSError, UnicodeError, ValueError) as exc:
    sys.exit(f"cannot write JSON to {path}: {exc}")
PY
}

spw_metadata_commit_or_empty() {
  file="$1"
  if [ -f "$file" ]; then
    spw_json_get "$file" "commit"
  fi
}

spw_metadata_commit_lenient_or_empty() {
  file="$1"
  [ -f "$file" ] || return 0

  if value=$(
    python3 -S - "$file" 2>/dev/null <<'PY'
import json
import re
import sys

path = sys.argv[1]

def reject_constant(constant):
    raise ValueError(f"non-standard numeric constant: {constant}")

try:
    with open(path, "r", encoding="utf-8") as handle:
        data = json.load(handle, parse_constant=reject_constant)
except (OSError, UnicodeError, ValueError, RecursionError):
    raise SystemExit(1)

commit = data.get("commit") if isinstance(data, dict) else None
if isinstance(commit, str) and re.fullmatch(r"[0-9a-fA-F]{40}", commit):
    print(commit)
PY
  ); then
    printf '%s\n' "$value"
  fi
}
