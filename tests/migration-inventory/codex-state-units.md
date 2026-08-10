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

Items 5-25 close a second, larger gap. `requireManagedUpdateControl`,
`verifyInstalledFingerprint`, and `verifyUninstalledResources` port
`scripts/core/lifecycle.sh:62-70`, `:87-124`, and `:126-141`.
`tests/test_codex_state_units.sh` is 47 lines and sources only the two
identity-state functions (confirmed above); it never calls any of these
three, so — relative to *this* inventory's own driver — all 21 of their
assertions are port-only by the same rule that produced items 1-4.

That is not the whole story for these three functions specifically.
`tests/test_marketplace_reconcile.sh` (319 lines, sourcing `status.sh`,
`lifecycle.sh`, and `adapter.sh`) does assert against all three, and its own
migration inventory (`marketplace-reconcile.md`, landing in slice 4c) will map
that driver's assertions onto these same production functions. Each item below
states its `tests/test_marketplace_reconcile.sh` status by exact grep, not by
assumption — the grep command or line citation backing each "no counterpart"
or "counterpart" claim is quoted inline in that item.

> Items 5-25 are port-only relative to `test_codex_state_units.sh` and carry no
> claim about `tests/test_marketplace_reconcile.sh`. Slice 4c's
> `marketplace-reconcile.md` maps that driver's assertions onto these same
> cases; an item appearing as port-only here and mapped there is the expected
> outcome, not a discrepancy, because each inventory scopes "port-only" to its
> own driver. Items with no counterpart in either driver are marked `New`.

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
5. **New.** `requireManagedUpdateControl("managed")` returns `{ ok: true }`.
   Port: `tests/unit/lifecycle.test.js:124-126`. No counterpart in
   `tests/test_codex_state_units.sh` (which never calls the shell's
   `spw_require_managed_update_control`) or in
   `tests/test_marketplace_reconcile.sh` — `grep -ciE
   'update.control|\bmanaged\b|\bunsupported\b'
   tests/test_marketplace_reconcile.sh` returns 0.
6. **New.** `requireManagedUpdateControl("unsupported")` returns `{ ok: false,
   message: "adapter cannot guarantee manager-controlled updates" }`. Port:
   `tests/unit/lifecycle.test.js:128-133`. No counterpart in either driver,
   same rationale as item 5.
7. **New.** `requireManagedUpdateControl` rejects an unrecognised capability
   (`"weird"`) with `unknown adapter update-control capability: weird`. Port:
   `tests/unit/lifecycle.test.js:135-140`. No counterpart in either driver,
   same rationale as item 5.
8. `verifyInstalledFingerprint` returns `ok: true` for an exact 40-character
   commit match. Port: `tests/unit/lifecycle.test.js:142-156`. No counterpart
   in `tests/test_codex_state_units.sh`. Counterpart in
   `tests/test_marketplace_reconcile.sh:275` (INSTALL-VERIFY-01): the bare
   `out=$(spw_verify_installed_fingerprint "$desired" ...)` call runs under
   `set -eu`, so a nonzero exit — the shell's only equivalent of `ok: false`
   here — would abort the script; that is the shell's assertion that this
   case succeeds.
9. `verifyInstalledFingerprint`'s `stdout` is exactly `["desired_commit=…",
   "installed_commit=…", "manager updated"]` for the same exact-match case.
   Port: `tests/unit/lifecycle.test.js:142-156`. No counterpart in
   `tests/test_codex_state_units.sh`. Partial counterpart in
   `tests/test_marketplace_reconcile.sh:276-277`: `grep -Fq "manager
   updated"` and `grep -Fq "installed_commit=$desired"` check two of the
   three lines as independent substrings; the shell never checks for the
   `desired_commit=` line, nor that these are the *only* three lines in this
   order.
10. `verifyInstalledFingerprint`'s `stderr` is `[]` for the same exact-match
    case. Port: `tests/unit/lifecycle.test.js:142-156`. No counterpart in
    either driver: `tests/test_marketplace_reconcile.sh:275-278` captures
    only stdout (`out=$(...)`) and never inspects stderr for this case.
