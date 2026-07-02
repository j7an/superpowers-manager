#!/bin/sh
set -eu

root=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)
. "$root/scripts/lib.sh"

plugins='{"installed":[{"pluginId":"superpowers@superpowers-wrapper"},{"pluginId":"other@x"}],"available":[]}'
markets='{"marketplaces":[{"name":"openai-curated"},{"name":"superpowers-wrapper"}]}'

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
test "$(spw_json_array_has "$plugins" installed pluginId "superpowers@superpowers-wrapper")" = present
test "$(spw_json_array_has "$markets" marketplaces name "superpowers-wrapper")" = present

# absent: value not present
test "$(spw_json_array_has "$plugins" installed pluginId "missing@x")" = absent
test "$(spw_json_array_has "$markets" marketplaces name "missing")" = absent

# malformed schema -> non-zero exit (fail closed), no "present"/"absent" output
assert_fails '{}' installed pluginId "superpowers@superpowers-wrapper"
assert_fails '{"installed":{}}' installed pluginId "superpowers@superpowers-wrapper"

# absent: empty array
test "$(spw_json_array_has '{"installed":[]}' installed pluginId "x")" = absent

# malformed JSON -> non-zero exit (fail closed), no "present"/"absent" output
assert_fails 'not json {{{' installed pluginId "x"

echo "test_uninstall_helpers: OK"
