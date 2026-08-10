# Migration inventory: tests/test_codex_state_units.sh

Source read in full (47 lines). Ported to `tests/unit/lifecycle.test.js`.

No behavior ID in `docs/baseline/traceability.md` references
`test_codex_state_units` (confirmed by `grep -c '^| *\`' docs/baseline/traceability.md`
returning 121 with zero `test_codex_state_units` hits). This inventory, not the
121-ID count, is the evidence that no assertion was dropped.

## Counting rules applied

- Each bare `[ -z "$output" ]`, relied on by `set -e`, is one assertion.
- Each `if <command>; then echo …; exit 1; fi` negative guard is one
  assertion.
- Each `grep -Fxq` is one assertion.
- A `for` loop over N states performing the same assertion(s) each
  contributes N times that many assertions.

## Assertion inventory

<!-- inventory:mapped:start -->

### `spw_require_no_legacy_state` admits the two clean identity states (`:11-14`)

1. `[ -z "$output" ]` for `neither` (`:12-13`). Port:
   `tests/unit/lifecycle.test.js:25-29`.
2. `[ -z "$output" ]` for `manager` (`:12-13`). Port:
   `tests/unit/lifecycle.test.js:25-29`.

### `spw_require_no_legacy_state` rejects `legacy` and `both` (`:16-26`)

3. The `if …; then exit 1; fi` rejection for `legacy` (`:17-20`). Port:
   `tests/unit/lifecycle.test.js:31-39`.
4. The `if …; then exit 1; fi` rejection for `both` (`:17-20`). Port:
   `tests/unit/lifecycle.test.js:31-39`.
5. `grep -Fxq 'Legacy superpowers-wrapper Codex state is installed.'` for
   `legacy` (`:21-22`). Port: `tests/unit/lifecycle.test.js:31-39`.
6. `grep -Fxq 'Run: npx superpowers-wrapper@0.1.1 uninstall'` for `legacy`
   (`:23-24`). Port: `tests/unit/lifecycle.test.js:31-39`.
7. `grep -Fxq 'Then run: npx superpowers-manager install'` for `legacy`
   (`:25-26`). Port: `tests/unit/lifecycle.test.js:31-39`.
8. `grep -Fxq 'Legacy superpowers-wrapper Codex state is installed.'` for
   `both` (`:21-22`). Port: `tests/unit/lifecycle.test.js:31-39`.
9. `grep -Fxq 'Run: npx superpowers-wrapper@0.1.1 uninstall'` for `both`
   (`:23-24`). Port: `tests/unit/lifecycle.test.js:31-39`.
10. `grep -Fxq 'Then run: npx superpowers-manager install'` for `both`
    (`:25-26`). Port: `tests/unit/lifecycle.test.js:31-39`.

### `spw_report_legacy_state` is silent for the two clean identity states (`:29-32`)

11. `[ -z "$output" ]` for `neither` (`:30-31`). Port:
    `tests/unit/lifecycle.test.js:41-45`.
12. `[ -z "$output" ]` for `manager` (`:30-31`). Port:
    `tests/unit/lifecycle.test.js:41-45`.

### `spw_report_legacy_state` reports `legacy` and `both` (`:34-40`)

13. `grep -Fxq 'Legacy superpowers-wrapper Codex state remains installed.'`
    for `legacy` (`:36-37`). Port: `tests/unit/lifecycle.test.js:47-55`.
14. `grep -Fxq 'Run: npx superpowers-wrapper@0.1.1 uninstall'` for `legacy`
    (`:38-39`). Port: `tests/unit/lifecycle.test.js:47-55`.
15. `grep -Fxq 'Legacy superpowers-wrapper Codex state remains installed.'`
    for `both` (`:36-37`). Port: `tests/unit/lifecycle.test.js:47-55`.
16. `grep -Fxq 'Run: npx superpowers-wrapper@0.1.1 uninstall'` for `both`
    (`:38-39`). Port: `tests/unit/lifecycle.test.js:47-55`.

<!-- inventory:mapped:end -->

