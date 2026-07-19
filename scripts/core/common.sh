#!/bin/sh
# Sourced module; callers own set -eu.

spw_die() {
  echo "error: $*" >&2
  exit 1
}

spw_usage_error() {
  echo "error: $*" >&2
  exit 2
}

spw_require_command() {
  command_name="$1"
  if ! command -v "$command_name" >/dev/null 2>&1; then
    spw_die "required command not found: $command_name"
  fi
}

spw_make_workspace() {
  mktemp -d "$1/$2.XXXXXX"
}

spw_cleanup_workspace_trap() {
  _spw_workspace_trap_status=$?
  trap - 0 HUP INT TERM
  rm -rf "$_spw_workspace_trap_path" || :
  exit "$_spw_workspace_trap_status"
}

spw_install_workspace_trap() {
  _spw_workspace_trap_path="$1"
  trap spw_cleanup_workspace_trap 0
  trap 'exit 129' HUP
  trap 'exit 130' INT
  trap 'exit 143' TERM
}

spw_root() {
  CDPATH= cd -- "$(dirname "$0")/.." && pwd
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
