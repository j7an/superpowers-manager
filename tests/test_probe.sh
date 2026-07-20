#!/bin/sh
set -eu

test_dir=$(CDPATH= cd -- "$(dirname "$0")" && pwd)
. "$test_dir/lib/harness.sh"
spw_test_root

test_probe_status() {
  . "$root/scripts/core/common.sh"
  . "$root/scripts/core/provenance.sh"
  . "$root/scripts/core/upstream.sh"
  . "$root/scripts/core/selection.sh"
  . "$root/scripts/core/status.sh"
  . "$root/scripts/core/lifecycle.sh"

  desired="896224c4b1879920ab573417e68fd51d2ccc9072"

  # Probe source fields must always use the defensive display path.
  test "$(spw_display_source 'https://example.invalid/upstream')" = \
    'https://example.invalid/upstream'
  test "$(spw_display_source 'https://token@example.invalid/upstream')" = \
    '<redacted-source>'

  test "$(spw_status_for_commits "$desired" "" "")" = "needs prepare"
  test "$(spw_status_for_commits "$desired" "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" "")" = "needs prepare"
  test "$(spw_status_for_commits "$desired" "$desired" "")" = "needs install"
  test "$(spw_status_for_commits "$desired" "$desired" "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")" = "needs install"
  test "$(spw_status_for_commits "$desired" "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" "$desired")" = "needs prepare"
  test "$(spw_status_for_commits "$desired" "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" "896224c")" = "needs prepare"
  test "$(spw_status_for_commits "$desired" "$desired" "$desired")" = "current"
  test "$(spw_status_for_commits "$desired" "$desired" "896224c")" = "current"

  # spw_commit_matches: full-sha match, 7-char short-sha match, mismatch, and
  # the load-bearing empty-observed invariant (empty must NOT match).
  spw_commit_matches "$desired" "$desired"
  spw_commit_matches "$desired" "896224c"
  ! spw_commit_matches "$desired" "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef"
  ! spw_commit_matches "$desired" ""

  spw_test_tmpdir
  mkdir -p "$tmpdir/plugin/.codex-plugin"
  assert_manifest_short() {
    version="$1"
    expected="$2"
    cat > "$tmpdir/plugin/.codex-plugin/plugin.json" <<JSON
{
  "name": "superpowers",
  "version": "$version"
}
JSON
    actual=$( . "$root/scripts/adapters/codex/lib.sh"; spw_manifest_short_sha_or_empty "$tmpdir/plugin/.codex-plugin/plugin.json")
    if [ "$actual" != "$expected" ]; then
      echo "unexpected manifest short sha for $version: $actual (expected $expected)" >&2
      exit 1
    fi
  }

  assert_manifest_short "6.0.3+manager.896224c" "896224c"
  assert_manifest_short "6.1.0-beta.1+manager.abc1234" "abc1234"
  assert_manifest_short "0.0.0-main+manager.def5678" "def5678"
  assert_manifest_short "0.0.0-ref-feature-foo+manager.fedcba9" "fedcba9"
  assert_manifest_short "0.0.0-ref-042+manager.0123abc" "0123abc"
  assert_manifest_short "0.0.0+manager.896224c" "896224c"
  # The template's placeholder version is not a real fingerprint -> empty.
  assert_manifest_short "0.0.0+manager.template" ""
  assert_manifest_short "6.0.3+manager.abcxyz1" ""

  fixture_generated_root="$tmpdir/generated-root"
  fixture_generated_metadata="$fixture_generated_root/plugins/superpowers/.superpowers-upstream.json"
  mkdir -p "$(dirname "$fixture_generated_metadata")"

  printf '%s\n' '{' > "$fixture_generated_metadata"
  test "$(spw_generated_commit_or_empty "$fixture_generated_root")" = ""

  printf '%s\n' '{"commit": 7}' > "$fixture_generated_metadata"
  test "$(spw_generated_commit_or_empty "$fixture_generated_root")" = ""

  printf '%s\n' '{"commit": "not-a-commit"}' > "$fixture_generated_metadata"
  test "$(spw_generated_commit_or_empty "$fixture_generated_root")" = ""

  printf '%s\n' '{"commit": "0123456789abcdef0123456789abcdef01234567"}' > "$fixture_generated_metadata"
  test "$(spw_generated_commit_or_empty "$fixture_generated_root")" = "0123456789abcdef0123456789abcdef01234567"

  caller_root="$root"
  generated_root="caller-generated-root-path"
  generated_metadata="caller-generated-metadata-path"
  spw_generated_metadata_path "$fixture_generated_root" > "$tmpdir/generated-metadata-path.out"
  test "$root" = "$caller_root"
  test "$generated_root" = "caller-generated-root-path"
  test "$generated_metadata" = "caller-generated-metadata-path"
  test "$(cat "$tmpdir/generated-metadata-path.out")" = "$fixture_generated_metadata"

  generated_root="caller-generated-root-commit"
  generated_metadata="caller-generated-metadata-commit"
  spw_generated_commit_or_empty "$fixture_generated_root" > "$tmpdir/generated-commit.out"
  test "$root" = "$caller_root"
  test "$generated_root" = "caller-generated-root-commit"
  test "$generated_metadata" = "caller-generated-metadata-commit"
  test "$(cat "$tmpdir/generated-commit.out")" = "0123456789abcdef0123456789abcdef01234567"

  chmod 000 "$fixture_generated_metadata"
  if [ ! -r "$fixture_generated_metadata" ]; then
    test "$(spw_generated_commit_or_empty "$fixture_generated_root")" = ""
  fi
  chmod 600 "$fixture_generated_metadata"

  echo "test_probe_status: OK"
}

