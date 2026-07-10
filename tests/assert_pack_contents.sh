#!/bin/sh
# Compare the file list in an `npm pack --json` report against the expected
# tarball contents. Used two ways: the repo test suite feeds it dry-run JSON;
# the publish workflow feeds it the JSON from the real pack that produced the
# published artifact. Exits non-zero listing any mismatch.
set -eu

root=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)
json_file="$1"

python3 - "$json_file" "$root/tests/expected_tarball_contents.txt" <<'PY'
import json, sys

with open(sys.argv[1], encoding="utf-8") as f:
    report = json.load(f)
if not isinstance(report, list) or len(report) != 1:
    sys.exit("unexpected npm pack --json shape: expected a one-element array")
actual = sorted(entry["path"] for entry in report[0]["files"])
with open(sys.argv[2], encoding="utf-8") as f:
    expected = sorted(
        line.strip() for line in f
        if line.strip() and not line.startswith("#")
    )
if actual != expected:
    missing = [p for p in expected if p not in actual]
    extra = [p for p in actual if p not in expected]
    if missing:
        print("missing from tarball:", *missing, sep="\n  ")
    if extra:
        print("unexpected in tarball:", *extra, sep="\n  ")
    sys.exit(1)
print(f"tarball contents OK ({len(actual)} files)")
PY
