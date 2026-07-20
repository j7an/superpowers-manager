#!/bin/sh
set -eu

test_dir=$(CDPATH= cd -- "$(dirname "$0")" && pwd)
. "$test_dir/lib/harness.sh"
spw_test_root

test_installed_finders() {
  . "$root/scripts/adapters/codex/lib.sh"
  spw_test_tmpdir

  search_root="$tmpdir/.codex"
  version_a="6.0.3+manager.aaaaaaa"
  version_b="6.0.3+manager.bbbbbbb"
  cache_a="$search_root/plugins/cache/superpowers-manager/superpowers/$version_a"
  cache_b="$search_root/plugins/cache/superpowers-manager/superpowers/$version_b"
  mkdir -p "$cache_a/.codex-plugin" "$cache_b/.codex-plugin"

  cat > "$cache_a/.superpowers-upstream.json" <<'JSON'
{"commit":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}
JSON
  cat > "$cache_b/.superpowers-upstream.json" <<'JSON'
{"commit":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"}
JSON
  cat > "$cache_a/.codex-plugin/plugin.json" <<'JSON'
{"name":"superpowers","version":"6.0.3+manager.aaaaaaa"}
JSON
  cat > "$cache_b/.codex-plugin/plugin.json" <<'JSON'
{"name":"superpowers","version":"6.0.3+manager.bbbbbbb"}
JSON

  # Codex's active listing is authoritative even when an older retained cache
  # directory sorts first on disk.
  listing_b='{"installed":[{"pluginId":"unrelated@elsewhere","version":"1.0.0"},{"pluginId":"superpowers@superpowers-manager","version":"6.0.3+manager.bbbbbbb"}]}'
  active_version=$(spw_active_plugin_version_from_json \
    "$listing_b" "superpowers@superpowers-manager")
  [ "$active_version" = "$version_b" ]
  active_root=$(spw_installed_root_for_version \
    "$search_root" "superpowers-manager" "superpowers" "$active_version")
  [ "$active_root" = "$cache_b" ]
  [ "$(spw_installed_commit_from_root_or_empty "$active_root")" = \
    "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" ]

  # Verified absence is successful and prints an empty version.
  absent_version=$(spw_active_plugin_version_from_json \
    '{"installed":[{"pluginId":"unrelated@elsewhere"}]}' \
    "superpowers@superpowers-manager")
  [ -z "$absent_version" ]

  assert_listing_rejected() {
    listing="$1"
    output_file="$tmpdir/rejected.out"
    rc=0
    spw_active_plugin_version_from_json \
      "$listing" "superpowers@superpowers-manager" >"$output_file" || rc=$?
    [ "$rc" -eq 2 ]
    [ ! -s "$output_file" ]
  }

  assert_listing_rejected '{'
  assert_listing_rejected '[]'
  assert_listing_rejected '{"installed":{}}'
  assert_listing_rejected '{"installed":[{}]}'
  assert_listing_rejected '{"installed":[{"pluginId":""}]}'
  assert_listing_rejected '{"installed":[{"pluginId":7}]}'
  assert_listing_rejected '{"installed":[{"pluginId":"superpowers@superpowers-manager"}]}'
  assert_listing_rejected '{"installed":[{"pluginId":"superpowers@superpowers-manager","version":7}]}'
  assert_listing_rejected '{"installed":[{"pluginId":"superpowers@superpowers-manager","version":""}]}'
  assert_listing_rejected '{"installed":[{"pluginId":"superpowers@superpowers-manager","version":"."}]}'
  assert_listing_rejected '{"installed":[{"pluginId":"superpowers@superpowers-manager","version":".."}]}'
  assert_listing_rejected '{"installed":[{"pluginId":"superpowers@superpowers-manager","version":"bad/name"}]}'
  assert_listing_rejected '{"installed":[{"pluginId":"superpowers@superpowers-manager","version":"bad\\name"}]}'
  assert_listing_rejected '{"installed":[{"pluginId":"superpowers@superpowers-manager","version":"bad\nname"}]}'
  assert_listing_rejected '{"installed":[{"pluginId":"superpowers@superpowers-manager","version":"bad\rname"}]}'
  assert_listing_rejected '{"installed":[{"pluginId":"superpowers@superpowers-manager","version":"bad\u001bname"}]}'
  assert_listing_rejected '{"installed":[{"pluginId":"superpowers@superpowers-manager","version":"bad\u0085name"}]}'
  assert_listing_rejected '{"installed":[{"pluginId":"superpowers@superpowers-manager","version":"1.0.0"},{"pluginId":"superpowers@superpowers-manager","version":"2.0.0"}]}'

  # The old filesystem-sweep selection path must not remain available.
  if grep -Eq 'spw_find_installed_(metadata|manifest)|find .*plugins/cache|head -n 1' \
    "$root/scripts/adapters/codex/lib.sh"; then
    echo "installed fingerprint selection must not sweep retained cache roots" >&2
    exit 1
  fi

  echo "test_installed_finders: OK"
}

test_uninstall_helpers() {
  . "$root/scripts/core/common.sh"
  . "$root/scripts/adapters/codex/lib.sh"
  . "$root/scripts/core/common.sh"
  . "$root/scripts/core/lifecycle.sh"

  if grep -Eq '^spw_(plugin_is_installed|marketplace_is_registered)\(\)' \
    "$root/scripts/adapters/codex/lib.sh"; then
    echo "dead Codex ownership adapter helpers must remain removed" >&2
    exit 1
  fi

  plugins='{"installed":[{"pluginId":"superpowers@superpowers-manager"},{"pluginId":"other@x"}],"available":[]}'
  markets='{"marketplaces":[{"name":"openai-curated"},{"name":"superpowers-manager"}]}'

  assert_fails() {
    if out=$(spw_json_array_has "$1" "$2" "$3" "$4" 2>&1); then
      echo "expected spw_json_array_has to fail for invalid schema" >&2
      printf '%s\n' "$out" >&2
      exit 1
    fi
    case "$out" in
      present|absent)
        echo "expected no membership result on helper failure" >&2
        printf '%s\n' "$out" >&2
        exit 1
        ;;
    esac
  }

  # present: value found in the named array on the named field
  test "$(spw_json_array_has "$plugins" installed pluginId "superpowers@superpowers-manager")" = present
  test "$(spw_json_array_has "$markets" marketplaces name "superpowers-manager")" = present

  # absent: value not present
  test "$(spw_json_array_has "$plugins" installed pluginId "missing@x")" = absent
  test "$(spw_json_array_has "$markets" marketplaces name "missing")" = absent

  # malformed schema -> non-zero exit (fail closed), no "present"/"absent" output
  assert_fails '{}' installed pluginId "superpowers@superpowers-manager"
  assert_fails '{"installed":{}}' installed pluginId "superpowers@superpowers-manager"
  assert_fails '{"installed":[{}]}' installed pluginId "superpowers@superpowers-manager"
  assert_fails '{"installed":[{"pluginId":42}]}' installed pluginId "superpowers@superpowers-manager"
  assert_fails '{"installed":[null]}' installed pluginId "superpowers@superpowers-manager"
  assert_fails '{"marketplaces":[{}]}' marketplaces name "superpowers-manager"
  assert_fails '{"marketplaces":[{"name":42}]}' marketplaces name "superpowers-manager"
  assert_fails '{"marketplaces":[null]}' marketplaces name "superpowers-manager"

  # absent: empty array
  test "$(spw_json_array_has '{"installed":[]}' installed pluginId "x")" = absent

  # malformed JSON -> non-zero exit (fail closed), no "present"/"absent" output
  assert_fails 'not json {{{' installed pluginId "x"

  for state in neither manager; do
    output=$(spw_require_no_legacy_state "$state" 2>&1)
    [ -z "$output" ]
  done

  for state in legacy both; do
    if output=$(spw_require_no_legacy_state "$state" 2>&1); then
      echo "legacy policy must reject $state" >&2
      exit 1
    fi
    printf '%s\n' "$output" | grep -Fxq 'Legacy superpowers-wrapper Codex state is installed.'
    printf '%s\n' "$output" | grep -Fxq 'Run: npx superpowers-wrapper@0.1.1 uninstall'
    printf '%s\n' "$output" | grep -Fxq 'Then run: npx superpowers-manager install'
  done

  for state in neither manager; do
    output=$(spw_report_legacy_state "$state")
    [ -z "$output" ]
  done

  for state in legacy both; do
    output=$(spw_report_legacy_state "$state")
    printf '%s\n' "$output" | grep -Fxq 'Legacy superpowers-wrapper Codex state remains installed.'
    printf '%s\n' "$output" | grep -Fxq 'Run: npx superpowers-wrapper@0.1.1 uninstall'
  done

  echo "test_uninstall_helpers: OK"
}

failed=0
spw_section test_installed_finders test_installed_finders
spw_section test_uninstall_helpers test_uninstall_helpers
[ "$failed" -eq 0 ] || exit "$failed"