test_probe_commands() {
  spw_test_tmpdir
  tmpdir_physical=$(CDPATH= cd -- "$tmpdir" && pwd -P)

  . "$root/scripts/core/common.sh"
  . "$root/scripts/core/provenance.sh"

  upstream="$tmpdir/upstream"
  mkdir -p "$upstream"
  git -C "$tmpdir" init upstream >/dev/null
  printf '%s\n' 'upstream' > "$upstream/README.md"
  git -C "$upstream" add README.md >/dev/null
  spw_git_commit "$upstream" "fake upstream"

  pkg="$tmpdir/pkg"
  mkdir -p "$pkg"
  cp -R "$root/scripts" "$pkg/scripts"
  cp -R "$root/config" "$pkg/config"
  mkdir -p "$pkg/plugins/superpowers"

  installed_root="$tmpdir/codex-home/plugins/cache/superpowers-manager/superpowers/1.0.0"
  mkdir -p "$installed_root/.codex-plugin"

  adapter_log="$tmpdir/adapter.log"
  recording_adapter="$tmpdir/recording-adapter"
  cat > "$recording_adapter" <<EOF
#!/bin/sh
printf '%s\n' "\$*" >> "$adapter_log"
if [ "\$*" = "inspect --view fingerprint" ]; then
  SPW_PROBE_PLUGIN_JSON="\${SPW_PROBE_FINGERPRINT_JSON:?}"
  export SPW_PROBE_PLUGIN_JSON
fi
if [ "\$*" = "inspect --view update-control" ]; then
  case "\${SPW_TEST_UPDATE_CONTROL:-managed}" in
    managed) ;;
    unsupported)
      printf '%s\n' '{"protocol":1,"operation":"inspect","ok":true,"messages":[],"result":{"view":"update-control","update_control":"unsupported"},"error":null}'
      exit 0
      ;;
    malformed)
      printf '%s' '{'
      exit 0
      ;;
  esac
fi
exec "$pkg/scripts/adapters/codex/adapter" "\$@"
EOF
  chmod +x "$recording_adapter"

  probe_codex="$tmpdir/codex"
  cat > "$probe_codex" <<'SH'
