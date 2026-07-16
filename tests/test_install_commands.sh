#!/bin/sh
set -eu

root=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)
tmpdir=$(mktemp -d)
trap 'rm -rf "$tmpdir"' EXIT INT TERM

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
git -C "$upstream" -c user.email=superpowers-wrapper@example.invalid -c user.name=superpowers-wrapper -c commit.gpgsign=false commit -m "fake upstream" >/dev/null
git -C "$upstream" -c user.email=superpowers-wrapper@example.invalid -c user.name=superpowers-wrapper -c tag.gpgsign=false tag -a v1.0.0 -m "fake release"

# --- Copied package root (simulates the npx-materialized package) ---
pkg="$tmpdir/pkg"
mkdir -p "$pkg/plugins/superpowers/.codex-plugin"
cp -R "$root/scripts" "$pkg/scripts"
cp -R "$root/config" "$pkg/config"
cp "$root/plugins/superpowers/.codex-plugin/plugin.template.json" "$pkg/plugins/superpowers/.codex-plugin/plugin.template.json"
test -x "$pkg/scripts/install" || { echo "install must remain executable in the packaged root" >&2; exit 1; }

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
fake_codex="$tmpdir/codex"
log="$state/codex.log"
cat > "$fake_codex" <<'EOF'
#!/bin/sh
state=$(CDPATH= cd -- "$(dirname "$0")" && pwd)/state
printf '%s\n' "$*" >> "$state/codex.log"

if [ "$1" = plugin ] && [ "$2" = marketplace ] && [ "$3" = list ]; then
  rc=0; [ -f "$state/marketplace_list.rc" ] && rc=$(cat "$state/marketplace_list.rc")
  cat "$state/marketplace_list.json"
  exit "$rc"
fi
if [ "$1" = plugin ] && [ "$2" = list ]; then
  rc=0; [ -f "$state/plugin_list.rc" ] && rc=$(cat "$state/plugin_list.rc")
  cat "$state/plugin_list.json"
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
  [ -f "$state/plugin_add_noop" ] && exit 0
  dest="$state/codex-home/plugins/cache/superpowers-manager/superpowers/1.0.0"
  mkdir -p "$dest"
  cp "$SPW_TEST_PKG_ROOT/plugins/superpowers/.superpowers-upstream.json" "$dest/.superpowers-upstream.json"
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

marketplace_absent='{"marketplaces":[{"name":"openai-curated","root":"/x"}]}'
plugin_absent='{"installed":[],"available":[]}'
manager_plugin='{"installed":[{"pluginId":"superpowers@superpowers-manager"}],"available":[]}'
legacy_plugin='{"installed":[{"pluginId":"superpowers@superpowers-wrapper"}],"available":[]}'
both_plugins='{"installed":[{"pluginId":"superpowers@superpowers-manager"},{"pluginId":"superpowers@superpowers-wrapper"}],"available":[]}'
legacy_marketplace='{"marketplaces":[{"name":"superpowers-wrapper","root":"/legacy"}]}'
both_marketplaces='{"marketplaces":[{"name":"superpowers-manager","root":"/manager"},{"name":"superpowers-wrapper","root":"/legacy"}]}'

reset() {
  rm -f "$state/marketplace_list.rc" "$state/marketplace_add_fail" \
        "$state/plugin_list.rc" "$state/plugin_add_noop" "$state/plugin_add_stale"
  rm -rf "$state/codex-home"
  printf '%s\n' "$plugin_absent" > "$state/plugin_list.json"
  : > "$log"
}

run_install() {
  env \
    SUPERPOWERS_CODEX="$fake_codex" \
    SUPERPOWERS_UPSTREAM_URL="$upstream" \
    SUPERPOWERS_INSTALLED_SEARCH_ROOT="$state/codex-home" \
    SPW_TEST_PKG_ROOT="$pkg" \
    "$@" \
    sh "$pkg/scripts/install"
}

run_update() {
  env \
    SUPERPOWERS_CODEX="$fake_codex" \
    SUPERPOWERS_UPSTREAM_URL="$upstream" \
    SUPERPOWERS_INSTALLED_SEARCH_ROOT="$state/codex-home" \
    SPW_TEST_PKG_ROOT="$pkg" \
    "$@" \
    sh "$pkg/scripts/update"
}

