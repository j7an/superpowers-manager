#!/bin/sh
# Compare the file list in an `npm pack --json` report against the expected
# tarball contents. Used two ways: the repo test suite feeds it dry-run JSON;
# the publish workflow feeds it the JSON from the real pack that produced the
# published artifact. Exits non-zero listing any mismatch.
set -eu

root=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)
json_file="$1"

exec node "$root/tests/tools/assert-pack-contents.ts" \
  "$json_file" "$root/package.json" "$root/tests/expected_tarball_contents.txt"
