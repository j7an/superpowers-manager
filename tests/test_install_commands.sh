#!/bin/sh
set -eu

test_dir=$(CDPATH= cd -- "$(dirname "$0")" && pwd)
. "$test_dir/lib/harness.sh"
spw_test_root
spw_test_tmpdir

# ---------------------------------------------------------------------------
# Harness: a fake upstream git repo, a copied package root (running install
# from the real repo root would dirty the working tree), the shipped built-in
# validator plus a fake failing additional validator, and a fake codex whose
# marketplace/plugin state lives in $state.
# ---------------------------------------------------------------------------

# --- Fake upstream with one stable release tag ---
upstream="$tmpdir/upstream"
mkdir -p "$upstream/skills/brainstorming"
cat > "$upstream/skills/brainstorming/SKILL.md" <<'EOF'
---
name: brainstorming
description: Fake upstream skill
---
# Brainstorming
EOF
printf 'license\n' > "$upstream/LICENSE"
printf 'readme\n' > "$upstream/README.md"
printf 'code\n' > "$upstream/CODE_OF_CONDUCT.md"
git -C "$tmpdir" init upstream >/dev/null
git -C "$upstream" add .
spw_git_commit "$upstream" "fake upstream"
spw_git_tag "$upstream" v1.0.0 "fake release"

# --- Copied package root (simulates the npx-materialized package) ---
pkg="$tmpdir/pkg"
mkdir -p "$pkg/plugins/superpowers/.codex-plugin"
cp -R "$root/scripts" "$pkg/scripts"
cp -R "$root/config" "$pkg/config"
cp "$root/plugins/superpowers/.codex-plugin/plugin.template.json" "$pkg/plugins/superpowers/.codex-plugin/plugin.template.json"
test -x "$pkg/scripts/install" || { echo "install must remain executable in the packaged root" >&2; exit 1; }
test -x "$pkg/scripts/adapters/codex/adapter" || { echo "codex adapter must remain executable in the packaged root" >&2; exit 1; }
test -f "$pkg/scripts/adapters/codex/validate-generated-plugin.py" || { echo "codex validator must remain packaged" >&2; exit 1; }

# --- Additional validator failure fixture ---
failing_validator="$tmpdir/failing_validator.py"
cat > "$failing_validator" <<'PY'
import sys
sys.exit(1)
PY

# --- Fake codex: logs argv; marketplace state is a JSON fixture it mutates;
#     `plugin add` copies the generated metadata into a Codex-like cache so
#     the post-install verifier can find it. Behavior flags are marker files. ---
state="$tmpdir/state"
mkdir -p "$state"
install_tmp="$tmpdir/install-tmp"
mkdir -p "$install_tmp"
fake_codex="$tmpdir/codex"
fake_adapter="$tmpdir/adapter"
log="$state/codex.log"
cat > "$fake_codex" <<'EOF'
#!/bin/sh
state=$(CDPATH= cd -- "$(dirname "$0")" && pwd)/state
printf '%s\n' "$*" >> "$state/codex.log"

if [ "$1" = plugin ] && [ "$2" = list ]; then
  rc=0; [ -f "$state/plugin_list.rc" ] && rc=$(cat "$state/plugin_list.rc")
  cat "$state/plugin_list.json"
  exit "$rc"
fi
if [ "$1" = plugin ] && [ "$2" = marketplace ] && [ "$3" = list ]; then
  rc=0; [ -f "$state/marketplace_list.rc" ] && rc=$(cat "$state/marketplace_list.rc")
  cat "$state/marketplace_list.json"
  exit "$rc"
fi
if [ "$1" = plugin ] && [ "$2" = marketplace ] && [ "$3" = add ]; then
  [ -f "$state/marketplace_add_fail" ] && exit 1
  python3 - "$state/marketplace_list.json" "$4" <<'PY'
import json, sys
path, new_root = sys.argv[1], sys.argv[2]
with open(path, encoding="utf-8") as f:
    data = json.load(f)
data["marketplaces"] = [m for m in data["marketplaces"] if m.get("name") != "superpowers-manager"]
data["marketplaces"].append({"name": "superpowers-manager", "root": new_root})
with open(path, "w", encoding="utf-8") as f:
    json.dump(data, f)
