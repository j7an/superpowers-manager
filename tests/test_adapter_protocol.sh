#!/bin/sh
set -eu

root=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)
tmpdir=$(mktemp -d)
trap 'rm -rf "$tmpdir"' EXIT INT TERM

. "$root/scripts/core/common.sh"
. "$root/scripts/core/provenance.sh"
. "$root/scripts/core/adapter.sh"

SPW_ADAPTER="$root/tests/fixtures/fake-adapter"
[ "$SPW_ADAPTER_RESPONSE_VALIDATOR" = "$root/scripts/core/validate-adapter-response.py" ]
grep -Fxq 'from __future__ import annotations' "$SPW_ADAPTER_RESPONSE_VALIDATOR"
python3 -S "$root/tests/test_adapter_protocol.py"

system_python=/usr/bin/python3
if [ -x "$system_python" ]; then
  system_python_version=$(
    "$system_python" -S -c 'import sys; print("%d.%d" % sys.version_info[:2])'
  )
  if [ "$system_python_version" = "3.9" ]; then
    "$system_python" -S -c '
import runpy
import sys

assert sys.version_info[:2] == (3, 9)
validator = sys.argv[1]
sys.argv = [validator, "--help"]
runpy.run_path(validator, run_name="__main__")
' "$SPW_ADAPTER_RESPONSE_VALIDATOR" >/dev/null
  fi
fi

run_adapter() {
  scenario="$1"
  operation="$2"
  inspect_view="$3"
  shift 3

  RUN_RESULT="$tmpdir/${scenario}-${operation}.result.json"
  RUN_STDOUT="$tmpdir/${scenario}-${operation}.stdout"
  RUN_STDERR="$tmpdir/${scenario}-${operation}.stderr"
  rm -f "$RUN_RESULT" "$RUN_RESULT.response" "$RUN_STDOUT" "$RUN_STDERR"

  RUN_RC=0
  SPW_ADAPTER="$root/tests/fixtures/fake-adapter" \
  SPW_FAKE_ADAPTER_SCENARIO="$scenario" \
    spw_invoke_adapter "$operation" "$RUN_RESULT" "$inspect_view" -- "$@" \
    >"$RUN_STDOUT" 2>"$RUN_STDERR" || RUN_RC=$?
}

run_adapter success build ""
[ "$RUN_RC" -eq 0 ]
grep -Fxq '{}' "$RUN_RESULT"
[ ! -s "$RUN_STDOUT" ]
[ ! -s "$RUN_STDERR" ]

run_adapter success inspect fingerprint fingerprint
[ "$RUN_RC" -eq 0 ]
[ "$(spw_adapter_result_get "$RUN_RESULT" "view")" = "fingerprint" ]
[ "$(spw_adapter_result_get "$RUN_RESULT" "fingerprint")" = "0123456789abcdef0123456789abcdef01234567" ]

run_adapter success inspect ownership ownership
[ "$RUN_RC" -eq 0 ]
[ "$(spw_adapter_result_boolean "$RUN_RESULT" "resources.plugin")" = true ]
[ "$(spw_adapter_result_boolean "$RUN_RESULT" "legacy_resources.plugin")" = false ]
[ "$(spw_adapter_result_get "$RUN_RESULT" "identity_state")" = manager ]

run_adapter success inspect update-control update-control
[ "$RUN_RC" -eq 0 ]
[ "$(spw_adapter_result_get "$RUN_RESULT" "view")" = "update-control" ]
[ "$(spw_adapter_result_get "$RUN_RESULT" "update_control")" = "managed" ]

run_adapter update-control-unsupported inspect update-control update-control
[ "$RUN_RC" -eq 0 ]
[ "$(spw_adapter_result_get "$RUN_RESULT" "update_control")" = "unsupported" ]

real_update_control_result="$tmpdir/real-update-control.result.json"
missing_update_control_codex="$tmpdir/codex-must-not-run"
SPW_ADAPTER="$root/scripts/adapters/codex/adapter" \
SUPERPOWERS_CODEX="$missing_update_control_codex" \
  spw_inspect_update_control "$real_update_control_result"
