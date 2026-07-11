#!/bin/sh
set -eu

root=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)
wf="$root/.github/workflows/release.yml"

[ -f "$wf" ] || { echo "missing $wf" >&2; exit 1; }
# Trusted publishing requires id-token: write in the CALLER workflow too.
grep -q 'id-token: write' "$wf"
# The reusable workflow must be pinned to released v4.2.2 exactly.
grep -Fq 'uses: j7an/shared-workflows/.github/workflows/publish-npm.yml@dc9105acf09a4ad43bad2e4a86f4c65f553fe3c0 # v4.2.2' "$wf"
# Trigger only on semver-shaped vX.Y.Z tags, not floating v1/v1.2 tags.
grep -q 'tags:' "$wf"
grep -q '"v\*\.\*\.\*"' "$wf"
# Wires this package's name and all optional hooks. The released workflow
# defaults each hook to empty, so omitting one would silently skip that gate.
grep -q 'package-name: superpowers-wrapper' "$wf"
grep -q 'test-command: sh tests/run.sh' "$wf"
grep -q 'pack-contents-script: tests/assert_pack_contents.sh' "$wf"
grep -q 'verify-command:' "$wf"
grep -Fq 'npx --yes "${PACKAGE}@${VERSION}" --version' "$wf"

echo "test_release_workflow: OK"
