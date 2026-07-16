#!/bin/sh
set -eu

root=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)
tmpdir=$(mktemp -d)
trap 'rm -rf "$tmpdir"' EXIT INT TERM

command -v npm >/dev/null 2>&1 || { echo "error: npm is required for this test" >&2; exit 1; }

if [ -e "$root/bin/superpowers-wrapper.js" ]; then
  echo "deprecated executable must not ship" >&2
  exit 1
fi
if grep -Fq '"superpowers-wrapper"' "$root/package.json"; then
  echo "old npm/bin identity remains in package.json" >&2
  exit 1
fi

(cd "$root" && npm_config_cache="$tmpdir/npm-cache" npm pack --dry-run --json > "$tmpdir/pack.json")
sh "$root/tests/assert_pack_contents.sh" "$tmpdir/pack.json"

echo "test_npm_pack_contents: OK"
