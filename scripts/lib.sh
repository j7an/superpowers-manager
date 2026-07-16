#!/bin/sh

SPW_UPSTREAM_URL_DEFAULT="https://github.com/obra/superpowers"
SPW_PLUGIN_ID="superpowers@superpowers-manager"
SPW_MARKETPLACE_NAME="superpowers-manager"
SPW_LEGACY_PLUGIN_ID="superpowers@superpowers-wrapper"
SPW_LEGACY_MARKETPLACE_NAME="superpowers-wrapper"

spw_die() {
  echo "error: $*" >&2
  exit 1
}

spw_require_command() {
  command_name="$1"
  if ! command -v "$command_name" >/dev/null 2>&1; then
    spw_die "required command not found: $command_name"
  fi
}

spw_root() {
  CDPATH= cd -- "$(dirname "$0")/.." && pwd
}

spw_config_ref() {
  root="$1"
  if [ -n "${SUPERPOWERS_REF:-}" ]; then
    printf '%s\n' "$SUPERPOWERS_REF"
    return
  fi
  sed -n '1{s/[[:space:]]*$//;p;}' "$root/config/upstream-ref"
}

spw_short_commit() {
  commit="$1"
  printf '%s' "$commit" | cut -c 1-7
}

spw_is_semver_base() {
  version="$1"
  printf '%s' "$version" | grep -Eq '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-((0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*)(\.(0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*))*))?$'
}

spw_sanitize_ref_for_version() {
  ref="$1"
  sanitized=$(printf '%s' "$ref" | sed 's/[^0-9A-Za-z-][^0-9A-Za-z-]*/-/g; s/^-*//; s/-*$//')
  sanitized=$(printf '%s' "$sanitized" | cut -c 1-48 | sed 's/^-*//; s/-*$//')
  if [ -z "$sanitized" ]; then
    sanitized="unknown"
  fi
  printf '%s' "$sanitized"
}

spw_manifest_version_for_ref() {
  requested_ref="$1"
  resolution_kind="$2"
  resolved_ref="$3"
  commit="$4"
  short=$(spw_short_commit "$commit")

  case "$resolution_kind" in
    latest-release|tag)
      base=$(printf '%s' "$resolved_ref" | sed -n 's/^v//p')
      if [ -n "$base" ] && spw_is_semver_base "$base"; then
        printf '%s+manager.%s\n' "$base" "$short"
        return
      fi
      ;;
    ref)
      if [ "$requested_ref" = "main" ]; then
        printf '0.0.0-main+manager.%s\n' "$short"
        return
      fi
      sanitized=$(spw_sanitize_ref_for_version "$requested_ref")
      printf '0.0.0-ref-%s+manager.%s\n' "$sanitized" "$short"
      return
      ;;
    raw-commit)
      ;;
  esac

  printf '0.0.0+manager.%s\n' "$short"
}

spw_manifest_version_for_commit() {
  commit="$1"
  spw_manifest_version_for_ref "$commit" "raw-commit" "$commit" "$commit"
}

spw_commit_matches() {
  desired="$1"
  observed="$2"
  short=$(printf '%s' "$desired" | cut -c 1-7)
  [ -n "$observed" ] && { [ "$observed" = "$desired" ] || [ "$observed" = "$short" ]; }
}