PY
  exit 0
fi
if [ "$1" = plugin ] && [ "$2" = marketplace ] && [ "$3" = remove ]; then
  python3 - "$state/marketplace_list.json" "$4" <<'PY'
import json, sys
path, name = sys.argv[1], sys.argv[2]
with open(path, encoding="utf-8") as f:
    data = json.load(f)
data["marketplaces"] = [m for m in data["marketplaces"] if m.get("name") != name]
with open(path, "w", encoding="utf-8") as f:
    json.dump(data, f)
PY
  exit 0
fi
if [ "$1" = plugin ] && [ "$2" = add ]; then
  [ -f "$state/plugin_add_fail" ] && exit 1
  [ -f "$state/plugin_add_noop" ] && exit 0
  dest="$state/codex-home/plugins/cache/superpowers-manager/superpowers/1.0.0"
  mkdir -p "$dest"
  cp "$SPW_TEST_PKG_ROOT/plugins/superpowers/.superpowers-upstream.json" "$dest/.superpowers-upstream.json"
  printf '%s\n' '{"installed":[{"pluginId":"superpowers@superpowers-manager","version":"1.0.0"}],"available":[]}' > "$state/plugin_list.json"
  if [ -f "$state/plugin_add_stale" ]; then
    python3 - "$dest/.superpowers-upstream.json" <<'PY'
import json, sys
path = sys.argv[1]
with open(path, encoding="utf-8") as f:
    data = json.load(f)
data["commit"] = "0" * 40
with open(path, "w", encoding="utf-8") as f:
    json.dump(data, f)
PY
  fi
  exit 0
fi
if [ "$1" = plugin ] && [ "$2" = remove ]; then
  rm -rf "$state/codex-home/plugins/cache/superpowers-manager"
  exit 0
fi
exit 0
EOF
chmod +x "$fake_codex"

cat > "$fake_adapter" <<'EOF'
#!/bin/sh
set -eu
state=$(CDPATH= cd -- "$(dirname "$0")" && pwd)/state
printf '%s\n' "$*" >> "$state/adapter.log"
if [ "${1:-}" = inspect ] && [ "${2:-}" = --view ] && [ "${3:-}" = update-control ]; then
  count=0
  [ ! -f "$state/update-control-count" ] || count=$(cat "$state/update-control-count")
  count=$((count + 1))
  printf '%s\n' "$count" > "$state/update-control-count"
  update_control=managed
  [ ! -f "$state/update-control" ] || update_control=$(cat "$state/update-control")
  if [ "$update_control" = managed-then-unsupported ]; then
    if [ "$count" -eq 1 ]; then
      update_control=managed
    else
      update_control=unsupported
    fi
  fi
  case "$update_control" in
    managed|unsupported)
      printf '{"protocol":1,"operation":"inspect","ok":true,"messages":[],"result":{"view":"update-control","update_control":"%s"},"error":null}\n' "$update_control"
      exit 0
      ;;
    malformed)
      printf '%s' '{'
      exit 0
      ;;
    failure)
      printf '%s\n' '{"protocol":1,"operation":"inspect","ok":false,"messages":[],"result":null,"error":{"code":"inspect-failed","message":"update-control inspection failed","hints":[]}}'
      exit 1
      ;;
    *)
      echo "unknown update-control fixture: $update_control" >&2
      exit 99
      ;;
  esac
fi
if [ "${1:-}" = inspect ] && [ "${2:-}" = --view ] && [ "${3:-}" = fingerprint ] &&
   [ -d "$state/codex-home/plugins/cache/superpowers-manager" ]; then
  if [ -f "$state/fingerprint_inspect_fail" ]; then
    printf '%s\n' 'fingerprint inspection failed in adapter fixture' >&2
    exit 99
  fi
  if [ -f "$state/fingerprint_inspect_malformed" ]; then
    printf '%s' '{'
    exit 0
  fi
fi
exec "$SPW_TEST_PKG_ROOT/scripts/adapters/codex/adapter" "$@"
EOF
chmod +x "$fake_adapter"

marketplace_absent='{"marketplaces":[{"name":"openai-curated","root":"/x"}]}'

