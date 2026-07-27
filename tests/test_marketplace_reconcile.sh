#!/bin/sh
set -eu

test_dir=$(CDPATH= cd -- "$(dirname "$0")" && pwd)
. "$test_dir/lib/harness.sh"
spw_test_root
. "$root/scripts/core/common.sh"
. "$root/scripts/core/provenance.sh"
. "$root/scripts/core/status.sh"
. "$root/scripts/core/lifecycle.sh"
. "$root/scripts/core/adapter.sh"
spw_test_tmpdir

# The legacy core reconciliation helper must stay deleted: reconciliation is an
# adapter-owned behavior and tests below exercise the shipped adapter directly.
if command -v spw_reconcile_marketplace >/dev/null 2>&1; then
  echo "dead core reconciliation helper must not remain defined" >&2
  exit 1
fi

# --- shipped Codex adapter marketplace reconciliation ---
# Record every fake Codex invocation so reconciliation assertions cover the
# exact command order and ensure only the manager marketplace can be mutated.
fake_log="$tmpdir/codex-commands.log"
fake_codex="$tmpdir/fake-codex"
mkdir -p "$tmpdir/requested"
cat > "$fake_codex" <<'SH'
#!/bin/sh
set -eu
printf '%s\n' "$*" >> "$FAKE_CODEX_LOG"

if [ "$1 $2 $3" = "plugin marketplace list" ] && [ "$4" = "--json" ]; then
  if [ "${FAKE_CODEX_LIST_EXIT:-0}" -ne 0 ]; then
    exit "$FAKE_CODEX_LIST_EXIT"
  fi
  if [ "${FAKE_CODEX_LIST_INVALID_UTF8:-0}" -ne 0 ]; then
    printf '%s\377%s\n' \
      '{"marketplaces":[{"name":"openai-' \
      'curated","root":"/other"}]}'
    exit 0
  fi
  if [ -n "${FAKE_CODEX_LIST_OUTPUT+x}" ]; then
    printf '%s\n' "$FAKE_CODEX_LIST_OUTPUT"
  else
    printf '%s\n' '{"marketplaces":[]}'
  fi
  exit 0
fi
if [ "$1 $2 $3" = "plugin list --json" ]; then
  printf '%s\n' "${FAKE_CODEX_PLUGIN_LIST_OUTPUT:?}"
  exit 0
fi
if [ "$1 $2 $3" = "plugin marketplace add" ]; then
  exit "${FAKE_CODEX_ADD_EXIT:-0}"
fi
if [ "$1 $2 $3" = "plugin marketplace remove" ]; then
  exit "${FAKE_CODEX_REMOVE_EXIT:-0}"
fi
if [ "$1 $2" = "plugin add" ]; then
  exit 0
fi
if [ "$1 $2" = "plugin remove" ]; then
  exit 0
fi
echo "unexpected fake Codex command: $*" >&2
exit 99
SH
chmod +x "$fake_codex"
export FAKE_CODEX_LOG="$fake_log"
SUPERPOWERS_CODEX="$fake_codex"
export SUPERPOWERS_CODEX

# BASELINE CASE: UNINSTALL-TARGETS-01 adapter removes only manager resources
: > "$fake_log"
SPW_ADAPTER="$root/scripts/adapters/codex/adapter" \
SUPERPOWERS_CODEX="$fake_codex" \
  spw_adapter_uninstall "$tmpdir/uninstall-result.json" true true >/dev/null
test "$(cat "$fake_log")" = "plugin remove superpowers@superpowers-manager
plugin marketplace remove superpowers-manager"

assert_exact_commands() {
  expected="$1"
  actual=$(grep '^plugin marketplace ' "$fake_log" || true)
  [ "$actual" = "$expected" ] || {
    echo "unexpected Codex commands:" >&2
    printf 'expected:\n%s\nactual:\n%s\n' "$expected" "$actual" >&2
    exit 1
  }
}

assert_no_mutation() {
  if grep -Eq '^plugin marketplace (add|remove) ' "$fake_log"; then
    echo "reconciliation mutated marketplaces after a list/parse failure" >&2
    cat "$fake_log" >&2
    exit 1
  fi
}

