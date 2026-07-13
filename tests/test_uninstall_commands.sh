#!/bin/sh
set -eu

root=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)
tmpdir=$(mktemp -d)
trap 'rm -rf "$tmpdir"' EXIT INT TERM

if grep -Fq 'scripts/adapters/codex/lib.sh' "$root/scripts/uninstall"; then
  echo "public uninstall must not source the Codex adapter library" >&2
  exit 1
fi
if grep -Eq 'SPW_PLUGIN_ID|SPW_MARKETPLACE_NAME' "$root/scripts/core/lifecycle.sh"; then
  echo "shared lifecycle code must not reference Codex-owned identifiers" >&2
  exit 1
fi

state="$tmpdir/state"
mkdir -p "$state"
uninstall_tmp="$tmpdir/uninstall-tmp"
mkdir -p "$uninstall_tmp"
fake_codex="$tmpdir/codex"
recording_adapter="$tmpdir/adapter"
log="$state/codex.log"
adapter_log="$state/adapter.log"

# Fake codex. Dispatches on argv; state files live next to the binary.
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
if [ "$1" = plugin ] && [ "$2" = remove ]; then
  if [ -f "$state/remove_noop" ]; then
    :
  elif [ -f "$state/remove_plugin_missing_installed" ]; then
    printf '%s\n' '{"available":[]}' > "$state/plugin_list.json"
  else
    printf '%s\n' '{"installed":[],"available":[]}' > "$state/plugin_list.json"
  fi
  exit 0
fi
if [ "$1" = plugin ] && [ "$2" = marketplace ] && [ "$3" = remove ]; then
  if [ -f "$state/remove_marketplace_fail" ]; then
    printf '%s\n' 'marketplace remove exploded' >&2
    exit 1
  fi
  [ -f "$state/remove_noop" ] || printf '%s\n' '{"marketplaces":[{"name":"openai-curated","root":"/x"}]}' > "$state/marketplace_list.json"
  exit 0
fi
exit 0
EOF
chmod +x "$fake_codex"

cat > "$recording_adapter" <<EOF
#!/bin/sh
state="$state"
printf '%s\n' "\$*" >> "\$state/adapter.log"
exec "$root/scripts/adapters/codex/adapter" "\$@"
EOF
chmod +x "$recording_adapter"

plugin_present='{"installed":[{"pluginId":"superpowers@superpowers-wrapper","name":"superpowers","marketplaceName":"superpowers-wrapper"}],"available":[]}'
plugin_absent='{"installed":[],"available":[]}'
marketplace_present='{"marketplaces":[{"name":"openai-curated","root":"/x"},{"name":"superpowers-wrapper","root":"/y"}]}'
marketplace_absent='{"marketplaces":[{"name":"openai-curated","root":"/x"}]}'

reset() {
  rm -f "$state/plugin_list.rc" "$state/marketplace_list.rc" "$state/remove_noop" \
    "$state/remove_plugin_missing_installed" "$state/remove_marketplace_fail"
  : > "$log"
  : > "$adapter_log"
}

run_uninstall() {
  TMPDIR="$uninstall_tmp" SPW_ADAPTER="$recording_adapter" SUPERPOWERS_CODEX="$fake_codex" sh "$root/scripts/uninstall"
}

expect_fail() {
  if TMPDIR="$uninstall_tmp" SPW_ADAPTER="$recording_adapter" SUPERPOWERS_CODEX="$fake_codex" sh "$root/scripts/uninstall" >"$state/out" 2>&1; then
    echo "expected uninstall to fail but it succeeded" >&2
    cat "$state/out" >&2
    exit 1
  fi
}

assert_uninstall_tmp_empty() {
  if find "$uninstall_tmp" -mindepth 1 -print | grep -q .; then
    echo "uninstall leaked its invocation workspace or adapter sidecars" >&2
    find "$uninstall_tmp" -mindepth 1 -print >&2
    exit 1
  fi
}

assert_output_contains() {
  if ! grep -Fq "$1" "$state/out"; then
    echo "expected output to contain: $1" >&2
    cat "$state/out" >&2
    exit 1
  fi
}

