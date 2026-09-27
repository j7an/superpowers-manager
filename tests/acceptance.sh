#!/bin/sh
set -eu

root=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)

# Prints "<label>: start", runs the command, then "<label>: complete status=0".
# Call it only as a plain statement: inside if/&&/|| set -e is suspended.
# Not reentrant: POSIX sh has no local variables.
phase() {
  phase_label=$1
  shift
  echo "$phase_label: start"
  "$@"
  echo "$phase_label: complete status=0"
}

phase "acceptance: shared checks" sh "$root/tests/run.sh" --require-package-node "$@"
phase "acceptance: Codex harness integration" sh "$root/tests/container.sh" harness-codex
phase "acceptance: Pi harness integration" sh "$root/tests/container.sh" harness-pi
phase "acceptance: OpenCode harness integration" sh "$root/tests/container.sh" harness-opencode
phase "acceptance: Claude Code harness integration" sh "$root/tests/container.sh" harness-claude-code
