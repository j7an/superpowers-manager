#!/bin/sh
set -eu

root=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)

python3 -S "$root/tests/test_selection_state.py"

. "$root/scripts/core/common.sh"
. "$root/scripts/core/provenance.sh"
. "$root/scripts/core/upstream.sh"
. "$root/scripts/core/selection.sh"

tmpdir=$(mktemp -d)
trap 'rm -rf "$tmpdir"' EXIT INT TERM
mkdir -p "$tmpdir/home" "$tmpdir/workspace" "$tmpdir/config-root/config"
ln -s "$root/scripts" "$tmpdir/config-root/scripts"
printf '%s\n' 'v1.2.3' > "$tmpdir/config-root/config/upstream-ref"

test "$(SUPERPOWERS_CONFIG_DIR="$tmpdir/explicit" spw_selection_config_dir)" = "$tmpdir/explicit"
test "$(XDG_CONFIG_HOME="$tmpdir/xdg" HOME="$tmpdir/home" spw_selection_config_dir)" = "$tmpdir/xdg/superpowers-manager"
test "$(XDG_CONFIG_HOME= HOME="$tmpdir/home" spw_selection_config_dir)" = "$tmpdir/home/.config/superpowers-manager"
test "$(HOME="$tmpdir/home" spw_selection_config_dir)" = "$tmpdir/home/.config/superpowers-manager"

if (SUPERPOWERS_CONFIG_DIR=relative spw_selection_config_dir) >"$tmpdir/out" 2>&1; then
  echo "relative SUPERPOWERS_CONFIG_DIR unexpectedly succeeded" >&2
  exit 1
fi
grep -Fq 'SUPERPOWERS_CONFIG_DIR must be absolute' "$tmpdir/out"
if (XDG_CONFIG_HOME=relative HOME="$tmpdir/home" spw_selection_config_dir) >"$tmpdir/out" 2>&1; then
  echo "relative XDG_CONFIG_HOME unexpectedly succeeded" >&2
  exit 1
fi
grep -Fq 'XDG_CONFIG_HOME must be absolute' "$tmpdir/out"
if env -u HOME -u XDG_CONFIG_HOME -u SUPERPOWERS_CONFIG_DIR sh -c ". '$root/scripts/core/common.sh'; . '$root/scripts/core/selection.sh'; spw_selection_config_dir" >"$tmpdir/out" 2>&1; then
  echo "missing HOME unexpectedly succeeded" >&2
  exit 1
fi
grep -Fq 'HOME is required' "$tmpdir/out"

if (spw_usage_error 'bad arguments') >"$tmpdir/out" 2>&1; then
  echo "usage error unexpectedly succeeded" >&2
  exit 1
else
  status=$?
fi
test "$status" -eq 2
grep -Fq 'error: bad arguments' "$tmpdir/out"

official_source='https://github.com/obra/superpowers'
saved_source='ssh://git@github.com/example/saved.git'
environment_source='/tmp/environment upstream'
pinned_commit='0123456789abcdef0123456789abcdef01234567'
resolved_default='1111111111111111111111111111111111111111'
resolved_environment='2222222222222222222222222222222222222222'
resolved_latest='9999999999999999999999999999999999999999'
resolver_log="$tmpdir/resolver.log"

spw_resolve_ref() {
  printf '%s|%s\n' "$1" "$2" >> "$resolver_log"
  case "$2" in
    latest-release) printf '%s\n' "latest-release v9.9.9 $resolved_latest" ;;
    v1.2.3) printf '%s\n' "tag v1.2.3 $resolved_default" ;;
    *) printf '%s\n' "ref $2 $resolved_environment" ;;
  esac
}

absent_config="$tmpdir/absent"
track_config="$tmpdir/track"
pinned_config="$tmpdir/pinned"
python3 -S "$root/scripts/core/selection-state.py" write-track-latest \
  --path "$track_config/selection.json" --source "$saved_source"
python3 -S "$root/scripts/core/selection-state.py" write-pinned \
  --path "$pinned_config/selection.json" --source "$saved_source" \
  --requested-ref v6.1.1 --resolved-ref v6.1.1 --commit "$pinned_commit"

clear_overrides() {
  unset SUPERPOWERS_REF SUPERPOWERS_UPSTREAM_URL || :
}

assert_exported_selection() {
  sh -c '
    set -u
    : "$SPW_SELECTION_STATE_PATH" "$SPW_SAVED_MODE" "$SPW_SAVED_SOURCE"
    : "$SPW_SAVED_REQUESTED_REF" "$SPW_SAVED_RESOLVED_REF" "$SPW_SAVED_COMMIT"
    : "$SPW_SELECTION_ORIGIN" "$SPW_SELECTION_MODE" "$SPW_UPSTREAM_SOURCE_ORIGIN"
    : "$SPW_EFFECTIVE_SOURCE" "$SPW_REQUESTED_REF" "$SPW_RESOLVED_REF"
    : "$SPW_DESIRED_COMMIT" "$SPW_RESOLUTION_KIND"
  '
}

