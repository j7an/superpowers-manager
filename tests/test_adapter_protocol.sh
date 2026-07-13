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
grep -Fxq 'hint: inspect wrapper state' "$RUN_STDERR"

run_adapter wrong-operation build ""
[ "$RUN_RC" -eq 2 ]
grep -Fq 'response operation does not match invocation' "$RUN_STDERR"

run_adapter malformed build ""
[ "$RUN_RC" -eq 2 ]
grep -Fq 'error: invalid adapter response:' "$RUN_STDERR"

run_adapter stdout-noise build ""
[ "$RUN_RC" -eq 2 ]
grep -Fq 'error: invalid adapter response:' "$RUN_STDERR"

run_adapter crash build ""
[ "$RUN_RC" -eq 2 ]
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
grep -Fxq 'error: codex plugin add failed for superpowers@superpowers-wrapper' "$RUN_STDERR"
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
[ "$RUN_RC" -eq 0 ]
[ "$(spw_adapter_result_get "$RUN_RESULT" "fingerprint")" = "" ]
[ ! -s "$RUN_STDOUT" ]
[ ! -s "$RUN_STDERR" ]

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
