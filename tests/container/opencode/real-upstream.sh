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
  if [ "$status" -ne 0 ] && [ -s "$root/walk/native.stderr" ]; then
    tail -n 80 "$root/walk/native.stderr" >&2
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
GIT_CONFIG_NOSYSTEM=1
SPW_NATIVE_DIAGNOSTIC="$root/walk/native.stderr"
export HOME XDG_CONFIG_HOME XDG_DATA_HOME XDG_CACHE_HOME XDG_STATE_HOME TMPDIR \
  SUPERPOWERS_CONFIG_DIR SUPERPOWERS_CACHE_DIR \
  SUPERPOWERS_OPENCODE OPENCODE_DISABLE_AUTOUPDATE \
  OPENCODE_DISABLE_MODELS_FETCH OPENCODE_CONFIG OPENCODE_CONFIG_DIR \
  OPENCODE_DB OPENCODE_TEST_MANAGED_CONFIG_DIR \
  GIT_CONFIG_NOSYSTEM SPW_NATIVE_DIAGNOSTIC SPW_OPENCODE_MAJOR

mkdir -p "$HOME/.opencode" "$XDG_CONFIG_HOME/opencode" "$XDG_DATA_HOME" \
  "$XDG_CACHE_HOME" "$XDG_STATE_HOME" "$TMPDIR" "$SUPERPOWERS_CONFIG_DIR" \
  "$SUPERPOWERS_CACHE_DIR" "$root/explicit" "$OPENCODE_CONFIG_DIR" \
  "$root/database" "$OPENCODE_TEST_MANAGED_CONFIG_DIR" "$root/project"
cp -R /opt/spw-opencode-config-seed/. "$XDG_CONFIG_HOME/opencode/"
cp -R /opt/spw-opencode-config-seed/. "$HOME/.opencode/"
cp -R /opt/spw-opencode-cache-seed/. "$XDG_CACHE_HOME/"
node --disable-warning=ExperimentalWarning -e '
  const { DatabaseSync } = require("node:sqlite");
  const db = new DatabaseSync(process.argv[1]);
  db.exec("CREATE TABLE account(id TEXT PRIMARY KEY, email TEXT NOT NULL, url TEXT NOT NULL, access_token TEXT NOT NULL, refresh_token TEXT NOT NULL, token_expiry INTEGER); CREATE TABLE account_state(id INTEGER PRIMARY KEY, active_account_id TEXT, active_org_id TEXT); INSERT INTO account_state VALUES(1, NULL, NULL)");
  db.close();
' "$OPENCODE_DB"

cd "$root/project"
SPW_WALK_HARNESS=opencode
SPW_WALK_LABEL=OpenCode

discovered_names() {
  SPW_OPENCODE_PROBE_ROOT="$root" node /workspace/tests/container/opencode/native-probe.ts advertised >"$root/walk/advertised" \
    || walk_fail "OpenCode advertised-skills observer failed"
  LC_ALL=C comm -23 "$root/walk/advertised" "$root/walk/baseline"
}

verify_v2_refusal() {
  refusal_tag=$1
  refusal_commit=$(git -C /opt/spw-upstream/superpowers rev-parse "$refusal_tag^{commit}") \
    || walk_fail "cannot inspect upstream commit at $refusal_tag"
  run_manager pin "$refusal_tag"
  run_manager prepare --harness opencode
  walk_snapshot >"$root/walk/refusal-before"
  if run_manager install --harness opencode >"$root/walk/refusal-stdout" 2>"$root/walk/refusal-stderr"; then
    walk_fail "entrypoint-less ref unexpectedly installed on OpenCode V2 at $refusal_tag"
  fi
  printf '%s\n' 'error: the selected upstream ref does not support OpenCode 2; select a ref that ships the V2 entrypoint' >"$root/walk/refusal-expected"
  cmp -s "$root/walk/refusal-expected" "$root/walk/refusal-stderr" \
    || walk_fail "unexpected OpenCode V2 refusal at $refusal_tag"
  [ ! -s "$root/walk/refusal-stdout" ] \
    || walk_fail "unexpected OpenCode V2 refusal output at $refusal_tag"
  walk_snapshot >"$root/walk/refusal-after"
  cmp -s "$root/walk/refusal-before" "$root/walk/refusal-after" \
    || walk_fail "OpenCode V2 refusal mutated harness state at $refusal_tag"
  discovered_names >"$root/walk/refusal-names" \
    || walk_fail "skill discovery failed after OpenCode V2 refusal at $refusal_tag"
  [ ! -s "$root/walk/refusal-names" ] \
    || walk_fail "skills appeared after OpenCode V2 refusal at $refusal_tag"
  walk_snapshot >"$root/walk/refusal-probe-before"
  run_manager probe --harness opencode --porcelain >"$root/walk/refusal-probe"
  walk_snapshot >"$root/walk/refusal-probe-after"
  cmp -s "$root/walk/refusal-probe-before" "$root/walk/refusal-probe-after" \
    || walk_fail "probe mutated state after OpenCode V2 refusal at $refusal_tag"
  grep -Fxq "desired_commit=$refusal_commit" "$root/walk/refusal-probe" \
    || walk_fail "desired commit differs after OpenCode V2 refusal at $refusal_tag"
  grep -Fxq installation_state=absent "$root/walk/refusal-probe" \
    || walk_fail "installation is not absent after OpenCode V2 refusal at $refusal_tag"
  grep -Fxq 'status=needs install' "$root/walk/refusal-probe" \
    || walk_fail "probe status differs after OpenCode V2 refusal at $refusal_tag"
  grep -Fxq compatibility=supported "$root/walk/refusal-probe" \
    || walk_fail "unqualified ref reached OpenCode V2 refusal at $refusal_tag"
  echo "real-upstream opencode: $refusal_tag V2 refusal verified"
}

. /workspace/tests/container/real-upstream-walk.sh
walk_setup
SPW_OPENCODE_PROBE_ROOT="$root" node /workspace/tests/container/opencode/native-probe.ts advertised >"$root/walk/baseline" \
  || walk_fail "OpenCode advertised-skills observer failed"
while IFS= read -r baseline_tag; do
  expected_names "$baseline_tag" >"$root/walk/baseline-expected"
  LC_ALL=C comm -12 "$root/walk/baseline" "$root/walk/baseline-expected" >"$root/walk/baseline-collisions"
  [ ! -s "$root/walk/baseline-collisions" ] \
    || walk_fail "OpenCode built-in skill names collide with upstream at $baseline_tag"
done </workspace/tests/container/upstream-refs
if [ "$SPW_OPENCODE_MAJOR" = 2 ]; then
  : >"$root/walk/v2-refs"
  while IFS= read -r v2_tag; do
    git -C /opt/spw-upstream/superpowers ls-tree --name-only "$v2_tag" -- index.js >"$root/walk/v2-entrypoint" \
      || walk_fail "cannot inspect OpenCode V2 entrypoint at $v2_tag"
    if [ -s "$root/walk/v2-entrypoint" ]; then
      printf '%s\n' "$v2_tag" >>"$root/walk/v2-refs"
    else
      verify_v2_refusal "$v2_tag"
    fi
  done </workspace/tests/container/upstream-refs
  [ -s "$root/walk/v2-refs" ] || walk_fail "window has no OpenCode V2-supported ref"
  walk_main "$root/walk/v2-refs"
else
  walk_main
fi