assert_effective() {
  expected_selection_origin="$1"
  expected_selection_mode="$2"
  expected_source_origin="$3"
  expected_source="$4"
  expected_requested="$5"
  expected_resolved="$6"
  expected_commit="$7"
  expected_kind="$8"
  test "$SPW_SELECTION_ORIGIN" = "$expected_selection_origin"
  test "$SPW_SELECTION_MODE" = "$expected_selection_mode"
  test "$SPW_UPSTREAM_SOURCE_ORIGIN" = "$expected_source_origin"
  test "$SPW_EFFECTIVE_SOURCE" = "$expected_source"
  test "$SPW_REQUESTED_REF" = "$expected_requested"
  test "$SPW_RESOLVED_REF" = "$expected_resolved"
  test "$SPW_DESIRED_COMMIT" = "$expected_commit"
  test "$SPW_RESOLUTION_KIND" = "$expected_kind"
  assert_exported_selection
}

# Absent state: packaged defaults, then independent environment overrides.
clear_overrides
SUPERPOWERS_CONFIG_DIR="$absent_config"
export SUPERPOWERS_CONFIG_DIR
: > "$resolver_log"
spw_compute_effective_selection "$tmpdir/config-root" "$tmpdir/workspace"
assert_effective package-default default package-default "$official_source" \
  v1.2.3 v1.2.3 "$resolved_default" tag
test "$SPW_SAVED_MODE" = none
test "$(wc -l < "$resolver_log" | tr -d ' ')" -eq 1

clear_overrides
SUPERPOWERS_CONFIG_DIR="$absent_config"
SUPERPOWERS_REF=main
SUPERPOWERS_UPSTREAM_URL="$environment_source"
export SUPERPOWERS_CONFIG_DIR SUPERPOWERS_REF SUPERPOWERS_UPSTREAM_URL
: > "$resolver_log"
spw_compute_effective_selection "$tmpdir/config-root" "$tmpdir/workspace"
assert_effective environment override environment "$environment_source" \
  main main "$resolved_environment" ref

clear_overrides
SUPERPOWERS_CONFIG_DIR="$absent_config"
SUPERPOWERS_REF=main
export SUPERPOWERS_CONFIG_DIR SUPERPOWERS_REF
: > "$resolver_log"
spw_compute_effective_selection "$tmpdir/config-root" "$tmpdir/workspace"
assert_effective environment override package-default "$official_source" \
  main main "$resolved_environment" ref

clear_overrides
SUPERPOWERS_CONFIG_DIR="$absent_config"
SUPERPOWERS_UPSTREAM_URL="$environment_source"
export SUPERPOWERS_CONFIG_DIR SUPERPOWERS_UPSTREAM_URL
: > "$resolver_log"
spw_compute_effective_selection "$tmpdir/config-root" "$tmpdir/workspace"
assert_effective package-default default environment "$environment_source" \
  v1.2.3 v1.2.3 "$resolved_default" tag

# Track-latest state: saved ref and source can each be overridden independently.
clear_overrides
SUPERPOWERS_CONFIG_DIR="$track_config"
export SUPERPOWERS_CONFIG_DIR
: > "$resolver_log"
spw_compute_effective_selection "$tmpdir/config-root" "$tmpdir/workspace"
assert_effective user-config track-latest user-config "$saved_source" \
  latest-release v9.9.9 "$resolved_latest" latest-release
test "$SPW_SAVED_MODE" = track-latest

clear_overrides
SUPERPOWERS_CONFIG_DIR="$track_config"
SUPERPOWERS_REF=main
export SUPERPOWERS_CONFIG_DIR SUPERPOWERS_REF
: > "$resolver_log"
spw_compute_effective_selection "$tmpdir/config-root" "$tmpdir/workspace"
assert_effective environment override user-config "$saved_source" \
  main main "$resolved_environment" ref

clear_overrides
SUPERPOWERS_CONFIG_DIR="$track_config"
SUPERPOWERS_UPSTREAM_URL="$environment_source"
export SUPERPOWERS_CONFIG_DIR SUPERPOWERS_UPSTREAM_URL
: > "$resolver_log"
spw_compute_effective_selection "$tmpdir/config-root" "$tmpdir/workspace"
assert_effective user-config track-latest environment "$environment_source" \
  latest-release v9.9.9 "$resolved_latest" latest-release

clear_overrides
SUPERPOWERS_CONFIG_DIR="$track_config"
SUPERPOWERS_REF=main
SUPERPOWERS_UPSTREAM_URL="$environment_source"
export SUPERPOWERS_CONFIG_DIR SUPERPOWERS_REF SUPERPOWERS_UPSTREAM_URL
: > "$resolver_log"
spw_compute_effective_selection "$tmpdir/config-root" "$tmpdir/workspace"
assert_effective environment override environment "$environment_source" \
  main main "$resolved_environment" ref

# Pinned state reuses its verified identity unless the ref itself is overridden.
clear_overrides
SUPERPOWERS_CONFIG_DIR="$pinned_config"
export SUPERPOWERS_CONFIG_DIR
: > "$resolver_log"
spw_compute_effective_selection "$tmpdir/config-root" "$tmpdir/workspace"
assert_effective user-config pinned user-config "$saved_source" \
  v6.1.1 v6.1.1 "$pinned_commit" tag
