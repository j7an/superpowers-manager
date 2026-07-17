#!/bin/sh
set -eu

root=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)
wf="$root/.github/workflows/tag-release.yml"
bump="$root/.version-bump.json"
package="$root/package.json"
release_doc="$root/RELEASING.md"

[ -f "$wf" ] || { echo "missing $wf" >&2; exit 1; }
[ -f "$bump" ] || { echo "missing $bump" >&2; exit 1; }
[ -f "$package" ] || { echo "missing $package" >&2; exit 1; }
[ -f "$release_doc" ] || { echo "missing $release_doc" >&2; exit 1; }

grep -q 'workflow_dispatch:' "$wf"
grep -Fq 'uses: j7an/shared-workflows/.github/workflows/tag-release.yml@dc9105acf09a4ad43bad2e4a86f4c65f553fe3c0 # v4.2.2' "$wf"
grep -q 'tag-prefix: "v"' "$wf"
grep -q 'RELEASE_BOT_PRIVATE_KEY: ${{ secrets.RELEASE_BOT_PRIVATE_KEY }}' "$wf"

python3 - "$bump" "$package" "$release_doc" <<'PY'
import json
import re
import sys

path, package_path, release_doc_path = sys.argv[1:]
with open(path, encoding="utf-8") as fh:
    actual = json.load(fh)

expected = {"files": [{"path": "package.json", "field": "version"}]}
if actual != expected:
    raise SystemExit(f"unexpected {path}: {actual!r}")

with open(package_path, encoding="utf-8") as fh:
    package = json.load(fh)
with open(release_doc_path, encoding="utf-8") as fh:
    release_doc = fh.read()

match = re.search(
    r"`superpowers-manager@(\d+\.\d+\.\d+)` and its GitHub Release",
    release_doc,
)
if match is None:
    raise SystemExit("RELEASING.md does not identify the published Manager baseline")
if package.get("version") != match.group(1):
    raise SystemExit(
        "package.json version does not match the documented published Manager "
        f"baseline: {package.get('version')!r} != {match.group(1)!r}"
    )
PY

echo "test_tag_release_workflow: OK"
