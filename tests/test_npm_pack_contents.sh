#!/bin/sh
set -eu

test_dir=$(CDPATH= cd -- "$(dirname "$0")" && pwd)
. "$test_dir/lib/harness.sh"
spw_test_root
spw_test_tmpdir

command -v npm >/dev/null 2>&1 || { echo "error: npm is required for this test" >&2; exit 1; }

(cd "$root" && npm pack --dry-run --json > "$tmpdir/pack-raw.json")

sh "$root/tests/assert_pack_contents.sh" "$tmpdir/pack-raw.json"

python3 - "$tmpdir/pack-raw.json" "$tmpdir/pack.json" "$tmpdir/pack-array.json" "$tmpdir/pack-keyed.json" <<'PY'
import json
import sys

with open(sys.argv[1], encoding="utf-8") as f:
    report = json.load(f)
if isinstance(report, list) and len(report) == 1:
    packed = report[0]
elif isinstance(report, dict) and len(report) == 1:
    packed = next(iter(report.values()))
else:
    raise SystemExit("unexpected npm pack report fixture shape")

with open(sys.argv[2], "w", encoding="utf-8") as f:
    json.dump([packed], f)
with open(sys.argv[3], "w", encoding="utf-8") as f:
    json.dump([packed], f)
with open(sys.argv[4], "w", encoding="utf-8") as f:
    json.dump({"packed": packed}, f)
PY
sh "$root/tests/assert_pack_contents.sh" "$tmpdir/pack-array.json"
sh "$root/tests/assert_pack_contents.sh" "$tmpdir/pack-keyed.json"

python3 - "$tmpdir/pack.json" "$tmpdir" <<'PY'
import json
import sys

with open(sys.argv[1], encoding="utf-8") as f:
    packed = json.load(f)[0]
fixtures = {
    "shape-empty-array.json": [],
    "shape-two-element-array.json": [packed, packed],
    "shape-empty-object.json": {},
    "shape-two-entry-object.json": {"first": packed, "second": packed},
    "shape-non-object-entry.json": [None],
}
for name, report in fixtures.items():
    with open(f"{sys.argv[2]}/{name}", "w", encoding="utf-8") as f:
        json.dump(report, f)
PY

for fixture in "$tmpdir"/shape-*.json; do
    if output=$(sh "$root/tests/assert_pack_contents.sh" "$fixture" 2>&1); then
        echo "error: malformed npm pack report was accepted: $fixture" >&2
        exit 1
    fi
    case $output in
        *"unexpected npm pack --json shape: expected a one-element array or a keyed object with exactly one value"*) ;;
        *)
            echo "error: malformed npm pack report lacked shape diagnostic: $fixture" >&2
            printf '%s\n' "$output" >&2
            exit 1
            ;;
    esac
done

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

distless="$tmpdir/distless"
mkdir -p "$distless"
cp "$root/package.json" "$distless/package.json"

rc=0
(
  cd "$distless"
  npm pack --dry-run --json
) >"$tmpdir/distless-out" 2>"$tmpdir/distless-err" || rc=$?

[ "$rc" -ne 0 ] || {
  echo "distless npm pack must fail" >&2
  exit 1
}
grep -Fq 'dist/cli.js is missing' "$tmpdir/distless-err"

echo "test_npm_pack_contents: OK"
