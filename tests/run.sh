#!/bin/sh
set -eu

root=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)

failed=0

echo "==> tests/run-node-suites.js"
node "$root/tests/run-node-suites.js" || failed=$((failed + 1))

for test_file in "$root"/tests/test_*.sh; do
  echo "==> ${test_file#$root/}"
  sh "$test_file" || failed=$((failed + 1))
done
exit $failed
