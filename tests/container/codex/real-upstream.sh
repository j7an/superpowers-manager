#!/bin/sh
set -eu

if [ "${SPW_CONTAINER:-}" != 1 ] || [ "$(id -u)" != 10001 ]; then
  echo "error: Codex acceptance requires the isolated UID 10001 container" >&2
  exit 1
fi
case "$HOME" in /home/spw|/tmp/*) ;; *) echo "error: refusing non-isolated HOME: $HOME" >&2; exit 1 ;; esac
if [ "${1:-}" != --isolated ]; then
  exec env -i PATH="$PATH" HOME=/home/spw SPW_CONTAINER=1 sh "$0" --isolated
fi

root=$(mktemp -d /tmp/spw-codex-XXXXXX)
trap 'rm -rf "$root"' EXIT HUP INT TERM
HOME="$root/home"
SUPERPOWERS_CONFIG_DIR="$root/config"
SUPERPOWERS_CACHE_DIR="$root/cache"
SUPERPOWERS_CODEX=codex
SUPERPOWERS_INSTALLED_SEARCH_ROOT="$HOME/.codex"
export HOME SUPERPOWERS_CONFIG_DIR SUPERPOWERS_CACHE_DIR SUPERPOWERS_CODEX \
  SUPERPOWERS_INSTALLED_SEARCH_ROOT
mkdir -p "$HOME" "$root/cwd"
cd "$root/cwd"
SPW_WALK_HARNESS=codex
SPW_WALK_LABEL=Codex

listed_version() {
  timeout 30 codex plugin list --json >"$root/walk/codex-list" \
    || walk_fail "cannot list Codex plugins"
  node -e '
    const fs = require("node:fs");
    const fail = () => {
      console.error("error: real-upstream codex: malformed Codex plugin listing");
      process.exit(1);
    };
    let listing;
    try { listing = JSON.parse(fs.readFileSync(process.argv[1], "utf8")); } catch { fail(); }
    if (!listing || typeof listing !== "object" || !Array.isArray(listing.installed) ||
      listing.installed.some((entry) => !entry || typeof entry !== "object" ||
        Array.isArray(entry) || typeof entry.pluginId !== "string")) fail();
    const managed = listing.installed.filter((entry) => entry.pluginId === "superpowers@superpowers-manager");
    if (managed.length > 1 || (managed.length === 1 &&
      (typeof managed[0].version !== "string" || managed[0].version.length === 0))) fail();
    if (managed.length) process.stdout.write(managed[0].version);
  ' "$root/walk/codex-list" || walk_fail "cannot parse Codex plugin listing"
}

discovered_names() {
  timeout 30 node /workspace/tests/container/codex/hooks-list-rpc.ts \
    "$(pwd -P)" "$root/walk/skills.json" "$root/walk/skills.err" skills/list \
    || walk_fail "cannot discover Codex skills"
  node /workspace/tests/container/codex/assert-state.ts skill-names \
    "$root/walk/skills.json" "$(pwd -P)" \
    || walk_fail "cannot parse Codex skills"
}

. /workspace/tests/container/real-upstream-walk.sh
walk_setup
walk_main
