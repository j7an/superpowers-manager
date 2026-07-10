#!/bin/sh
set -eu

root=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)
tmpdir=$(mktemp -d)
trap 'rm -rf "$tmpdir"' EXIT INT TERM

command -v npm >/dev/null 2>&1 || { echo "error: npm is required for this test" >&2; exit 1; }

(cd "$root" && npm pack --dry-run --json > "$tmpdir/pack.json")
sh "$root/tests/assert_pack_contents.sh" "$tmpdir/pack.json"

echo "test_npm_pack_contents: OK"
