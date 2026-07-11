#!/bin/sh
set -eu

root=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)
. "$root/scripts/lib.sh"
tmpdir=$(mktemp -d)
trap 'rm -rf "$tmpdir"' EXIT INT TERM

# --- spw_marketplace_root_from_json ---
json='{"marketplaces":[{"name":"openai-curated","root":"/x"},{"name":"superpowers-wrapper","root":"/y"}]}'
out=$(spw_marketplace_root_from_json "$json" superpowers-wrapper)
[ "$out" = "/y" ] || { echo "expected /y, got '$out'" >&2; exit 1; }

out=$(spw_marketplace_root_from_json '{"marketplaces":[{"name":"openai-curated","root":"/x"}]}' superpowers-wrapper)
[ -z "$out" ] || { echo "expected empty for absent, got '$out'" >&2; exit 1; }

if spw_marketplace_root_from_json 'not json {{{' superpowers-wrapper >/dev/null 2>&1; then
  echo "malformed JSON must fail closed" >&2; exit 1
fi
if spw_marketplace_root_from_json '{"unexpected":[]}' superpowers-wrapper >/dev/null 2>&1; then
  echo "schema drift must fail closed" >&2; exit 1
fi
if spw_marketplace_root_from_json '{"marketplaces":[{"name":"superpowers-wrapper","root":""}]}' superpowers-wrapper >/dev/null 2>&1; then
  echo "empty root must fail closed" >&2; exit 1
fi
if spw_marketplace_root_from_json '{"marketplaces":[{"name":"superpowers-wrapper"}]}' superpowers-wrapper >/dev/null 2>&1; then
  echo "missing wrapper root must fail closed" >&2; exit 1
fi
if spw_marketplace_root_from_json '{"marketplaces":[{"name":"superpowers-wrapper","root":17}]}' superpowers-wrapper >/dev/null 2>&1; then
  echo "non-string wrapper root must fail closed" >&2; exit 1
fi
for invalid_item_json in \
  '{"marketplaces":["openai-curated"]}' \
  '{"marketplaces":[{"root":"/x"}]}' \
  '{"marketplaces":[{"marketplaceName":"openai-curated","root":"/x"}]}' \
  '{"marketplaces":[{"name":"","root":"/x"}]}' \
  '{"marketplaces":[{"name":17,"root":"/x"}]}' \
  '{"marketplaces":[{"name":"superpowers-wrapper","root":"/y"},{"root":"/x"}]}'
do
  set +e
  spw_marketplace_root_from_json "$invalid_item_json" superpowers-wrapper >/dev/null 2>&1
  status=$?
  set -e
  [ "$status" -eq 2 ] || {
    echo "malformed marketplace item must exit 2: $invalid_item_json (got $status)" >&2
    exit 1
  }
done
for unrelated_root_json in \
  '{"marketplaces":[{"name":"openai-curated"}]}' \
  '{"marketplaces":[{"name":"openai-curated","root":17}]}'
do
  if ! out=$(spw_marketplace_root_from_json "$unrelated_root_json" superpowers-wrapper); then
    echo "unrelated marketplace root must not invalidate listing: $unrelated_root_json" >&2
    exit 1
  fi
  [ -z "$out" ] || {
    echo "unrelated marketplace root must be ignored: $unrelated_root_json (got '$out')" >&2
    exit 1
  }
done

# --- spw_paths_equal: symlinked roots are the same physical location.
# This is the portable equivalent of macOS /var vs /private/var. ---
mkdir -p "$tmpdir/real"
ln -s "$tmpdir/real" "$tmpdir/link"
[ "$(spw_paths_equal "$tmpdir/real" "$tmpdir/link")" = same ]
[ "$(spw_paths_equal "$tmpdir/real" "$tmpdir")" = different ]
# Python's realpath normalizes nonexistent paths without raising. These cases
# exercise its resulting equal/different comparison, not the OSError fallback.
[ "$(spw_paths_equal /no/such/path-a /no/such/path-a)" = same ]
[ "$(spw_paths_equal /no/such/path-a /no/such/path-b)" = different ]

# --- spw_reconcile_marketplace ---
# Record every fake Codex invocation so reconciliation assertions cover the
# exact command order and ensure only the wrapper marketplace can be mutated.
fake_log="$tmpdir/codex-commands.log"
fake_codex="$tmpdir/fake-codex"
cat > "$fake_codex" <<'SH'
#!/bin/sh
set -eu
printf '%s\n' "$*" >> "$FAKE_CODEX_LOG"

if [ "$1 $2 $3" = "plugin marketplace list" ] && [ "$4" = "--json" ]; then
  if [ "${FAKE_CODEX_LIST_EXIT:-0}" -ne 0 ]; then
    exit "$FAKE_CODEX_LIST_EXIT"
  fi
  if [ -n "${FAKE_CODEX_LIST_OUTPUT+x}" ]; then
    printf '%s\n' "$FAKE_CODEX_LIST_OUTPUT"
  else
    printf '%s\n' '{"marketplaces":[]}'
  fi
  exit 0
fi
if [ "$1 $2 $3" = "plugin marketplace add" ]; then
  exit "${FAKE_CODEX_ADD_EXIT:-0}"
fi
if [ "$1 $2 $3" = "plugin marketplace remove" ]; then
  exit "${FAKE_CODEX_REMOVE_EXIT:-0}"
fi
echo "unexpected fake Codex command: $*" >&2
exit 99
SH
chmod +x "$fake_codex"
export FAKE_CODEX_LOG="$fake_log"