test ! -s "$resolver_log"
test "$SPW_SAVED_REQUESTED_REF" = v6.1.1
test "$SPW_SAVED_RESOLVED_REF" = v6.1.1
test "$SPW_SAVED_COMMIT" = "$pinned_commit"

clear_overrides
SUPERPOWERS_CONFIG_DIR="$pinned_config"
SUPERPOWERS_REF=main
export SUPERPOWERS_CONFIG_DIR SUPERPOWERS_REF
: > "$resolver_log"
spw_compute_effective_selection "$tmpdir/config-root" "$tmpdir/workspace"
assert_effective environment override user-config "$saved_source" \
  main main "$resolved_environment" ref
test "$(wc -l < "$resolver_log" | tr -d ' ')" -eq 1

clear_overrides
SUPERPOWERS_CONFIG_DIR="$pinned_config"
SUPERPOWERS_UPSTREAM_URL="$environment_source"
export SUPERPOWERS_CONFIG_DIR SUPERPOWERS_UPSTREAM_URL
: > "$resolver_log"
spw_compute_effective_selection "$tmpdir/config-root" "$tmpdir/workspace"
assert_effective user-config pinned environment "$environment_source" \
  v6.1.1 v6.1.1 "$pinned_commit" tag
test ! -s "$resolver_log"

clear_overrides
SUPERPOWERS_CONFIG_DIR="$pinned_config"
SUPERPOWERS_REF=main
SUPERPOWERS_UPSTREAM_URL="$environment_source"
export SUPERPOWERS_CONFIG_DIR SUPERPOWERS_REF SUPERPOWERS_UPSTREAM_URL
: > "$resolver_log"
spw_compute_effective_selection "$tmpdir/config-root" "$tmpdir/workspace"
assert_effective environment override environment "$environment_source" \
  main main "$resolved_environment" ref

# Resolver output is parsed as data even when a mutable ref contains a glob.
clear_overrides
SUPERPOWERS_CONFIG_DIR="$absent_config"
SUPERPOWERS_REF='*'
export SUPERPOWERS_CONFIG_DIR SUPERPOWERS_REF
: > "$resolver_log"
spw_compute_effective_selection "$tmpdir/config-root" "$tmpdir/workspace"
assert_effective environment override package-default "$official_source" \
  '*' '*' "$resolved_environment" ref

# Raw commit saved pins derive their resolution kind without resolver access.
raw_config="$tmpdir/raw"
python3 -S "$root/scripts/core/selection-state.py" write-pinned \
  --path "$raw_config/selection.json" --source "$saved_source" \
  --requested-ref "$pinned_commit" --resolved-ref "$pinned_commit" \
  --commit "$pinned_commit"
clear_overrides
SUPERPOWERS_CONFIG_DIR="$raw_config"
export SUPERPOWERS_CONFIG_DIR
: > "$resolver_log"
spw_compute_effective_selection "$tmpdir/config-root" "$tmpdir/workspace"
assert_effective user-config pinned user-config "$saved_source" \
  "$pinned_commit" "$pinned_commit" "$pinned_commit" raw-commit
test ! -s "$resolver_log"

# Invalid saved state fails before source validation can reach ref resolution.
malformed_config="$tmpdir/malformed"
mkdir -p "$malformed_config"
printf '%s\n' '{"schema_version":2,"mode":"track-latest","source":"https://example.invalid/repo"}' > "$malformed_config/selection.json"
clear_overrides
SUPERPOWERS_CONFIG_DIR="$malformed_config"
SUPERPOWERS_REF=main
SUPERPOWERS_UPSTREAM_URL="$environment_source"
export SUPERPOWERS_CONFIG_DIR SUPERPOWERS_REF SUPERPOWERS_UPSTREAM_URL
: > "$resolver_log"
if (spw_compute_effective_selection "$tmpdir/config-root" "$tmpdir/workspace") >"$tmpdir/out" 2>&1; then
  echo "malformed saved state unexpectedly succeeded" >&2
  exit 1
fi
grep -Fq 'schema_version must equal integer 1' "$tmpdir/out"
test ! -s "$resolver_log"

# Effective HTTP(S) userinfo is rejected before resolver access and display is safe.
clear_overrides
SUPERPOWERS_CONFIG_DIR="$absent_config"
SUPERPOWERS_UPSTREAM_URL='https://token@example.invalid/repo'
export SUPERPOWERS_CONFIG_DIR SUPERPOWERS_UPSTREAM_URL
: > "$resolver_log"
if (spw_compute_effective_selection "$tmpdir/config-root" "$tmpdir/workspace") >"$tmpdir/out" 2>&1; then
  echo "credential-bearing source unexpectedly succeeded" >&2
  exit 1
fi
grep -Fq 'HTTP(S) source must not include userinfo' "$tmpdir/out"
test ! -s "$resolver_log"
test "$(spw_display_source "$SUPERPOWERS_UPSTREAM_URL")" = '<redacted-source>'
test "$(spw_display_source "$official_source")" = "$official_source"

printf '%s\n' OK