assert_no_removes() {
  if grep -Fq "remove" "$log"; then
    echo "expected no remove commands; log was:" >&2
    cat "$log" >&2
    exit 1
  fi
}

line_of() {
  grep -Fn "$1" "$2" | head -n1 | cut -d: -f1
}

# --- Scenario 0: missing python3 -> clear requirement error, no Codex calls ---
reset
printf '%s\n' "$plugin_present" > "$state/plugin_list.json"
printf '%s\n' "$marketplace_present" > "$state/marketplace_list.json"
mkdir -p "$state/no_python_path"
ln -sf /usr/bin/dirname "$state/no_python_path/dirname"
if PATH="$state/no_python_path" SUPERPOWERS_CODEX="$fake_codex" /bin/sh "$root/scripts/uninstall" >"$state/out" 2>&1; then
  echo "expected uninstall to fail when python3 is missing" >&2
  cat "$state/out" >&2
  exit 1
fi
if ! grep -Fq "required command not found: python3" "$state/out"; then
  echo "expected a clear python3 requirement error; output was:" >&2
  cat "$state/out" >&2
  exit 1
fi
if [ -s "$log" ]; then
  echo "expected no Codex calls when python3 is missing; log was:" >&2
  cat "$log" >&2
  exit 1
fi

# --- Scenario 0b: missing Codex is reported by the invoked ownership adapter
# as a controlled inspect failure, not short-circuited by public core code. ---
reset
printf '%s\n' "$plugin_present" > "$state/plugin_list.json"
printf '%s\n' "$marketplace_present" > "$state/marketplace_list.json"
missing_codex="$tmpdir/missing-codex"
if SPW_ADAPTER="$recording_adapter" SUPERPOWERS_CODEX="$missing_codex" \
  sh "$root/scripts/uninstall" >"$state/out" 2>&1; then
  echo "expected uninstall to fail when Codex is missing" >&2
  cat "$state/out" >&2
  exit 1
fi
grep -Fxq "inspect --view ownership" "$adapter_log"
grep -Fxq "error: required Codex command not found: $missing_codex" "$state/out"
if grep -Fq "error: invalid adapter response:" "$state/out"; then
  echo "missing Codex must remain a controlled ownership-inspect failure" >&2
  cat "$state/out" >&2
  exit 1
fi

# --- Scenario 1: both present -> both removed, plugin before marketplace,
#     openai-curated never named ---
reset
printf '%s\n' "$plugin_present" > "$state/plugin_list.json"
printf '%s\n' "$marketplace_present" > "$state/marketplace_list.json"
run_uninstall >/dev/null
assert_uninstall_tmp_empty
grep -Fxq "inspect --view ownership" "$adapter_log"
grep -Fxq "uninstall --plugin-present true --marketplace-present true" "$adapter_log"
[ "$(grep -Fc "inspect --view ownership" "$adapter_log")" -eq 2 ]
[ "$(grep -Fc "uninstall --plugin-present true --marketplace-present true" "$adapter_log")" -eq 1 ]
first_inspect_line=$(line_of "inspect --view ownership" "$adapter_log")
uninstall_line=$(line_of "uninstall --plugin-present true --marketplace-present true" "$adapter_log")
second_inspect_line=$(grep -Fn "inspect --view ownership" "$adapter_log" | tail -n1 | cut -d: -f1)
[ "$first_inspect_line" -lt "$uninstall_line" ] || { echo "ownership inspect must precede adapter uninstall" >&2; exit 1; }
[ "$uninstall_line" -lt "$second_inspect_line" ] || { echo "ownership re-inspect must follow adapter uninstall" >&2; exit 1; }
grep -Fq "plugin remove superpowers@superpowers-wrapper" "$log"
grep -Fq "plugin marketplace remove superpowers-wrapper" "$log"
rm_line=$(line_of "plugin remove superpowers@superpowers-wrapper" "$log")
mp_line=$(line_of "plugin marketplace remove superpowers-wrapper" "$log")
[ "$rm_line" -lt "$mp_line" ] || { echo "plugin remove must precede marketplace remove" >&2; exit 1; }
if grep -Fq "openai-curated" "$log"; then
  echo "uninstall must never name openai-curated" >&2
  exit 1