assert_exact_commands() {
  expected="$1"
  actual=$(cat "$fake_log")
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

assert_reconcile_fails_without_mutation() {
  label="$1"
  : > "$fake_log"
  if (spw_reconcile_marketplace "$fake_codex" "$tmpdir/requested") >"$tmpdir/$label.out" 2>&1; then
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
FAKE_CODEX_LIST_OUTPUT='{"unexpected":[]}'
assert_reconcile_fails_without_mutation schema-invalid-json
FAKE_CODEX_LIST_OUTPUT='{"marketplaces":[{"name":"superpowers-wrapper","root":""}]}'
assert_reconcile_fails_without_mutation empty-root-json
FAKE_CODEX_LIST_OUTPUT='{"marketplaces":[{"name":"superpowers-wrapper"}]}'
assert_reconcile_fails_without_mutation missing-wrapper-root-json
FAKE_CODEX_LIST_OUTPUT='{"marketplaces":[{"name":"superpowers-wrapper","root":17}]}'
assert_reconcile_fails_without_mutation invalid-wrapper-root-json
for invalid_item_case in \
  'non-object-item|{"marketplaces":["openai-curated"]}' \
  'missing-name|{"marketplaces":[{"root":"/other"}]}' \
  'renamed-name|{"marketplaces":[{"marketplaceName":"openai-curated","root":"/other"}]}' \
  'empty-name|{"marketplaces":[{"name":"","root":"/other"}]}' \
  'invalid-name|{"marketplaces":[{"name":17,"root":"/other"}]}' \
  'malformed-after-wrapper|{"marketplaces":[{"name":"superpowers-wrapper","root":"/registered"},{"root":"/other"}]}'
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
  spw_reconcile_marketplace "$fake_codex" "$tmpdir/requested"
  assert_exact_commands "plugin marketplace list --json
plugin marketplace add $tmpdir/requested"
done

FAKE_CODEX_LIST_OUTPUT='{"marketplaces":[{"name":"openai-curated","root":"/other"}]}'
: > "$fake_log"
spw_reconcile_marketplace "$fake_codex" "$tmpdir/requested"
assert_exact_commands "plugin marketplace list --json
plugin marketplace add $tmpdir/requested"
! grep -Fq openai-curated "$fake_log"

mkdir -p "$tmpdir/registered-root"
ln -s "$tmpdir/registered-root" "$tmpdir/registered-root-link"
FAKE_CODEX_LIST_OUTPUT=$(printf '{"marketplaces":[{"name":"openai-curated","root":"/other"},{"name":"superpowers-wrapper","root":"%s"}]}' "$tmpdir/registered-root-link")
: > "$fake_log"
spw_reconcile_marketplace "$fake_codex" "$tmpdir/registered-root"
assert_exact_commands "plugin marketplace list --json"
assert_no_mutation

mkdir -p "$tmpdir/old-root" "$tmpdir/new-root"
FAKE_CODEX_LIST_OUTPUT=$(printf '{"marketplaces":[{"name":"openai-curated","root":"/other"},{"name":"superpowers-wrapper","root":"%s"}]}' "$tmpdir/old-root")
: > "$fake_log"
spw_reconcile_marketplace "$fake_codex" "$tmpdir/new-root"
assert_exact_commands "plugin marketplace list --json
plugin marketplace remove superpowers-wrapper
plugin marketplace add $tmpdir/new-root"
! grep -Fq openai-curated "$fake_log"

FAKE_CODEX_ADD_EXIT=23
export FAKE_CODEX_ADD_EXIT
: > "$fake_log"
if (spw_reconcile_marketplace "$fake_codex" "$tmpdir/new-root") >"$tmpdir/failed-add.out" 2>&1; then
  echo "failed re-add must return nonzero" >&2
  exit 1
fi
unset FAKE_CODEX_ADD_EXIT
assert_exact_commands "plugin marketplace list --json
plugin marketplace remove superpowers-wrapper
plugin marketplace add $tmpdir/new-root"
grep -Fq "$tmpdir/old-root" "$tmpdir/failed-add.out"
grep -Fq "$tmpdir/new-root" "$tmpdir/failed-add.out"
grep -Fq "recover with:" "$tmpdir/failed-add.out"

# --- spw_verify_refresh: compares installed metadata to the desired commit
# passed by the caller; it must not call scripts/probe or resolve upstream after
# Codex has already been mutated.
desired="abcdef0123456789abcdef0123456789abcdef01"
installed_root="$tmpdir/codex/plugins/cache/superpowers-wrapper/superpowers/1.0.0"
mkdir -p "$installed_root"
cat > "$installed_root/.superpowers-upstream.json" <<EOF
{"commit":"$desired"}
EOF
out=$(SUPERPOWERS_INSTALLED_SEARCH_ROOT="$tmpdir/codex" spw_verify_refresh "$desired")
printf '%s\n' "$out" | grep -Fq "wrapper updated"
printf '%s\n' "$out" | grep -Fq "installed_commit=$desired"

if (SUPERPOWERS_INSTALLED_SEARCH_ROOT="$tmpdir/codex" spw_verify_refresh "1111111111111111111111111111111111111111") >"$tmpdir/stale.out" 2>&1; then
  echo "stale installed metadata must fail" >&2; exit 1
fi
grep -Fq "still stale" "$tmpdir/stale.out"

rm -rf "$tmpdir/codex"
if (SUPERPOWERS_INSTALLED_SEARCH_ROOT="$tmpdir/codex" spw_verify_refresh "$desired") >"$tmpdir/undetectable.out" 2>&1; then
  echo "undetectable installed metadata must fail" >&2; exit 1
fi
grep -Fq "installed wrapper not detectable" "$tmpdir/undetectable.out"
if grep -Fq "wrapper updated" "$tmpdir/undetectable.out"; then
  echo "undetectable installed metadata must not print success" >&2; exit 1
fi

echo "test_marketplace_reconcile: OK"
