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

echo "test_adapter_protocol: OK"
