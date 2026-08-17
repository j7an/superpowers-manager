#!/bin/sh
set -eu

root=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)

failed=0

echo "==> tests/run-node-suites.js"
node "$root/tests/run-node-suites.js" || failed=$((failed + 1))

exit $failed