reset() {
  rm -f "$state/marketplace_list.rc" "$state/marketplace_add_fail" \
        "$state/plugin_add_fail" "$state/plugin_add_noop" "$state/plugin_add_stale" \
        "$state/fingerprint_inspect_fail" "$state/fingerprint_inspect_malformed" \
        "$state/plugin_list.rc" "$state/update-control" "$state/update-control-count"
  rm -rf "$state/codex-home"
  printf '%s\n' '{"installed":[],"available":[]}' > "$state/plugin_list.json"
  : > "$log"
  : > "$state/adapter.log"
}

set_update_control() {
  printf '%s\n' "$1" > "$state/update-control"
}

seed_installed_current() {
  dest="$state/codex-home/plugins/cache/superpowers-manager/superpowers/1.0.0"
  mkdir -p "$dest"
  if [ -f "$pkg/plugins/superpowers/.superpowers-upstream.json" ]; then
    cp "$pkg/plugins/superpowers/.superpowers-upstream.json" "$dest/.superpowers-upstream.json"
  else
    seed_commit=$(git -C "$upstream" rev-parse HEAD)
    printf '{"commit":"%s"}\n' "$seed_commit" > "$dest/.superpowers-upstream.json"
  fi
  printf '%s\n' '{"installed":[{"pluginId":"superpowers@superpowers-manager","version":"1.0.0"}],"available":[]}' > "$state/plugin_list.json"
}

run_install() {
  env \
    TMPDIR="$install_tmp" \
    SPW_ADAPTER="$fake_adapter" \
    SUPERPOWERS_CODEX="$fake_codex" \
    SUPERPOWERS_UPSTREAM_URL="$upstream" \
    SUPERPOWERS_INSTALLED_SEARCH_ROOT="$state/codex-home" \
    SPW_TEST_PKG_ROOT="$pkg" \
    "$@" \
    sh "$pkg/scripts/install"
}

run_update() {
  env \
    TMPDIR="$install_tmp" \
    SPW_ADAPTER="$fake_adapter" \
    SUPERPOWERS_CODEX="$fake_codex" \
    SUPERPOWERS_UPSTREAM_URL="$upstream" \
    SUPERPOWERS_INSTALLED_SEARCH_ROOT="$state/codex-home" \
    SPW_TEST_PKG_ROOT="$pkg" \
    "$@" \
    sh "$pkg/scripts/update"
}

run_prepare() {
  env \
    TMPDIR="$install_tmp" \
    SPW_ADAPTER="$fake_adapter" \
    SUPERPOWERS_CODEX="$fake_codex" \
    SUPERPOWERS_UPSTREAM_URL="$upstream" \
    SUPERPOWERS_INSTALLED_SEARCH_ROOT="$state/codex-home" \
    SPW_TEST_PKG_ROOT="$pkg" \
    "$@" \
    sh "$pkg/scripts/prepare"
}

expect_fail() {
  if run_install "$@" >"$state/out" 2>&1; then
    echo "expected install to fail but it succeeded" >&2
    cat "$state/out" >&2
    exit 1
  fi
}

assert_install_tmp_empty() {
  if find "$install_tmp" -mindepth 1 -print | grep -q .; then
    echo "install leaked its invocation workspace or adapter sidecars:" >&2
    find "$install_tmp" -mindepth 1 -print >&2
    exit 1
  fi
}

line_of() {
  grep -Fn "$1" "$log" | head -n1 | cut -d: -f1
}

adapter_line_of() {
  grep -Fn "$1" "$state/adapter.log" | head -n1 | cut -d: -f1
}

assert_no_codex_mutation() {
  if grep -Eq '^plugin (add|remove) |^plugin marketplace (add|remove) ' "$log"; then
    echo "expected no Codex mutation; log was:" >&2
    cat "$log" >&2
    exit 1
  fi
}

# Prepare remains capability-independent because it does not inspect or mutate
# Codex state.
reset
set_update_control unsupported
run_prepare >"$state/out"
if grep -Fq 'inspect --view update-control' "$state/adapter.log"; then
  echo "prepare must not inspect update control" >&2
  cat "$state/adapter.log" >&2
  exit 1
fi
if grep -Fq 'install --package-root' "$state/adapter.log"; then
  echo "prepare must not invoke adapter install" >&2
  cat "$state/adapter.log" >&2
  exit 1
