#!/bin/sh
set -eu

if [ "${SPW_CONTAINER:-}" != 1 ] || [ "$(id -u)" != 10001 ]; then
  echo "error: Hermes acceptance requires the isolated UID 10001 container" >&2
  exit 1
fi
if [ "${HERMES_ENABLE_PROJECT_PLUGINS+x}" = x ]; then
  echo "error: Hermes acceptance isolation retained project plugin activation" >&2
  exit 1
fi
if [ "${1:-}" != --isolated ]; then
  exec env -i PATH="$PATH" HOME=/home/spw SPW_CONTAINER=1 sh "$0" --isolated
fi

root=$(mktemp -d /tmp/spw-hermes-XXXXXX)
trap 'rm -rf "$root"' EXIT HUP INT TERM
HOME="$root/home"
HERMES_HOME="$root/hermes"
SUPERPOWERS_CONFIG_DIR="$root/config"
SUPERPOWERS_CACHE_DIR="$root/cache"
SUPERPOWERS_HERMES=hermes
export HOME HERMES_HOME SUPERPOWERS_CONFIG_DIR SUPERPOWERS_CACHE_DIR SUPERPOWERS_HERMES
mkdir -p "$HOME" "$HERMES_HOME" "$root/cwd"
cd "$root/cwd"
SPW_WALK_HARNESS=hermes
SPW_WALK_LABEL=Hermes

discovered_names() {
  timeout 60 hermes plugins list --json >"$root/walk/hermes-list" \
    || walk_fail "cannot list Hermes plugins"
  node -e '
    const fs = require("node:fs");
    const entries = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    if (!Array.isArray(entries)) process.exit(2);
    const rows = entries.filter((entry) => entry.name === "superpowers");
    if (rows.length > 1) process.exit(2);
    process.stdout.write(rows.length === 1 && rows[0].status === "enabled" ? "enabled" : "");
  ' "$root/walk/hermes-list" >"$root/walk/hermes-enabled" \
    || walk_fail "cannot parse Hermes plugin listing"
  [ -s "$root/walk/hermes-enabled" ] || return 0
  if ! timeout 120 hermes plugins doctor "$HERMES_HOME/plugins/superpowers" --ci >"$root/walk/doctor" 2>&1; then
    cat "$root/walk/doctor" >&2
    walk_fail "upstream register() failed under Hermes plugin doctor"
  fi
  cat "$root/walk/doctor" >&2
  find "$HERMES_HOME/plugins/superpowers/skills" -mindepth 2 -maxdepth 2 -name SKILL.md \
    | sed 's|.*/skills/\([^/]*\)/SKILL.md$|\1|' | LC_ALL=C sort
}
refusal_snapshot() {
  find "$HOME" "$HERMES_HOME" "$SUPERPOWERS_CONFIG_DIR" -type f -exec sha256sum {} + \
    >"$root/walk/refusal-snapshot-raw" || walk_fail "cannot snapshot Hermes refusal state"
  LC_ALL=C sort "$root/walk/refusal-snapshot-raw"
}
verify_hermes_refusal() {
  refusal_tag=$1
  run_manager pin "$refusal_tag"
  refusal_snapshot >"$root/walk/refusal-before"
  if run_manager prepare --harness hermes >"$root/walk/refusal-stdout" 2>"$root/walk/refusal-stderr"; then
    walk_fail "unsupported Hermes ref unexpectedly prepared at $refusal_tag"
  fi
  grep -Fq "does not provide a native Hermes plugin" "$root/walk/refusal-stderr" \
    || walk_fail "unexpected Hermes refusal at $refusal_tag"
  refusal_snapshot >"$root/walk/refusal-after"
  cmp -s "$root/walk/refusal-before" "$root/walk/refusal-after" \
    || walk_fail "Hermes refusal mutated harness state at $refusal_tag"
  walk_snapshot >"$root/walk/refusal-probe-before"
  run_manager probe --harness hermes --porcelain >"$root/walk/refusal-probe"
  walk_snapshot >"$root/walk/refusal-probe-after"
  cmp -s "$root/walk/refusal-probe-before" "$root/walk/refusal-probe-after" \
    || walk_fail "probe mutated state after Hermes refusal at $refusal_tag"
  grep -Fxq installation_state=absent "$root/walk/refusal-probe" \
    || walk_fail "installation is not absent after Hermes refusal at $refusal_tag"
  echo "real-upstream hermes: $refusal_tag refusal verified"
}
. /workspace/tests/container/real-upstream-walk.sh
walk_setup
: >"$root/walk/hermes-refs"
while IFS= read -r hermes_tag; do
  git -C /opt/spw-upstream/superpowers ls-tree --name-only "$hermes_tag" -- .hermes-plugin/plugin.yaml \
    >"$root/walk/hermes-entrypoint" || walk_fail "cannot inspect Hermes entrypoint at $hermes_tag"
  if [ -s "$root/walk/hermes-entrypoint" ]; then
    printf '%s\n' "$hermes_tag" >>"$root/walk/hermes-refs"
  else
    verify_hermes_refusal "$hermes_tag"
  fi
done </workspace/tests/container/upstream-refs
[ -s "$root/walk/hermes-refs" ] || walk_fail "window has no Hermes-supported ref"
walk_main "$root/walk/hermes-refs"
