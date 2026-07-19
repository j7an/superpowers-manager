#!/bin/sh
# Sourced module; callers own set -eu.

SPW_UPSTREAM_URL_DEFAULT="https://github.com/obra/superpowers"

spw_config_ref() (
  config_root="$1"
  if [ -n "${SUPERPOWERS_REF:-}" ]; then
    printf '%s\n' "$SUPERPOWERS_REF"
    return
  fi
  sed -n '1{s/[[:space:]]*$//;p;}' "$config_root/config/upstream-ref"
)

spw_short_commit() {
  commit="$1"
  printf '%s' "$commit" | cut -c 1-7
}

spw_is_semver_base() {
  version="$1"
  printf '%s' "$version" | grep -Eq '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-((0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*)(\.(0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*))*))?$'
}

spw_is_pinnable_tag() {
  ref="$1"
  case "$ref" in
    *'
'*|*"$(printf '\r')"*) return 1 ;;
    v*) spw_is_semver_base "${ref#v}" ;;
    *) return 1 ;;
  esac
}

spw_is_full_commit() {
  ref="$1"
  [ "${#ref}" -eq 40 ] || return 1
  case "$ref" in
    *[!0-9A-Fa-f]*) return 1 ;;
    *) return 0 ;;
  esac
}

spw_git_safe_source() {
  source="$1"
  case "$source" in
    /*|*://*|*:*|~*) printf '%s\n' "$source" ;;
    *) printf '%s/%s\n' "$(pwd -P)" "$source" ;;
  esac
}

spw_resolve_exact_tag() {
  source="$1"
  ref="$2"
  source_display=$(spw_display_source "$source")
  query_source=$(spw_git_safe_source "$source")
  if ! output=$(git ls-remote --tags -- "$query_source" "refs/tags/$ref" "refs/tags/$ref^{}" 2>&1); then
    spw_die "cannot query exact upstream tag $ref from $source_display: $output"
  fi
  commit=$(printf '%s\n' "$output" | awk -v direct="refs/tags/$ref" '
    $2 == direct { direct_sha = $1 }
    $2 == direct "^{}" { peeled_sha = $1 }
    END { if (peeled_sha != "") print peeled_sha; else if (direct_sha != "") print direct_sha }
  ')
  [ -n "$commit" ] || spw_die "upstream tag not found: $ref"
  printf '%s\n' "$commit"
}

spw_verify_raw_commit() (
  source="$1"
  commit=$(printf '%s' "$2" | tr '[:upper:]' '[:lower:]')
  workspace="$3"
  source_display=$(spw_display_source "$source")
  fetch_source=$(spw_git_safe_source "$source")

  if ! verify_workspace=$(spw_make_workspace "$workspace" "superpowers-manager.commit"); then
    spw_die "cannot create raw-commit verification workspace under $workspace"
  fi
  spw_install_workspace_trap "$verify_workspace"

  if ! init_output=$(git init "$verify_workspace" 2>&1); then
    spw_die "cannot initialize raw-commit verification workspace: $init_output"
  fi
  if fetch_output=$(git -C "$verify_workspace" fetch --no-tags -- "$fetch_source" "$commit" 2>&1); then
    :
  else
    case "$fetch_output" in
      *'not our ref'*|*'unadvertised object'*|*"couldn't find remote ref"*)
        spw_die "source cannot supply requested commit: $commit"
        ;;
      *)
        spw_die "cannot fetch requested commit from $source_display"
        ;;
    esac
  fi
  if ! object_type=$(git -C "$verify_workspace" cat-file -t "$commit" 2>/dev/null); then
    spw_die "requested object is not a commit: $commit"
  fi
  if [ "$object_type" != commit ]; then
    spw_die "requested object is not a commit: $commit"
  fi
  printf '%s\n' "$commit"
)

spw_fetch_exact_commit() (
  source="$1"
  commit="$2"
  repository="$3"
  workspace="$4"
  source_display=$(spw_display_source "$source")
  fetch_source=$(spw_git_safe_source "$source")

  if ! fetch_workspace=$(spw_make_workspace "$workspace" "superpowers-manager.fetch"); then
    spw_die "cannot create exact-commit fetch workspace under $workspace"
  fi
  spw_install_workspace_trap "$fetch_workspace"

  if ! init_output=$(git init "$fetch_workspace" 2>&1); then
    spw_die "cannot initialize exact-commit fetch workspace: $init_output"
  fi
  if fetch_output=$(git -C "$fetch_workspace" fetch --no-tags -- "$fetch_source" "$commit" 2>&1); then
    :
  else
    case "$fetch_output" in
      *'not our ref'*|*'unadvertised object'*|*"couldn't find remote ref"*)
        spw_die "source cannot supply requested commit: $commit"
        ;;
      *)
        spw_die "cannot fetch requested commit from $source_display"
        ;;
    esac
  fi
  if ! object_type=$(git -C "$fetch_workspace" cat-file -t "$commit" 2>/dev/null); then
    spw_die "requested object is not a commit: $commit"
  fi
  if [ "$object_type" != commit ]; then
    spw_die "requested object is not a commit: $commit"
  fi

  if [ ! -d "$repository/.git" ]; then
    if ! init_output=$(git init "$repository" 2>&1); then
      spw_die "cannot initialize upstream cache repository: $init_output"
    fi
  fi
  if ! transfer_output=$(
    git -C "$repository" fetch --no-tags -- "$fetch_workspace" "$commit" 2>&1
  ); then
    spw_die "cannot transfer requested commit into upstream cache: $transfer_output"
  fi
  if ! object_type=$(git -C "$repository" cat-file -t "$commit" 2>/dev/null); then
    spw_die "cannot verify requested commit in upstream cache: $commit"
  fi
  if [ "$object_type" != commit ]; then
    spw_die "cannot verify requested commit in upstream cache: $commit"
  fi
)

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
  query_source=$(spw_git_safe_source "$upstream_url")

  if [ "$requested_ref" = "latest-release" ]; then
    if ! output=$(git ls-remote --tags -- "$query_source" 'refs/tags/v*' 2>&1); then
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

  if ! tag_output=$(git ls-remote --tags -- "$query_source" "refs/tags/$requested_ref" "refs/tags/$requested_ref^{}" 2>&1); then
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

  if ! ref_output=$(git ls-remote -- "$query_source" "$requested_ref" 2>&1); then
    spw_die "cannot query upstream ref $requested_ref from $upstream_url: $ref_output"
  fi
  resolved=$(printf '%s\n' "$ref_output" | awk 'NF >= 2 { print $1; exit }')
  if [ -n "$resolved" ]; then
    printf 'ref %s %s\n' "$requested_ref" "$resolved"
    return
  fi

  spw_die "cannot resolve upstream ref: $requested_ref"
}
