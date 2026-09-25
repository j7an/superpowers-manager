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
  run_opencode_lines() {
    echo "container: OpenCode V1 lane: start"
    run_opencode_probe /opt/spw-test-tools/node_modules/opencode-ai/bin/opencode.exe 1
    echo "container: OpenCode V1 lane: complete status=0"
    echo "container: OpenCode V2 lane: start"
    run_opencode_probe /opt/spw-test-tools/node_modules/@opencode/cli/bin/opencode.exe 2
    echo "container: OpenCode V2 lane: complete status=0"
  }
  case "$mode" in
    suite)
      echo "container suite: shared checks: start"
      sh tests/run.sh
      echo "container suite: shared checks: complete status=0"
      echo "container suite: Codex harness integration: start"
      sh tests/container/codex/offline-probe.sh
      echo "container suite: Codex harness integration: complete status=0"
      echo "container suite: Pi harness integration: start"
      sh tests/container/pi/offline-probe.sh
      echo "container suite: Pi harness integration: complete status=0"
      echo "container suite: OpenCode harness integration: start"
      run_opencode_lines
      echo "container suite: OpenCode harness integration: complete status=0"
      echo "container suite: Claude Code harness integration: start"
      sh tests/container/claude-code/offline-probe.sh
      echo "container suite: Claude Code harness integration: complete status=0"
      ;;
    harness-codex)
      echo "container: Codex harness integration: start"
      sh tests/container/codex/offline-probe.sh
      echo "container: Codex harness integration: complete status=0"
      ;;
    harness-pi)
      echo "container: Pi harness integration: start"
      sh tests/container/pi/offline-probe.sh
      echo "container: Pi harness integration: complete status=0"
      ;;
    harness-opencode)
      echo "container: OpenCode harness integration: start"
      run_opencode_lines
      echo "container: OpenCode harness integration: complete status=0"
      ;;
    harness-claude-code)
      echo "container: Claude Code harness integration: start"
      sh tests/container/claude-code/offline-probe.sh
      echo "container: Claude Code harness integration: complete status=0"
      ;;
    *) echo "error: unknown container test mode: $mode" >&2; exit 2 ;;
  esac
  exit 0
fi

mode="${1:-suite}"
case "$mode" in suite|harness-codex|harness-pi|harness-opencode|harness-claude-code) ;; *) echo "usage: tests/container.sh [suite|harness-codex|harness-pi|harness-opencode|harness-claude-code]" >&2; exit 2 ;; esac

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
