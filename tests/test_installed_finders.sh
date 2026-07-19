#!/bin/sh
set -eu

root=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)
. "$root/scripts/adapters/codex/lib.sh"

tmpdir=$(mktemp -d)
trap 'rm -rf "$tmpdir"' EXIT INT TERM

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