[ "$(spw_adapter_result_get "$real_update_control_result" "view")" = "update-control" ]
[ "$(spw_adapter_result_get "$real_update_control_result" "update_control")" = "managed" ]

old_adapter="$tmpdir/old-adapter"
cat > "$old_adapter" <<'SH'
#!/bin/sh
printf '%s\n' '{"protocol":1,"operation":"inspect","ok":false,"messages":[],"result":null,"error":{"code":"invalid-arguments","message":"unsupported inspect view: update-control","hints":[]}}'
exit 1
SH
chmod +x "$old_adapter"
old_result="$tmpdir/old-adapter-update-control.result.json"
old_rc=0
SPW_ADAPTER="$old_adapter" \
  spw_inspect_update_control "$old_result" >/dev/null 2>/dev/null || old_rc=$?
[ "$old_rc" -eq 1 ]
[ ! -f "$old_result" ]

identity_codex="$tmpdir/identity-codex"
cat > "$identity_codex" <<'SH'
#!/bin/sh
set -eu
case "$*" in
  "plugin list --json")
    printf '%s\n' "${SPW_IDENTITY_PLUGIN_JSON:?}"
    ;;
  "plugin marketplace list --json")
    printf '%s\n' "${SPW_IDENTITY_MARKETPLACE_JSON:?}"
    ;;
  *)
    echo "unexpected identity Codex command: $*" >&2
    exit 99
    ;;
esac
SH
chmod +x "$identity_codex"

assert_identity_state() {
  label="$1"
  plugin_json="$2"
  marketplace_json="$3"
  expected_manager_plugin="$4"
  expected_manager_marketplace="$5"
  expected_legacy_plugin="$6"
  expected_legacy_marketplace="$7"
  expected_state="$8"
  result="$tmpdir/identity-$label.result.json"
  SPW_ADAPTER="$root/scripts/adapters/codex/adapter" \
  SUPERPOWERS_CODEX="$identity_codex" \
  SPW_IDENTITY_PLUGIN_JSON="$plugin_json" \
  SPW_IDENTITY_MARKETPLACE_JSON="$marketplace_json" \
    spw_invoke_adapter inspect "$result" ownership -- --view ownership
  [ "$(spw_adapter_result_boolean "$result" resources.plugin)" = "$expected_manager_plugin" ]
  [ "$(spw_adapter_result_boolean "$result" resources.marketplace)" = "$expected_manager_marketplace" ]
  [ "$(spw_adapter_result_boolean "$result" legacy_resources.plugin)" = "$expected_legacy_plugin" ]
  [ "$(spw_adapter_result_boolean "$result" legacy_resources.marketplace)" = "$expected_legacy_marketplace" ]
  [ "$(spw_adapter_result_get "$result" identity_state)" = "$expected_state" ]
}

assert_identity_state neither \
  '{"installed":[]}' \
  '{"marketplaces":[]}' \
  false false false false neither
assert_identity_state manager \
  '{"installed":[{"pluginId":"superpowers@superpowers-manager"}]}' \
  '{"marketplaces":[{"name":"superpowers-manager"}]}' \
  true true false false manager
assert_identity_state legacy \
  '{"installed":[{"pluginId":"superpowers@superpowers-wrapper"}]}' \
  '{"marketplaces":[{"name":"superpowers-wrapper"}]}' \
  false false true true legacy
assert_identity_state both \
  '{"installed":[{"pluginId":"superpowers@superpowers-manager"},{"pluginId":"superpowers@superpowers-wrapper"}]}' \
  '{"marketplaces":[{"name":"superpowers-manager"},{"name":"superpowers-wrapper"}]}' \
  true true true true both

run_adapter success install "" both-hints
[ "$RUN_RC" -eq 0 ]
[ "$(spw_adapter_result_get "$RUN_RESULT" "verification_hints.mismatch")" = "installed commit differs" ]
[ "$(spw_adapter_result_get "$RUN_RESULT" "verification_hints.missing")" = "plugin metadata missing" ]

run_adapter controlled-failure install ""
[ "$RUN_RC" -eq 1 ]
[ ! -f "$RUN_RESULT" ]
grep -Fxq 'before-failure' "$RUN_STDOUT"
grep -Fxq 'adapter-stderr-before-failure' "$RUN_STDERR"
grep -Fxq 'replayed-warning' "$RUN_STDERR"
grep -Fxq 'error: controlled failure' "$RUN_STDERR"
grep -Fxq 'hint: retry later' "$RUN_STDERR"
grep -Fxq 'hint: inspect manager state' "$RUN_STDERR"