fi
assert_no_codex_mutation

# Unsupported update control blocks both the current update fast path and a
# direct install before any Codex mutation.
reset
seed_installed_current
printf '%s\n' "$marketplace_absent" > "$state/marketplace_list.json"
set_update_control unsupported
if run_update >"$state/out" 2>&1; then exit 1; fi
grep -Fq 'adapter cannot guarantee manager-controlled updates' "$state/out"
if grep -Fq 'manager is current' "$state/out"; then exit 1; fi
assert_no_codex_mutation

reset
set_update_control unsupported
if run_install >"$state/out" 2>&1; then exit 1; fi
assert_no_codex_mutation

# Protocol and execution failures from an old adapter remain public exit 1.
reset
set_update_control malformed
if run_install >"$state/out" 2>&1; then
  echo "install unexpectedly accepted malformed update-control output" >&2
  exit 1
else
  rc=$?
fi
[ "$rc" -eq 1 ] || { echo "malformed adapter response exited $rc, expected 1" >&2; exit 1; }
assert_no_codex_mutation

reset
set_update_control failure
if run_update >"$state/out" 2>&1; then
  echo "update unexpectedly accepted failed update-control inspection" >&2
  exit 1
else
  rc=$?
fi
[ "$rc" -eq 1 ] || { echo "failed adapter response exited $rc, expected 1" >&2; exit 1; }
assert_no_codex_mutation

# A needs-prepare install reinspects after preparation and rejects capability
# drift before mutation.
reset
printf '%s\n' "$marketplace_absent" > "$state/marketplace_list.json"
printf '%s\n' '{' > "$pkg/plugins/superpowers/.superpowers-upstream.json"
set_update_control managed-then-unsupported
if run_install >"$state/out" 2>&1; then
  echo "install must reject capability drift after prepare" >&2
  exit 1
fi
grep -Fq 'prepared v1.0.0' "$state/out"
[ "$(cat "$state/update-control-count")" -eq 2 ]
build_line=$(adapter_line_of 'build --upstream-root')
second_control_line=$(grep -Fn 'inspect --view update-control' "$state/adapter.log" | tail -n1 | cut -d: -f1)
[ "$build_line" -lt "$second_control_line" ] || { echo "update control must be reinspected after prepare" >&2; exit 1; }
assert_no_codex_mutation

# A needs-install path performs fresh ownership and capability inspections
# immediately before adapter install.
reset
printf '%s\n' "$marketplace_absent" > "$state/marketplace_list.json"
run_install >"$state/out"
[ "$(cat "$state/update-control-count")" -eq 2 ]
last_ownership_line=$(grep -Fn 'inspect --view ownership' "$state/adapter.log" | tail -n1 | cut -d: -f1)
last_control_line=$(grep -Fn 'inspect --view update-control' "$state/adapter.log" | tail -n1 | cut -d: -f1)
install_line=$(adapter_line_of "install --package-root $pkg")
[ "$last_ownership_line" -lt "$last_control_line" ] || { echo "fresh ownership inspection must precede update-control gate" >&2; exit 1; }
[ "$last_control_line" -lt "$install_line" ] || { echo "fresh update-control gate must precede adapter install" >&2; exit 1; }

# The fresh needs-install gate, rather than the initial probe result, controls
# mutation authority.
reset
printf '%s\n' "$marketplace_absent" > "$state/marketplace_list.json"
set_update_control managed-then-unsupported
if run_install >"$state/out" 2>&1; then
  echo "install must reject capability drift before adapter install" >&2
  exit 1
fi
[ "$(cat "$state/update-control-count")" -eq 2 ]
assert_no_codex_mutation

# Restore the copied package's initial template-only state so the established
# validation scenarios retain their original preconditions.
rm -rf "$pkg/plugins/superpowers"
mkdir -p "$pkg/plugins/superpowers/.codex-plugin"
cp "$root/plugins/superpowers/.codex-plugin/plugin.template.json" \
  "$pkg/plugins/superpowers/.codex-plugin/plugin.template.json"