fi
if grep -Fq "other@x" "$adapter_log"; then
  echo "adapter uninstall must receive booleans, not unrelated provider names" >&2
  exit 1
fi

# --- Scenario 2: plugin absent, marketplace present -> only marketplace removed ---
reset
printf '%s\n' "$plugin_absent" > "$state/plugin_list.json"
printf '%s\n' "$marketplace_present" > "$state/marketplace_list.json"
out=$(run_uninstall)
if grep -Fq "plugin remove superpowers@superpowers-wrapper" "$log"; then
  echo "must not remove an absent plugin" >&2
  exit 1
fi
grep -Fxq "uninstall --plugin-present false --marketplace-present true" "$adapter_log"
grep -Fq "plugin marketplace remove superpowers-wrapper" "$log"
printf '%s\n' "$out" | grep -Fq "plugin not installed; skipping"

# --- Scenario 3: both absent -> no removes, idempotent success, both skips ---
reset
printf '%s\n' "$plugin_absent" > "$state/plugin_list.json"
printf '%s\n' "$marketplace_absent" > "$state/marketplace_list.json"
out=$(run_uninstall)
assert_no_removes
grep -Fxq "uninstall --plugin-present false --marketplace-present false" "$adapter_log"
printf '%s\n' "$out" | grep -Fq "plugin not installed; skipping"
printf '%s\n' "$out" | grep -Fq "marketplace not registered; skipping"

# --- Scenario 5: plugin list query fails -> abort, no removes ---
reset
printf '%s\n' "$plugin_present" > "$state/plugin_list.json"
printf '%s\n' "$marketplace_present" > "$state/marketplace_list.json"
printf '1\n' > "$state/plugin_list.rc"
expect_fail
assert_uninstall_tmp_empty
if grep -Fq "uninstall --" "$adapter_log"; then
  echo "adapter uninstall must not run when ownership inspection fails" >&2
  cat "$adapter_log" >&2
  exit 1
fi
assert_no_removes

# --- Scenario 6: malformed plugin list JSON -> abort, no removes ---
reset
printf '%s\n' 'not json {{{' > "$state/plugin_list.json"
printf '%s\n' "$marketplace_present" > "$state/marketplace_list.json"
expect_fail
if grep -Fq "uninstall --" "$adapter_log"; then
  echo "adapter uninstall must not run on malformed ownership inspection" >&2
  cat "$adapter_log" >&2
  exit 1
fi
assert_no_removes

# --- Scenario 6b: malformed individual plugin entry -> abort, no removes ---
reset
printf '%s\n' '{"installed":[{}],"available":[]}' > "$state/plugin_list.json"
printf '%s\n' "$marketplace_present" > "$state/marketplace_list.json"
expect_fail
if grep -Fq "uninstall --" "$adapter_log"; then
  echo "adapter uninstall must not run on malformed individual plugin entries" >&2
  cat "$adapter_log" >&2
  exit 1
fi
assert_no_removes
assert_output_contains "cannot parse output of"

# --- Scenario 7: plugin PRESENT but marketplace list fails -> preflight must
#     abort before ANY remove (the plugin must NOT be removed) ---
reset
printf '%s\n' "$plugin_present" > "$state/plugin_list.json"
printf '%s\n' "$marketplace_present" > "$state/marketplace_list.json"
printf '1\n' > "$state/marketplace_list.rc"
expect_fail
if grep -Fq "uninstall --" "$adapter_log"; then
  echo "adapter uninstall must not run when marketplace ownership inspection fails" >&2
  cat "$adapter_log" >&2
  exit 1
fi
assert_no_removes

