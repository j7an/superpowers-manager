#!/bin/sh
# Sourced module; callers own set -eu.

spw_selection_config_dir() {
  if [ "${SUPERPOWERS_CONFIG_DIR+x}" = x ]; then
    case "$SUPERPOWERS_CONFIG_DIR" in
      /*) printf '%s\n' "$SUPERPOWERS_CONFIG_DIR" ;;
      *) echo "error: SUPERPOWERS_CONFIG_DIR must be absolute" >&2; return 1 ;;
    esac
    return
  fi

  if [ -n "${XDG_CONFIG_HOME:-}" ]; then
    case "$XDG_CONFIG_HOME" in
      /*) printf '%s/superpowers-manager\n' "$XDG_CONFIG_HOME" ;;
      *) echo "error: XDG_CONFIG_HOME must be absolute" >&2; return 1 ;;
    esac
    return
  fi

  if [ -z "${HOME:-}" ]; then
    echo "error: HOME is required to locate selection state" >&2
    return 1
  fi
  case "$HOME" in
    /*) printf '%s/.config/superpowers-manager\n' "$HOME" ;;
    *) echo "error: HOME must be absolute" >&2; return 1 ;;
  esac
}

spw_selection_state_path() {
  _spw_selection_config_dir=$(spw_selection_config_dir) || return $?
  printf '%s/selection.json\n' "$_spw_selection_config_dir"
}

spw_selection_state() {
  _spw_selection_state_root="$1"
  shift
  if _spw_selection_state_error=$(
    python3 -S "$_spw_selection_state_root/scripts/core/selection-state.py" \
      "$@" 2>&1
  ); then
    :
  else
    _spw_selection_state_error=${_spw_selection_state_error#error: }
    spw_die "$_spw_selection_state_error"
  fi
}

spw_load_saved_selection() {
  _spw_selection_root="$1"
  _spw_selection_workspace="$2"
  SPW_SELECTION_STATE_PATH=$(spw_selection_state_path)
  if ! _spw_selection_normalized=$(mktemp "$_spw_selection_workspace/selection-state.XXXXXX"); then
    spw_die "cannot create normalized selection scratch file"
  fi

  if _spw_selection_error=$(
    python3 -S "$_spw_selection_root/scripts/core/selection-state.py" read \
      --path "$SPW_SELECTION_STATE_PATH" \
      --output "$_spw_selection_normalized" 2>&1
  ); then
    :
  else
    rm -f "$_spw_selection_normalized"
    _spw_selection_error=${_spw_selection_error#error: }
    spw_die "$_spw_selection_error"
  fi

  SPW_SAVED_MODE=$(spw_json_get "$_spw_selection_normalized" saved_mode)
  SPW_SAVED_SOURCE=$(spw_json_get "$_spw_selection_normalized" saved_source)
  SPW_SAVED_REQUESTED_REF=$(spw_json_get "$_spw_selection_normalized" saved_requested_ref)
  SPW_SAVED_RESOLVED_REF=$(spw_json_get "$_spw_selection_normalized" saved_resolved_ref)
  SPW_SAVED_COMMIT=$(spw_json_get "$_spw_selection_normalized" saved_commit)
  rm -f "$_spw_selection_normalized"

  export SPW_SELECTION_STATE_PATH
  export SPW_SAVED_MODE SPW_SAVED_SOURCE SPW_SAVED_REQUESTED_REF
  export SPW_SAVED_RESOLVED_REF SPW_SAVED_COMMIT
}

spw_compute_effective_selection() {
  _spw_selection_root="$1"
  _spw_selection_workspace="$2"
  spw_load_saved_selection "$_spw_selection_root" "$_spw_selection_workspace"

  if [ -n "${SUPERPOWERS_UPSTREAM_URL:-}" ]; then
    SPW_UPSTREAM_SOURCE_ORIGIN="environment"
    SPW_EFFECTIVE_SOURCE="$SUPERPOWERS_UPSTREAM_URL"
  elif [ "$SPW_SAVED_MODE" != "none" ]; then
    SPW_UPSTREAM_SOURCE_ORIGIN="user-config"
    SPW_EFFECTIVE_SOURCE="$SPW_SAVED_SOURCE"
  else
    SPW_UPSTREAM_SOURCE_ORIGIN="package-default"
    SPW_EFFECTIVE_SOURCE="$SPW_UPSTREAM_URL_DEFAULT"
  fi

  spw_selection_state "$_spw_selection_root" \
    validate-source --source="$SPW_EFFECTIVE_SOURCE"

  _spw_selection_uses_saved_pin=false
  if [ -n "${SUPERPOWERS_REF:-}" ]; then
    SPW_SELECTION_ORIGIN="environment"
    SPW_SELECTION_MODE="override"
    SPW_REQUESTED_REF="$SUPERPOWERS_REF"
  elif [ "$SPW_SAVED_MODE" = "pinned" ]; then
    SPW_SELECTION_ORIGIN="user-config"
    SPW_SELECTION_MODE="pinned"
    SPW_REQUESTED_REF="$SPW_SAVED_REQUESTED_REF"
    _spw_selection_uses_saved_pin=true
  elif [ "$SPW_SAVED_MODE" = "track-latest" ]; then
    SPW_SELECTION_ORIGIN="user-config"
    SPW_SELECTION_MODE="track-latest"
    SPW_REQUESTED_REF="latest-release"
  else
    SPW_SELECTION_ORIGIN="package-default"
    SPW_SELECTION_MODE="default"
    SPW_REQUESTED_REF=$(spw_config_ref "$_spw_selection_root")
  fi

  if [ "$_spw_selection_uses_saved_pin" = true ]; then
    SPW_RESOLVED_REF="$SPW_SAVED_RESOLVED_REF"
    SPW_DESIRED_COMMIT="$SPW_SAVED_COMMIT"
    if printf '%s' "$SPW_SAVED_REQUESTED_REF" | grep -Eq '^[0-9a-f]{40}$'; then
      SPW_RESOLUTION_KIND="raw-commit"
    else
      SPW_RESOLUTION_KIND="tag"
    fi
  else
    _spw_selection_resolution=$(
      spw_resolve_ref "$SPW_EFFECTIVE_SOURCE" "$SPW_REQUESTED_REF"
    )
    if _spw_selection_fields=$(
      printf '%s\n' "$_spw_selection_resolution" | awk '
        NR == 1 && NF == 3 { printf "%s\t%s\t%s\n", $1, $2, $3; next }
        { exit 1 }
        END { if (NR != 1) exit 1 }
      '
    ); then
      :
    else
      spw_die "invalid ref resolution result"
    fi
    _spw_selection_tab=$(printf '\tX')
    _spw_selection_tab=${_spw_selection_tab%X}
    IFS=$_spw_selection_tab read -r \
      SPW_RESOLUTION_KIND SPW_RESOLVED_REF SPW_DESIRED_COMMIT <<EOF
$_spw_selection_fields
EOF
  fi

  export SPW_SELECTION_ORIGIN SPW_SELECTION_MODE
  export SPW_UPSTREAM_SOURCE_ORIGIN SPW_EFFECTIVE_SOURCE
  export SPW_REQUESTED_REF SPW_RESOLVED_REF SPW_DESIRED_COMMIT
  export SPW_RESOLUTION_KIND
}

spw_display_source() {
  _spw_selection_display_source="$1"
  if _spw_selection_display=$(
    python3 -S "$(spw_root)/scripts/core/selection-state.py" \
      display-source --source="$_spw_selection_display_source" 2>/dev/null
  ); then
    printf '%s\n' "$_spw_selection_display"
  else
    printf '%s\n' '<redacted-source>'
  fi
}