# Legacy and mixed identity state stop before prepare or adapter mutation.
for legacy_state in legacy both; do
  reset
  case "$legacy_state" in
    legacy)
      printf '%s\n' '{"installed":[{"pluginId":"superpowers@superpowers-wrapper"}],"available":[]}' > "$state/plugin_list.json"
      ;;
    both)
      seed_installed_current
      printf '%s\n' '{"installed":[{"pluginId":"superpowers@superpowers-manager","version":"1.0.0"},{"pluginId":"superpowers@superpowers-wrapper"}],"available":[]}' > "$state/plugin_list.json"
      ;;
  esac
  printf '%s\n' '{"marketplaces":[{"name":"superpowers-wrapper","root":"/legacy"}]}' > "$state/marketplace_list.json"
  if run_install >"$state/out" 2>&1; then
    echo "install must reject $legacy_state identity state" >&2
    exit 1
  fi
  grep -Fxq 'Legacy superpowers-wrapper Codex state is installed.' "$state/out"
  grep -Fxq 'Run: npx superpowers-wrapper@0.1.1 uninstall' "$state/out"
  grep -Fxq 'Then run: npx superpowers-manager install' "$state/out"
  if grep -Eq '^build |^install ' "$state/adapter.log"; then
    echo "legacy state must stop before build or install adapter mutation" >&2
    cat "$state/adapter.log" >&2
    exit 1
  fi
  assert_no_codex_mutation
done

# ---------------------------------------------------------------------------
# Scenario V1: built-in validation failure leaves Codex untouched.
# ---------------------------------------------------------------------------
reset
printf '%s\n' "$marketplace_absent" > "$state/marketplace_list.json"
python3 - "$pkg/plugins/superpowers/.codex-plugin/plugin.template.json" <<'PY'
import json, sys
path = sys.argv[1]
with open(path, encoding="utf-8") as handle:
    manifest = json.load(handle)
manifest["name"] = "wrong-name"
with open(path, "w", encoding="utf-8") as handle:
    json.dump(manifest, handle, indent=2)
    handle.write("\n")
PY
if run_install >"$state/out" 2>&1; then
  echo "expected install to fail on built-in validation" >&2
  cat "$state/out" >&2
  exit 1
fi
grep -Fq "field \`name\` must equal \`superpowers\`" "$state/out"
assert_no_codex_mutation
cp "$root/plugins/superpowers/.codex-plugin/plugin.template.json" \
  "$pkg/plugins/superpowers/.codex-plugin/plugin.template.json"

# Scenario V2: explicit additional-validator failure also leaves Codex untouched.
reset
printf '%s\n' "$marketplace_absent" > "$state/marketplace_list.json"
if run_install SUPERPOWERS_VALIDATOR="$failing_validator" >"$state/out" 2>&1; then
  echo "expected install to fail on additional validation" >&2
  cat "$state/out" >&2
  exit 1
fi
grep -Fq "additional plugin validation failed" "$state/out"
assert_no_codex_mutation

# ---------------------------------------------------------------------------
# Scenario 1: fresh install — prepare runs, marketplace listed before added,
# marketplace added before plugin add, fingerprint verified.
# ---------------------------------------------------------------------------
reset
printf '%s\n' "$marketplace_absent" > "$state/marketplace_list.json"
run_install > "$state/out"
test -f "$pkg/plugins/superpowers/.superpowers-upstream.json" || { echo "prepare must have generated the tree" >&2; exit 1; }
list_line=$(line_of "plugin marketplace list")
add_line=$(line_of "plugin marketplace add $pkg")
pa_line=$(line_of "plugin add superpowers@superpowers-manager")
{ [ "$list_line" -lt "$add_line" ] && [ "$add_line" -lt "$pa_line" ]; } || {
  echo "order must be: marketplace list, marketplace add, plugin add" >&2; cat "$log" >&2; exit 1; }
grep -Fq "manager updated" "$state/out"
assert_install_tmp_empty
if grep -Fq "marketplace remove" "$log"; then
  echo "fresh install must not remove any marketplace" >&2; exit 1
fi
if grep -Fq "plugin remove superpowers@superpowers-manager" "$log"; then
  echo "add-only fresh install must not remove the manager plugin" >&2; exit 1
fi
if grep -Fq "openai-curated" "$log"; then
  echo "install must never name openai-curated" >&2; exit 1
fi