run_adapter wrong-operation build ""
[ "$RUN_RC" -eq 1 ]
[ ! -f "$RUN_RESULT" ]
grep -Fq 'response operation does not match invocation' "$RUN_STDERR"

run_adapter malformed build ""
[ "$RUN_RC" -eq 1 ]
[ ! -f "$RUN_RESULT" ]
grep -Fq 'error: invalid adapter response:' "$RUN_STDERR"

run_adapter stdout-noise build ""
[ "$RUN_RC" -eq 1 ]
[ ! -f "$RUN_RESULT" ]
grep -Fq 'error: invalid adapter response:' "$RUN_STDERR"

run_adapter crash build ""
[ "$RUN_RC" -eq 1 ]
[ ! -f "$RUN_RESULT" ]
grep -Fxq 'adapter crashed' "$RUN_STDERR"
grep -Fq 'error: invalid adapter response:' "$RUN_STDERR"

real_pkg="$tmpdir/real-package-root"
real_state="$tmpdir/real-codex-state"
real_codex="$tmpdir/real-codex"
mkdir -p "$real_pkg" "$real_state"
cat > "$real_codex" <<'SH'
#!/bin/sh
set -eu

state="${SPW_REAL_CODEX_STATE:?}"
scenario="${SPW_REAL_CODEX_SCENARIO:?}"
printf '%s\n' "$*" >> "$state/log"

if [ "$1" = plugin ] && [ "$2" = marketplace ] && [ "$3" = list ]; then
  printf '%s\n' '{"marketplaces":[]}'
  exit 0
fi
if [ "$1" = plugin ] && [ "$2" = marketplace ] && [ "$3" = add ]; then
  printf '%b' 'marketplace-out\\literal\ttag\rdone\n'
  printf '\377non-utf-marketplace\n'
  printf '%b' 'marketplace-err\\literal\ttag\rdone\n' >&2
  exit 0
fi
if [ "$1" = plugin ] && [ "$2" = add ]; then
  printf '%b' 'plugin-out\\literal\ttag\rdone\n'
  printf '\376non-utf-plugin\n'
  printf '%b' 'plugin-err\\literal\ttag\rdone\n' >&2
  if [ "$scenario" = install-failure-after-mutation ]; then
    exit 1
  fi
  exit 0
fi

echo "unexpected fake codex command: $*" >&2
exit 99
SH
chmod +x "$real_codex"

run_real_install() {
  scenario="$1"
  RUN_RESULT="$tmpdir/${scenario}-real-install.result.json"
  RUN_STDOUT="$tmpdir/${scenario}-real-install.stdout"
  RUN_STDERR="$tmpdir/${scenario}-real-install.stderr"
  rm -f "$RUN_RESULT" "$RUN_RESULT.response" "$RUN_STDOUT" "$RUN_STDERR" "$real_state/log"

  RUN_RC=0
  SPW_ADAPTER="$root/scripts/adapters/codex/adapter" \
  SUPERPOWERS_CODEX="$real_codex" \
  SPW_REAL_CODEX_STATE="$real_state" \
  SPW_REAL_CODEX_SCENARIO="$scenario" \
  spw_invoke_adapter install "$RUN_RESULT" "" -- --package-root "$real_pkg" \
    >"$RUN_STDOUT" 2>"$RUN_STDERR" || RUN_RC=$?
}

run_real_install install-success
[ "$RUN_RC" -eq 0 ]
[ -f "$RUN_RESULT" ]
[ ! -s "$RUN_STDOUT" ]
grep -Fxq 'marketplace-out\\literal\ttag\rdone' "$RUN_STDERR"
grep -Fxq 'marketplace-err\\literal\ttag\rdone' "$RUN_STDERR"
grep -Fxq 'plugin-out\\literal\ttag\rdone' "$RUN_STDERR"
grep -Fxq 'plugin-err\\literal\ttag\rdone' "$RUN_STDERR"
grep -Fxq '\\xffnon-utf-marketplace' "$RUN_STDERR"
grep -Fxq '\\xfenon-utf-plugin' "$RUN_STDERR"
[ "$(wc -l < "$RUN_RESULT.response" | tr -d ' ')" -eq 1 ]
if grep -Fq 'error: invalid adapter response:' "$RUN_STDERR"; then
  echo "escaped Codex output must not poison a successful install envelope" >&2
  exit 1
