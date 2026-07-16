#!/bin/sh
set -eu

root=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)
tsc_bin="${SPW_TSC:-/opt/spw-test-tools/node_modules/.bin/tsc}"

if [ ! -x "$tsc_bin" ]; then
  echo "SKIP (tsc unavailable; container run is authoritative)"
  exit 0
fi

"$tsc_bin" -p "$root/tests/tsconfig.json"
echo "test_js_types: OK"