# ---------------------------------------------------------------------------
# Scenario 1b: a generated/current manager still runs adapter install so the
# package root is actively reconciled instead of being skipped as "already up to
# date".
# ---------------------------------------------------------------------------
reset
seed_installed_current
printf '%s\n' "$marketplace_absent" > "$state/marketplace_list.json"
run_install > "$state/out"
grep -Fq "install --package-root $pkg" "$state/adapter.log"
list_line=$(line_of "plugin marketplace list")
add_line=$(line_of "plugin marketplace add $pkg")
pa_line=$(line_of "plugin add superpowers@superpowers-manager")
{ [ "$list_line" -lt "$add_line" ] && [ "$add_line" -lt "$pa_line" ]; } || {
  echo "current install must still reconcile via adapter install" >&2
  cat "$state/adapter.log" >&2
  cat "$log" >&2
  exit 1
}

# ---------------------------------------------------------------------------
# Scenario 1c: even when the installed fingerprint already matches, a different
# registered package root is reconciled through adapter install.
# ---------------------------------------------------------------------------
reset
seed_installed_current
printf '{"marketplaces":[{"name":"superpowers-manager","root":"%s"}]}\n' "$tmpdir/otherroot" > "$state/marketplace_list.json"
run_install > "$state/out"
grep -Fq "install --package-root $pkg" "$state/adapter.log"
rm_line=$(line_of "plugin marketplace remove superpowers-manager")
add_line=$(line_of "plugin marketplace add $pkg")
pa_line=$(line_of "plugin add superpowers@superpowers-manager")
{ [ "$rm_line" -lt "$add_line" ] && [ "$add_line" -lt "$pa_line" ]; } || {
  echo "same-commit install must still reconcile a different package root" >&2
  cat "$state/adapter.log" >&2
  cat "$log" >&2
  exit 1
}

# ---------------------------------------------------------------------------
# Scenario 2: registered at the same physical root via a symlink -> keep.
# Portable equivalent of macOS /var vs /private/var normalization.
# ---------------------------------------------------------------------------
reset
ln -s "$pkg" "$tmpdir/pkg-link"
printf '{"marketplaces":[{"name":"superpowers-manager","root":"%s"}]}\n' "$tmpdir/pkg-link" > "$state/marketplace_list.json"
run_install > "$state/out"
if grep -Fq "marketplace add" "$log" || grep -Fq "marketplace remove" "$log"; then
  echo "same-root install must not re-register the marketplace" >&2; cat "$log" >&2; exit 1
fi
grep -Fq "plugin add superpowers@superpowers-manager" "$log"
if grep -Fq "plugin remove superpowers@superpowers-manager" "$log"; then
  echo "add-only same-root install must not remove the manager plugin" >&2; exit 1
fi

# ---------------------------------------------------------------------------
# Scenario 3: registered at a different root -> remove then add, in order.
# ---------------------------------------------------------------------------
reset
printf '{"marketplaces":[{"name":"openai-curated","root":"/x"},{"name":"superpowers-manager","root":"%s"}]}\n' "$tmpdir/otherroot" > "$state/marketplace_list.json"
run_install > "$state/out"
rm_line=$(line_of "plugin marketplace remove superpowers-manager")
add_line=$(line_of "plugin marketplace add $pkg")
pa_line=$(line_of "plugin add superpowers@superpowers-manager")
{ [ "$rm_line" -lt "$add_line" ] && [ "$add_line" -lt "$pa_line" ]; } || {
  echo "order must be: marketplace remove, marketplace add, plugin add" >&2; cat "$log" >&2; exit 1; }
if grep -Fq "marketplace remove openai-curated" "$log"; then
  echo "must only ever remove the manager marketplace" >&2; exit 1
fi
if grep -Fq "plugin remove superpowers@superpowers-manager" "$log"; then
  echo "add-only drift reconciliation must not remove the manager plugin" >&2; exit 1
fi

# ---------------------------------------------------------------------------
# Scenario 3b: update stays read-only when probe reports current.
# ---------------------------------------------------------------------------
reset
seed_installed_current
printf '%s\n' "$marketplace_absent" > "$state/marketplace_list.json"
run_update > "$state/out"
grep -Fq "manager is current" "$state/out"
if grep -Fq "install --package-root" "$state/adapter.log"; then
  echo "update must not invoke adapter install when probe reports current" >&2
  cat "$state/adapter.log" >&2
  exit 1
