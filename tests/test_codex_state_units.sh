#!/bin/sh
set -eu

test_dir=$(CDPATH= cd -- "$(dirname "$0")" && pwd)
. "$test_dir/lib/harness.sh"
spw_test_root
. "$root/scripts/core/common.sh"
. "$root/scripts/core/lifecycle.sh"

test_uninstall_helpers() {
  for state in neither manager; do
    output=$(spw_require_no_legacy_state "$state" 2>&1)
    [ -z "$output" ]
  done

  for state in legacy both; do
    if output=$(spw_require_no_legacy_state "$state" 2>&1); then
      echo "legacy policy must reject $state" >&2
      exit 1
    fi
    printf '%s\n' "$output" |
      grep -Fxq 'Legacy superpowers-wrapper Codex state is installed.'
    printf '%s\n' "$output" |
      grep -Fxq 'Run: npx superpowers-wrapper@0.1.1 uninstall'
    printf '%s\n' "$output" |
      grep -Fxq 'Then run: npx superpowers-manager install'
  done

  for state in neither manager; do
    output=$(spw_report_legacy_state "$state")
    [ -z "$output" ]
  done

  for state in legacy both; do
    output=$(spw_report_legacy_state "$state")
    printf '%s\n' "$output" |
      grep -Fxq 'Legacy superpowers-wrapper Codex state remains installed.'
    printf '%s\n' "$output" |
      grep -Fxq 'Run: npx superpowers-wrapper@0.1.1 uninstall'
  done

  echo "test_uninstall_helpers: OK"
}

failed=0
spw_section test_uninstall_helpers test_uninstall_helpers
[ "$failed" -eq 0 ] || exit "$failed"
