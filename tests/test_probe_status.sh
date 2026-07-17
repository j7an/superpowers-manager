#!/bin/sh
set -eu

root=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)
. "$root/scripts/core/common.sh"
. "$root/scripts/core/provenance.sh"
. "$root/scripts/core/status.sh"
. "$root/scripts/core/lifecycle.sh"

desired="896224c4b1879920ab573417e68fd51d2ccc9072"

test "$(spw_status_for_commits "$desired" "" "")" = "needs prepare"
test "$(spw_status_for_commits "$desired" "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" "")" = "needs prepare"
test "$(spw_status_for_commits "$desired" "$desired" "")" = "needs install"
test "$(spw_status_for_commits "$desired" "$desired" "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")" = "needs install"
test "$(spw_status_for_commits "$desired" "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" "$desired")" = "needs prepare"
test "$(spw_status_for_commits "$desired" "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" "896224c")" = "needs prepare"
test "$(spw_status_for_commits "$desired" "$desired" "$desired")" = "current"
test "$(spw_status_for_commits "$desired" "$desired" "896224c")" = "current"

# spw_commit_matches: full-sha match, 7-char short-sha match, mismatch, and
# the load-bearing empty-observed invariant (empty must NOT match).
spw_commit_matches "$desired" "$desired"
spw_commit_matches "$desired" "896224c"
! spw_commit_matches "$desired" "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef"
! spw_commit_matches "$desired" ""

tmpdir=$(mktemp -d)
trap 'rm -rf "$tmpdir"' EXIT INT TERM
mkdir -p "$tmpdir/plugin/.codex-plugin"
assert_manifest_short() {
  version="$1"
  expected="$2"
  cat > "$tmpdir/plugin/.codex-plugin/plugin.json" <<JSON
{
  "name": "superpowers",
  "version": "$version"
}
JSON
  actual=$( . "$root/scripts/adapters/codex/lib.sh"; spw_manifest_short_sha_or_empty "$tmpdir/plugin/.codex-plugin/plugin.json")
  if [ "$actual" != "$expected" ]; then
    echo "unexpected manifest short sha for $version: $actual (expected $expected)" >&2
    exit 1
  fi
}

assert_manifest_short "6.0.3+manager.896224c" "896224c"
assert_manifest_short "6.1.0-beta.1+manager.abc1234" "abc1234"
assert_manifest_short "0.0.0-main+manager.def5678" "def5678"
assert_manifest_short "0.0.0-ref-feature-foo+manager.fedcba9" "fedcba9"
assert_manifest_short "0.0.0-ref-042+manager.0123abc" "0123abc"
assert_manifest_short "0.0.0+manager.896224c" "896224c"
# The template's placeholder version is not a real fingerprint -> empty.
assert_manifest_short "0.0.0+manager.template" ""
assert_manifest_short "6.0.3+manager.abcxyz1" ""

fixture_generated_root="$tmpdir/generated-root"
fixture_generated_metadata="$fixture_generated_root/plugins/superpowers/.superpowers-upstream.json"
mkdir -p "$(dirname "$fixture_generated_metadata")"

printf '%s\n' '{' > "$fixture_generated_metadata"
test "$(spw_generated_commit_or_empty "$fixture_generated_root")" = ""

printf '%s\n' '{"commit": 7}' > "$fixture_generated_metadata"
test "$(spw_generated_commit_or_empty "$fixture_generated_root")" = ""

printf '%s\n' '{"commit": "not-a-commit"}' > "$fixture_generated_metadata"
test "$(spw_generated_commit_or_empty "$fixture_generated_root")" = ""

printf '%s\n' '{"commit": "0123456789abcdef0123456789abcdef01234567"}' > "$fixture_generated_metadata"
test "$(spw_generated_commit_or_empty "$fixture_generated_root")" = "0123456789abcdef0123456789abcdef01234567"

caller_root="$root"
generated_root="caller-generated-root-path"
generated_metadata="caller-generated-metadata-path"
spw_generated_metadata_path "$fixture_generated_root" > "$tmpdir/generated-metadata-path.out"
test "$root" = "$caller_root"
test "$generated_root" = "caller-generated-root-path"
test "$generated_metadata" = "caller-generated-metadata-path"
test "$(cat "$tmpdir/generated-metadata-path.out")" = "$fixture_generated_metadata"

generated_root="caller-generated-root-commit"
generated_metadata="caller-generated-metadata-commit"
spw_generated_commit_or_empty "$fixture_generated_root" > "$tmpdir/generated-commit.out"
test "$root" = "$caller_root"
test "$generated_root" = "caller-generated-root-commit"
test "$generated_metadata" = "caller-generated-metadata-commit"
test "$(cat "$tmpdir/generated-commit.out")" = "0123456789abcdef0123456789abcdef01234567"

chmod 000 "$fixture_generated_metadata"
if [ ! -r "$fixture_generated_metadata" ]; then
  test "$(spw_generated_commit_or_empty "$fixture_generated_root")" = ""
fi
chmod 600 "$fixture_generated_metadata"

echo "test_probe_status: OK"