spw_select_latest_release_from_ls_remote() {
  awk '
    $2 ~ /^refs\/tags\/v[0-9]+\.[0-9]+\.[0-9]+(\^\{\})?$/ {
      ref = $2
      peeled = 0
      if (ref ~ /\^\{\}$/) {
        peeled = 1
        sub(/\^\{\}$/, "", ref)
      }
      tag = ref
      sub(/^refs\/tags\//, "", tag)
      split(substr(tag, 2), parts, ".")
      key = sprintf("%010d.%010d.%010d", parts[1], parts[2], parts[3])
      tag_by_key[key] = tag
      if (peeled || !(tag in sha_by_tag)) {
        sha_by_tag[tag] = $1
      }
    }
    END {
      for (key in tag_by_key) {
        tag = tag_by_key[key]
        print key, tag, sha_by_tag[tag]
      }
    }
  ' | sort | tail -n 1 | awk '
    NF == 3 { print $2 " " $3; found = 1 }
    END { if (!found) exit 1 }
  '
}

spw_resolve_ref() {
  upstream_url="$1"
  requested_ref="$2"
  spw_require_command git

  if [ "$requested_ref" = "latest-release" ]; then
    if ! output=$(git ls-remote --tags "$upstream_url" 'refs/tags/v*' 2>&1); then
      spw_die "cannot query upstream tags from $upstream_url: $output"
    fi
    if ! selected=$(printf '%s\n' "$output" | spw_select_latest_release_from_ls_remote); then
      spw_die "no stable semver tag found for latest-release"
    fi
    printf 'latest-release %s\n' "$selected"
    return
  fi

  if printf '%s' "$requested_ref" | grep -Eq '^[0-9a-fA-F]{40}$'; then
    printf 'raw-commit %s %s\n' "$requested_ref" "$requested_ref"
    return
  fi

  if ! tag_output=$(git ls-remote --tags "$upstream_url" "refs/tags/$requested_ref" "refs/tags/$requested_ref^{}" 2>&1); then
    spw_die "cannot query upstream tag $requested_ref from $upstream_url: $tag_output"
  fi
  resolved=$(printf '%s\n' "$tag_output" | awk -v tag_ref="refs/tags/$requested_ref" '
    NF >= 2 && ($2 == tag_ref || $2 == tag_ref "^{}") {
      sha = $1
    }
    END { if (sha != "") print sha }
  ')
  if [ -n "$resolved" ]; then
    printf 'tag %s %s\n' "$requested_ref" "$resolved"
    return
  fi

  if ! ref_output=$(git ls-remote "$upstream_url" "$requested_ref" 2>&1); then
    spw_die "cannot query upstream ref $requested_ref from $upstream_url: $ref_output"
  fi
  resolved=$(printf '%s\n' "$ref_output" | awk 'NF >= 2 { print $1; exit }')
  if [ -n "$resolved" ]; then
    printf 'ref %s %s\n' "$requested_ref" "$resolved"
    return
  fi

  spw_die "cannot resolve upstream ref: $requested_ref"
}

spw_json_get() {
  file="$1"
  key="$2"
  if ! value=$(
    python3 - "$file" "$key" 2>&1 <<'PY'
import json
import sys

path, dotted_key = sys.argv[1:]
MAX_JSON_NESTING = 256

def reject_constant(constant):
    raise ValueError(f"non-standard numeric constant: {constant}")

def nesting_exceeds_limit(value):
    stack = [(value, 0)]
    while stack:
        current, depth = stack.pop()
        if isinstance(current, dict):
            next_depth = depth + 1
            if next_depth > MAX_JSON_NESTING:
                return True
            stack.extend((child, next_depth) for child in current.values())
        elif isinstance(current, list):
            next_depth = depth + 1
            if next_depth > MAX_JSON_NESTING:
                return True
            stack.extend((child, next_depth) for child in current)
    return False

try:
    with open(path, "r", encoding="utf-8") as f:
        data = json.load(f, parse_constant=reject_constant)
except RecursionError:
    sys.exit(f"JSON nesting exceeds limit in {path}")
except json.JSONDecodeError as exc:
    sys.exit(
        f"invalid JSON in {path}: "
        f"line {exc.lineno} column {exc.colno}: {exc.msg}"
    )
except (OSError, UnicodeError) as exc:
    sys.exit(f"cannot read JSON in {path}: {exc}")
except ValueError as exc:
    sys.exit(f"invalid JSON in {path}: {exc}")

if nesting_exceeds_limit(data):
    sys.exit(f"JSON nesting exceeds limit in {path}")

if not isinstance(data, dict):
    sys.exit(f"JSON value must be an object in {path}")

value = data
for part in dotted_key.split("."):
    if not isinstance(value, dict):
        value = ""
        break
    value = value.get(part, "")
try:
    print(value if value is not None else "")
except (OSError, UnicodeError) as exc:
    sys.exit(f"cannot output JSON value from {path}: {exc}")
PY
  ); then
    spw_die "$value"
  fi
  printf '%s\n' "$value"
}

spw_copy_path_if_present() {
  src="$1"
  dst="$2"
  if [ -e "$src" ]; then
    rm -rf "$dst"
    cp -R "$src" "$dst"
  fi
}

spw_require_upstream_path() {
  path="$1"
  label="$2"
  if [ ! -e "$path" ]; then
    spw_die "required upstream path missing: $label"
  fi
}

spw_write_metadata_json() {
  file="$1"
  source="$2"
  requested_ref="$3"
  resolved_ref="$4"
  commit="$5"
  upstream_manifest_version="$6"
  python3 - "$file" "$source" "$requested_ref" "$resolved_ref" "$commit" "$upstream_manifest_version" <<'PY'
import json, sys
path, source, requested, resolved, commit, version = sys.argv[1:]
data = {
    "source": source,
    "requested_ref": requested,
    "resolved_ref": resolved,
    "commit": commit,
    "upstream_manifest_version": version,
}
try:
    with open(path, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2, allow_nan=False)
        f.write("\n")
except RecursionError as exc:
    sys.exit(f"JSON nesting exceeds limit while writing {path}: {exc}")
except (OSError, UnicodeError, ValueError) as exc:
    sys.exit(f"cannot write JSON to {path}: {exc}")
PY
}

spw_apply_manifest_overlay() {
  manifest="$1"
  version="$2"
  python3 - "$manifest" "$version" <<'PY'
import json
import sys

path, version = sys.argv[1:]
MAX_JSON_NESTING = 256

def reject_constant(constant):
    raise ValueError(f"non-standard numeric constant: {constant}")

def nesting_exceeds_limit(value):
    stack = [(value, 0)]
    while stack:
        current, depth = stack.pop()
        if isinstance(current, dict):
            next_depth = depth + 1
            if next_depth > MAX_JSON_NESTING:
                return True
            stack.extend((child, next_depth) for child in current.values())
        elif isinstance(current, list):
            next_depth = depth + 1
            if next_depth > MAX_JSON_NESTING:
                return True
            stack.extend((child, next_depth) for child in current)
    return False

try:
    with open(path, "r", encoding="utf-8") as f:
        data = json.load(f, parse_constant=reject_constant)
except RecursionError:
    sys.exit(f"JSON nesting exceeds limit in {path}")
except json.JSONDecodeError as exc:
    sys.exit(
        f"invalid manifest JSON in {path}: "
        f"line {exc.lineno} column {exc.colno}: {exc.msg}"
    )
except (OSError, UnicodeError) as exc:
    sys.exit(f"cannot read manifest JSON in {path}: {exc}")
except ValueError as exc:
    sys.exit(f"invalid manifest JSON in {path}: {exc}")

if nesting_exceeds_limit(data):
    sys.exit(f"JSON nesting exceeds limit in {path}")

if not isinstance(data, dict):
    sys.exit(f"manifest must be a JSON object: {path}")

data["version"] = version
data["skills"] = "./skills/"
data.pop("hooks", None)

try:
    with open(path, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2, allow_nan=False)
        f.write("\n")
except RecursionError as exc:
    sys.exit(f"manifest JSON nesting exceeds limit while writing {path}: {exc}")
except (OSError, UnicodeError, ValueError) as exc:
    sys.exit(f"cannot write manifest JSON in {path}: {exc}")
PY
}

spw_status_for_commits() {
  desired="$1"
  generated="$2"
  installed="$3"

  if [ -z "$generated" ]; then
    printf '%s\n' "needs prepare"
  elif ! spw_commit_matches "$desired" "$generated"; then
    printf '%s\n' "needs prepare"
  elif [ -z "$installed" ]; then
    printf '%s\n' "needs install"
  elif ! spw_commit_matches "$desired" "$installed"; then
    printf '%s\n' "needs install"
  else
    printf '%s\n' "current"
  fi
}

spw_metadata_commit_or_empty() {
  file="$1"
  if [ -f "$file" ]; then
    spw_json_get "$file" "commit"
  fi
}

spw_manifest_short_sha_or_empty() {
  file="$1"
  if [ ! -f "$file" ]; then
    return 0
  fi
  version=$(spw_json_get "$file" "version")
  case "$version" in
    *+manager.*)
      short="${version##*.}"
      case "$short" in
        ""|*[!0-9a-fA-F]*)
          ;;
        *)
          printf '%s\n' "$short"
          ;;
      esac
      ;;
  esac
}

