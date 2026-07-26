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

spw_upstream_cli() (
  _upstream_root=${SPW_MANAGER_ROOT:-${root-}}
  [ -n "$_upstream_root" ] || spw_die "manager root is not set"
  if _upstream_out=$(
    spw_node_cli "$_upstream_root" upstream-cli.js 'upstream helper' "$@" 2>&1
  ); then
    if [ -n "$_upstream_out" ]; then
      printf '%s\n' "$_upstream_out"
    fi
    return 0
  fi
  spw_die "${_upstream_out#error: }"
)

spw_git_safe_source() {
  spw_upstream_cli safe-source --source="$1"
}

spw_pin_kind() {
  spw_upstream_cli pin-kind --ref="$1"
}

spw_manifest_version_for_ref() {
  spw_upstream_cli manifest-version \
    --requested-ref="$1" --resolution-kind="$2" \
    --resolved-ref="$3" --commit="$4"
}

spw_resolve_ref() {
  spw_require_command git
  spw_upstream_cli resolve-ref --source="$1" --ref="$2"
}

spw_resolve_exact_tag() {
  spw_upstream_cli resolve-exact-tag --source="$1" --ref="$2"
}

spw_verify_raw_commit() {
  spw_upstream_cli verify-raw-commit \
    --source="$1" --commit="$2" --workspace-parent="$3"
}

spw_fetch_exact_commit() {
  spw_upstream_cli fetch-exact-commit \
    --source="$1" --commit="$2" --repository="$3" --workspace-parent="$4"
}