run_probe() {
  env \
    SUPERPOWERS_CODEX="$fake_codex" \
    SUPERPOWERS_UPSTREAM_URL="$upstream" \
    SUPERPOWERS_INSTALLED_SEARCH_ROOT="$state/codex-home" \
    SPW_TEST_PKG_ROOT="$pkg" \
    "$@" \
    sh "$pkg/scripts/probe" --porcelain
}

expect_fail() {
  if run_install "$@" >"$state/out" 2>&1; then
    echo "expected install to fail but it succeeded" >&2
    cat "$state/out" >&2
    exit 1
  fi
}

line_of() {
  grep -Fn "$1" "$log" | head -n1 | cut -d: -f1
}

assert_listings_only() {
  expected='plugin list --json
plugin marketplace list --json'
  actual=$(cat "$log")
  if [ "$actual" != "$expected" ]; then
    echo "expected exactly the two read-only listings; log was:" >&2
    cat "$log" >&2
    exit 1
  fi
}

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
assert_listings_only
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
assert_listings_only

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
grep -Fq "installed manager not detectable" "$state/out"
if grep -Fq "manager updated" "$state/out"; then
  echo "must not print success when the installed manager is undetectable" >&2; exit 1
fi

# ---------------------------------------------------------------------------
# Scenario 7: installed fingerprint stays stale -> install fails, no success.
# ---------------------------------------------------------------------------
reset
printf '%s\n' "$marketplace_absent" > "$state/marketplace_list.json"
: > "$state/plugin_add_stale"
expect_fail
grep -Fq "still stale" "$state/out"
if grep -Fq "manager updated" "$state/out"; then
  echo "must not print success while stale" >&2; exit 1
fi

# ---------------------------------------------------------------------------
# Scenario 8: remove-add refresh mode -> plugin remove between marketplace
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
# Scenario 9: invalid refresh mode -> fails before any codex call.
# ---------------------------------------------------------------------------
reset
printf '%s\n' "$marketplace_absent" > "$state/marketplace_list.json"
expect_fail SUPERPOWERS_INSTALL_REFRESH_MODE=bogus
if [ -s "$log" ]; then
  echo "invalid refresh mode must fail before any codex call" >&2; exit 1
fi

# ---------------------------------------------------------------------------
# Legacy-state safety: install/update fail after read-only identity discovery;
# probe exposes all four exact states without mutation.
# ---------------------------------------------------------------------------
for fixtures in legacy both; do
  reset
  if [ "$fixtures" = legacy ]; then
    printf '%s\n' "$legacy_plugin" > "$state/plugin_list.json"
    printf '%s\n' "$legacy_marketplace" > "$state/marketplace_list.json"
  else
    printf '%s\n' "$both_plugins" > "$state/plugin_list.json"
    printf '%s\n' "$both_marketplaces" > "$state/marketplace_list.json"
  fi
  expect_fail
  grep -Fq "Legacy superpowers-wrapper Codex state is installed." "$state/out"
  assert_listings_only
done

reset
printf '%s\n' "$legacy_plugin" > "$state/plugin_list.json"
printf '%s\n' "$legacy_marketplace" > "$state/marketplace_list.json"
if run_update >"$state/out" 2>&1; then
  echo "expected update to fail for legacy state" >&2
  exit 1
fi
grep -Fq "Legacy superpowers-wrapper Codex state is installed." "$state/out"
assert_listings_only

assert_probe_state() {
  expected="$1"
  plugins="$2"
  marketplaces="$3"
  reset
  printf '%s\n' "$plugins" > "$state/plugin_list.json"
  printf '%s\n' "$marketplaces" > "$state/marketplace_list.json"
  output=$(run_probe)
  test "$(printf '%s\n' "$output" | awk -F= '$1 == "identity_state" { print $2 }')" = "$expected"
  assert_listings_only
}

assert_probe_state neither "$plugin_absent" "$marketplace_absent"
assert_probe_state manager "$manager_plugin" "$marketplace_absent"
assert_probe_state legacy "$legacy_plugin" "$legacy_marketplace"
assert_probe_state both "$both_plugins" "$both_marketplaces"

echo "test_install_commands: OK"
