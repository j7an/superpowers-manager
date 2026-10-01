#!/bin/sh
set -eu

if [ "${SPW_CONTAINER:-}" != 1 ] || [ "$(id -u)" != 10001 ]; then
  echo "error: Pi acceptance requires the isolated UID 10001 container" >&2
  exit 1
fi
if [ "${1:-}" != --isolated ]; then
  exec env -i PATH="$PATH" HOME=/home/spw SPW_CONTAINER=1 \
    PI_OFFLINE=1 PI_SKIP_VERSION_CHECK=1 sh "$0" --isolated
fi

root=$(mktemp -d /tmp/spw-pi-XXXXXX)
trap 'rm -rf "$root"' EXIT HUP INT TERM
HOME="$root/home"
PI_CODING_AGENT_DIR="$HOME/.pi/agent"
SUPERPOWERS_CONFIG_DIR="$root/config"
SUPERPOWERS_CACHE_DIR="$root/cache"
SUPERPOWERS_PI=pi
export HOME PI_CODING_AGENT_DIR SUPERPOWERS_CONFIG_DIR SUPERPOWERS_CACHE_DIR \
  SUPERPOWERS_PI
mkdir -p "$HOME" "$PI_CODING_AGENT_DIR" "$root/cwd"
cd "$root/cwd"
SPW_WALK_HARNESS=pi
SPW_WALK_LABEL=Pi

discovered_names() {
  timeout 60 node /workspace/tests/container/pi/skill-names.ts \
    "$PI_CODING_AGENT_DIR" \
    /opt/spw-test-tools/node_modules/@earendil-works/pi-coding-agent \
    "$PI_CODING_AGENT_DIR/superpowers-manager/installed" \
    || walk_fail "cannot discover Pi skills"
}

. /workspace/tests/container/real-upstream-walk.sh
walk_setup
walk_main
