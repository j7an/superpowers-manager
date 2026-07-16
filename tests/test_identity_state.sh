#!/bin/sh
set -eu

root=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)
. "$root/scripts/lib.sh"

tmpdir=$(mktemp -d)
trap 'rm -rf "$tmpdir"' EXIT INT TERM

fake_codex="$tmpdir/codex"
cat > "$fake_codex" <<'EOF'
#!/bin/sh
state=$(CDPATH= cd -- "$(dirname "$0")" && pwd)
if [ "$1" = plugin ] && [ "$2" = list ]; then
  rc=0; [ -f "$state/plugin.rc" ] && rc=$(cat "$state/plugin.rc")
  cat "$state/plugin.json"
  exit "$rc"
fi
if [ "$1" = plugin ] && [ "$2" = marketplace ] && [ "$3" = list ]; then
  rc=0; [ -f "$state/marketplace.rc" ] && rc=$(cat "$state/marketplace.rc")
  cat "$state/marketplace.json"
  exit "$rc"
fi
exit 1
EOF
chmod +x "$fake_codex"

manager_plugin='{"installed":[{"pluginId":"superpowers@superpowers-manager"}],"available":[]}'
legacy_plugin='{"installed":[{"pluginId":"superpowers@superpowers-wrapper"}],"available":[]}'
both_plugins='{"installed":[{"pluginId":"superpowers@superpowers-manager"},{"pluginId":"superpowers@superpowers-wrapper"}],"available":[]}'
no_plugins='{"installed":[],"available":[]}'
manager_marketplace='{"marketplaces":[{"name":"superpowers-manager","root":"/manager"}]}'
legacy_marketplace='{"marketplaces":[{"name":"superpowers-wrapper","root":"/legacy"}]}'
both_marketplaces='{"marketplaces":[{"name":"superpowers-manager","root":"/manager"},{"name":"superpowers-wrapper","root":"/legacy"}]}'
no_marketplaces='{"marketplaces":[]}'

assert_state() {
  expected="$1"
  plugins="$2"
  marketplaces="$3"
  printf '%s\n' "$plugins" > "$tmpdir/plugin.json"
  printf '%s\n' "$marketplaces" > "$tmpdir/marketplace.json"
  snapshot=$(spw_codex_identity_snapshot "$fake_codex")
  actual=$(spw_snapshot_get "$snapshot" identity_state)
  if [ "$actual" != "$expected" ]; then
    echo "identity state was $actual, expected $expected" >&2
    printf '%s\n' "$snapshot" >&2
    exit 1
  fi
}

# Either half of an identity family is sufficient, and combinations collapse
# to the four externally visible states.
assert_state manager "$manager_plugin" "$no_marketplaces"
assert_state manager "$no_plugins" "$manager_marketplace"
assert_state legacy "$legacy_plugin" "$no_marketplaces"
assert_state legacy "$no_plugins" "$legacy_marketplace"
assert_state both "$both_plugins" "$no_marketplaces"
assert_state both "$no_plugins" "$both_marketplaces"
assert_state both "$manager_plugin" "$legacy_marketplace"
assert_state both "$legacy_plugin" "$manager_marketplace"
assert_state neither "$no_plugins" "$no_marketplaces"

assert_snapshot_fails() {
  plugins="$1"
  marketplaces="$2"
  printf '%s\n' "$plugins" > "$tmpdir/plugin.json"
  printf '%s\n' "$marketplaces" > "$tmpdir/marketplace.json"
  if (spw_codex_identity_snapshot "$fake_codex") >"$tmpdir/out" 2>&1; then
    echo "malformed Codex listing must fail" >&2
    exit 1
  fi
}

assert_snapshot_fails '{"installed":[42]}' "$no_marketplaces"
assert_snapshot_fails '{"installed":[{}]}' "$no_marketplaces"
assert_snapshot_fails '{"installed":[{"pluginId":42}]}' "$no_marketplaces"
assert_snapshot_fails '{"installed":[{"pluginId":""}]}' "$no_marketplaces"
assert_snapshot_fails "$no_plugins" '{"marketplaces":[42]}'
assert_snapshot_fails "$no_plugins" '{"marketplaces":[{}]}'
assert_snapshot_fails "$no_plugins" '{"marketplaces":[{"name":42}]}'
assert_snapshot_fails "$no_plugins" '{"marketplaces":[{"name":""}]}'
assert_snapshot_fails 'not json {{{' "$no_marketplaces"
assert_snapshot_fails "$no_plugins" 'not json {{{'

printf '1\n' > "$tmpdir/plugin.rc"
assert_snapshot_fails "$no_plugins" "$no_marketplaces"
rm -f "$tmpdir/plugin.rc"
printf '1\n' > "$tmpdir/marketplace.rc"
assert_snapshot_fails "$no_plugins" "$no_marketplaces"
rm -f "$tmpdir/marketplace.rc"

legacy_message='Legacy superpowers-wrapper Codex state is installed.'
legacy_uninstall='Run: npx superpowers-wrapper@0.1.1 uninstall'
manager_install='Then run: npx superpowers-manager@0.1.2 install'

for state in legacy both; do
  if (spw_require_no_legacy_state "$state") >"$tmpdir/out" 2>&1; then
    echo "legacy state $state must fail" >&2
    exit 1
  fi
  grep -Fxq "$legacy_message" "$tmpdir/out"
  grep -Fxq "$legacy_uninstall" "$tmpdir/out"
  grep -Fxq "$manager_install" "$tmpdir/out"
done
spw_require_no_legacy_state neither
spw_require_no_legacy_state manager

# Coexistence regression: a legacy cache may be traversed before the manager cache,
# but installed-file discovery must return only manager-owned artifacts.
legacy_cache="$tmpdir/cache/plugins/cache/superpowers-wrapper/superpowers/1.0.0"
manager_cache="$tmpdir/cache/plugins/cache/superpowers-manager/superpowers/1.0.0"
mkdir -p "$legacy_cache/.codex-plugin" "$manager_cache/.codex-plugin"
: > "$legacy_cache/.superpowers-upstream.json"
: > "$manager_cache/.superpowers-upstream.json"
: > "$legacy_cache/.codex-plugin/plugin.json"
: > "$manager_cache/.codex-plugin/plugin.json"
test "$(SUPERPOWERS_INSTALLED_SEARCH_ROOT="$tmpdir/cache" spw_find_installed_metadata)" = "$manager_cache/.superpowers-upstream.json"
test "$(SUPERPOWERS_INSTALLED_SEARCH_ROOT="$tmpdir/cache" spw_find_installed_manifest)" = "$manager_cache/.codex-plugin/plugin.json"

legacy_only="$tmpdir/legacy-only/plugins/cache/superpowers-wrapper/superpowers/1.0.0"
mkdir -p "$legacy_only/.codex-plugin"
: > "$legacy_only/.superpowers-upstream.json"
: > "$legacy_only/.codex-plugin/plugin.json"
test -z "$(SUPERPOWERS_INSTALLED_SEARCH_ROOT="$tmpdir/legacy-only" spw_find_installed_metadata)"
test -z "$(SUPERPOWERS_INSTALLED_SEARCH_ROOT="$tmpdir/legacy-only" spw_find_installed_manifest)"

echo "test_identity_state: OK"
