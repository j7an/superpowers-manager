#!/bin/sh
set -eu

root=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)
sh "$root/tests/run.sh" --require-package-node "$@"
sh "$root/tests/container.sh" codex-spike
