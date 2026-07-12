#!/bin/sh

root=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)
. "$root/scripts/core/common.sh"
. "$root/scripts/core/upstream.sh"
. "$root/scripts/core/provenance.sh"
. "$root/scripts/core/status.sh"
. "$root/scripts/core/lifecycle.sh"
. "$root/scripts/core/adapter.sh"
. "$root/scripts/adapters/codex/lib.sh"

# Codex installs a plugin into a versioned cache directory:
#   ~/.codex/plugins/cache/<marketplace>/superpowers/<version>/...
# so the metadata/manifest live one directory below the plugin name, not
# directly inside it (confirmed by the Task 1 behavior probe against the live
# install). Match both the versioned layout and a flat layout (no intervening
# version directory) so staging copies and any future flat cache still resolve.
spw_find_installed_metadata() {
  search_root="${SUPERPOWERS_INSTALLED_SEARCH_ROOT:-$HOME/.codex}"
  find "$search_root" \
    \( -path "*/superpowers/.superpowers-upstream.json" \
       -o -path "*/superpowers/*/.superpowers-upstream.json" \) \
    -type f 2>/dev/null | head -n 1
}

spw_find_installed_manifest() {
  search_root="${SUPERPOWERS_INSTALLED_SEARCH_ROOT:-$HOME/.codex}"
  find "$search_root" \
    \( -path "*/superpowers/.codex-plugin/plugin.json" \
       -o -path "*/superpowers/*/.codex-plugin/plugin.json" \) \
    -type f 2>/dev/null | head -n 1
}

# Given a JSON document as the FIRST ARGUMENT (a string), print "present" if any
# element of the top-level array <array_key> is an object whose <field> equals
# <value>, else print "absent" (exit 0). On unparseable JSON or invalid schema,
# print nothing and exit 2 so callers can fail closed rather than treat an
# unreadable listing as "absent".
# The JSON is passed as an argument (exactly as spw_json_get takes a file path),
# NOT on stdin: the here-doc below is Python's stdin (its program source), so a
# json.load(sys.stdin) here would read the program, not the caller's JSON.
spw_json_array_has() {
  json="$1"
  array_key="$2"
  field="$3"
  value="$4"
  python3 - "$json" "$array_key" "$field" "$value" <<'PY'
import json, sys
raw, array_key, field, value = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]
try:
    data = json.loads(raw)
except (json.JSONDecodeError, RecursionError):
    sys.exit(2)
if not isinstance(data, dict):
    sys.exit(2)
items = data.get(array_key)
if not isinstance(items, list):
    sys.exit(2)
found = any(isinstance(i, dict) and i.get(field) == value for i in items)
print("present" if found else "absent")
PY
}

# Return 0 if <plugin_id> is installed, 1 if genuinely not installed. Fail
# closed: spw_die (exit) if the listing cannot be queried or parsed, so a
# read/parse error is never mistaken for "absent".
spw_plugin_is_installed() {
  codex_bin="$1"
  plugin_id="$2"
  if ! out=$("$codex_bin" plugin list --json 2>/dev/null); then
    spw_die "cannot list Codex plugins via '$codex_bin plugin list --json'"
  fi
  if ! result=$(spw_json_array_has "$out" "installed" "pluginId" "$plugin_id"); then
    spw_die "cannot parse output of '$codex_bin plugin list --json'"
  fi
  [ "$result" = present ]
}

# Return 0 if <marketplace_name> is registered, 1 if genuinely not registered.
# Fail closed exactly like spw_plugin_is_installed.
spw_marketplace_is_registered() {
  codex_bin="$1"
  marketplace_name="$2"
  if ! out=$("$codex_bin" plugin marketplace list --json 2>/dev/null); then
    spw_die "cannot list Codex marketplaces via '$codex_bin plugin marketplace list --json'"
  fi
  if ! result=$(spw_json_array_has "$out" "marketplaces" "name" "$marketplace_name"); then
    spw_die "cannot parse output of '$codex_bin plugin marketplace list --json'"
  fi
  [ "$result" = present ]
}

# Print the registered root of <marketplace_name> from a marketplace-list JSON
# document (as a string argument, like spw_json_array_has), or nothing if the
# marketplace is absent. Exit 2 on unparseable JSON, a non-object item, or an
# item without a non-empty string name: such an item cannot be proven unrelated
# and must not be mistaken for an absent wrapper marketplace. Validate root only
# on the matching item; unrelated marketplace roots are never read. A matching
# item without a non-empty string root also exits 2. Empty output is unambiguous:
# a valid registered root is always a non-empty path.
spw_marketplace_root_from_json() {
  json="$1"
  marketplace_name="$2"
  python3 - "$json" "$marketplace_name" <<'PY'
import json, sys
raw, name = sys.argv[1], sys.argv[2]
try:
    data = json.loads(raw)
except (json.JSONDecodeError, RecursionError):
    sys.exit(2)
if not isinstance(data, dict):
    sys.exit(2)
items = data.get("marketplaces")
if not isinstance(items, list):
    sys.exit(2)
for item in items:
    if not isinstance(item, dict):
        sys.exit(2)
    item_name = item.get("name")
    if not isinstance(item_name, str) or not item_name:
        sys.exit(2)
for item in items:
    if item["name"] == name:
        item_root = item.get("root")
        if not isinstance(item_root, str) or not item_root:
            sys.exit(2)
        print(item_root)
        sys.exit(0)
PY
}

