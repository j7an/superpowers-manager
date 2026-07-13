#!/bin/sh
set -eu

root=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)
. "$root/scripts/adapters/codex/lib.sh"

tmpdir=$(mktemp -d)
trap 'rm -rf "$tmpdir"' EXIT INT TERM

# Reproduce the real Codex installed-cache layout observed by the Task 1
# behavior probe: ~/.codex/plugins/cache/<marketplace>/<plugin>/<version>/...
# The <version> directory segment sits between the plugin name and the files,
# so the finders must tolerate it (an earlier pattern anchored the file
# directly under */superpowers/ and silently missed every real install).
cache="$tmpdir/.codex/plugins/cache/superpowers-wrapper/superpowers/6.0.3+wrapper.abc1234"
mkdir -p "$cache/.codex-plugin"
cat > "$cache/.superpowers-upstream.json" <<'JSON'
{
  "commit": "abc1234def5678abc1234def5678abc1234def56"
}
JSON
cat > "$cache/.codex-plugin/plugin.json" <<'JSON'
{
  "name": "superpowers",
  "version": "6.0.3+wrapper.abc1234"
}
JSON

found_metadata=$(SUPERPOWERS_INSTALLED_SEARCH_ROOT="$tmpdir/.codex" spw_find_installed_metadata)
test "$found_metadata" = "$cache/.superpowers-upstream.json"

found_manifest=$(SUPERPOWERS_INSTALLED_SEARCH_ROOT="$tmpdir/.codex" spw_find_installed_manifest)
test "$found_manifest" = "$cache/.codex-plugin/plugin.json"

# Backward-compatible: a layout with no intervening version directory must
# still resolve (covers staging copies and any future flat cache layout).
flat="$tmpdir/flat/superpowers"
mkdir -p "$flat/.codex-plugin"
cat > "$flat/.superpowers-upstream.json" <<'JSON'
{
  "commit": "0000000111111122222223333333444444455555"
}
JSON
cat > "$flat/.codex-plugin/plugin.json" <<'JSON'
{
  "name": "superpowers",
  "version": "0.0.0-main+wrapper.0000000"
}
JSON

flat_metadata=$(SUPERPOWERS_INSTALLED_SEARCH_ROOT="$tmpdir/flat" spw_find_installed_metadata)
test "$flat_metadata" = "$flat/.superpowers-upstream.json"

flat_manifest=$(SUPERPOWERS_INSTALLED_SEARCH_ROOT="$tmpdir/flat" spw_find_installed_manifest)
test "$flat_manifest" = "$flat/.codex-plugin/plugin.json"

echo "test_installed_finders: OK"
