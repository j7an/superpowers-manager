#!/bin/sh
# Sourced module; callers own set -eu.

SPW_PLUGIN_ID="superpowers@superpowers-wrapper"
SPW_MARKETPLACE_NAME="superpowers-wrapper"

# Given a JSON document as the FIRST ARGUMENT (a string), print "present" if any
# element of the top-level array <array_key> is an object whose <field> equals
# <value>, else print "absent" (exit 0). On unparseable JSON or invalid schema,
# print nothing and exit 2 so callers can fail closed rather than treat an
# unreadable listing as "absent". Every item in the inspected array must be an
# object with a non-empty string <field>; otherwise ownership is unprovable and
# the helper exits 2 instead of treating the malformed entry as unrelated.
# The JSON is passed as an argument (exactly as spw_json_get takes a file path),
# NOT on stdin: the here-doc below is Python's stdin (its program source), so a
# json.load(sys.stdin) here would read the program, not the caller's JSON.
spw_json_array_has() {
  json="$1"
  array_key="$2"
  field="$3"
  value="$4"
  python3 - "$json" "$array_key" "$field" "$value" <<'PY'
import json, sys
raw, array_key, field, value = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]
try:
    data = json.loads(raw)
except (json.JSONDecodeError, RecursionError):
    sys.exit(2)
if not isinstance(data, dict):
    sys.exit(2)
items = data.get(array_key)
if not isinstance(items, list):
    sys.exit(2)
for item in items:
    if not isinstance(item, dict):
        sys.exit(2)
    field_value = item.get(field)
    if not isinstance(field_value, str) or not field_value:
        sys.exit(2)
found = any(item[field] == value for item in items)
print("present" if found else "absent")
PY
}

# Return 0 if <plugin_id> is installed, 1 if genuinely not installed. Fail
# closed: spw_die (exit) if the listing cannot be queried or parsed, so a
# read/parse error is never mistaken for "absent".
spw_plugin_is_installed() {
  codex_bin="$1"
  plugin_id="$2"
  if ! out=$("$codex_bin" plugin list --json 2>/dev/null); then
    spw_die "cannot list Codex plugins via '$codex_bin plugin list --json'"
  fi
  if ! result=$(spw_json_array_has "$out" "installed" "pluginId" "$plugin_id"); then
    spw_die "cannot parse output of '$codex_bin plugin list --json'"
  fi
  [ "$result" = present ]
}

# Return 0 if <marketplace_name> is registered, 1 if genuinely not registered.
# Fail closed exactly like spw_plugin_is_installed.
spw_marketplace_is_registered() {
  codex_bin="$1"
  marketplace_name="$2"
  if ! out=$("$codex_bin" plugin marketplace list --json 2>/dev/null); then
    spw_die "cannot list Codex marketplaces via '$codex_bin plugin marketplace list --json'"
  fi
  if ! result=$(spw_json_array_has "$out" "marketplaces" "name" "$marketplace_name"); then
    spw_die "cannot parse output of '$codex_bin plugin marketplace list --json'"
  fi
  [ "$result" = present ]
}

# Print the registered root of <marketplace_name> from a marketplace-list JSON
# document (as a string argument, like spw_json_array_has), or nothing if the
# marketplace is absent. Exit 2 on unparseable JSON, a non-object item, or an
# item without a non-empty string name: such an item cannot be proven unrelated
# and must not be mistaken for an absent wrapper marketplace. Validate root only
# on the matching item; unrelated marketplace roots are never read. A matching
# item without a non-empty string root also exits 2. Empty output is unambiguous:
# a valid registered root is always a non-empty path.
spw_marketplace_root_from_json() {
  json="$1"
  marketplace_name="$2"
  python3 - "$json" "$marketplace_name" <<'PY'
import json, sys
raw, name = sys.argv[1], sys.argv[2]
try:
    data = json.loads(raw)
except (json.JSONDecodeError, RecursionError):
    sys.exit(2)
if not isinstance(data, dict):
    sys.exit(2)
items = data.get("marketplaces")
if not isinstance(items, list):
    sys.exit(2)
for item in items:
    if not isinstance(item, dict):
        sys.exit(2)
    item_name = item.get("name")
    if not isinstance(item_name, str) or not item_name:
        sys.exit(2)
for item in items:
    if item["name"] == name:
        item_root = item.get("root")
        if not isinstance(item_root, str) or not item_root:
            sys.exit(2)
        print(item_root)
        sys.exit(0)
PY
}

# Print "same" if the two paths refer to the same physical location, else
# "different". Physical-path normalization via os.path.realpath on both
# sides (handles /var vs /private/var and other symlinked roots); if
# realpath fails, fall back to comparing the original strings.
spw_paths_equal() {
  python3 - "$1" "$2" <<'PY'
import os, sys
a, b = sys.argv[1], sys.argv[2]
try:
    na, nb = os.path.realpath(a), os.path.realpath(b)
except OSError:
    na, nb = a, b
print("same" if na == nb else "different")
PY
}

