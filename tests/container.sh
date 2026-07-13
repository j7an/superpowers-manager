#!/bin/sh
set -eu

root=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)
image="superpowers-wrapper-test:local"

if [ "${1:-}" = "--inside" ]; then
  mode="${2:-suite}"
  case "$mode" in
    suite)
      sh tests/run.sh
      exec sh tests/container/codex-offline-probe.sh
      ;;
    codex-spike) exec sh tests/container/codex-offline-probe.sh ;;
    *) echo "error: unknown container test mode: $mode" >&2; exit 2 ;;
  esac
fi

mode="${1:-suite}"
case "$mode" in suite|codex-spike) ;; *) echo "usage: tests/container.sh [suite|codex-spike]" >&2; exit 2 ;; esac

command -v docker >/dev/null 2>&1 || {
  echo "error: docker is required for the container acceptance suite" >&2
  exit 1
}

docker build --pull -f "$root/tests/container/Dockerfile" -t "$image" "$root"
exec docker run --rm \
  --network none \
  --read-only \
  --tmpfs /tmp:rw,exec,nosuid,size=512m \
  --tmpfs /home/spw:rw,nosuid,size=128m,uid=10001,gid=10001 \
  "$image" "$mode"
