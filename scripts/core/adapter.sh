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

spw_adapter_result_boolean() {
  result_file="$1"
  dotted_key="$2"
  value=$(spw_adapter_result_get "$result_file" "$dotted_key")
  case "$value" in
    true|True)
      printf 'true\n'
      ;;
    false|False)
      printf 'false\n'
      ;;
    *)
      spw_die "expected Boolean adapter result at $dotted_key in $result_file"
      ;;
  esac
}

spw_inspect_fingerprint() {
  result_file="$1"
  spw_invoke_adapter inspect "$result_file" fingerprint -- --view fingerprint
}

spw_inspect_ownership() {
  result_file="$1"
  spw_invoke_adapter inspect "$result_file" ownership -- --view ownership
}

spw_adapter_install() {
  result_file="$1"
  package_root="$2"
  spw_invoke_adapter install "$result_file" "" -- --package-root "$package_root"
}

spw_adapter_uninstall() {
  result_file="$1"
  plugin_present="$2"
  marketplace_present="$3"
  spw_invoke_adapter uninstall "$result_file" "" -- \
    --plugin-present "$plugin_present" \
    --marketplace-present "$marketplace_present"
}
