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
    *) echo "error: unknown container test mode: $mode" >&2; exit 2 ;;
  esac
  exit 0
fi

mode="${1:-suite}"
case "$mode" in suite|harness-codex|harness-pi) ;; *) echo "usage: tests/container.sh [suite|harness-codex|harness-pi]" >&2; exit 2 ;; esac

native_node=${SPW_NATIVE_NODE_VERSION:-24}
case "$native_node" in
  24.12.0|24) ;;
  *) echo "error: SPW_NATIVE_NODE_VERSION must be 24.12.0 or 24" >&2; exit 2 ;;
esac
image="superpowers-manager-test:node-$native_node"

command -v docker >/dev/null 2>&1 || {
  echo "error: docker is required for the container acceptance suite" >&2
  exit 1
}

docker build --pull \
  --build-arg "NATIVE_NODE_VERSION=$native_node" \
  -f "$root/tests/container/Dockerfile" -t "$image" "$root"
exec docker run --rm \
  --network none \
  --read-only \
  --tmpfs /tmp:rw,exec,nosuid,size=512m \
  --tmpfs /home/spw:rw,nosuid,size=128m,uid=10001,gid=10001 \
  "$image" "$mode"