# Codex installs a plugin into a versioned cache directory:
#   ~/.codex/plugins/cache/<marketplace>/superpowers/<version>/...
# so the metadata/manifest live one directory below the plugin name, not
# directly inside it (confirmed by the Task 1 behavior probe against the live
# install). Match both the versioned layout and a flat manager-cache layout (no
# intervening version directory).
spw_find_installed_metadata() {
  search_root="${SUPERPOWERS_INSTALLED_SEARCH_ROOT:-$HOME/.codex}"
  find "$search_root" \
    \( -path "*/plugins/cache/$SPW_MARKETPLACE_NAME/superpowers/.superpowers-upstream.json" \
       -o -path "*/plugins/cache/$SPW_MARKETPLACE_NAME/superpowers/*/.superpowers-upstream.json" \) \
    -type f 2>/dev/null | head -n 1
}

spw_find_installed_manifest() {
  search_root="${SUPERPOWERS_INSTALLED_SEARCH_ROOT:-$HOME/.codex}"
  find "$search_root" \
    \( -path "*/plugins/cache/$SPW_MARKETPLACE_NAME/superpowers/.codex-plugin/plugin.json" \
       -o -path "*/plugins/cache/$SPW_MARKETPLACE_NAME/superpowers/*/.codex-plugin/plugin.json" \) \
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
    data = json.loads(
        raw,
        parse_constant=lambda constant: (_ for _ in ()).throw(ValueError(constant)),
    )
except (json.JSONDecodeError, RecursionError, ValueError):
    sys.exit(2)
if not isinstance(data, dict):
    sys.exit(2)
items = data.get(array_key)
if not isinstance(items, list):
    sys.exit(2)
for item in items:
    if not isinstance(item, dict):
        sys.exit(2)
    item_value = item.get(field)
    if not isinstance(item_value, str) or not item_value:
        sys.exit(2)
found = any(item[field] == value for item in items)
print("present" if found else "absent")
PY
}

