#!/bin/sh
set -eu

if [ "${SPW_CONTAINER:-}" != 1 ] || [ "$(id -u)" != 10001 ]; then
  echo "error: OpenCode acceptance requires the isolated UID 10001 container" >&2
  exit 1
fi
if [ -z "${SPW_OPENCODE_BIN:-}" ] || [ -z "${SPW_OPENCODE_MAJOR:-}" ]; then
  echo "error: SPW_OPENCODE_BIN and SPW_OPENCODE_MAJOR must name the OpenCode executable under test and its expected major" >&2
  exit 1
fi
if [ "${1:-}" != --isolated ]; then
  exec env -i PATH="$PATH" HOME=/home/spw SPW_CONTAINER=1 \
    SPW_OPENCODE_BIN="$SPW_OPENCODE_BIN" \
    SPW_OPENCODE_MAJOR="$SPW_OPENCODE_MAJOR" \
    sh "$0" --isolated
fi
if [ "${OPENCODE_CONFIG+x}" = x ] || \
  [ "${OPENCODE_CONFIG_DIR+x}" = x ] || \
  [ "${OPENCODE_CONFIG_CONTENT+x}" = x ] || \
  [ "${OPENCODE_DB+x}" = x ] || \
  [ "${OPENCODE_TEST_MANAGED_CONFIG_DIR+x}" = x ]; then
  echo "error: OpenCode acceptance isolation retained an ambient native input" >&2
  exit 1
fi

root=$(mktemp -d /tmp/spw-opencode-XXXXXX)
cleanup() {
  status=$?
  if [ "$status" -ne 0 ] && [ -s "$root/native.stderr" ]; then
    tail -n 80 "$root/native.stderr" >&2
  fi
  rm -rf "$root"
  exit "$status"
}
trap cleanup EXIT HUP INT TERM
HOME="$root/home"
XDG_CONFIG_HOME="$root/config"
XDG_DATA_HOME="$root/data"
XDG_CACHE_HOME="$root/cache"
XDG_STATE_HOME="$root/state"
TMPDIR="$root/tmp"
SUPERPOWERS_CONFIG_DIR="$root/selection"
SUPERPOWERS_CACHE_DIR="$root/manager-cache"
SUPERPOWERS_UPSTREAM_URL="$root/upstream"
SUPERPOWERS_OPENCODE="$SPW_OPENCODE_BIN"
spw_reported=$("$SUPERPOWERS_OPENCODE" --version)
spw_major=$(printf '%s' "$spw_reported" | sed -n 's/^\(opencode v\)\{0,1\}\([0-9][0-9]*\)\..*$/\2/p')
if [ "$spw_major" != "$SPW_OPENCODE_MAJOR" ]; then
  echo "error: expected OpenCode major $SPW_OPENCODE_MAJOR, got '$spw_reported'" >&2
  exit 1
fi
OPENCODE_DISABLE_AUTOUPDATE=1
OPENCODE_DISABLE_MODELS_FETCH=1
OPENCODE_CONFIG="$root/explicit/opencode.jsonc"
OPENCODE_CONFIG_DIR="$root/override"
OPENCODE_DB="$root/database/opencode.db"
OPENCODE_TEST_MANAGED_CONFIG_DIR="$root/managed"
GIT_CONFIG_GLOBAL=/dev/null
GIT_CONFIG_NOSYSTEM=1
SPW_NATIVE_DIAGNOSTIC="$root/native.stderr"
export HOME XDG_CONFIG_HOME XDG_DATA_HOME XDG_CACHE_HOME XDG_STATE_HOME TMPDIR \
  SUPERPOWERS_CONFIG_DIR SUPERPOWERS_CACHE_DIR SUPERPOWERS_UPSTREAM_URL \
  SUPERPOWERS_OPENCODE OPENCODE_DISABLE_AUTOUPDATE \
  OPENCODE_DISABLE_MODELS_FETCH OPENCODE_CONFIG OPENCODE_CONFIG_DIR \
  OPENCODE_DB OPENCODE_TEST_MANAGED_CONFIG_DIR GIT_CONFIG_GLOBAL \
  GIT_CONFIG_NOSYSTEM SPW_NATIVE_DIAGNOSTIC SPW_OPENCODE_MAJOR

