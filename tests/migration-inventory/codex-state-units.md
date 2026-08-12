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
   `tests/unit/lifecycle.test.js:29-33`.
2. `[ -z "$output" ]` for `manager` (`:12-13`). Port:
   `tests/unit/lifecycle.test.js:29-33`.

### `spw_require_no_legacy_state` rejects `legacy` and `both` (`:16-26`)

3. The `if …; then exit 1; fi` rejection for `legacy` (`:17-20`). Port:
   `tests/unit/lifecycle.test.js:35-43`.
4. The `if …; then exit 1; fi` rejection for `both` (`:17-20`). Port:
   `tests/unit/lifecycle.test.js:35-43`.
5. `grep -Fxq 'Legacy superpowers-wrapper Codex state is installed.'` for
   `legacy` (`:21-22`). Port: `tests/unit/lifecycle.test.js:35-43`.
6. `grep -Fxq 'Run: npx superpowers-wrapper@0.1.1 uninstall'` for `legacy`
   (`:23-24`). Port: `tests/unit/lifecycle.test.js:35-43`.
7. `grep -Fxq 'Then run: npx superpowers-manager install'` for `legacy`
   (`:25-26`). Port: `tests/unit/lifecycle.test.js:35-43`.
8. `grep -Fxq 'Legacy superpowers-wrapper Codex state is installed.'` for
   `both` (`:21-22`). Port: `tests/unit/lifecycle.test.js:35-43`.
9. `grep -Fxq 'Run: npx superpowers-wrapper@0.1.1 uninstall'` for `both`
   (`:23-24`). Port: `tests/unit/lifecycle.test.js:35-43`.
10. `grep -Fxq 'Then run: npx superpowers-manager install'` for `both`
    (`:25-26`). Port: `tests/unit/lifecycle.test.js:35-43`.

### `spw_report_legacy_state` is silent for the two clean identity states (`:29-32`)

11. `[ -z "$output" ]` for `neither` (`:30-31`). Port:
    `tests/unit/lifecycle.test.js:45-49`.
12. `[ -z "$output" ]` for `manager` (`:30-31`). Port:
    `tests/unit/lifecycle.test.js:45-49`.

### `spw_report_legacy_state` reports `legacy` and `both` (`:34-40`)

13. `grep -Fxq 'Legacy superpowers-wrapper Codex state remains installed.'`
    for `legacy` (`:36-37`). Port: `tests/unit/lifecycle.test.js:51-59`.
14. `grep -Fxq 'Run: npx superpowers-wrapper@0.1.1 uninstall'` for `legacy`
    (`:38-39`). Port: `tests/unit/lifecycle.test.js:51-59`.
15. `grep -Fxq 'Legacy superpowers-wrapper Codex state remains installed.'`
    for `both` (`:36-37`). Port: `tests/unit/lifecycle.test.js:51-59`.
16. `grep -Fxq 'Run: npx superpowers-wrapper@0.1.1 uninstall'` for `both`
    (`:38-39`). Port: `tests/unit/lifecycle.test.js:51-59`.

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
   Port: `tests/unit/lifecycle.test.js:66-75`. No shell counterpart — the
   shell driver never called `spw_require_no_legacy_state` with a state
   outside `neither|manager|legacy|both`.
2. **New.** `reportLegacyState` returns `{ kind: "unknown", message:
   "unknown adapter identity state: garbage" }` for an unrecognised state.
   Port: `tests/unit/lifecycle.test.js:66-75`. No shell counterpart, same
   rationale as item 1.
3. **New.** `requireNoLegacyState` returns `{ kind: "unknown", message:
   "unknown adapter identity state: " }` for an empty identity state. Port:
   `tests/unit/lifecycle.test.js:77-86`. No shell counterpart, same
   rationale as item 1.
