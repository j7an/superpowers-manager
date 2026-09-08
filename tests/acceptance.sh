#!/bin/sh
set -eu

root=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)
echo "acceptance: shared checks: start"
sh "$root/tests/run.sh" --require-package-node "$@"
echo "acceptance: shared checks: complete status=0"
echo "acceptance: Codex harness integration: start"
sh "$root/tests/container.sh" harness-codex
echo "acceptance: Codex harness integration: complete status=0"
echo "acceptance: Pi harness integration: start"
sh "$root/tests/container.sh" harness-pi
echo "acceptance: Pi harness integration: complete status=0"