## Port-only assertions (outside the 1:1 mapping)

The `*)` arm of both `spw_require_no_legacy_state`'s and
`spw_report_legacy_state`'s `case` statements (`scripts/core/lifecycle.sh:56-58`
and `:81-83`) was never exercised by `tests/test_codex_state_units.sh`: the
shell driver only ever called either function with `neither`, `manager`,
`legacy`, or `both`. The `spw_die` path — which, unlike the `legacy|both` path,
does add an `error: ` prefix — was therefore unwitnessed on the shell side.
These four items close that gap; they do not carry one across from the shell.

<!-- inventory:port-only:start -->

1. **New.** `requireNoLegacyState` returns `{ kind: "unknown", message:
   "unknown adapter identity state: garbage" }` for an unrecognised state.
   Port: `tests/unit/lifecycle.test.js:62-71`. No shell counterpart — the
   shell driver never called `spw_require_no_legacy_state` with a state
   outside `neither|manager|legacy|both`.
2. **New.** `reportLegacyState` returns `{ kind: "unknown", message:
   "unknown adapter identity state: garbage" }` for an unrecognised state.
   Port: `tests/unit/lifecycle.test.js:62-71`. No shell counterpart, same
   rationale as item 1.
3. **New.** `requireNoLegacyState` returns `{ kind: "unknown", message:
   "unknown adapter identity state: " }` for an empty identity state. Port:
   `tests/unit/lifecycle.test.js:73-82`. No shell counterpart, same
   rationale as item 1.
4. **New.** `reportLegacyState` returns `{ kind: "unknown", message:
   "unknown adapter identity state: " }` for an empty identity state. Port:
   `tests/unit/lifecycle.test.js:73-82`. No shell counterpart, same
   rationale as item 1.

<!-- inventory:port-only:end -->

## Cardinality

```json inventory
{
  "shellOriginal": 16,
  "portOnly": 4,
  "ports": { "tests/unit/lifecycle.test.js": 6 }
}
```

- Shell original: **16** assertions (2 clean-state checks for
  `spw_require_no_legacy_state`, 2 rejection checks + 6 `grep -Fxq` checks for
  its `legacy`/`both` arm, 2 clean-state checks for `spw_report_legacy_state`,
  4 `grep -Fxq` checks for its `legacy`/`both` arm; sum: 2+2+6+2+4 = 16).
- Port (`tests/unit/lifecycle.test.js`): 6 static `test(` call sites, carrying
  all 16 shell assertions (each of the four `void test(...)` cases covering
  `neither`/`manager`/`legacy`/`both` groups multiple shell assertions behind
  one `assert.deepEqual`, since the port returns a verdict object rather than
  writing text line by line), plus 4 port-only assertions (items 1-4 above)
  covering the `*)` arm neither shell case statement ever reached.
- Reconciliation: 16 of 16 shell items are mapped 1:1, no merges, no drops of
  assertion coverage. One distinction the shell driver captured is not
  preserved as an assertion here, and is called out rather than silently
  lost: `tests/test_codex_state_units.sh` invoked
  `spw_require_no_legacy_state` with `2>&1` (`:12`, `:17`) but
  `spw_report_legacy_state` with no redirect at all (`:30`, `:35`) — positive
  evidence that the block path writes to stderr and the report path writes
  to stdout (`scripts/core/lifecycle.sh:53` has `>&2`; `:75-77` does not).
  `LegacyVerdict` is a pure verdict by design (see `src/lifecycle.ts`'s
  header comment) — it carries no stream and no exit status — so nothing in
  this repo witnesses that stdout/stderr split after this commit. This is a
  deferral, not a drop: the command-path caller that consumes
  `LegacyVerdict.lines`, landing in **slice 4b**, must pin the report path's
  lines to stdout and the block path's lines to stderr, and that is where the
  distinction becomes assertable again. The 4 port-only entries are strictly
  additive test coverage — not a reconciliation of any shell assertion — and
  are excluded from the 16/16 arithmetic above.