run_shipped_install() {
  result="$tmpdir/adapter-result.json"
  rm -f "$result" "$result.response"
  SPW_ADAPTER="$root/scripts/adapters/codex/adapter" \
  SUPERPOWERS_CODEX="$fake_codex" \
    spw_adapter_install "$result" "$tmpdir/requested"
}

assert_reconcile_fails_without_mutation() {
  label="$1"
  : > "$fake_log"
  if (run_shipped_install) >"$tmpdir/$label.out" 2>&1; then
    echo "$label must fail" >&2
    exit 1
  fi
  assert_exact_commands "plugin marketplace list --json"
  assert_no_mutation
}

FAKE_CODEX_LIST_EXIT=17
export FAKE_CODEX_LIST_EXIT
assert_reconcile_fails_without_mutation list-command-failure
unset FAKE_CODEX_LIST_EXIT

FAKE_CODEX_LIST_OUTPUT='not json {{{'
export FAKE_CODEX_LIST_OUTPUT
assert_reconcile_fails_without_mutation malformed-json
FAKE_CODEX_LIST_INVALID_UTF8=1
export FAKE_CODEX_LIST_INVALID_UTF8
assert_reconcile_fails_without_mutation invalid-utf8-json
unset FAKE_CODEX_LIST_INVALID_UTF8
FAKE_CODEX_LIST_OUTPUT='{"unexpected":[]}'
assert_reconcile_fails_without_mutation schema-invalid-json
FAKE_CODEX_LIST_OUTPUT='{"marketplaces":[{"name":"superpowers-manager","root":""}]}'
assert_reconcile_fails_without_mutation empty-root-json
FAKE_CODEX_LIST_OUTPUT='{"marketplaces":[{"name":"superpowers-manager"}]}'
assert_reconcile_fails_without_mutation missing-manager-root-json
FAKE_CODEX_LIST_OUTPUT='{"marketplaces":[{"name":"superpowers-manager","root":17}]}'
assert_reconcile_fails_without_mutation invalid-manager-root-json
for invalid_item_case in \
  'non-object-item|{"marketplaces":["openai-curated"]}' \
  'missing-name|{"marketplaces":[{"root":"/other"}]}' \
  'renamed-name|{"marketplaces":[{"marketplaceName":"openai-curated","root":"/other"}]}' \
  'empty-name|{"marketplaces":[{"name":"","root":"/other"}]}' \
  'invalid-name|{"marketplaces":[{"name":17,"root":"/other"}]}' \
  'malformed-after-manager|{"marketplaces":[{"name":"superpowers-manager","root":"/registered"},{"root":"/other"}]}'
