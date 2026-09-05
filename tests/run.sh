#!/bin/sh
set -eu

root=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)

failed=0

echo "==> tests/run-node-suites.ts"
node "$root/tests/run-node-suites.ts" || failed=$((failed + 1))

# Emitted on every path, pass or fail. Absence means this script was killed.
echo "tests/run.sh: complete failed=$failed"
exit $failed
