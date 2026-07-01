#!/bin/sh
set -eu

root=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)
. "$root/scripts/lib.sh"

plugins='{"installed":[{"pluginId":"superpowers@superpowers-wrapper"},{"pluginId":"other@x"}],"available":[]}'
markets='{"marketplaces":[{"name":"openai-curated"},{"name":"superpowers-wrapper"}]}'

# present: value found in the named array on the named field
test "$(spw_json_array_has "$plugins" installed pluginId "superpowers@superpowers-wrapper")" = present
test "$(spw_json_array_has "$markets" marketplaces name "superpowers-wrapper")" = present

# absent: value not present
test "$(spw_json_array_has "$plugins" installed pluginId "missing@x")" = absent
test "$(spw_json_array_has "$markets" marketplaces name "missing")" = absent

# absent: array key entirely missing
test "$(spw_json_array_has '{}' installed pluginId "superpowers@superpowers-wrapper")" = absent

# absent: empty array
test "$(spw_json_array_has '{"installed":[]}' installed pluginId "x")" = absent

# malformed JSON -> non-zero exit (fail closed), no "present"/"absent" output
if spw_json_array_has 'not json {{{' installed pluginId "x"; then
  echo "malformed JSON must make spw_json_array_has fail" >&2
  exit 1
fi

echo "test_uninstall_helpers: OK"
