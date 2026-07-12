#!/bin/sh
# Sourced module; callers own set -eu.

spw_adapter_package_root() {
  if [ -n "${SPW_PACKAGE_ROOT:-}" ]; then
    printf '%s\n' "$SPW_PACKAGE_ROOT"
  elif [ -n "${root:-}" ]; then
    printf '%s\n' "$root"
  else
    spw_root
  fi
}

SPW_ADAPTER_ROOT=$(spw_adapter_package_root)
SPW_ADAPTER="${SPW_ADAPTER:-$SPW_ADAPTER_ROOT/scripts/adapters/codex/adapter}"
SPW_ADAPTER_RESPONSE_VALIDATOR="${SPW_ADAPTER_RESPONSE_VALIDATOR:-$SPW_ADAPTER_ROOT/scripts/core/validate-adapter-response.py}"

spw_invoke_adapter() {
  operation="$1"
  result_file="$2"
  inspect_view="$3"
  shift 3
  [ "${1:-}" = "--" ] || spw_die "internal adapter invocation missing --"
  shift

  response_file="${result_file}.response"
  adapter_exit=0
  "$SPW_ADAPTER" "$operation" "$@" > "$response_file" || adapter_exit=$?

  args=""
  if [ -n "$inspect_view" ]; then
    args="$inspect_view"
  fi
  if [ -n "$args" ]; then
    python3 -S "$SPW_ADAPTER_RESPONSE_VALIDATOR" \
      --operation "$operation" --adapter-exit "$adapter_exit" \
      --response "$response_file" --result "$result_file" \
      --inspect-view "$inspect_view"
  else
    python3 -S "$SPW_ADAPTER_RESPONSE_VALIDATOR" \
      --operation "$operation" --adapter-exit "$adapter_exit" \
      --response "$response_file" --result "$result_file"
  fi
}

spw_adapter_result_get() {
  result_file="$1"
  dotted_key="$2"
  spw_json_get "$result_file" "$dotted_key"
}