fi

run_real_install install-failure-after-mutation
[ "$RUN_RC" -eq 1 ]
[ ! -f "$RUN_RESULT" ]
grep -Fxq 'plugin-out\\literal\ttag\rdone' "$RUN_STDERR"
grep -Fxq 'plugin-err\\literal\ttag\rdone' "$RUN_STDERR"
grep -Fxq '\\xfenon-utf-plugin' "$RUN_STDERR"
[ "$(wc -l < "$RUN_RESULT.response" | tr -d ' ')" -eq 1 ]
if grep -Fq 'Traceback' "$RUN_STDERR"; then
  echo "non-UTF Codex output must not produce a traceback" >&2
  exit 1
fi

# Protocol strings are terminal-facing. Reject C0/C1 controls rather than
# serializing an envelope that could inject terminal behavior when replayed.
control=$(printf '\033')
control_out="$tmpdir/control.out"
control_err="$tmpdir/control.err"
if "$root/scripts/adapters/codex/adapter" install "--bad-$control" \
  >"$control_out" 2>"$control_err"; then
  echo "terminal control in an adapter error must be rejected" >&2
  exit 1
fi
[ ! -s "$control_out" ]
grep -Fq 'protocol strings must not contain terminal control characters' "$control_err"

# A lone UTF-8 surrogate from a POSIX argv byte replays as its original byte
# through Python's surrogateescape handler unless the emitter rejects it.
surrogate=$(LC_ALL=C printf '\233')
surrogate_out="$tmpdir/surrogate.out"
surrogate_err="$tmpdir/surrogate.err"
if LC_ALL=C "$root/scripts/adapters/codex/adapter" "bad-$surrogate" \
  >"$surrogate_out" 2>"$surrogate_err"; then
  echo "surrogate adapter operation must be rejected" >&2
  exit 1
fi
if [ -s "$surrogate_out" ]; then
  echo "surrogate adapter operation emitted bytes: $(LC_ALL=C od -An -tx1 "$surrogate_out")" >&2
  exit 1
fi
grep -Fq 'protocol strings must not contain terminal control characters' "$surrogate_err"

# A zero-argument adapter failure must identify the adapter boundary, not
# falsely claim that the build operation ran.
zero_out="$tmpdir/zero-argument.out"
if "$root/scripts/adapters/codex/adapter" >"$zero_out" 2>/dev/null; then
  echo "zero-argument adapter invocation must fail" >&2
  exit 1
fi
[ "$(spw_json_get "$zero_out" operation)" = adapter ]
[ "$(spw_json_get "$zero_out" error.code)" = invalid-arguments ]
grep -Fxq 'error: codex plugin add failed for superpowers@superpowers-manager' "$RUN_STDERR"
if grep -Fq 'error: invalid adapter response:' "$RUN_STDERR"; then
  echo "escaped Codex output must not poison a controlled failure envelope" >&2
  exit 1
fi

RUN_RESULT="$tmpdir/real-inspect-invalid.result.json"
RUN_STDOUT="$tmpdir/real-inspect-invalid.stdout"
RUN_STDERR="$tmpdir/real-inspect-invalid.stderr"
rm -f "$RUN_RESULT" "$RUN_RESULT.response" "$RUN_STDOUT" "$RUN_STDERR"
mkdir -p "$tmpdir/empty-codex"
RUN_RC=0
SPW_ADAPTER="$root/scripts/adapters/codex/adapter" \
SUPERPOWERS_INSTALLED_SEARCH_ROOT="$tmpdir/empty-codex" \
spw_invoke_adapter inspect "$RUN_RESULT" fingerprint -- --view nope \
  >"$RUN_STDOUT" 2>"$RUN_STDERR" || RUN_RC=$?
