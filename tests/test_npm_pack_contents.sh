#!/bin/sh
set -eu

root=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)
tmpdir=$(mktemp -d)
trap 'rm -rf "$tmpdir"' EXIT INT TERM

command -v npm >/dev/null 2>&1 || { echo "error: npm is required for this test" >&2; exit 1; }

(cd "$root" && npm pack --dry-run --json > "$tmpdir/pack.json")
sh "$root/tests/assert_pack_contents.sh" "$tmpdir/pack.json"

python3 - "$tmpdir/pack.json" <<'PY'
import json
import sys

with open(sys.argv[1], encoding="utf-8") as f:
    report = json.load(f)

paths = tuple(file["path"] for file in report[0]["files"])
for path in paths:
    parts = path.split("/")
    if (
        "selection.json" in parts
        or any(part.startswith("superpowers-manager.pin.") for part in parts)
        or ".git" in parts
        or ".cache" in parts
        or (
            path.startswith("plugins/superpowers/")
            and path
            != "plugins/superpowers/.codex-plugin/plugin.template.json"
        )
        or path == "docs/superpowers"
        or path.startswith("docs/superpowers/")
    ):
        raise SystemExit(f"forbidden npm pack path: {path}")
PY

assert_rejected_identity() {
    field=$1
    value=$2
    diagnostic=$3
    fixture="$tmpdir/pack-$field.json"

    python3 - "$tmpdir/pack.json" "$fixture" "$field" "$value" <<'PY'
import json
import sys

with open(sys.argv[1], encoding="utf-8") as f:
    report = json.load(f)
report[0][sys.argv[3]] = sys.argv[4]
with open(sys.argv[2], "w", encoding="utf-8") as f:
    json.dump(report, f)
PY

    if output=$(sh "$root/tests/assert_pack_contents.sh" "$fixture" 2>&1); then
        echo "error: tampered npm pack $field was accepted" >&2
        exit 1
    fi
    case $output in
        *"$diagnostic"*) ;;
        *)
            echo "error: npm pack $field failure lacked diagnostic: $diagnostic" >&2
            printf '%s\n' "$output" >&2
            exit 1
            ;;
    esac
}

assert_rejected_identity name tampered-package "pack report name mismatch"
assert_rejected_identity version 0.0.0-tampered "pack report version mismatch"
assert_rejected_identity id tampered-package@0.0.0 "pack report id mismatch"

echo "test_npm_pack_contents: OK"