do
  label=${invalid_item_case%%|*}
  FAKE_CODEX_LIST_OUTPUT=${invalid_item_case#*|}
  assert_reconcile_fails_without_mutation "$label"
done

for unrelated_root_case in \
  '{"marketplaces":[{"name":"openai-curated"}]}' \
  '{"marketplaces":[{"name":"openai-curated","root":17}]}'
do
  FAKE_CODEX_LIST_OUTPUT=$unrelated_root_case
  : > "$fake_log"
  run_shipped_install >/dev/null
  assert_exact_commands "plugin marketplace list --json
plugin marketplace add $tmpdir/requested"
done

FAKE_CODEX_LIST_OUTPUT='{"marketplaces":[{"name":"openai-curated","root":"/other"}]}'
: > "$fake_log"
run_shipped_install >/dev/null
assert_exact_commands "plugin marketplace list --json
plugin marketplace add $tmpdir/requested"
! grep -Fq openai-curated "$fake_log"

mkdir -p "$tmpdir/registered-root"
ln -s "$tmpdir/registered-root" "$tmpdir/registered-root-link"
FAKE_CODEX_LIST_OUTPUT=$(printf '{"marketplaces":[{"name":"openai-curated","root":"/other"},{"name":"superpowers-manager","root":"%s"}]}' "$tmpdir/registered-root-link")
: > "$fake_log"
result="$tmpdir/adapter-result.json"
SPW_ADAPTER="$root/scripts/adapters/codex/adapter" SUPERPOWERS_CODEX="$fake_codex" \
  spw_adapter_install "$result" "$tmpdir/registered-root" >/dev/null
assert_exact_commands "plugin marketplace list --json"
assert_no_mutation

mkdir -p "$tmpdir/old-root" "$tmpdir/new-root"
FAKE_CODEX_LIST_OUTPUT=$(printf '{"marketplaces":[{"name":"openai-curated","root":"/other"},{"name":"superpowers-manager","root":"%s"}]}' "$tmpdir/old-root")
: > "$fake_log"
result="$tmpdir/adapter-result.json"
SPW_ADAPTER="$root/scripts/adapters/codex/adapter" SUPERPOWERS_CODEX="$fake_codex" \
  spw_adapter_install "$result" "$tmpdir/new-root" >/dev/null
assert_exact_commands "plugin marketplace list --json
plugin marketplace remove superpowers-manager
plugin marketplace add $tmpdir/new-root"
! grep -Fq openai-curated "$fake_log"

FAKE_CODEX_ADD_EXIT=23
export FAKE_CODEX_ADD_EXIT
: > "$fake_log"
if (SPW_ADAPTER="$root/scripts/adapters/codex/adapter" SUPERPOWERS_CODEX="$fake_codex" \
  spw_adapter_install "$tmpdir/adapter-result.json" "$tmpdir/new-root") >"$tmpdir/failed-add.out" 2>&1; then
  echo "failed re-add must return nonzero" >&2
  exit 1
fi
unset FAKE_CODEX_ADD_EXIT
assert_exact_commands "plugin marketplace list --json
plugin marketplace remove superpowers-manager
plugin marketplace add $tmpdir/new-root"
grep -Fq "$tmpdir/old-root" "$tmpdir/failed-add.out"
grep -Fq "$tmpdir/new-root" "$tmpdir/failed-add.out"
grep -Fq "recover with:" "$tmpdir/failed-add.out"

FAKE_CODEX_REMOVE_EXIT=29
export FAKE_CODEX_REMOVE_EXIT
: > "$fake_log"
if (SPW_ADAPTER="$root/scripts/adapters/codex/adapter" SUPERPOWERS_CODEX="$fake_codex" \
  spw_adapter_install "$tmpdir/adapter-result.json" "$tmpdir/new-root") >"$tmpdir/failed-remove.out" 2>&1; then
  echo "failed remove must return nonzero" >&2
  exit 1
fi
unset FAKE_CODEX_REMOVE_EXIT
assert_exact_commands "plugin marketplace list --json
plugin marketplace remove superpowers-manager"
if grep -Fq "plugin marketplace add" "$fake_log"; then
  echo "add must not follow a failed marketplace remove" >&2
  exit 1
fi

# A failed/missing ownership result must never be treated as absence.
invalid_ownership="$tmpdir/invalid-ownership.json"
printf '%s\n' '{}' > "$invalid_ownership"
if (spw_verify_uninstalled_resources "$invalid_ownership") >"$tmpdir/invalid-ownership.out" 2>&1; then
  echo "malformed ownership result must fail closed" >&2
  exit 1
fi

# BASELINE CASE: UNINSTALL-VERIFY-01 both manager resources must be absent
for remaining in plugin marketplace; do
  case "$remaining" in
    plugin)
      resources='{"plugin":true,"marketplace":false}'
      residual_message='owned plugin resource is still installed after removal'
      ;;
    marketplace)
      resources='{"plugin":false,"marketplace":true}'
      residual_message='owned marketplace resource is still registered after removal'
      ;;
  esac
  printf '%s\n' \
    "{\"view\":\"ownership\",\"resources\":$resources,\"legacy_resources\":{\"plugin\":false,\"marketplace\":false},\"identity_state\":\"manager\"}" \
    > "$tmpdir/remaining-$remaining.json"
  if (spw_verify_uninstalled_resources "$tmpdir/remaining-$remaining.json") \
      >"$tmpdir/remaining-$remaining.out" 2>&1; then
    echo "remaining $remaining resource must fail uninstall verification" >&2
    exit 1
  fi
  grep -Fq "$residual_message" "$tmpdir/remaining-$remaining.out"
