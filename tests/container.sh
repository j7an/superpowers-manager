#!/bin/sh
set -eu

root=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)

if [ "${1:-}" = "--inside" ]; then
  actual_uid=$(id -u)
  if [ "$actual_uid" != 10001 ]; then
    echo "error: container acceptance suite must run as UID 10001 (got $actual_uid)" >&2
    exit 1
  fi

  mode="${2:-suite}"
  run_opencode_probe() {
    SPW_OPENCODE_BIN="$1" SPW_OPENCODE_MAJOR="$2" \
      OPENCODE_CONFIG=/tmp/spw-ambient-forbidden.jsonc \
      OPENCODE_CONFIG_DIR=/tmp/spw-ambient-forbidden-config \
      OPENCODE_CONFIG_CONTENT='{"plugin":["superpowers"]}' \
      OPENCODE_DB=/tmp/spw-ambient-forbidden.db \
      OPENCODE_TEST_MANAGED_CONFIG_DIR=/tmp/spw-ambient-forbidden-managed \
      sh tests/container/opencode/offline-probe.sh
  }
  run_opencode_walk() {
    SPW_OPENCODE_BIN="$1" SPW_OPENCODE_MAJOR="$2" \
      OPENCODE_CONFIG=/tmp/spw-ambient-forbidden.jsonc \
      OPENCODE_CONFIG_DIR=/tmp/spw-ambient-forbidden-config \
      OPENCODE_CONFIG_CONTENT='{"plugin":["superpowers"]}' \
      OPENCODE_DB=/tmp/spw-ambient-forbidden.db \
      OPENCODE_TEST_MANAGED_CONFIG_DIR=/tmp/spw-ambient-forbidden-managed \
      sh tests/container/opencode/real-upstream.sh
  }
  run_opencode_lines() {
    echo "container: OpenCode V1 lane: start"
    run_opencode_probe /opt/spw-test-tools/node_modules/opencode-ai/bin/opencode.exe 1
    echo "container: OpenCode V1 lane: complete status=0"
    echo "container: OpenCode V1 real-upstream walk: start"
    run_opencode_walk /opt/spw-test-tools/node_modules/opencode-ai/bin/opencode.exe 1
    echo "container: OpenCode V1 real-upstream walk: complete status=0"
    echo "container: OpenCode V2 lane: start"
    run_opencode_probe /opt/spw-test-tools/node_modules/@opencode/cli/bin/opencode.exe 2
    echo "container: OpenCode V2 lane: complete status=0"
    echo "container: OpenCode V2 real-upstream walk: start"
    run_opencode_walk /opt/spw-test-tools/node_modules/@opencode/cli/bin/opencode.exe 2
    echo "container: OpenCode V2 real-upstream walk: complete status=0"
  }

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
  case "$mode" in
    suite)
      phase "container suite: shared checks" sh tests/run.sh
      phase "container suite: Codex harness integration" sh tests/container/codex/offline-probe.sh
      phase "container: Codex real-upstream walk" sh tests/container/codex/real-upstream.sh
      phase "container suite: Pi harness integration" sh tests/container/pi/offline-probe.sh
      phase "container: Pi real-upstream walk" sh tests/container/pi/real-upstream.sh
      phase "container suite: OpenCode harness integration" run_opencode_lines
      phase "container suite: Claude Code harness integration" sh tests/container/claude-code/offline-probe.sh
      phase "container: Claude Code real-upstream walk" sh tests/container/claude-code/real-upstream.sh
      phase "container suite: Hermes harness integration" sh tests/container/hermes/offline-probe.sh
      phase "container: Hermes real-upstream walk" sh tests/container/hermes/real-upstream.sh
      ;;
    shared) phase "container: shared checks" sh tests/run.sh ;;
    harness-codex) phase "container: Codex harness integration" sh tests/container/codex/offline-probe.sh; phase "container: Codex real-upstream walk" sh tests/container/codex/real-upstream.sh ;;
    harness-pi) phase "container: Pi harness integration" sh tests/container/pi/offline-probe.sh; phase "container: Pi real-upstream walk" sh tests/container/pi/real-upstream.sh ;;
    harness-opencode) phase "container: OpenCode harness integration" run_opencode_lines ;;
    harness-claude-code) phase "container: Claude Code harness integration" sh tests/container/claude-code/offline-probe.sh; phase "container: Claude Code real-upstream walk" sh tests/container/claude-code/real-upstream.sh ;;
    harness-hermes) phase "container: Hermes harness integration" sh tests/container/hermes/offline-probe.sh; phase "container: Hermes real-upstream walk" sh tests/container/hermes/real-upstream.sh ;;
    *) echo "error: unknown container test mode: $mode" >&2; exit 2 ;;
  esac
  exit 0
fi

mode="${1:-suite}"
case "$mode" in suite|shared|harness-codex|harness-pi|harness-opencode|harness-claude-code|harness-hermes) ;; *) echo "usage: tests/container.sh [suite|shared|harness-codex|harness-pi|harness-opencode|harness-claude-code|harness-hermes]" >&2; exit 2 ;; esac

image="superpowers-manager-test"

command -v docker >/dev/null 2>&1 || {
  echo "error: docker is required for the container acceptance suite" >&2
  exit 1
}

docker build --pull \
  -f "$root/tests/container/Dockerfile" -t "$image" "$root"
exec docker run --rm \
  --network none \
  --read-only \
  --tmpfs /tmp:rw,exec,nosuid,size=512m \
  --tmpfs /home/spw:rw,nosuid,size=128m,uid=10001,gid=10001 \
  "$image" "$mode"
