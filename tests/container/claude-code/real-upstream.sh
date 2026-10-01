#!/bin/sh
set -eu

if [ "${SPW_CONTAINER:-}" != 1 ] || [ "$(id -u)" != 10001 ]; then
  echo "error: Claude Code acceptance requires the isolated UID 10001 container" >&2
  exit 1
fi
if [ "${1:-}" != --isolated ]; then
  exec env -i PATH="$PATH" HOME=/home/spw SPW_CONTAINER=1 sh "$0" --isolated
fi

# ponytail: Environment setup is duplicated across harnesses; extract a sourced helper if a fifth lands.
root=$(mktemp -d /tmp/spw-claude-code-XXXXXX)
trap 'rm -rf "$root"' EXIT HUP INT TERM
HOME="$root/home"
CLAUDE_CONFIG_DIR="$root/claude"
CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1
DISABLE_AUTOUPDATER=1
SUPERPOWERS_CONFIG_DIR="$root/config"
SUPERPOWERS_CACHE_DIR="$root/cache"
SUPERPOWERS_CLAUDE_CODE=claude
export HOME CLAUDE_CONFIG_DIR CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC \
  DISABLE_AUTOUPDATER SUPERPOWERS_CONFIG_DIR SUPERPOWERS_CACHE_DIR SUPERPOWERS_CLAUDE_CODE
mkdir -p "$HOME" "$CLAUDE_CONFIG_DIR" "$root/cwd"
cd "$root/cwd"
SPW_WALK_HARNESS=claude-code
SPW_WALK_LABEL="Claude Code"

listed_version() {
  timeout 60 claude plugin list --json >"$root/walk/claude-list" \
    || walk_fail "cannot list Claude Code plugins"
  node -e '
    const fs = require("node:fs");
    const fail = () => {
      console.error("error: real-upstream claude-code: malformed Claude Code plugin listing");
      process.exit(1);
    };
    let entries;
    try { entries = JSON.parse(fs.readFileSync(process.argv[1], "utf8")); } catch { fail(); }
    if (!Array.isArray(entries) || entries.some((entry) =>
      !entry || typeof entry !== "object" || Array.isArray(entry) || typeof entry.id !== "string")) fail();
    const managed = entries.filter((entry) => entry.id === "superpowers@superpowers-manager");
    if (managed.length > 1 || (managed.length === 1 &&
      (typeof managed[0].version !== "string" || managed[0].version.length === 0))) fail();
    if (managed.length) process.stdout.write(managed[0].version);
  ' "$root/walk/claude-list" || walk_fail "cannot parse Claude Code plugin listing"
}

discovered_names() {
  claude_version=$(listed_version) || walk_fail "cannot discover Claude Code plugin version"
  [ -n "$claude_version" ] || return 0
  timeout 60 claude plugin details superpowers >"$root/walk/claude-details" \
    || walk_fail "cannot inspect Claude Code plugin details"
  node -e '
    const fs = require("node:fs");
    const fail = () => {
      console.error("error: real-upstream claude-code: malformed Claude Code skill details");
      process.exit(1);
    };
    let text;
    try { text = fs.readFileSync(process.argv[1], "utf8"); } catch { fail(); }
    const lines = text.split("\n").filter((line) => /^  Skills \(/.test(line));
    if (lines.length !== 1) fail();
    const match = /^  Skills \((\d+)\)  (.*)$/.exec(lines[0]);
    if (!match) fail();
    const names = match[2] ? match[2].split(", ") : [];
    if (names.length !== Number(match[1]) || names.some((name) => !/^[a-z0-9][a-z0-9-]*$/.test(name)) ||
      new Set(names).size !== names.length) fail();
    process.stdout.write(names.length ? names.sort().join("\n") + "\n" : "");
  ' "$root/walk/claude-details" || walk_fail "cannot parse Claude Code skill details"
}

. /workspace/tests/container/real-upstream-walk.sh
walk_setup
walk_main