[ "$RUN_RC" -eq 1 ]
[ ! -f "$RUN_RESULT" ]
[ "$(spw_json_get "$RUN_RESULT.response" "operation")" = "inspect" ]
[ "$(spw_json_get "$RUN_RESULT.response" "ok")" = "False" ]
[ "$(spw_json_get "$RUN_RESULT.response" "error.code")" = "invalid-arguments" ]
grep -Fxq 'error: unsupported inspect view: nope' "$RUN_STDERR"
if grep -Fq 'response operation does not match invocation' "$RUN_STDERR"; then
  echo "invalid inspect view must be a controlled inspect failure, not an operation mismatch" >&2
  exit 1
fi

fingerprint_codex="$tmpdir/fingerprint-codex"
cat > "$fingerprint_codex" <<'SH'
#!/bin/sh
set -eu
[ "$*" = "plugin list --json" ] || exit 99
printf '%s\n' "${SPW_FINGERPRINT_LISTING:?}"
SH
chmod +x "$fingerprint_codex"
fingerprint_root="$tmpdir/fingerprint-root"
fingerprint_a="$fingerprint_root/plugins/cache/superpowers-manager/superpowers/1.0.0+manager.aaaaaaa"
fingerprint_b="$fingerprint_root/plugins/cache/superpowers-manager/superpowers/1.0.0+manager.bbbbbbb"
mkdir -p "$fingerprint_a" "$fingerprint_b"
printf '%s\n' '{"commit":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}' \
  > "$fingerprint_a/.superpowers-upstream.json"
printf '%s\n' '{"commit":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"}' \
  > "$fingerprint_b/.superpowers-upstream.json"

RUN_RESULT="$tmpdir/active-fingerprint.result.json"
SPW_ADAPTER="$root/scripts/adapters/codex/adapter" \
SUPERPOWERS_CODEX="$fingerprint_codex" \
SUPERPOWERS_INSTALLED_SEARCH_ROOT="$fingerprint_root" \
SPW_FINGERPRINT_LISTING='{"installed":[{"pluginId":"superpowers@superpowers-manager","version":"1.0.0+manager.bbbbbbb"}]}' \
  spw_inspect_fingerprint "$RUN_RESULT"
[ "$(spw_adapter_result_get "$RUN_RESULT" fingerprint)" = \
  "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" ]

RUN_RESULT="$tmpdir/absent-fingerprint.result.json"
SPW_ADAPTER="$root/scripts/adapters/codex/adapter" \
SUPERPOWERS_CODEX="$fingerprint_codex" \
SUPERPOWERS_INSTALLED_SEARCH_ROOT="$fingerprint_root" \
SPW_FINGERPRINT_LISTING='{"installed":[]}' \
  spw_inspect_fingerprint "$RUN_RESULT"
[ "$(spw_adapter_result_get "$RUN_RESULT" fingerprint)" = "" ]

for invalid_listing in \
  '{' \
  '{"installed":[{"pluginId":"superpowers@superpowers-manager","version":"missing-cache"}]}'
do
  RUN_RESULT="$tmpdir/failed-fingerprint.result.json"
  rm -f "$RUN_RESULT" "$RUN_RESULT.response"
  RUN_RC=0
  SPW_ADAPTER="$root/scripts/adapters/codex/adapter" \
  SUPERPOWERS_CODEX="$fingerprint_codex" \
  SUPERPOWERS_INSTALLED_SEARCH_ROOT="$fingerprint_root" \
  SPW_FINGERPRINT_LISTING="$invalid_listing" \
    spw_inspect_fingerprint "$RUN_RESULT" >/dev/null 2>/dev/null || RUN_RC=$?
  [ "$RUN_RC" -eq 1 ]
  [ ! -f "$RUN_RESULT" ]
done

missing_codex="$tmpdir/missing-codex"
RUN_RESULT="$tmpdir/missing-codex-install.result.json"
RUN_STDOUT="$tmpdir/missing-codex-install.stdout"
RUN_STDERR="$tmpdir/missing-codex-install.stderr"
rm -f "$RUN_RESULT" "$RUN_RESULT.response" "$RUN_STDOUT" "$RUN_STDERR"
RUN_RC=0
SPW_ADAPTER="$root/scripts/adapters/codex/adapter" \
SUPERPOWERS_CODEX="$missing_codex" \
spw_invoke_adapter install "$RUN_RESULT" "" -- --package-root "$real_pkg" \
  >"$RUN_STDOUT" 2>"$RUN_STDERR" || RUN_RC=$?