11. `verifyInstalledFingerprint` returns `ok: true` for the seven-character
    short form (`scripts/core/status.sh:7`'s `cut -c 1-7` rule, pinned to
    `commitMatches` — see the test's own comment). Port:
    `tests/unit/lifecycle.test.js:158-168`. No counterpart in
    `tests/test_codex_state_units.sh`. Counterpart in
    `tests/test_marketplace_reconcile.sh:281` (the short-form case), same
    implicit-success form as item 8.
12. `verifyInstalledFingerprint` returns `ok: false` with `stderr` naming
    "inspection failed after install" when the *inspection call itself*
    fails (`AdapterResult.status !== 0`). Port:
    `tests/unit/lifecycle.test.js:170-177`. No counterpart in
    `tests/test_codex_state_units.sh`. No counterpart in
    `tests/test_marketplace_reconcile.sh` either: `grep -c "inspection
    failed after install" tests/test_marketplace_reconcile.sh` returns 0.
    Its only `spw_inspect_fingerprint` override (`:304-306`) writes
    malformed content but returns 0 itself, so that driver never forces the
    inspection *call* to fail — only its *content* to be unparseable, which
    is a different branch (see item 14).
13. Same case's `stdout` is `[]`. Port:
    `tests/unit/lifecycle.test.js:170-177`. No counterpart in either driver,
    same rationale as item 12.
14. Same case's `stderr` is exactly `["error: installed manager fingerprint
    inspection failed after install."]`. Port:
    `tests/unit/lifecycle.test.js:170-177`. No counterpart in either driver,
    same rationale as item 12.
    `tests/test_marketplace_reconcile.sh:307-316` tests the *sibling* branch
    — an unparseable fingerprint value (`raw` present but non-string,
    non-null) — and asserts on the word "parse" (`:312`) instead; that
    sibling branch has no port among these 14 tests either (none of them
    passes a non-string, non-null `fingerprint`), so neither driver's
    malformed-inspection case lines up with this item or with any other item
    in this list.
15. `verifyInstalledFingerprint` returns `ok: false` on a stale/mismatched
    commit. Port: `tests/unit/lifecycle.test.js:179-191`. No counterpart in
    `tests/test_codex_state_units.sh`. Counterpart in
    `tests/test_marketplace_reconcile.sh:287-289` (the `if (...); then …
    exit 1; fi` guard around the stale-commit case).
16. Same case's `stderr` is exactly `["error: installed manager fingerprint
    does not match the prepared plugin after install.", "hint: try
    reinstalling"]`. Port: `tests/unit/lifecycle.test.js:179-191`. No
    counterpart in `tests/test_codex_state_units.sh`. Partial counterpart in
    `tests/test_marketplace_reconcile.sh:290-291`: `grep -Fq "does not match
    the prepared plugin"` and `grep -Fq "adapter mismatch hint"` check the
    same two message strings independently, not as an exact two-line array.
17. `verifyInstalledFingerprint` returns `ok: false` when the fingerprint is
    undetectable (`fingerprint: null`). Port:
    `tests/unit/lifecycle.test.js:193-207`. No counterpart in
    `tests/test_codex_state_units.sh`. Counterpart in
    `tests/test_marketplace_reconcile.sh:295-302` (the undetectable-case
    guard, plus its explicit check that "manager updated" is absent).
18. Same case's `stderr` is exactly `["error: installed manager fingerprint
    is not detectable after install.", "hint: codex reported nothing"]`.
    Port: `tests/unit/lifecycle.test.js:193-207`. No counterpart in
    `tests/test_codex_state_units.sh`. Partial counterpart in
    `tests/test_marketplace_reconcile.sh:298-299`: `grep -Fq "fingerprint is
    not detectable"` and `grep -Fq "adapter missing hint"` check the same two
    message strings independently, not as an exact two-line array.
19. `verifyInstalledFingerprint` returns `ok: false` with no hint line when
    the adapter supplies no `verification_hints` at all. Port:
    `tests/unit/lifecycle.test.js:209-217`. No counterpart in either driver:
    every call in `tests/test_marketplace_reconcile.sh` reuses the same
    `$install_result` file (`:272-274`), whose `verification_hints` always
    defines both `mismatch` and `missing` — a hintless mismatch is never
    constructed there.
20. Same case's `stderr` has exactly one line (no `hint:` line appended).
    Port: `tests/unit/lifecycle.test.js:209-217`. No counterpart in either
    driver, same rationale as item 19.
21. `verifyUninstalledResources` returns `{ ok: true }` when both resources
    are absent. Port: `tests/unit/lifecycle.test.js:219-226`. No counterpart
    in `tests/test_codex_state_units.sh`. Counterpart in
    `tests/test_marketplace_reconcile.sh:252-255` (UNINSTALL-VERIFY-01
    baseline case): the bare `spw_verify_uninstalled_resources
    "$tmpdir/uninstalled.json"` call under `set -eu` is the shell's assertion
    that this case succeeds.
22. `verifyUninstalledResources` rejects a surviving plugin with `"owned
    plugin resource is still installed after removal"`. Port:
    `tests/unit/lifecycle.test.js:228-238`. No counterpart in
    `tests/test_codex_state_units.sh`. Counterpart in
    `tests/test_marketplace_reconcile.sh:231-251` (the `plugin` iteration of
    the UNINSTALL-VERIFY-01 loop): `residual_message='owned plugin resource
    is still installed after removal'` (`:235`) is the identical string,
    checked with `grep -Fq "$residual_message"` (`:250`) after asserting
    failure (`:245-249`).
23. `verifyUninstalledResources` rejects a surviving marketplace with `"owned
    marketplace resource is still registered after removal"`. Port:
    `tests/unit/lifecycle.test.js:240-250`. No counterpart in
    `tests/test_codex_state_units.sh`. Counterpart in
    `tests/test_marketplace_reconcile.sh:231-251` (the `marketplace`
    iteration of the same loop): `residual_message='owned marketplace
    resource is still registered after removal'` (`:239`) is the identical
    string, checked the same way.
24. `verifyUninstalledResources` fails closed with `"expected a Boolean
    adapter result at resources.plugin"` when a resource field is present but
    not Boolean (`plugin: "false"`). Port:
    `tests/unit/lifecycle.test.js:252-265`. No counterpart in
    `tests/test_codex_state_units.sh`. No counterpart in
    `tests/test_marketplace_reconcile.sh` either: `grep -cE "expected a
    Boolean|expected an object" tests/test_marketplace_reconcile.sh` returns
    0. Its only malformed-ownership case (`:222-228`) supplies `{}` — a
    `resources` key that is missing entirely, which in the TypeScript port is
    a *different* branch (`"expected an object adapter result at
    resources"`, not ported among these 14 tests) — and that case never
    checks message text at all, only that the call fails.
25. `verifyUninstalledResources` fails closed when the inspection itself
    failed (`AdapterResult.status !== 0`). Port:
    `tests/unit/lifecycle.test.js:267-270`. No counterpart in
    `tests/test_codex_state_units.sh`. No counterpart in
    `tests/test_marketplace_reconcile.sh`: unlike
    `spw_verify_installed_fingerprint`, `spw_verify_uninstalled_resources`
    takes only a file path and has no shell-level notion of the *inspection
    call* failing independently of its content — every case that driver
    constructs is a real file, well-formed or not, never a captured nonzero
    exit status.

<!-- inventory:port-only:end -->

## Cardinality

```json inventory
{
  "shellOriginal": 16,
  "portOnly": 25,
  "ports": { "tests/unit/lifecycle.test.js": 20 }
}
```

- Shell original: **16** assertions (2 clean-state checks for
  `spw_require_no_legacy_state`, 2 rejection checks + 6 `grep -Fxq` checks for
  its `legacy`/`both` arm, 2 clean-state checks for `spw_report_legacy_state`,
  4 `grep -Fxq` checks for its `legacy`/`both` arm; sum: 2+2+6+2+4 = 16).
- Port (`tests/unit/lifecycle.test.js`): 20 static `test(` call sites,
  carrying all 16 shell assertions (each of the four `void test(...)` cases
  covering `neither`/`manager`/`legacy`/`both` groups multiple shell
  assertions behind one `assert.deepEqual`, since the port returns a verdict
  object rather than writing text line by line), plus 25 port-only assertions
  (items 1-25 above): items 1-4 cover the `*)` arm neither shell case
  statement ever reached, and items 5-25 are the 21 assertions across the 14
  new `void test(...)` cases for `requireManagedUpdateControl`,
  `verifyInstalledFingerprint`, and `verifyUninstalledResources`
  (1+1+1+3+1+3+2+2+2+1+1+1+1+1 = 21, reading the fourteen cases top to
  bottom). Of those 21, 10 (items 8, 9, 11, 15, 16, 17, 18, 21, 22, 23) have a
  counterpart — full or partial — in `tests/test_marketplace_reconcile.sh`;
  the other 11 (items 5, 6, 7, 10, 12, 13, 14, 19, 20, 24, 25) are `New` with
  no counterpart in either driver. Slice 4c's `marketplace-reconcile.md` is
  the inventory that maps `tests/test_marketplace_reconcile.sh`'s own
  assertions onto these same ten items; this file makes no claim beyond
  "port-only relative to `test_codex_state_units.sh`" for any of the 21.
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
  distinction becomes assertable again. The 25 port-only entries (items 1-25)
  are strictly additive test coverage — not a reconciliation of any shell
  assertion — and are excluded from the 16/16 arithmetic above.
