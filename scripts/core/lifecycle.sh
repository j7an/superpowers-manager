#!/bin/sh
# Sourced module; callers own set -eu.

# Replace the live tree with a single atomic rename, keeping a backup so a
# failed swap restores the previous working generated tree. candidate and
# live_root must be same-filesystem siblings for atomic renames.
spw_replace_generated_tree() {
  candidate="$1"
  live_root="$2"
  parent=$(dirname "$live_root")
  backup="$parent/.superpowers.bak.$$"

  rm -rf "$backup"
  if [ -e "$live_root" ]; then
    mv "$live_root" "$backup"
  fi
  if mv "$candidate" "$live_root"; then
    rm -rf "$backup"
  else
    if [ -e "$backup" ]; then
      mv "$backup" "$live_root"
    fi
    rm -rf "$candidate"
    spw_die "failed to install generated tree into $live_root; previous tree restored"
  fi
}

spw_generated_metadata_path() (
  generated_root="$1"
  printf '%s\n' "$generated_root/plugins/superpowers/.superpowers-upstream.json"
)

spw_generated_commit_or_empty() (
  generated_root="$1"
  generated_metadata=$(spw_generated_metadata_path "$generated_root")
  spw_metadata_commit_lenient_or_empty "$generated_metadata"
)

spw_probe_field() {
  printf '%s\n' "$1" | awk -F= -v key="$2" '$1 == key { print $2 }'
}

spw_require_no_legacy_state() {
  identity_state="$1"
  case "$identity_state" in
    neither|manager)
      return 0
      ;;
    legacy|both)
      printf '%s\n' \
        'Legacy superpowers-wrapper Codex state is installed.' \
        'Run: npx superpowers-wrapper@0.1.1 uninstall' \
        'Then run: npx superpowers-manager install' >&2
      return 1
      ;;
    *)
      spw_die "unknown adapter identity state: $identity_state"
      ;;
  esac
}

spw_require_managed_update_control() {
  case "$1" in
    managed) return 0 ;;
    unsupported)
      spw_die "adapter cannot guarantee manager-controlled updates"
      ;;
    *) spw_die "unknown adapter update-control capability: $1" ;;
  esac
}

spw_report_legacy_state() {
  case "$1" in
    legacy|both)
      printf '%s\n' \
        'Legacy superpowers-wrapper Codex state remains installed.' \
        'Run: npx superpowers-wrapper@0.1.1 uninstall'
      ;;
    neither|manager)
      ;;
    *)
      spw_die "unknown adapter identity state: $1"
      ;;
  esac
}

spw_verify_installed_fingerprint() {
  desired_commit="$1"
  install_result="$2"
  inspect_result="$3"
  if ! spw_inspect_fingerprint "$inspect_result"; then
    echo "error: installed manager fingerprint inspection failed after install." >&2
    return 1
  fi
  if ! installed_commit=$(spw_adapter_result_get "$inspect_result" "fingerprint"); then
    echo "error: cannot parse installed manager fingerprint inspection result after install." >&2
    return 1
  fi
  printf 'desired_commit=%s\n' "$desired_commit"
  printf 'installed_commit=%s\n' "$installed_commit"
  if [ -n "$installed_commit" ] && spw_commit_matches "$desired_commit" "$installed_commit"; then
    echo "manager updated"
    return 0
  fi

  hint=""
  if [ -f "$install_result" ]; then
    if [ -n "$installed_commit" ]; then
      hint=$(spw_adapter_result_get "$install_result" "verification_hints.mismatch" || true)
    else
      hint=$(spw_adapter_result_get "$install_result" "verification_hints.missing" || true)
    fi
  fi

  if [ -n "$installed_commit" ]; then
    echo "error: installed manager fingerprint does not match the prepared plugin after install." >&2
  else
    echo "error: installed manager fingerprint is not detectable after install." >&2
  fi
  if [ -n "$hint" ]; then
    echo "hint: $hint" >&2
  fi
  return 1
}

spw_verify_uninstalled_resources() {
  inspect_result="$1"

  if ! plugin_present=$(spw_adapter_result_boolean "$inspect_result" "resources.plugin"); then
    return 1
  fi
  if ! marketplace_present=$(spw_adapter_result_boolean "$inspect_result" "resources.marketplace"); then
    return 1
  fi
  if [ "$plugin_present" = true ]; then
    spw_die "owned plugin resource is still installed after removal"
  fi
  if [ "$marketplace_present" = true ]; then
    spw_die "owned marketplace resource is still registered after removal"
  fi
}
