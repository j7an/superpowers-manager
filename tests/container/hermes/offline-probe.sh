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
SUPERPOWERS_UPSTREAM_URL="$root/upstream"
SUPERPOWERS_HERMES=hermes
GIT_CONFIG_GLOBAL=/dev/null
GIT_CONFIG_NOSYSTEM=1
export HOME HERMES_HOME SUPERPOWERS_CONFIG_DIR SUPERPOWERS_CACHE_DIR \
  SUPERPOWERS_UPSTREAM_URL SUPERPOWERS_HERMES GIT_CONFIG_GLOBAL GIT_CONFIG_NOSYSTEM
upstream=$SUPERPOWERS_UPSTREAM_URL
plugin_root="$HERMES_HOME/plugins/superpowers"
mkdir -p "$HOME" "$HERMES_HOME" "$root/cwd" "$upstream/.hermes-plugin" \
  "$upstream/skills/using-superpowers"
cd "$root/cwd"
fail() { echo "error: $*" >&2; exit 1; }
run_manager() { timeout 60 node /workspace/src/cli.ts "$@"; }
hermes_cli() { timeout 60 hermes "$@"; }
fixture_git() {
  git -C "$upstream" -c user.name=fixture -c user.email=fixture@example.invalid \
    -c core.hooksPath=/dev/null -c init.templateDir= "$@"
}
snapshot() {
  find "$HERMES_HOME" -print | LC_ALL=C sort
  find "$HERMES_HOME" -type f -exec sha256sum {} + | LC_ALL=C sort
}
listed() {
  hermes_cli plugins list --json >"$root/list.json" || fail "cannot list Hermes plugins"
  node -e '
    const fs = require("node:fs");
    const entries = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    if (!Array.isArray(entries)) process.exit(1);
    const rows = entries.filter((entry) => entry.name === "superpowers");
    if (process.argv[2] === "enabled") {
      if (rows.length !== 1 || rows[0].status !== "enabled") process.exit(1);
    } else if (rows.length) process.exit(1);
  ' "$root/list.json" "$1" || fail "unexpected Hermes plugin listing"
}

cp /workspace/tests/fixtures/hermes-native/plugin.yaml.txt "$upstream/.hermes-plugin/plugin.yaml"
cp /workspace/tests/fixtures/hermes-native/__init__.py.txt "$upstream/.hermes-plugin/__init__.py"
mkdir -p "$upstream/skills/using-superpowers/references"
cp /workspace/tests/fixtures/hermes-native/hermes-tools.md.txt "$upstream/skills/using-superpowers/references/hermes-tools.md"
cp /workspace/tests/fixtures/pi-native/SKILL.md.txt "$upstream/skills/using-superpowers/SKILL.md"
cp /workspace/tests/fixtures/pi-native/LICENSE.txt "$upstream/LICENSE"
fixture_git init -q
fixture_git add .
fixture_git commit -qm 'native fixture A'
fixture_git tag v6.4.2
commit_a=$(fixture_git rev-parse HEAD)
snapshot >"$root/empty-before"
run_manager probe --harness hermes --porcelain >"$root/empty-probe"
snapshot >"$root/empty-after"
cmp "$root/empty-before" "$root/empty-after" || fail "fresh probe mutated Hermes state"
run_manager pin "$commit_a"
run_manager prepare --harness hermes
mkdir -p "$plugin_root"
printf '%s\n' foreign >"$plugin_root/foreign"
snapshot >"$root/foreign-before"
refused_status=0
run_manager install --harness hermes >"$root/refused.out" 2>"$root/refused.err" || refused_status=$?
[ "$refused_status" = 1 ] || fail "foreign install did not refuse with exit 1"
snapshot >"$root/foreign-after"
cmp "$root/foreign-before" "$root/foreign-after" || fail "refused install mutated state"
rm -rf "$plugin_root"
run_manager install --harness hermes
listed enabled
spw-hermes-python - "$plugin_root" <<'PY'
import importlib.util
import sys
from pathlib import Path
root = Path(sys.argv[1])
spec = importlib.util.spec_from_file_location("spw_check", root / "__init__.py", submodule_search_locations=[str(root)])
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
cache = root / "__pycache__"
assert cache.is_file() and not cache.is_symlink() and cache.stat().st_size == 0
PY
snapshot >"$root/probe-before"
run_manager probe --harness hermes --porcelain >"$root/probe-1"
run_manager probe --harness hermes --porcelain >"$root/probe-2"
snapshot >"$root/probe-after"
cmp "$root/probe-1" "$root/probe-2" || fail "repeated probes differ"
cmp "$root/probe-before" "$root/probe-after" || fail "probe mutated Hermes state"
grep -Fxq status=current "$root/probe-1" || fail "probe did not report current"
identity_a=$(sed -n 's/^installed_identity=//p' "$root/probe-1")
[ -n "$identity_a" ] || fail "probe omitted identity A"
mkdir -p "$upstream/skills/snapshot-probe"
printf -- '---\nname: snapshot-probe\ndescription: Use when verifying a Hermes snapshot refresh\n---\nphase B\n' \
  >"$upstream/skills/snapshot-probe/SKILL.md"
fixture_git add .
fixture_git commit -qm 'native fixture B'
commit_b=$(fixture_git rev-parse HEAD)
run_manager pin "$commit_b"
run_manager prepare --harness hermes
listed enabled
run_manager probe --harness hermes --porcelain >"$root/prepared-b-probe"
grep -Fxq "installed_identity=$identity_a" "$root/prepared-b-probe" || fail "preparing B changed installed A"
test ! -e "$plugin_root/skills/snapshot-probe" || fail "preparing B touched installed skills"
run_manager update --harness hermes
listed enabled
run_manager probe --harness hermes --porcelain >"$root/updated-probe"
grep -Fxq status=current "$root/updated-probe" || fail "B is not current after update"
test -f "$plugin_root/skills/snapshot-probe/SKILL.md" || fail "B skill is absent"
run_manager uninstall --harness hermes
listed absent
test ! -e "$plugin_root" || fail "plugin directory remains after uninstall"
entries=$(grep -c superpowers "$HERMES_HOME/config.yaml" || true)
[ "$entries" = 0 ] || fail "superpowers activation remains after uninstall"
run_manager uninstall --harness hermes >"$root/noop.out"
grep -Fxq "No managed Superpowers Hermes installation is present." "$root/noop.out" \
  || fail "second uninstall was not idempotent"
echo "hermes harness integration: complete status=0"
