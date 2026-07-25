#!/bin/sh
# Compare the file list in an `npm pack --json` report against the expected
# tarball contents. Used two ways: the repo test suite feeds it dry-run JSON;
# the publish workflow feeds it the JSON from the real pack that produced the
# published artifact. Exits non-zero listing any mismatch.
set -eu

root=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)
json_file="$1"

python3 - "$json_file" "$root/package.json" "$root/tests/expected_tarball_contents.txt" <<'PY'
import json, sys

with open(sys.argv[1], encoding="utf-8") as f:
    report = json.load(f)
if isinstance(report, list) and len(report) == 1:
    packed = report[0]
elif isinstance(report, dict) and len(report) == 1:
    packed = next(iter(report.values()))
else:
    sys.exit(
        "unexpected npm pack --json shape: expected a one-element array "
        "or a keyed object with exactly one value"
    )
if not isinstance(packed, dict):
    sys.exit(
        "unexpected npm pack --json shape: expected a one-element array "
        "or a keyed object with exactly one value"
    )
with open(sys.argv[2], encoding="utf-8") as f:
    package = json.load(f)
if package.get("name") != "superpowers-manager":
    sys.exit(
        "root package name mismatch: "
        f"expected 'superpowers-manager', got {package.get('name')!r}"
    )
version = package.get("version")
if not isinstance(version, str) or not version:
    sys.exit(f"root package version is missing or invalid: {version!r}")
if packed.get("name") != package["name"]:
    sys.exit(
        "pack report name mismatch: "
        f"expected {package['name']!r}, got {packed.get('name')!r}"
    )
if packed.get("version") != version:
    sys.exit(
        "pack report version mismatch: "
        f"expected {version!r}, got {packed.get('version')!r}"
    )
expected_id = f"superpowers-manager@{version}"
if packed.get("id") != expected_id:
    sys.exit(
        "pack report id mismatch: "
        f"expected {expected_id!r}, got {packed.get('id')!r}"
    )
actual = sorted(entry["path"] for entry in packed["files"])
with open(sys.argv[3], encoding="utf-8") as f:
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