4. **New.** `reportLegacyState` returns `{ kind: "unknown", message:
   "unknown adapter identity state: " }` for an empty identity state. Port:
   `tests/unit/lifecycle.test.js:77-86`. No shell counterpart, same
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
    inspection *call* to fail — only its *content* to be unparseable. On the
    shell that content lands on a **different** branch,
    `scripts/core/lifecycle.sh:95-97`'s "cannot parse" path, not on the
    "inspection failed" path this item describes. **In the port the two
    collapse onto this item's branch**, which is a behavioural divergence
    rather than a mapping gap — see the divergence note under item 14.
13. Same case's `stdout` is `[]`. Port:
    `tests/unit/lifecycle.test.js:170-177`. No counterpart in either driver,
    same rationale as item 12.
14. Same case's `stderr` is exactly `["error: installed manager fingerprint
    inspection failed after install."]`. Port:
    `tests/unit/lifecycle.test.js:170-177`. No counterpart in either driver,
    same rationale as item 12.

    **Divergence — a live shell assertion with no satisfying port.**
    *Rewritten 2026-08-10 at the whole-branch review; the previous text was
    wrong in both halves and is quoted here so the error is not re-derived:
    it said `:307-316` tests "an unparseable fingerprint value (`raw` present
    but non-string, non-null)" and concluded that "neither driver's
    malformed-inspection case lines up with this item or with any other item
    in this list." Both claims are false, and item 12 fourteen lines above
    described the same lines correctly, so the inventory contradicted itself.*

    What `tests/test_marketplace_reconcile.sh:304-316` actually exercises:
    `:304-306` overrides `spw_inspect_fingerprint` with
    `printf '%s\n' '{' > "$1"`, which writes malformed JSON for the **whole
    result file** — not a non-string value in the `fingerprint` field. That
    `printf` **succeeds**, so `scripts/core/lifecycle.sh:91` does not take the
    "inspection failed" branch. Control reaches `:95`, where
    `spw_adapter_result_get` → `spw_json_get` fails at `json.load`
    (`scripts/core/provenance.sh:39-43` exits with `invalid JSON in <path>`),
    the command substitution's subshell dies non-zero, and `:96` emits
    **`error: cannot parse installed manager fingerprint inspection result
    after install.`** `:312`'s `grep -Fq "parse"` is a **live assertion** on
    that output, with `:313-314` forbidding both "fingerprint is not
    detectable" and "manager updated".

    In the port that same malformed content arrives as an `AdapterResult`
    that `resultObject` rejects (`src/lifecycle.ts:101-112` returns `null` for
    a non-zero status, a non-`ok` envelope, or a non-object `result`), so
    `:129-137` returns `"error: installed manager fingerprint inspection
    failed after install."` — **which does not contain the word "parse"**, and
    is this item's own text. The port's "cannot parse" branch (`:142-150`)
    fires only on a `raw` that is present, non-null and non-string — a trigger
    **the shell cannot produce**, because `spw_json_get` prints any non-null
    scalar (`provenance.sh:62`), so a numeric `fingerprint` would be
    stringified and compared rather than diagnosed.

    So the two sides genuinely disagree, in both directions at once: a
    currently-asserted shell assertion (`:312`) has **no satisfying port**,
    and the port's "cannot parse" branch is **new behaviour with no shell
    origin**. **The code fix is deferred, the record is not.** Slice 4c's
    `marketplace-reconcile.md` reconciles that driver against this text and
    must treat `:312` as an open divergence to disposition — not as a mapped
    assertion and not as a gap this inventory already settled.

    **Resolved, this commit.** Spec §6.2.3 item 3b replaces `resultObject`
    with `readResult`, a three-way `ResultRead` (`"object" | "call-failed" |
    "unusable"`). `verifyInstalledFingerprint` now distinguishes the inspect
    *call* failing (`"call-failed"`, this item's own branch, unchanged) from
    the call succeeding with an unusable (non-object) result
    (`"unusable"`), which returns `"error: cannot parse installed manager
    fingerprint inspection result after install."` — matching
    `scripts/core/lifecycle.sh:95-97`'s branch and satisfying
    `tests/test_marketplace_reconcile.sh:312`'s `grep -Fq "parse"`. Pinned by
    items 26-28 below (`tests/unit/lifecycle.test.js:272-287`, "an unparseable
    fingerprint result names parsing, not inspection"), of which item 27 is
    the `stderr` assertion that carries the "cannot parse" text. **Slice 4c's
    `marketplace-reconcile.md` must disposition `:312` as mapped by that
    test, not as an open divergence** — the paragraphs above are kept as
    history (per this file's own convention of amending rather than
    deleting), not as the current state.
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
    `resources` key that is missing entirely. **Amended, this commit:**
    before spec §6.2.3 item 3a, that shape reached a *different*, port-only
    branch (`"expected an object adapter result at resources"`, not ported
    among these 14 tests); that branch is now deleted and `{}` falls through
    to this same Boolean check — see items 35-36 below. The shell's `:222-228`
    case still never checks message text, only that the call fails.
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
26. **New, this commit.** `verifyInstalledFingerprint` returns `ok: false`
    when the inspect call *succeeds* but its `result` is not an object (a
    string, here). Port: `tests/unit/lifecycle.test.js:272-287` ("an
    unparseable fingerprint result names parsing, not inspection").
    Counterpart in `tests/test_marketplace_reconcile.sh:304-316` (see item
    14's resolution paragraph for the full trace); no counterpart in
    `tests/test_codex_state_units.sh`.
27. Same case's `stderr` is exactly `["error: cannot parse installed manager
    fingerprint inspection result after install."]` — naming "cannot parse",
    not "inspection failed". Port: `tests/unit/lifecycle.test.js:272-287`.
    This is the assertion that resolves item 14's divergence callout above:
    it is what makes `tests/test_marketplace_reconcile.sh:312`'s live
    `grep -Fq "parse"` satisfiable, per the `readResult`/`ResultRead` split
    of spec §6.2.3 item 3b. Counterpart in
    `tests/test_marketplace_reconcile.sh:304-316`; no counterpart in
    `tests/test_codex_state_units.sh`.
28. Same case's `stdout` is exactly `[]`. Port:
    `tests/unit/lifecycle.test.js:272-287`. No counterpart in
    `tests/test_codex_state_units.sh`. Partial counterpart in
    `tests/test_marketplace_reconcile.sh:313-314`, which forbids the
    "manager updated" line on this path but reads one combined output
    capture and so never asserts that the call produced no stdout at all.
29. **New, this commit.** `verifyInstalledFingerprint` fails closed on a
    non-string, non-null `fingerprint` (e.g. `42`) rather than coercing it.
    Port: `tests/unit/lifecycle.test.js:289-301` ("a non-string fingerprint
    is unparseable, not empty"). **No shell counterpart is possible**:
    `scripts/core/provenance.sh:62`'s `spw_json_get` stringifies any
    non-null scalar before `spw_verify_installed_fingerprint` ever sees it,
    so a non-string `fingerprint` value cannot reach the shell function this
    ports. The branch itself already existed unchanged at the pre-commit
    `src/lifecycle.ts:142-150` (spec §6.2.3 item 3c keeps it unchanged) but
    was previously unpinned by any test; this item and item 30 close that
    gap.
30. Same case's `stderr` is exactly `["error: cannot parse installed manager
    fingerprint inspection result after install."]` — the same operator
    string item 27 pins for the unparseable-result case, so the two distinct
    triggers are confirmed to share one message rather than drifting apart.
    Port: `tests/unit/lifecycle.test.js:289-301`. No shell counterpart is
    possible, same rationale as item 29.
31. **New, this commit.** `verifyUninstalledResources` returns `ok: false`
    when the inspection call itself failed — the same case item 25 covers,
    which asserted only `ok === false` and left the operator string
    unpinned. Port: `tests/unit/lifecycle.test.js:303-312` ("an unreadable
    ownership inspection names reading, with its text"). No counterpart in
    either driver, same rationale as item 25.
32. Same case's failure `message` is exactly `"cannot read the adapter
    ownership inspection after removal"`. This is the assertion that closes
    the operator-string gap item 25 left open. Port:
    `tests/unit/lifecycle.test.js:303-312`. No counterpart in either driver,
    same rationale as item 25.
33. **New, this commit.** `verifyUninstalledResources` returns `ok: false`
    when the `["plugin", "marketplace"]` Boolean-check loop meets a valid
    `plugin` and a non-Boolean `marketplace`. Port:
    `tests/unit/lifecycle.test.js:314-325` ("the marketplace Boolean check
    names its own key"). No counterpart in either driver: `grep -cE
    "resources\.marketplace" tests/test_marketplace_reconcile.sh` returns 0.
34. Same case's failure `message` is exactly `"expected a Boolean adapter
    result at resources.marketplace"` — the loop names its own key rather
    than using a template that hardcoded `"plugin"` (which item 24 alone
    could not have caught, since item 24 only ever supplies a non-Boolean
    `plugin`). Port: `tests/unit/lifecycle.test.js:314-325`. No counterpart
    in either driver, same rationale as item 33.
35. **This commit; removes a port-only divergence rather than adding one.**
    `verifyUninstalledResources` returns `ok: false` on a non-object (or
    wholly absent) `resources` key (input `{}`), falling through to the same
    Boolean check as a present-but-wrong-type field. Port:
    `tests/unit/lifecycle.test.js:327-338` ("a non-object resources falls
    through to the Boolean message"). No counterpart in
    `tests/test_codex_state_units.sh`; `tests/test_marketplace_reconcile.sh`
    exercises the identical `{}` input at `:222-228`, but checks only that
    the call fails, never its message text.
36. Same case's failure `message` is exactly `"expected a Boolean adapter
    result at resources.plugin"`, rather than the now-deleted distinct
    `"expected an object adapter result at resources"` message. Port:
    `tests/unit/lifecycle.test.js:327-338`. Before spec §6.2.3 item 3a, the
    deleted message was a **live-shell-tested divergence**, not a harmless
    hardening: `scripts/core/adapter.sh:70` emits this same "expected Boolean
    adapter result at resources.plugin" text for the identical `{}` input
    that `tests/test_marketplace_reconcile.sh:224` writes, so the port's
    distinct message disagreed with the shell on a case the shell actually
    exercises. This item, and item 24's amendment above, are what stop that
    divergence from being reintroduced.

<!-- inventory:port-only:end -->

## Cardinality

```json inventory
{
  "shellOriginal": 16,
  "portOnly": 36,
  "ports": { "tests/unit/lifecycle.test.js": 25 }
}
```

- Shell original: **16** assertions (2 clean-state checks for
  `spw_require_no_legacy_state`, 2 rejection checks + 6 `grep -Fxq` checks for
  its `legacy`/`both` arm, 2 clean-state checks for `spw_report_legacy_state`,
  4 `grep -Fxq` checks for its `legacy`/`both` arm; sum: 2+2+6+2+4 = 16).
- Port (`tests/unit/lifecycle.test.js`): 25 static `test(` call sites,
  carrying all 16 shell assertions (each of the four `void test(...)` cases
  covering `neither`/`manager`/`legacy`/`both` groups multiple shell
  assertions behind one `assert.deepEqual`, since the port returns a verdict
  object rather than writing text line by line), plus 36 port-only assertions
  (items 1-36 above): items 1-4 cover the `*)` arm neither shell case
  statement ever reached, and items 5-25 are the 21 assertions across the 14
  original new `void test(...)` cases for `requireManagedUpdateControl`,
  `verifyInstalledFingerprint`, and `verifyUninstalledResources`
  (1+1+1+3+1+3+2+2+2+1+1+1+1+1 = 21, reading the fourteen cases top to
  bottom). Of those 21, 10 (items 8, 9, 11, 15, 16, 17, 18, 21, 22, 23) have a
  counterpart — full or partial — in `tests/test_marketplace_reconcile.sh`;
  the other 11 (items 5, 6, 7, 10, 12, 13, 14, 19, 20, 24, 25) are `New` with
  no counterpart in either driver. Slice 4c's `marketplace-reconcile.md` is
  the inventory that maps `tests/test_marketplace_reconcile.sh`'s own
  assertions onto these same ten items; this file makes no claim beyond
  "port-only relative to `test_codex_state_units.sh`" for any of the 21.
  Items 26-36 are eleven further port-only assertions across the five new
  `void test(...)` cases added by the commit that reconciles operator text
  with the shell original (spec §6.2.3 items 3 and 6), in the order those
  cases appear in the file: 26-28 (`:272-287`), 29-30 (`:289-301`), 31-32
  (`:303-312`), 33-34 (`:314-325`) and 35-36 (`:327-338`), summing
  3+2+2+2+2 = 11. Case by case: items 26-28 are the test that resolves item
  14's divergence callout — see the amendment there — of which items 26 and
  27 have a counterpart in `tests/test_marketplace_reconcile.sh:304-316`
  while item 28 has only a partial one at `:313-314` (see its own entry);
  items 29-30
  have no counterpart in either driver (see item 29 for why the shell
  cannot construct the trigger); items 31-32 pin message text for the same
  failed-inspection case item 25 already covered by `ok` alone; items 33-34
  pin the loop's second (`marketplace`) key, which item 24 alone never
  exercised; items 35-36 remove a port-only divergence that previously
  existed only as an aside inside item 24's prose, not as its own numbered
  item. Item 14's own classification earlier in this paragraph (`New`, no
  counterpart in either driver) is unchanged, because item 14 still names
  the "inspection failed" case, not the newly satisfiable "cannot parse"
  case that items 26-28 now cover.

  ***Amended 2026-08-12:*** *these five cases were previously carried as five
  items, 26-30 — one row per **case**, while items 12-25 above use one row
  per **assertion**. The five were split into eleven, 26-36, and `portOnly` moved
  from 30 to 36, so that a single convention governs the whole region and
  the declared count means the same thing at both ends of it. No item text
  was retired and no cited range moved — each new row reuses its case's
  existing `tests/unit/lifecycle.test.js` range, exactly as the 15/16, 17/18
  and 19/20 pairs already do. The port-only region carries its own
  `1..portOnly` numbering, and item 30 was the highest number in the file,
  so nothing later is renumbered. `shellOriginal` (16) and `ports` (25) are
  facts about the deleted shell driver and about static `test(` sites
  respectively, and neither changes.*
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
  this repo witnessed that stdout/stderr split at the commit that landed this
  file. That was recorded as a deferral, not a drop: the command-path caller
  that consumes `LegacyVerdict.lines`, landing in **slice 4b**, had to pin the
  report path's lines to stdout and the block path's lines to stderr.
  ***Deferral discharged 2026-08-11, in the slice it named; recorded here at
  that slice's closeout so the bullet stops reading as outstanding.*** *Both
  halves landed, in the two command modules that consume the two arms.* **Block
  path → stderr:** *`tests/unit/commands-install.test.js`'s legacy-blocked case
  asserts stderr is exactly the three `BLOCKED_LINES` and stdout carries only
  the unrelated note (`:427-433`).* **Report path → stdout, with its converse:**
  *`tests/unit/commands-uninstall.test.js` asserts both report lines are in
  stdout and then asserts stderr does **not** contain `remains installed`
  (`:84-101`) — the half that would otherwise pass silently if a caller wrote
  both verdicts to stderr.* The 30 port-only entries (items 1-30)
  are strictly additive test coverage — not a reconciliation of any shell
  assertion — and are excluded from the 16/16 arithmetic above.