mkdir -p "$HOME/.opencode" "$XDG_CONFIG_HOME/opencode" "$XDG_DATA_HOME" \
  "$XDG_CACHE_HOME" "$XDG_STATE_HOME" "$TMPDIR" "$SUPERPOWERS_CONFIG_DIR" \
  "$SUPERPOWERS_CACHE_DIR" "$root/explicit" "$OPENCODE_CONFIG_DIR" \
  "$root/database" "$OPENCODE_TEST_MANAGED_CONFIG_DIR" "$root/project"
cp -R /opt/spw-opencode-config-seed/. "$XDG_CONFIG_HOME/opencode/"
cp -R /opt/spw-opencode-config-seed/. "$HOME/.opencode/"
cp -R /opt/spw-opencode-cache-seed/. "$XDG_CACHE_HOME/"
printf '%s\n' '{// retained global comment' '  "theme": "dark",' '}' >"$XDG_CONFIG_HOME/opencode/opencode.jsonc"
printf '%s\n' '{// explicit preserved' '  "theme": "explicit",' '}' >"$OPENCODE_CONFIG"
printf '%s\n' '{// override preserved' '  "theme": "override",' '}' >"$OPENCODE_CONFIG_DIR/opencode.jsonc"
printf '%s\n' '{// home preserved' '  "theme": "home",' '}' >"$HOME/.opencode/opencode.jsonc"
printf '%s\n' '{// managed preserved' '  "theme": "managed",' '}' >"$OPENCODE_TEST_MANAGED_CONFIG_DIR/opencode.jsonc"
node --disable-warning=ExperimentalWarning -e '
  const { DatabaseSync } = require("node:sqlite");
  const db = new DatabaseSync(process.argv[1]);
  db.exec("CREATE TABLE account(id TEXT PRIMARY KEY, email TEXT NOT NULL, url TEXT NOT NULL, access_token TEXT NOT NULL, refresh_token TEXT NOT NULL, token_expiry INTEGER); CREATE TABLE account_state(id INTEGER PRIMARY KEY, active_account_id TEXT, active_org_id TEXT); INSERT INTO account_state VALUES(1, NULL, NULL)");
  db.close();
' "$OPENCODE_DB"

cd "$root/project"
prepared="$XDG_CONFIG_HOME/opencode/superpowers-manager/prepared"
installed="$XDG_CONFIG_HOME/opencode/superpowers-manager/installed"
observer=/workspace/tests/container/opencode/native-probe.ts

run_manager() {
  timeout 60 node /workspace/src/cli.ts "$@"
}
observe() {
  SPW_OPENCODE_PROBE_ROOT="$root" timeout 60 node "$observer" observe "$installed" "$1"
}
fixture_git() {
  git -C "$SUPERPOWERS_UPSTREAM_URL" -c user.name=fixture \
    -c user.email=fixture@example.invalid -c core.hooksPath=/dev/null \
    -c init.templateDir= "$@"
}
snapshot_non_target() {
  tar -cf "$1" -C "$root" explicit override home/.opencode managed database
}
assert_non_target_unchanged() {
  snapshot_non_target "$root/non-target.after.tar"
  cmp "$root/non-target.before.tar" "$root/non-target.after.tar"
  rm "$root/non-target.before.tar" "$root/non-target.after.tar"
}
guarded_manager() {
  snapshot_non_target "$root/non-target.before.tar"
  run_manager "$@"
  assert_non_target_unchanged
}