done
printf '%s\n' \
  '{"view":"ownership","resources":{"plugin":false,"marketplace":false},"legacy_resources":{"plugin":true,"marketplace":true},"identity_state":"legacy"}' \
  > "$tmpdir/uninstalled.json"
spw_verify_uninstalled_resources "$tmpdir/uninstalled.json"

# BASELINE CASE: INSTALL-VERIFY-01 installed fingerprint proof and hints
# --- spw_verify_installed_fingerprint: compares the installed fingerprint to
# the desired commit and replays only optional adapter-provided hints.
desired="abcdef0123456789abcdef0123456789abcdef01"
installed_root="$tmpdir/codex/plugins/cache/superpowers-manager/superpowers/1.0.0"
mkdir -p "$installed_root"
cat > "$installed_root/.superpowers-upstream.json" <<EOF
{"commit":"$desired"}
EOF
FAKE_CODEX_PLUGIN_LIST_OUTPUT='{"installed":[{"pluginId":"superpowers@superpowers-manager","version":"1.0.0"}]}'
export FAKE_CODEX_PLUGIN_LIST_OUTPUT
SUPERPOWERS_INSTALLED_SEARCH_ROOT="$tmpdir/codex"
export SUPERPOWERS_INSTALLED_SEARCH_ROOT
install_result="$tmpdir/install-result.json"
inspect_result="$tmpdir/inspect-result.json"
cat > "$install_result" <<'EOF'
{"verification_hints":{"mismatch":"adapter mismatch hint","missing":"adapter missing hint"}}
EOF
out=$(spw_verify_installed_fingerprint "$desired" "$install_result" "$inspect_result")
printf '%s\n' "$out" | grep -Fq "manager updated"
printf '%s\n' "$out" | grep -Fq "installed_commit=$desired"

printf '%s\n' "{\"commit\":\"$(printf '%s' "$desired" | cut -c 1-7)\"}" \
  > "$installed_root/.superpowers-upstream.json"
out=$(spw_verify_installed_fingerprint "$desired" "$install_result" "$inspect_result")
printf '%s\n' "$out" | grep -Fq "manager updated"
printf '%s\n' "$out" | grep -Fq "installed_commit=$(printf '%s' "$desired" | cut -c 1-7)"
printf '%s\n' "{\"commit\":\"$desired\"}" \
  > "$installed_root/.superpowers-upstream.json"

if (spw_verify_installed_fingerprint "1111111111111111111111111111111111111111" "$install_result" "$inspect_result") >"$tmpdir/stale.out" 2>&1; then
  echo "stale installed metadata must fail" >&2; exit 1
fi
grep -Fq "does not match the prepared plugin" "$tmpdir/stale.out"
grep -Fq "adapter mismatch hint" "$tmpdir/stale.out"

rm -rf "$tmpdir/codex"
FAKE_CODEX_PLUGIN_LIST_OUTPUT='{"installed":[]}'
if (spw_verify_installed_fingerprint "$desired" "$install_result" "$inspect_result") >"$tmpdir/undetectable.out" 2>&1; then
  echo "undetectable installed metadata must fail" >&2; exit 1
fi
grep -Fq "fingerprint is not detectable" "$tmpdir/undetectable.out"
grep -Fq "adapter missing hint" "$tmpdir/undetectable.out"
if grep -Fq "manager updated" "$tmpdir/undetectable.out"; then
  echo "undetectable installed metadata must not print success" >&2; exit 1
fi

spw_inspect_fingerprint() {
  printf '%s\n' '{' > "$1"
}
if spw_verify_installed_fingerprint "$desired" "$install_result" "$inspect_result" \
  > "$tmpdir/malformed-inspection.out" 2>&1; then
  echo "malformed fingerprint inspection result must fail" >&2
  exit 1
fi
grep -Fq "parse" "$tmpdir/malformed-inspection.out"
if grep -Fq "fingerprint is not detectable" "$tmpdir/malformed-inspection.out" ||
   grep -Fq "manager updated" "$tmpdir/malformed-inspection.out"; then
  echo "malformed fingerprint result must not be reported as absence or success" >&2
  exit 1
fi

echo "test_marketplace_reconcile: OK"
