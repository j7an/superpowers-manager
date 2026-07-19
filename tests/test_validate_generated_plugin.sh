#!/bin/sh
set -eu

test_dir=$(CDPATH= cd -- "$(dirname "$0")" && pwd)
. "$test_dir/lib/harness.sh"
spw_test_root
python3 -S "$root/tests/test_validate_generated_plugin.py"
echo "test_validate_generated_plugin: OK"