node "$observer" fixture-create "$SUPERPOWERS_UPSTREAM_URL"
fixture_git init -q
fixture_git add .
fixture_git commit -qm 'native fixture A'
commit_a=$(fixture_git rev-parse HEAD)
guarded_manager pin "$commit_a"
cp "$XDG_CONFIG_HOME/opencode/opencode.jsonc" "$root/target.before.jsonc"
guarded_manager prepare --harness opencode
cmp "$XDG_CONFIG_HOME/opencode/opencode.jsonc" "$root/target.before.jsonc"
echo "opencode prepare target config: unchanged"
test -d "$prepared"
test ! -e "$installed"
snapshot_non_target "$root/non-target.before.tar"
if run_manager install --harness opencode >"$root/refused.stdout" 2>"$root/refused.stderr"; then
  echo "error: custom OpenCode fixture installed without experimental opt-in" >&2
  exit 1
fi
test ! -e "$installed"
cmp "$XDG_CONFIG_HOME/opencode/opencode.jsonc" "$root/target.before.jsonc"
assert_non_target_unchanged

guarded_manager install --harness opencode --allow-experimental
observe A

node "$observer" fixture-phase-b \
  "$SUPERPOWERS_UPSTREAM_URL/skills/snapshot-probe/SKILL.md"
fixture_git add .
fixture_git commit -qm 'native fixture B'
commit_b=$(fixture_git rev-parse HEAD)
test "$commit_a" != "$commit_b"
guarded_manager pin "$commit_b"
guarded_manager prepare --harness opencode
observe A
guarded_manager update --harness opencode --allow-experimental
observe B

tripwire="$root/opencode-tripwire"
printf '#!/bin/sh\ntouch "%s"\nexit 97\n' "$root/native-called" >"$tripwire"
chmod +x "$tripwire"
tripwire_status=0
env -i PATH="$PATH" "$tripwire" || tripwire_status=$?
test "$tripwire_status" = 97
test -e "$root/native-called"
rm "$root/native-called"
probe_before="$root/probe.before.tar"
tar -cf "$probe_before" -C "$root" config data cache state selection manager-cache explicit override home managed database
SUPERPOWERS_OPENCODE="$tripwire" \
  run_manager probe --harness opencode >/dev/null
test ! -e "$root/native-called"
tar -cf "$root/probe.after.tar" -C "$root" config data cache state selection manager-cache explicit override home managed database
cmp "$probe_before" "$root/probe.after.tar"

actual_uninstall_stdout="$root/actual-uninstall.stdout"
actual_uninstall_stderr="$root/actual-uninstall.stderr"
snapshot_non_target "$root/non-target.before.tar"
run_manager uninstall --harness opencode >"$actual_uninstall_stdout" 2>"$actual_uninstall_stderr"
assert_non_target_unchanged
cat "$actual_uninstall_stdout"
cat "$actual_uninstall_stderr" >&2
grep -Fxq \
  "Removed the managed Superpowers OpenCode installation. Restart OpenCode to load the resulting state." \
  "$actual_uninstall_stdout"
test ! -s "$actual_uninstall_stderr"
test ! -e "$installed"
grep -Fq '// retained global comment' "$XDG_CONFIG_HOME/opencode/opencode.jsonc"
grep -Fq '"theme": "dark"' "$XDG_CONFIG_HOME/opencode/opencode.jsonc"
observe absent

noop_uninstall_stdout="$root/noop-uninstall.stdout"
noop_uninstall_stderr="$root/noop-uninstall.stderr"
snapshot_non_target "$root/non-target.before.tar"
run_manager uninstall --harness opencode >"$noop_uninstall_stdout" 2>"$noop_uninstall_stderr"
assert_non_target_unchanged
cat "$noop_uninstall_stdout"
cat "$noop_uninstall_stderr" >&2
grep -Fxq "No managed Superpowers OpenCode installation is present." \
  "$noop_uninstall_stdout"
if grep -Fqi "restart" "$noop_uninstall_stdout"; then
  echo "error: idempotent OpenCode uninstall must not request a restart" >&2
  exit 1
fi
test ! -s "$noop_uninstall_stderr"
observe absent
echo "opencode harness integration: complete status=0"