#!/bin/sh
set -eu
case "$*" in
  "plugin list --json")
    printf '%s\n' "${SPW_PROBE_PLUGIN_JSON:?}"
    ;;
  "plugin marketplace list --json")
    printf '%s\n' "${SPW_PROBE_MARKETPLACE_JSON:?}"
    ;;
  *)
    echo "unexpected probe Codex command: $*" >&2
    exit 99
    ;;
esac
SH
  chmod +x "$probe_codex"
  probe_plugin_json='{"installed":[]}'
  probe_fingerprint_json='{"installed":[{"pluginId":"superpowers@superpowers-manager","version":"1.0.0"}]}'
  probe_marketplace_json='{"marketplaces":[]}'

  tool_path="$tmpdir/tool-path"
  probe_tmp="$tmpdir/probe-tmp"
  git_log="$tmpdir/git.log"
  mkdir -p "$tool_path"
  mkdir -p "$probe_tmp"
  for tool in awk sed find head cut dirname pwd grep rm mktemp sort tail; do
    real=$(command -v "$tool")
    ln -sf "$real" "$tool_path/$tool"
  done
  real_git=$(command -v git)
  cat > "$tool_path/git" <<'EOF'
#!/bin/sh
printf '%s\n' "$*" >> "$SPW_TEST_GIT_LOG"
exec "$SPW_TEST_REAL_GIT" "$@"
EOF
  chmod +x "$tool_path/git"

  # Model a pyenv/asdf-style interpreter shim whose env-based shell lookup is not
  # available in the deliberately restricted probe PATH. The test harness must
  # resolve the interpreter itself rather than copying the shell shim.
  real_python3=$(python3 -c 'import os, sys; print(os.path.realpath(sys.executable))')
  mkdir -p "$tmpdir/python-shims"
  cat > "$tmpdir/python-shims/python3" <<EOF
#!/usr/bin/env sh
exec "$real_python3" "\$@"
EOF
  chmod +x "$tmpdir/python-shims/python3"
  PATH="$tmpdir/python-shims:$PATH" python3 - "$tool_path/python3" <<'PY'
import os
import sys

