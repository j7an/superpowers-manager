#!/bin/sh
set -eu

test_dir=$(CDPATH= cd -- "$(dirname "$0")" && pwd)
. "$test_dir/lib/harness.sh"
spw_test_root

test_bin_units() {
  command -v node >/dev/null 2>&1 || { echo "error: node is required for this test" >&2; exit 1; }
  node "$root/tests/bin/units.test.js"
  echo "test_bin_units: OK"
}

test_js_types() {
  tsc_bin="${SPW_TSC:-$root/node_modules/.bin/tsc}"

  if [ ! -x "$tsc_bin" ]; then
    echo "error: repo TypeScript compiler missing — run pnpm install --frozen-lockfile" >&2
    exit 1
  fi

  "$tsc_bin" -p "$root/tests/tsconfig.json"
  echo "test_js_types: OK"
}

failed=0
spw_section test_bin_units test_bin_units
spw_section test_js_types test_js_types
[ "$failed" -eq 0 ] || exit "$failed"
