#!/bin/sh
set -eu

root=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)
tmpdir=$(mktemp -d)
trap 'rm -rf "$tmpdir"' EXIT INT TERM

state="$tmpdir/state"
mkdir -p "$state"
fake_codex="$tmpdir/codex"
log="$state/codex.log"

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
  [ -f "$state/remove_noop" ] || printf '%s\n' '{"marketplaces":[{"name":"openai-curated","root":"/x"}]}' > "$state/marketplace_list.json"
  exit 0
fi
exit 0
EOF
chmod +x "$fake_codex"

plugin_present='{"installed":[{"pluginId":"superpowers@superpowers-wrapper","name":"superpowers","marketplaceName":"superpowers-wrapper"}],"available":[]}'
plugin_absent='{"installed":[],"available":[]}'
marketplace_present='{"marketplaces":[{"name":"openai-curated","root":"/x"},{"name":"superpowers-wrapper","root":"/y"}]}'
marketplace_absent='{"marketplaces":[{"name":"openai-curated","root":"/x"}]}'

reset() {
  rm -f "$state/plugin_list.rc" "$state/marketplace_list.rc" "$state/remove_noop" "$state/remove_plugin_missing_installed"
  : > "$log"
}

run_uninstall() {
  SUPERPOWERS_CODEX="$fake_codex" sh "$root/scripts/uninstall"
}

expect_fail() {
  if SUPERPOWERS_CODEX="$fake_codex" sh "$root/scripts/uninstall" >"$state/out" 2>&1; then
    echo "expected uninstall to fail but it succeeded" >&2
    cat "$state/out" >&2
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

# --- Scenario 1: both present -> both removed, plugin before marketplace,
#     openai-curated never named ---
reset
printf '%s\n' "$plugin_present" > "$state/plugin_list.json"
printf '%s\n' "$marketplace_present" > "$state/marketplace_list.json"
run_uninstall >/dev/null
grep -Fq "plugin remove superpowers@superpowers-wrapper" "$log"
grep -Fq "plugin marketplace remove superpowers-wrapper" "$log"
rm_line=$(grep -Fn "plugin remove superpowers@superpowers-wrapper" "$log" | head -n1 | cut -d: -f1)
mp_line=$(grep -Fn "plugin marketplace remove superpowers-wrapper" "$log" | head -n1 | cut -d: -f1)
[ "$rm_line" -lt "$mp_line" ] || { echo "plugin remove must precede marketplace remove" >&2; exit 1; }
if grep -Fq "openai-curated" "$log"; then
  echo "uninstall must never name openai-curated" >&2
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
grep -Fq "plugin marketplace remove superpowers-wrapper" "$log"
printf '%s\n' "$out" | grep -Fq "plugin not installed; skipping"

# --- Scenario 3: both absent -> no removes, idempotent success, both skips ---
reset
printf '%s\n' "$plugin_absent" > "$state/plugin_list.json"
printf '%s\n' "$marketplace_absent" > "$state/marketplace_list.json"
out=$(run_uninstall)
assert_no_removes
printf '%s\n' "$out" | grep -Fq "plugin not installed; skipping"
printf '%s\n' "$out" | grep -Fq "marketplace not registered; skipping"

# --- Scenario 5: plugin list query fails -> abort, no removes ---
reset
printf '%s\n' "$plugin_present" > "$state/plugin_list.json"
printf '%s\n' "$marketplace_present" > "$state/marketplace_list.json"
printf '1\n' > "$state/plugin_list.rc"
expect_fail
assert_no_removes

# --- Scenario 6: malformed plugin list JSON -> abort, no removes ---
reset
printf '%s\n' 'not json {{{' > "$state/plugin_list.json"
printf '%s\n' "$marketplace_present" > "$state/marketplace_list.json"
expect_fail
assert_no_removes

# --- Scenario 7: plugin PRESENT but marketplace list fails -> preflight must
#     abort before ANY remove (the plugin must NOT be removed) ---
reset
printf '%s\n' "$plugin_present" > "$state/plugin_list.json"
printf '%s\n' "$marketplace_present" > "$state/marketplace_list.json"
printf '1\n' > "$state/marketplace_list.rc"
expect_fail
assert_no_removes

# --- Scenario 8: plugin PRESENT but marketplace list is MALFORMED -> preflight
#     must abort before ANY remove. Same fail-closed guarantee as Scenario 7,
#     but reached via a parse error rather than a nonzero exit. ---
reset
printf '%s\n' "$plugin_present" > "$state/plugin_list.json"
printf '%s\n' 'not json {{{' > "$state/marketplace_list.json"
expect_fail
assert_no_removes

# --- Scenario 4: remove is a no-op (fixtures unchanged) -> verify-after must
#     detect the still-present target and fail ---
reset
printf '%s\n' "$plugin_present" > "$state/plugin_list.json"
printf '%s\n' "$marketplace_present" > "$state/marketplace_list.json"
: > "$state/remove_noop"   # removes are logged but do not mutate the fixtures
expect_fail
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
grep -Fq "plugin remove superpowers@superpowers-wrapper" "$log"
assert_output_contains "cannot parse output of"
if grep -Fq "uninstall complete" "$state/out"; then
  echo "must not report success when verify-after sees schema drift" >&2
  cat "$state/out" >&2
  exit 1
fi

echo "test_uninstall_commands: OK"