# Print "same" if the two paths refer to the same physical location, else
# "different". Physical-path normalization via os.path.realpath on both
# sides (handles /var vs /private/var and other symlinked roots); if
# realpath fails, fall back to comparing the original strings.
spw_paths_equal() {
  python3 - "$1" "$2" <<'PY'
import os, sys
a, b = sys.argv[1], sys.argv[2]
try:
    na, nb = os.path.realpath(a), os.path.realpath(b)
except OSError:
    na, nb = a, b
print("same" if na == nb else "different")
PY
}

# Reconcile Codex's wrapper marketplace pointer to <current_root>:
#   absent                     -> add
#   same physical root         -> keep
#   different root             -> remove, then add
# List/parse failures abort before any marketplace change. If remove
# succeeds and add fails, print a recovery command for the current root AND
# the previous root so the user can restore last-known-good state. Only the
# superpowers-wrapper marketplace is ever touched.
spw_reconcile_marketplace() {
  codex_bin="$1"
  current_root="$2"
  if ! listing=$("$codex_bin" plugin marketplace list --json 2>/dev/null); then
    spw_die "cannot list Codex marketplaces via '$codex_bin plugin marketplace list --json'"
  fi
  if ! registered_root=$(spw_marketplace_root_from_json "$listing" "$SPW_MARKETPLACE_NAME"); then
    spw_die "cannot parse output of '$codex_bin plugin marketplace list --json'"
  fi
  if [ -z "$registered_root" ]; then
    if ! "$codex_bin" plugin marketplace add "$current_root"; then
      spw_die "codex marketplace add failed for $current_root"
    fi
    return 0
  fi
  if [ "$(spw_paths_equal "$current_root" "$registered_root")" = same ]; then
    return 0
  fi
  echo "marketplace $SPW_MARKETPLACE_NAME registered at $registered_root; re-registering at $current_root"
  if ! "$codex_bin" plugin marketplace remove "$SPW_MARKETPLACE_NAME"; then
    spw_die "codex marketplace remove failed for $SPW_MARKETPLACE_NAME (registered at $registered_root)"
  fi
  if ! "$codex_bin" plugin marketplace add "$current_root"; then
    echo "error: marketplace $SPW_MARKETPLACE_NAME was removed but re-adding failed." >&2
    echo "recover with: $codex_bin plugin marketplace add $current_root" >&2
    echo "previous root (last known good): $registered_root" >&2
    exit 1
  fi
}

# Return the currently installed wrapper commit/fingerprint, or empty if the
# installed plugin cannot be detected. This is intentionally local-only: callers
# pass the desired commit into spw_verify_refresh so post-mutation verification
# never refetches or re-resolves upstream after Codex state has changed.
spw_installed_commit_or_empty() {
  installed_metadata=$(spw_find_installed_metadata || true)
  installed_manifest=$(spw_find_installed_manifest || true)
  installed_commit=""
  if [ -n "$installed_metadata" ]; then
    installed_commit=$(spw_metadata_commit_or_empty "$installed_metadata" || true)
  fi
  if [ -z "$installed_commit" ] && [ -n "$installed_manifest" ]; then
    installed_commit=$(spw_manifest_short_sha_or_empty "$installed_manifest" || true)
  fi
  printf '%s\n' "$installed_commit"
}

# After an install, confirm the installed wrapper refreshed to <desired_commit>.
# Never prints a success line while the installed wrapper is detectably stale.
# Shared by scripts/install and scripts/update.
spw_verify_refresh() {
  desired_commit="$1"
  installed_commit=$(spw_installed_commit_or_empty || true)
  printf 'desired_commit=%s\n' "$desired_commit"
  printf 'installed_commit=%s\n' "$installed_commit"
  if [ -n "$installed_commit" ] && spw_commit_matches "$desired_commit" "$installed_commit"; then
    echo "wrapper updated"
    return 0
  fi
  if [ -n "$installed_commit" ]; then
    echo "error: installed wrapper is still stale after install; the local plugin cache did not refresh." >&2
    echo "hint: retry with SUPERPOWERS_INSTALL_REFRESH_MODE=remove-add" >&2
    exit 1
  fi
  echo "error: installed wrapper not detectable, cannot confirm refresh; verify with 'codex plugin list --json'." >&2
  return 1
}