spw_find_installed_metadata() {
  search_root="${SUPERPOWERS_INSTALLED_SEARCH_ROOT:-$HOME/.codex}"
  find "$search_root" \
    \( -path "*/superpowers/.superpowers-upstream.json" \
       -o -path "*/superpowers/*/.superpowers-upstream.json" \) \
    -type f 2>/dev/null | head -n 1
}

spw_find_installed_manifest() {
  search_root="${SUPERPOWERS_INSTALLED_SEARCH_ROOT:-$HOME/.codex}"
  find "$search_root" \
    \( -path "*/superpowers/.codex-plugin/plugin.json" \
       -o -path "*/superpowers/*/.codex-plugin/plugin.json" \) \
    -type f 2>/dev/null | head -n 1
}

spw_codex_json_get_or_empty() {
  file="$1"
  key="$2"
  [ -f "$file" ] || return 1
  python3 - "$file" "$key" <<'PY'
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
    with open(path, "r", encoding="utf-8") as handle:
        data = json.load(handle, parse_constant=reject_constant)
except (OSError, UnicodeError, json.JSONDecodeError, RecursionError, ValueError):
    sys.exit(1)

if nesting_exceeds_limit(data) or not isinstance(data, dict):
    sys.exit(1)

value = data
for part in dotted_key.split("."):
    if not isinstance(value, dict):
        value = ""
        break
    value = value.get(part, "")

if value is None:
    value = ""
if not isinstance(value, str):
    sys.exit(1)
print(value)
PY
}

spw_codex_metadata_commit_or_empty() {
  file="$1"
  if ! commit=$(spw_codex_json_get_or_empty "$file" "commit"); then
    return 1
  fi
  case "$commit" in
    ""|*[!0-9a-fA-F]*) return 1 ;;
  esac
  case "${#commit}" in
    7|40) printf '%s\n' "$commit" ;;
    *) return 1 ;;
  esac
}

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
  if ! version=$(spw_codex_json_get_or_empty "$file" "version"); then
    return 1
  fi
  case "$version" in
    *+wrapper.*)
      short="${version##*.}"
      case "$short" in
        [0-9a-fA-F][0-9a-fA-F][0-9a-fA-F][0-9a-fA-F][0-9a-fA-F][0-9a-fA-F][0-9a-fA-F])
          printf '%s\n' "$short"
          ;;
      esac
      ;;
  esac
}

spw_installed_commit_or_empty() {
  installed_metadata=$(spw_find_installed_metadata || true)
  installed_manifest=$(spw_find_installed_manifest || true)
  installed_commit=""
  if [ -n "$installed_metadata" ]; then
    installed_commit=$(spw_codex_metadata_commit_or_empty "$installed_metadata" || true)
  fi
  if [ -z "$installed_commit" ] && [ -n "$installed_manifest" ]; then
    installed_commit=$(spw_manifest_short_sha_or_empty "$installed_manifest" || true)
  fi
  printf '%s\n' "$installed_commit"
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

def has_terminal_control(value):
    return any(
        ord(char) < 0x20
        or 0x7f <= ord(char) <= 0x9f
        or 0xd800 <= ord(char) <= 0xdfff
        for char in value
    )

if any(has_terminal_control(value) for value in (operation, code, error_message)):
    raise SystemExit("protocol strings must not contain terminal control characters")

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
                or has_terminal_control(text)
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
    if any(has_terminal_control(hint) for hint in hints):
        raise SystemExit("protocol hints must not contain terminal control characters")
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

# Append command output as structured message records while keeping the
# tab-delimited spool format unambiguous. Each physical command-output line is
# escaped with Python's unicode_escape codec so literal backslashes remain
# distinguishable from rendered control characters like \t and \r.
spw_codex_append_messages() {
  messages_file="$1"
  channel="$2"
  input_file="$3"
  [ -f "$input_file" ] || return 0
  python3 - "$messages_file" "$channel" "$input_file" <<'PY'
from pathlib import Path
import sys

messages_path = Path(sys.argv[1])
channel = sys.argv[2]
input_path = Path(sys.argv[3])

chunks = input_path.read_bytes().split(b"\n")
with messages_path.open("a", encoding="utf-8") as handle:
    for chunk in chunks:
        if not chunk:
            continue
        text = chunk.decode("utf-8", errors="backslashreplace")
        escaped = text.encode("unicode_escape").decode("ascii")
        if not escaped:
            continue
        handle.write(f"{channel}\t{escaped}\n")
PY
}