os.symlink(os.path.realpath(sys.executable), sys.argv[1])
PY

  desired_commit=$(git -C "$upstream" rev-parse HEAD)
  desired_short=$(printf '%s' "$desired_commit" | cut -c 1-7)

  write_generated_metadata() {
    commit="$1"
    cat > "$pkg/plugins/superpowers/.superpowers-upstream.json" <<EOF
{
  "commit": "$commit"
}
EOF
  }

  write_installed_manifest() {
    version="$1"
    cat > "$installed_root/.codex-plugin/plugin.json" <<EOF
{
  "name": "superpowers",
  "version": "$version"
}
EOF
  }

  generated_commit_from_pkg() {
    spw_metadata_commit_or_empty "$pkg/plugins/superpowers/.superpowers-upstream.json"
  }

  assert_probe_porcelain() {
    expected_installed="$1"
    expected_status="$2"
    expected_identity="$3"
    output="$4"

    printf '%s\n' "$output" | grep -Fxq "desired_commit=$desired_commit"
    printf '%s\n' "$output" | grep -Fxq "generated_commit=$(generated_commit_from_pkg)"
    printf '%s\n' "$output" | grep -Fxq "installed_commit=$expected_installed"
    printf '%s\n' "$output" | grep -Fxq "identity_state=$expected_identity"
    printf '%s\n' "$output" | grep -Fxq "status=$expected_status"
    printf '%s\n' "$output" | grep -Fxq "update_control=${SPW_EXPECTED_UPDATE_CONTROL:-managed}"
  }

  run_probe() {
    PATH="$tool_path" \
    TMPDIR="$probe_tmp" \
    SUPERPOWERS_CONFIG_DIR="$tmpdir/no-selection" \
    SUPERPOWERS_REF="$desired_commit" \
    SUPERPOWERS_UPSTREAM_URL="$upstream" \
    SUPERPOWERS_CODEX="$probe_codex" \
    SUPERPOWERS_INSTALLED_SEARCH_ROOT="$tmpdir/codex-home" \
    SPW_PROBE_PLUGIN_JSON="$probe_plugin_json" \
    SPW_PROBE_FINGERPRINT_JSON="$probe_fingerprint_json" \
    SPW_PROBE_MARKETPLACE_JSON="$probe_marketplace_json" \
    SPW_ADAPTER="$recording_adapter" \
    SPW_TEST_GIT_LOG="$git_log" \
    SPW_TEST_REAL_GIT="$real_git" \
    SPW_TEST_UPDATE_CONTROL="${SPW_TEST_UPDATE_CONTROL:-managed}" \
    /bin/sh "$pkg/scripts/probe" --porcelain
  }

  run_probe_with_saved_selection() {
    config_dir="$1"
    output_mode="$2"
    shift 2
    set -- "$@" /bin/sh "$pkg/scripts/probe"
    case "$output_mode" in
      human) ;;
      porcelain) set -- "$@" --porcelain ;;
      *)
        echo "unknown probe output mode: $output_mode" >&2
        return 2
        ;;
    esac
    env -u SUPERPOWERS_REF -u SUPERPOWERS_UPSTREAM_URL \
      PATH="$tool_path" \
      TMPDIR="$probe_tmp" \
      SUPERPOWERS_CONFIG_DIR="$config_dir" \
      SUPERPOWERS_CODEX="$probe_codex" \
      SUPERPOWERS_INSTALLED_SEARCH_ROOT="$tmpdir/codex-home" \
      SPW_PROBE_PLUGIN_JSON="$probe_plugin_json" \
      SPW_PROBE_FINGERPRINT_JSON="$probe_fingerprint_json" \
      SPW_PROBE_MARKETPLACE_JSON="$probe_marketplace_json" \
      SPW_ADAPTER="$recording_adapter" \
      SPW_TEST_GIT_LOG="$git_log" \
      SPW_TEST_REAL_GIT="$real_git" \
      "$@"
  }

  assert_probe_tmp_empty() {
    if find "$probe_tmp" -mindepth 1 -print | grep -q .; then
      echo "probe leaked its invocation workspace or adapter sidecars" >&2
      find "$probe_tmp" -mindepth 1 -print >&2
      exit 1
    fi
  }

  # Scenario 1: malformed installed metadata falls back to the manifest short SHA.
  write_generated_metadata "$desired_commit"
  printf '%s\n' '{' > "$installed_root/.superpowers-upstream.json"
  write_installed_manifest "0.0.0+manager.$desired_short"
  : > "$adapter_log"
  output=$(run_probe)
  assert_probe_porcelain "$desired_short" "current" neither "$output"
  grep -Fxq "inspect --view fingerprint" "$adapter_log"
  grep -Fxq "inspect --view ownership" "$adapter_log"
  grep -Fxq "inspect --view update-control" "$adapter_log"
  expected_keys='requested_ref