# --- Scenario 8b: malformed individual marketplace entry -> abort, no removes ---
reset
printf '%s\n' "$plugin_present" > "$state/plugin_list.json"
printf '%s\n' '{"marketplaces":[{}]}' > "$state/marketplace_list.json"
expect_fail
if grep -Fq "uninstall --" "$adapter_log"; then
  echo "adapter uninstall must not run on malformed individual marketplace entries" >&2
  cat "$adapter_log" >&2
  exit 1
fi
assert_no_removes
assert_output_contains "cannot parse output of"

# --- Scenario 8: plugin PRESENT but marketplace list is MALFORMED -> preflight
#     must abort before ANY remove. Same fail-closed guarantee as Scenario 7,
#     but reached via a parse error rather than a nonzero exit. ---
reset
printf '%s\n' "$plugin_present" > "$state/plugin_list.json"
printf '%s\n' 'not json {{{' > "$state/marketplace_list.json"
expect_fail
if grep -Fq "uninstall --" "$adapter_log"; then
  echo "adapter uninstall must not run on malformed marketplace ownership inspection" >&2
  cat "$adapter_log" >&2
  exit 1
fi
assert_no_removes

# --- Scenario 4: remove is a no-op (fixtures unchanged) -> verify-after must
#     detect the still-present target and fail ---
reset
printf '%s\n' "$plugin_present" > "$state/plugin_list.json"
printf '%s\n' "$marketplace_present" > "$state/marketplace_list.json"
: > "$state/remove_noop"   # removes are logged but do not mutate the fixtures
expect_fail
grep -Fxq "uninstall --plugin-present true --marketplace-present true" "$adapter_log"
if [ "$(grep -Fc "inspect --view ownership" "$adapter_log")" -ne 2 ]; then
  echo "verify-after must re-run ownership inspection after adapter uninstall" >&2
  cat "$adapter_log" >&2
  exit 1
fi
# the removal was attempted...
grep -Fq "plugin remove superpowers@superpowers-wrapper" "$log"
# ...but the plugin is still present on re-query, so uninstall must NOT succeed
assert_output_contains "still installed"

# --- Scenario 9: verify-after schema drift -> fail closed instead of reporting
#     success when the target array is missing from otherwise valid JSON ---
reset
printf '%s\n' "$plugin_present" > "$state/plugin_list.json"
printf '%s\n' "$marketplace_present" > "$state/marketplace_list.json"
: > "$state/remove_plugin_missing_installed"
expect_fail
grep -Fxq "uninstall --plugin-present true --marketplace-present true" "$adapter_log"
grep -Fq "plugin remove superpowers@superpowers-wrapper" "$log"
assert_output_contains "cannot parse output of"
if grep -Fq "uninstall complete" "$state/out"; then
  echo "must not report success when verify-after sees schema drift" >&2
  cat "$state/out" >&2
  exit 1
fi

# --- Scenario 10: plugin remove succeeds, marketplace remove fails -> adapter
#     must surface one controlled failure, replay the stderr, skip final core
#     success, and avoid unrelated mutation ---
reset
printf '%s\n' "$plugin_present" > "$state/plugin_list.json"
printf '%s\n' "$marketplace_present" > "$state/marketplace_list.json"
: > "$state/remove_marketplace_fail"
expect_fail
grep -Fxq "uninstall --plugin-present true --marketplace-present true" "$adapter_log"
grep -Fq "plugin remove superpowers@superpowers-wrapper" "$log"
grep -Fq "plugin marketplace remove superpowers-wrapper" "$log"
if grep -Fq "uninstall complete" "$state/out"; then
  echo "core must not print final success when marketplace removal fails" >&2
  cat "$state/out" >&2
  exit 1
fi
if grep -Fq "error: invalid adapter response:" "$state/out"; then
  echo "marketplace removal failure must be reported as one controlled adapter failure" >&2
  cat "$state/out" >&2
  exit 1
fi
grep -Fq "marketplace remove exploded" "$state/out"
grep -Fq "error: codex plugin marketplace remove failed for superpowers-wrapper" "$state/out"
if grep -Fq "openai-curated" "$log"; then
  echo "marketplace failure must not mutate unrelated providers" >&2
  cat "$log" >&2
  exit 1
fi

echo "test_uninstall_commands: OK"