fi
[ ! -s "$log" ] || {
  assert_no_codex_mutation
}

# Scenario 3c: update rejects mixed legacy state even when the manager
# fingerprint is already current.
reset
seed_installed_current
printf '%s\n' '{"installed":[{"pluginId":"superpowers@superpowers-manager","version":"1.0.0"},{"pluginId":"superpowers@superpowers-wrapper"}],"available":[]}' > "$state/plugin_list.json"
printf '%s\n' '{"marketplaces":[{"name":"superpowers-wrapper","root":"/legacy"}]}' > "$state/marketplace_list.json"
if run_update >"$state/out" 2>&1; then
  echo "current update must reject mixed legacy state" >&2
  exit 1
fi
grep -Fxq 'Then run: npx superpowers-manager install' "$state/out"
if grep -Eq '^build |^install ' "$state/adapter.log"; then
  echo "mixed legacy state must stop update before build or install" >&2
  cat "$state/adapter.log" >&2
  exit 1
fi
assert_no_codex_mutation

# ---------------------------------------------------------------------------
# Scenario 4: remove succeeds, add fails -> non-zero, recovery message names
# the current root AND the previous root; plugin add never attempted.
# ---------------------------------------------------------------------------
reset
printf '{"marketplaces":[{"name":"superpowers-manager","root":"%s"}]}\n' "$tmpdir/otherroot" > "$state/marketplace_list.json"
: > "$state/marketplace_add_fail"
expect_fail
grep -Fq "plugin marketplace add $pkg" "$state/out"
grep -Fq "$tmpdir/otherroot" "$state/out"
if grep -Fq "plugin add superpowers@superpowers-manager" "$log"; then
  echo "plugin add must not run after a failed marketplace add" >&2; exit 1
fi

# ---------------------------------------------------------------------------
# Scenario 5: malformed marketplace listing -> abort before any mutation.
# ---------------------------------------------------------------------------
reset
printf '%s\n' 'not json {{{' > "$state/marketplace_list.json"
expect_fail
if grep -Eq "marketplace (add|remove)|^plugin (add|remove)" "$log"; then
  echo "parse failure must abort before any mutation; log was:" >&2
  cat "$log" >&2
  exit 1
fi

# ---------------------------------------------------------------------------
# Scenario 6: plugin add refreshes nothing -> verification fails, no success.
# ---------------------------------------------------------------------------
reset
printf '%s\n' "$marketplace_absent" > "$state/marketplace_list.json"
: > "$state/plugin_add_noop"
expect_fail
grep -Fq "fingerprint is not detectable" "$state/out"
assert_install_tmp_empty
if grep -Fq "manager updated" "$state/out"; then
  echo "must not print success when the installed manager is undetectable" >&2; exit 1
fi

# ---------------------------------------------------------------------------
# Scenario 7: installed fingerprint stays stale -> install fails, no success,
# and any retry hint comes from the adapter result rather than hardcoded core
# text.
# ---------------------------------------------------------------------------
reset
printf '%s\n' "$marketplace_absent" > "$state/marketplace_list.json"
: > "$state/plugin_add_stale"
expect_fail
grep -Fq "does not match the prepared plugin" "$state/out"
grep -Fq "SUPERPOWERS_INSTALL_REFRESH_MODE=remove-add" "$state/out"
if grep -Fq "manager updated" "$state/out"; then
  echo "must not print success while stale" >&2; exit 1
fi

# ---------------------------------------------------------------------------
# Scenario 8: missing fingerprint replay hint also comes only from the adapter
# result.
# ---------------------------------------------------------------------------
reset
printf '%s\n' "$marketplace_absent" > "$state/marketplace_list.json"
: > "$state/plugin_add_noop"
expect_fail
grep -Fq "fingerprint is not detectable" "$state/out"
grep -Fq "verify with 'codex plugin list --json'" "$state/out"

