#!/bin/sh
# Sourced module; callers own set -eu.

SPW_PLUGIN_ID="superpowers@superpowers-wrapper"
SPW_MARKETPLACE_NAME="superpowers-wrapper"

spw_apply_manifest_overlay() {
  manifest="$1"
  version="$2"
  python3 - "$manifest" "$version" <<'PY'
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
    with open(path, "r", encoding="utf-8") as f:
        data = json.load(f, parse_constant=reject_constant)
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
data.pop("hooks", None)

try:
    with open(path, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2, allow_nan=False)
        f.write("\n")
except RecursionError as exc:
    sys.exit(f"manifest JSON nesting exceeds limit while writing {path}: {exc}")
except (OSError, UnicodeError, ValueError) as exc:
    sys.exit(f"cannot write manifest JSON in {path}: {exc}")
PY
}

spw_manifest_short_sha_or_empty() {
  file="$1"
  if [ ! -f "$file" ]; then
    return 0
  fi
  version=$(spw_json_get "$file" "version")
  case "$version" in
    *+wrapper.*)
      short="${version##*.}"
      case "$short" in
        ""|*[!0-9a-fA-F]*)
          ;;
        *)
          printf '%s\n' "$short"
          ;;
      esac
      ;;
  esac
}

spw_codex_emit() {
  operation="$1"
  ok="$2"
  result_json="$3"
  code="$4"
  error_message="$5"
  hints_file="$6"
  messages_file="$7"
  python3 - "$operation" "$ok" "$result_json" "$code" "$error_message" "$hints_file" "$messages_file" <<'PY'
import json
import sys

operation, ok_text, result_text, code, error_message, hints_path, messages_path = sys.argv[1:]

messages = []
if messages_path:
    with open(messages_path, encoding="utf-8") as handle:
        for number, raw in enumerate(handle, 1):
            line = raw.rstrip("\n")
            if "\t" not in line:
                raise SystemExit(f"invalid message record at line {number}")
            channel, text = line.split("\t", 1)
            if (
                channel not in {"stdout", "stderr"}
                or not text
                or "\t" in text
                or "\r" in text
            ):
                raise SystemExit(f"invalid message record at line {number}")
            messages.append({"channel": channel, "text": text})

ok = ok_text == "true"
if ok:
    envelope = {
        "protocol": 1,
        "operation": operation,
        "ok": True,
        "messages": messages,
        "result": json.loads(result_text),
        "error": None,
    }
else:
    hints = []
    if hints_path:
        with open(hints_path, encoding="utf-8") as handle:
            hints = [line.rstrip("\n") for line in handle if line.rstrip("\n")]
    envelope = {
        "protocol": 1,
        "operation": operation,
        "ok": False,
        "messages": messages,
        "result": None,
        "error": {"code": code, "message": error_message, "hints": hints},
    }
json.dump(envelope, sys.stdout, allow_nan=False, separators=(",", ":"))
sys.stdout.write("\n")
PY
}

spw_codex_success() {
  spw_codex_emit "$1" true "$2" "" "" "" "$3"
}

spw_codex_failure() {
  spw_codex_emit "$1" false '{}' "$2" "$3" "$4" "$5"
  exit 1
}

spw_codex_append_messages() {
  messages_file="$1"
  channel="$2"
  input_file="$3"
  [ -f "$input_file" ] || return 0
  while IFS= read -r line || [ -n "$line" ]; do
    [ -n "$line" ] || continue
    printf '%s\t%s\n' "$channel" "$line" >> "$messages_file"
  done < "$input_file"
}
