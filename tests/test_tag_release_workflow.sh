#!/bin/sh
set -eu

root=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)
wf="$root/.github/workflows/tag-release.yml"
bump="$root/.version-bump.json"

[ -f "$wf" ] || { echo "missing $wf" >&2; exit 1; }
[ -f "$bump" ] || { echo "missing $bump" >&2; exit 1; }

grep -q 'workflow_dispatch:' "$wf"
grep -Fq 'uses: j7an/shared-workflows/.github/workflows/tag-release.yml@dc9105acf09a4ad43bad2e4a86f4c65f553fe3c0 # v4.2.2' "$wf"
grep -q 'tag-prefix: "v"' "$wf"
grep -q 'RELEASE_BOT_PRIVATE_KEY: ${{ secrets.RELEASE_BOT_PRIVATE_KEY }}' "$wf"

python3 - "$bump" <<'PY'
import json
import sys

path = sys.argv[1]
with open(path, encoding="utf-8") as fh:
    actual = json.load(fh)

expected = {"files": [{"path": "package.json", "field": "version"}]}
if actual != expected:
    raise SystemExit(f"unexpected {path}: {actual!r}")
PY

echo "test_tag_release_workflow: OK"