# ---------------------------------------------------------------------------
# Scenario 8a: fingerprint inspection command failure is reported as an
# inspection failure, never as valid absence or success.
# ---------------------------------------------------------------------------
reset
printf '%s\n' "$marketplace_absent" > "$state/marketplace_list.json"
: > "$state/fingerprint_inspect_fail"
expect_fail
grep -Fq "fingerprint inspection" "$state/out"
if grep -Fq "fingerprint is not detectable" "$state/out" ||
   grep -Fq "manager updated" "$state/out"; then
  echo "unverifiable fingerprint state must not be reported as absence or success" >&2
  exit 1
fi

# ---------------------------------------------------------------------------
# Scenario 8b: malformed fingerprint inspection output is rejected by response
# validation and reported as an inspection failure, never as absence or success.
# ---------------------------------------------------------------------------
reset
printf '%s\n' "$marketplace_absent" > "$state/marketplace_list.json"
: > "$state/fingerprint_inspect_malformed"
expect_fail
grep -Fq "invalid adapter response" "$state/out"
grep -Fq "fingerprint inspection" "$state/out"
if grep -Fq "fingerprint is not detectable" "$state/out" ||
   grep -Fq "manager updated" "$state/out"; then
  echo "unverifiable fingerprint state must not be reported as absence or success" >&2
  exit 1
fi

# ---------------------------------------------------------------------------
# Scenario 9: remove-add refresh mode -> plugin remove between marketplace
# reconcile and plugin add; still only manager-scoped.
# ---------------------------------------------------------------------------
reset
printf '%s\n' "$marketplace_absent" > "$state/marketplace_list.json"
run_install SUPERPOWERS_INSTALL_REFRESH_MODE=remove-add > "$state/out"
list_line=$(line_of "plugin marketplace list")
add_line=$(line_of "plugin marketplace add $pkg")
rm_line=$(line_of "plugin remove superpowers@superpowers-manager")
pa_line=$(line_of "plugin add superpowers@superpowers-manager")
{ [ "$list_line" -lt "$add_line" ] && [ "$add_line" -lt "$rm_line" ] && [ "$rm_line" -lt "$pa_line" ]; } || {
  echo "remove-add order must be: marketplace reconcile, plugin remove, plugin add" >&2
  cat "$log" >&2
  exit 1
}
if grep -Fq "openai-curated" "$log"; then
  echo "remove-add mode must not touch openai-curated" >&2; exit 1
fi

# ---------------------------------------------------------------------------
# Scenario 10: invalid refresh mode -> ownership may be inspected, but no Codex
# mutation occurs.
# ---------------------------------------------------------------------------
reset
printf '%s\n' "$marketplace_absent" > "$state/marketplace_list.json"
expect_fail SUPERPOWERS_INSTALL_REFRESH_MODE=bogus
assert_no_codex_mutation

# ---------------------------------------------------------------------------
# Scenario 11: malformed generated provenance is remediated by install. Probe
# reports needs prepare, prepare replaces the bad tree, and mutation happens
# only after the regenerated candidate validates.
# ---------------------------------------------------------------------------
reset
printf '%s\n' "$marketplace_absent" > "$state/marketplace_list.json"
printf '%s\n' '{' > "$pkg/plugins/superpowers/.superpowers-upstream.json"
run_install > "$state/out"
grep -Fq "prepared v1.0.0" "$state/out"
grep -Fq "manager updated" "$state/out"
grep -Fq "install --package-root $pkg" "$state/adapter.log"
python3 - "$pkg/plugins/superpowers/.superpowers-upstream.json" <<'PY'
import json
import re
import sys

with open(sys.argv[1], encoding="utf-8") as handle:
    commit = json.load(handle)["commit"]
if not isinstance(commit, str) or re.fullmatch(r"[0-9a-fA-F]{40}", commit) is None:
    raise SystemExit("install did not replace malformed generated provenance")
PY

# ---------------------------------------------------------------------------
# Scenario 12: update follows the same malformed-provenance remediation path
# instead of aborting or incorrectly taking the current-state skip.
# ---------------------------------------------------------------------------
reset
printf '%s\n' "$marketplace_absent" > "$state/marketplace_list.json"
printf '%s\n' '{' > "$pkg/plugins/superpowers/.superpowers-upstream.json"
run_update > "$state/out"
grep -Fq "prepared v1.0.0" "$state/out"
grep -Fq "manager updated" "$state/out"
grep -Fq "install --package-root $pkg" "$state/adapter.log"

echo "test_install_commands: OK"
