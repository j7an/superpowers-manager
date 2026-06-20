#!/bin/sh

SPW_UPSTREAM_URL_DEFAULT="https://github.com/obra/superpowers"
SPW_PLUGIN_ID="superpowers@superpowers-wrapper"
SPW_MARKETPLACE_NAME="superpowers-wrapper"

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

spw_manifest_version_for_commit() {
  commit="$1"
  short=$(printf '%s' "$commit" | cut -c 1-7)
  printf '0.0.0+wrapper.%s\n' "$short"
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
    printf '%s\n' "$selected"
    return
  fi

  if printf '%s' "$requested_ref" | grep -Eq '^[0-9a-fA-F]{40}$'; then
    printf '%s %s\n' "$requested_ref" "$requested_ref"
    return
  fi

  if ! tag_output=$(git ls-remote --tags "$upstream_url" "refs/tags/$requested_ref^{}" 2>&1); then
    spw_die "cannot query upstream tag $requested_ref from $upstream_url: $tag_output"
  fi
  resolved=$(printf '%s\n' "$tag_output" | awk 'NF >= 2 { print $1; exit }')
  if [ -n "$resolved" ]; then
    printf '%s %s\n' "$requested_ref" "$resolved"
    return
  fi

  if ! ref_output=$(git ls-remote "$upstream_url" "$requested_ref" 2>&1); then
    spw_die "cannot query upstream ref $requested_ref from $upstream_url: $ref_output"
  fi
  resolved=$(printf '%s\n' "$ref_output" | awk 'NF >= 2 { print $1; exit }')
  if [ -n "$resolved" ]; then
    printf '%s %s\n' "$requested_ref" "$resolved"
    return
  fi

  spw_die "cannot resolve upstream ref: $requested_ref"
}

spw_json_get() {
  file="$1"
  key="$2"
  python3 - "$file" "$key" <<'PY'
import json, sys
with open(sys.argv[1], "r", encoding="utf-8") as f:
    data = json.load(f)
value = data
for part in sys.argv[2].split("."):
    value = value.get(part, "")
print(value if value is not None else "")
PY
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
with open(path, "w", encoding="utf-8") as f:
    json.dump(data, f, indent=2)
    f.write("\n")
PY
}

spw_update_manifest_version() {
  manifest="$1"
  version="$2"
  python3 - "$manifest" "$version" <<'PY'
import json, sys
path, version = sys.argv[1:]
with open(path, "r", encoding="utf-8") as f:
    data = json.load(f)
data["version"] = version
data.pop("hooks", None)
with open(path, "w", encoding="utf-8") as f:
    json.dump(data, f, indent=2)
    f.write("\n")
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
    0.0.0+wrapper.[0-9a-fA-F]*)
      printf '%s\n' "${version##*.}"
      ;;
  esac
}

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

# Decide, after an install, whether the wrapper refreshed. Given the re-probe
# status and the detected installed commit, return one of:
#   ok           - installed wrapper matches desired
#   stale        - installed wrapper is detectable but does NOT match desired
#                  (the install did not refresh the local plugin cache)
#   unverifiable - installed wrapper cannot be detected, so refresh cannot be
#                  confirmed either way
#   error        - an unexpected post-install status
# This lets `update` stay honest regardless of whether add-only or remove/add
# is the correct Codex refresh path: it never claims success while the
# installed wrapper is detectably stale.
spw_post_install_status() {
  status="$1"
  installed="$2"
  if [ "$status" = "current" ]; then
    printf '%s\n' "ok"
  elif [ "$status" = "needs install" ] && [ -n "$installed" ]; then
    printf '%s\n' "stale"
  elif [ "$status" = "needs install" ]; then
    printf '%s\n' "unverifiable"
  else
    printf '%s\n' "error"
  fi
}