resolved_ref
desired_commit
generated_commit
installed_commit
identity_state
status
selection_origin
selection_mode
upstream_source_origin
effective_source
saved_mode
saved_source
saved_requested_ref
saved_resolved_ref
saved_commit
update_control'
  actual_keys=$(printf '%s\n' "$output" | sed 's/=.*//')
  test "$actual_keys" = "$expected_keys"
  printf '%s\n' "$output" | grep -Fxq 'selection_origin=environment'
  printf '%s\n' "$output" | grep -Fxq 'selection_mode=override'
  printf '%s\n' "$output" | grep -Fxq 'upstream_source_origin=environment'
  printf '%s\n' "$output" | grep -Fxq "effective_source=$upstream"
  printf '%s\n' "$output" | grep -Fxq 'saved_mode=none'
  printf '%s\n' "$output" | grep -Fxq 'saved_source='
  printf '%s\n' "$output" | grep -Fxq 'saved_requested_ref='
  printf '%s\n' "$output" | grep -Fxq 'saved_resolved_ref='
  printf '%s\n' "$output" | grep -Fxq 'saved_commit='
  assert_probe_tmp_empty

  # A saved exact pin is authoritative and probe stays current without touching
  # Git, even after its source is unavailable. Dormant saved fields remain visible
  # when an environment ref overrides only the ref side of selection.
  saved_config="$tmpdir/saved-config"
  python3 -S "$pkg/scripts/core/selection-state.py" write-pinned \
    --path "$saved_config/selection.json" --source "$upstream" \
    --requested-ref "$desired_commit" --resolved-ref "$desired_commit" \
    --commit "$desired_commit"
  offline_source="$tmpdir/upstream-offline"
  mv "$upstream" "$offline_source"
  : > "$adapter_log"
  : > "$git_log"
  output=$(run_probe_with_saved_selection "$saved_config" porcelain)
  assert_probe_porcelain "$desired_short" "current" neither "$output"
  printf '%s\n' "$output" | grep -Fxq 'selection_origin=user-config'
  printf '%s\n' "$output" | grep -Fxq 'selection_mode=pinned'
  printf '%s\n' "$output" | grep -Fxq 'upstream_source_origin=user-config'
  printf '%s\n' "$output" | grep -Fxq "effective_source=$upstream"
  printf '%s\n' "$output" | grep -Fxq 'saved_mode=pinned'
  printf '%s\n' "$output" | grep -Fxq "saved_source=$upstream"
  printf '%s\n' "$output" | grep -Fxq "saved_requested_ref=$desired_commit"
  printf '%s\n' "$output" | grep -Fxq "saved_resolved_ref=$desired_commit"
  printf '%s\n' "$output" | grep -Fxq "saved_commit=$desired_commit"
  test ! -s "$git_log"
  grep -Fxq 'inspect --view update-control' "$adapter_log"
  assert_probe_tmp_empty

  : > "$adapter_log"
  : > "$git_log"
  output=$(run_probe_with_saved_selection \
    "$saved_config" porcelain SUPERPOWERS_REF="$desired_commit")
  printf '%s\n' "$output" | grep -Fxq 'selection_origin=environment'
  printf '%s\n' "$output" | grep -Fxq 'upstream_source_origin=user-config'
  printf '%s\n' "$output" | grep -Fxq 'saved_mode=pinned'
  printf '%s\n' "$output" | grep -Fxq "saved_commit=$desired_commit"
  test ! -s "$git_log"

  human_output=$(run_probe_with_saved_selection \
    "$saved_config" human SUPERPOWERS_REF="$desired_commit")
  printf '%s\n' "$human_output" | grep -Fxq 'selection origin: environment'
  printf '%s\n' "$human_output" | grep -Fxq 'selection mode: override'
  printf '%s\n' "$human_output" | grep -Fxq 'upstream source origin: user-config'
  printf '%s\n' "$human_output" | grep -Fxq "effective source: $upstream"
  printf '%s\n' "$human_output" | grep -Fxq 'saved mode: pinned'
  printf '%s\n' "$human_output" | grep -Fxq "saved source: $upstream"
  printf '%s\n' "$human_output" | grep -Fxq "saved requested ref: $desired_commit"
  printf '%s\n' "$human_output" | grep -Fxq "saved resolved ref: $desired_commit"
  printf '%s\n' "$human_output" | grep -Fxq "saved commit: $desired_commit"
  printf '%s\n' "$human_output" | grep -Fxq 'update control: managed'
  printf '%s\n' "$human_output" | grep -Fxq \
    'warning: effective ref and source have mixed origins (ref: environment, source: user-config)'

  mv "$offline_source" "$upstream"

  # A dash-prefixed local source saved by track-latest remains usable by probe.
  git -C "$upstream" tag v1.0.0
  ln -s upstream "$tmpdir/-upstream"
  dash_config="$tmpdir/dash-config"
  (
    cd "$tmpdir"
    SUPERPOWERS_CONFIG_DIR="$dash_config" SUPERPOWERS_UPSTREAM_URL=-upstream \
      /bin/sh "$pkg/scripts/track-latest" >/dev/null
  )
  : > "$adapter_log"
  : > "$git_log"
  output=$(
    cd "$tmpdir"
    run_probe_with_saved_selection "$dash_config" porcelain
  )
  assert_probe_porcelain "$desired_short" "current" neither "$output"
  printf '%s\n' "$output" | grep -Fxq 'selection_mode=track-latest'
  printf '%s\n' "$output" | grep -Fxq 'effective_source=-upstream'
  printf '%s\n' "$output" | grep -Fxq 'saved_source=-upstream'
  grep -Fq -- "ls-remote --tags -- $tmpdir_physical/-upstream refs/tags/v*" "$git_log"
  assert_probe_tmp_empty

  # Honest unsupported update control is reportable; execution or protocol
  # validation failures remain operational failures.
  : > "$adapter_log"
  SPW_TEST_UPDATE_CONTROL=unsupported
  SPW_EXPECTED_UPDATE_CONTROL=unsupported
  export SPW_TEST_UPDATE_CONTROL SPW_EXPECTED_UPDATE_CONTROL
  output=$(run_probe)
  assert_probe_porcelain "$desired_short" "current" neither "$output"
  unset SPW_EXPECTED_UPDATE_CONTROL
  SPW_TEST_UPDATE_CONTROL=malformed
  export SPW_TEST_UPDATE_CONTROL
  if run_probe >"$tmpdir/malformed-update-control.out" 2>"$tmpdir/malformed-update-control.err"; then
    echo "probe unexpectedly accepted malformed update-control inspection" >&2
    exit 1
  fi
  SPW_TEST_UPDATE_CONTROL=managed
  export SPW_TEST_UPDATE_CONTROL

  # Selection/source validation must fail before Git or adapter inspection.
  assert_preflight_failure() {
    config_dir="$1"
    expected="$2"
    shift 2
    : > "$adapter_log"
    : > "$git_log"
    if run_probe_with_saved_selection "$config_dir" porcelain "$@" \
        >"$tmpdir/preflight.out" 2>"$tmpdir/preflight.err"; then
      echo "probe unexpectedly accepted invalid selection preflight" >&2
      exit 1
    fi
    grep -Fq "$expected" "$tmpdir/preflight.err"
    test ! -s "$git_log"
    test ! -s "$adapter_log"
  }

  malformed_config="$tmpdir/malformed-config"
  mkdir -p "$malformed_config"
  printf '%s\n' '{' > "$malformed_config/selection.json"
  assert_preflight_failure "$malformed_config" 'invalid JSON'

  unsupported_config="$tmpdir/unsupported-config"
  mkdir -p "$unsupported_config"
  printf '%s\n' '{"schema_version":2,"mode":"track-latest","source":"https://example.invalid/repo"}' \
    > "$unsupported_config/selection.json"
  assert_preflight_failure "$unsupported_config" 'schema_version must equal integer 1'

  assert_preflight_failure "$tmpdir/no-selection" 'HTTP(S) source must not include userinfo' \
    SUPERPOWERS_REF="$desired_commit" \
    SUPERPOWERS_UPSTREAM_URL='https://token@example.invalid/repo'

  # Probe reports every validated identity state without mutation.
  probe_plugin_json='{"installed":[{"pluginId":"superpowers@superpowers-manager"}]}'
  probe_marketplace_json='{"marketplaces":[{"name":"superpowers-manager"}]}'
  : > "$adapter_log"
  output=$(run_probe)
  assert_probe_porcelain "$desired_short" "current" manager "$output"

  probe_plugin_json='{"installed":[{"pluginId":"superpowers@superpowers-wrapper"}]}'
  probe_marketplace_json='{"marketplaces":[{"name":"superpowers-wrapper"}]}'
  : > "$adapter_log"
  output=$(run_probe)
  assert_probe_porcelain "$desired_short" "current" legacy "$output"

  probe_plugin_json='{"installed":[{"pluginId":"superpowers@superpowers-manager"},{"pluginId":"superpowers@superpowers-wrapper"}]}'
  probe_marketplace_json='{"marketplaces":[{"name":"superpowers-manager"},{"name":"superpowers-wrapper"}]}'
  : > "$adapter_log"
  output=$(run_probe)
  assert_probe_porcelain "$desired_short" "current" both "$output"

  probe_plugin_json='{"installed":[]}'
  probe_marketplace_json='{"marketplaces":[]}'

  # Scenario 1b: semantically invalid metadata falls through to a valid manifest
  # fingerprint instead of poisoning the protocol response.
  printf '%s\n' '{"commit":"not-a-fingerprint"}' > "$installed_root/.superpowers-upstream.json"
  write_installed_manifest "0.0.0+manager.$desired_short"
  : > "$adapter_log"
  output=$(run_probe)
  assert_probe_porcelain "$desired_short" "current" neither "$output"
  grep -Fxq "inspect --view fingerprint" "$adapter_log"
  assert_probe_tmp_empty

  # Scenario 2: semantically invalid metadata plus malformed manifest -> null
  # fingerprint and needs install when generated is current.
  probe_fingerprint_json='{"installed":[]}'
  printf '%s\n' '{"commit":"not-a-fingerprint"}' > "$installed_root/.superpowers-upstream.json"
  printf '%s\n' '{' > "$installed_root/.codex-plugin/plugin.json"
  : > "$adapter_log"
  output=$(run_probe)
  assert_probe_porcelain "" "needs install" neither "$output"
  grep -Fxq "inspect --view fingerprint" "$adapter_log"
  assert_probe_tmp_empty

  # Scenario 2b: semantically invalid metadata with no manifest also yields null.
  rm -f "$installed_root/.codex-plugin/plugin.json"
  : > "$adapter_log"
  output=$(run_probe)
  assert_probe_porcelain "" "needs install" neither "$output"
  grep -Fxq "inspect --view fingerprint" "$adapter_log"
  assert_probe_tmp_empty

  # Scenario 3: stale generated metadata still wins over a null installed
  # fingerprint and keeps the status at needs prepare.
  write_generated_metadata "0000000000000000000000000000000000000000"
  : > "$adapter_log"
  output=$(run_probe)
  assert_probe_porcelain "" "needs prepare" neither "$output"
  grep -Fxq "inspect --view fingerprint" "$adapter_log"
  assert_probe_tmp_empty

  # Scenario 4: malformed generated provenance is treated as absent so probe can
  # report needs prepare instead of aborting the remediation path.
  printf '%s\n' '{' > "$pkg/plugins/superpowers/.superpowers-upstream.json"
  : > "$adapter_log"
  output=$(run_probe)
  printf '%s\n' "$output" | grep -Fxq "desired_commit=$desired_commit"
  printf '%s\n' "$output" | grep -Fxq "generated_commit="
  printf '%s\n' "$output" | grep -Fxq "installed_commit="
  printf '%s\n' "$output" | grep -Fxq "identity_state=neither"
  printf '%s\n' "$output" | grep -Fxq "status=needs prepare"
  grep -Fxq "inspect --view fingerprint" "$adapter_log"
  assert_probe_tmp_empty

  echo "test_probe_commands: OK"
}

failed=0
spw_section test_probe_status test_probe_status
spw_section test_probe_commands test_probe_commands
[ "$failed" -eq 0 ] || exit "$failed"