[ "$RUN_RC" -eq 1 ]
[ ! -f "$RUN_RESULT" ]
[ "$(spw_json_get "$RUN_RESULT.response" "operation")" = "install" ]
[ "$(spw_json_get "$RUN_RESULT.response" "ok")" = "False" ]
[ "$(spw_json_get "$RUN_RESULT.response" "error.code")" = "command-not-found" ]
grep -Fxq "error: required Codex command not found: $missing_codex" "$RUN_STDERR"
if grep -Fq 'error: invalid adapter response:' "$RUN_STDERR"; then
  echo "missing Codex must be a controlled install failure" >&2
  exit 1
fi

RUN_RESULT="$tmpdir/missing-codex-fingerprint.result.json"
RUN_STDOUT="$tmpdir/missing-codex-fingerprint.stdout"
RUN_STDERR="$tmpdir/missing-codex-fingerprint.stderr"
rm -f "$RUN_RESULT" "$RUN_RESULT.response" "$RUN_STDOUT" "$RUN_STDERR"
RUN_RC=0
SPW_ADAPTER="$root/scripts/adapters/codex/adapter" \
SUPERPOWERS_CODEX="$missing_codex" \
SUPERPOWERS_INSTALLED_SEARCH_ROOT="$tmpdir/empty-codex" \
spw_invoke_adapter inspect "$RUN_RESULT" fingerprint -- --view fingerprint \
  >"$RUN_STDOUT" 2>"$RUN_STDERR" || RUN_RC=$?
[ "$RUN_RC" -eq 1 ]
[ ! -f "$RUN_RESULT" ]
[ ! -s "$RUN_STDOUT" ]
[ "$(spw_json_get "$RUN_RESULT.response" "error.code")" = "command-not-found" ]
grep -Fxq "error: required Codex command not found: $missing_codex" "$RUN_STDERR"

for missing_case in ownership uninstall; do
  RUN_RESULT="$tmpdir/missing-codex-$missing_case.result.json"
  RUN_STDOUT="$tmpdir/missing-codex-$missing_case.stdout"
  RUN_STDERR="$tmpdir/missing-codex-$missing_case.stderr"
  rm -f "$RUN_RESULT" "$RUN_RESULT.response" "$RUN_STDOUT" "$RUN_STDERR"
  RUN_RC=0
  case "$missing_case" in
    ownership)
      SPW_ADAPTER="$root/scripts/adapters/codex/adapter" \
      SUPERPOWERS_CODEX="$missing_codex" \
      spw_invoke_adapter inspect "$RUN_RESULT" ownership -- --view ownership \
        >"$RUN_STDOUT" 2>"$RUN_STDERR" || RUN_RC=$?
      expected_operation=inspect
      ;;
    uninstall)
      SPW_ADAPTER="$root/scripts/adapters/codex/adapter" \
      SUPERPOWERS_CODEX="$missing_codex" \
      spw_invoke_adapter uninstall "$RUN_RESULT" "" -- \
        --plugin-present true --marketplace-present true \
        >"$RUN_STDOUT" 2>"$RUN_STDERR" || RUN_RC=$?
      expected_operation=uninstall
      ;;
  esac
  [ "$RUN_RC" -eq 1 ]
  [ ! -f "$RUN_RESULT" ]
  [ "$(spw_json_get "$RUN_RESULT.response" "operation")" = "$expected_operation" ]
  [ "$(spw_json_get "$RUN_RESULT.response" "ok")" = "False" ]
  [ "$(spw_json_get "$RUN_RESULT.response" "error.code")" = "command-not-found" ]
  grep -Fxq "error: required Codex command not found: $missing_codex" "$RUN_STDERR"
  if grep -Fq 'error: invalid adapter response:' "$RUN_STDERR"; then
    echo "missing Codex must be a controlled $expected_operation failure" >&2
    exit 1
  fi
done

echo "test_adapter_protocol: OK"