spw_snapshot_get() {
  snapshot="$1"
  key="$2"
  printf '%s\n' "$snapshot" | awk -F= -v key="$key" '$1 == key { print $2; found = 1 } END { if (!found) exit 1 }'
}

spw_codex_identity_snapshot() {
  codex_bin="$1"
  if ! plugin_listing=$("$codex_bin" plugin list --json 2>/dev/null); then
    spw_die "cannot list Codex plugins via '$codex_bin plugin list --json'"
  fi
  if ! manager_plugin=$(spw_json_array_has "$plugin_listing" installed pluginId "$SPW_PLUGIN_ID"); then
    spw_die "cannot parse output of '$codex_bin plugin list --json'"
  fi
  if ! legacy_plugin=$(spw_json_array_has "$plugin_listing" installed pluginId "$SPW_LEGACY_PLUGIN_ID"); then
    spw_die "cannot parse output of '$codex_bin plugin list --json'"
  fi

  if ! marketplace_listing=$("$codex_bin" plugin marketplace list --json 2>/dev/null); then
    spw_die "cannot list Codex marketplaces via '$codex_bin plugin marketplace list --json'"
  fi
  if ! manager_marketplace=$(spw_json_array_has "$marketplace_listing" marketplaces name "$SPW_MARKETPLACE_NAME"); then
    spw_die "cannot parse output of '$codex_bin plugin marketplace list --json'"
  fi
  if ! legacy_marketplace=$(spw_json_array_has "$marketplace_listing" marketplaces name "$SPW_LEGACY_MARKETPLACE_NAME"); then
    spw_die "cannot parse output of '$codex_bin plugin marketplace list --json'"
  fi

  manager=false
  legacy=false
  if [ "$manager_plugin" = present ] || [ "$manager_marketplace" = present ]; then
    manager=true
  fi
  if [ "$legacy_plugin" = present ] || [ "$legacy_marketplace" = present ]; then
    legacy=true
  fi
  case "$manager:$legacy" in
    true:true) identity_state=both ;;
    true:false) identity_state=manager ;;
    false:true) identity_state=legacy ;;
    false:false) identity_state=neither ;;
  esac

  printf 'manager_plugin=%s\n' "$([ "$manager_plugin" = present ] && printf true || printf false)"
  printf 'manager_marketplace=%s\n' "$([ "$manager_marketplace" = present ] && printf true || printf false)"
  printf 'legacy_plugin=%s\n' "$([ "$legacy_plugin" = present ] && printf true || printf false)"
  printf 'legacy_marketplace=%s\n' "$([ "$legacy_marketplace" = present ] && printf true || printf false)"
  printf 'identity_state=%s\n' "$identity_state"
}

