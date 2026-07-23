#!/bin/sh
set -eu

test_dir=$(CDPATH= cd -- "$(dirname "$0")" && pwd)
root=$(CDPATH= cd -- "$test_dir/.." && pwd)

command -v node >/dev/null 2>&1 || {
  echo "error: node is required for behavioral baseline tests" >&2
  exit 1
}

node --test \
  "$root/tests/baseline/fixture-contract.test.js" \
  "$root/tests/baseline/cli-parity.test.js" \
  "$root/tests/baseline/packaged-cli.test.js"