spw_require_no_legacy_state() {
  case "$1" in
    neither|manager) return 0 ;;
    legacy|both)
      printf '%s\n' \
        'Legacy superpowers-wrapper Codex state is installed.' \
        'Run: npx superpowers-wrapper@0.1.1 uninstall' \
        'Then run: npx superpowers-manager@0.1.2 install' >&2
      return 1
      ;;
    *) spw_die "unknown Codex identity state: $1" ;;
  esac
}

# Print the registered root of <marketplace_name> from a marketplace-list JSON
# document (as a string argument, like spw_json_array_has), or nothing if the
# marketplace is absent. Exit 2 on unparseable JSON, a non-object item, or an
# item without a non-empty string name: such an item cannot be proven unrelated
# and must not be mistaken for an absent manager marketplace. Validate root only
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

# Reconcile Codex's manager marketplace pointer to <current_root>:
#   absent                     -> add
#   same physical root         -> keep
#   different root             -> remove, then add
# List/parse failures abort before any marketplace change. If remove
# succeeds and add fails, print a recovery command for the current root AND
# the previous root so the user can restore last-known-good state. Only the
# superpowers-manager marketplace is ever touched.
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

# Return the currently installed manager commit/fingerprint, or empty if the
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

# After an install, confirm the installed manager refreshed to <desired_commit>.
# Never prints a success line while the installed manager is detectably stale.
# Shared by scripts/install and scripts/update.
spw_verify_refresh() {
  desired_commit="$1"
  installed_commit=$(spw_installed_commit_or_empty || true)
  printf 'desired_commit=%s\n' "$desired_commit"
  printf 'installed_commit=%s\n' "$installed_commit"
  if [ -n "$installed_commit" ] && spw_commit_matches "$desired_commit" "$installed_commit"; then
    echo "manager updated"
    return 0
  fi
  if [ -n "$installed_commit" ]; then
    echo "error: installed manager is still stale after install; the local plugin cache did not refresh." >&2
    echo "hint: retry with SUPERPOWERS_INSTALL_REFRESH_MODE=remove-add" >&2
    exit 1
  fi
  echo "error: installed manager not detectable, cannot confirm refresh; verify with 'codex plugin list --json'." >&2
  return 1
}
