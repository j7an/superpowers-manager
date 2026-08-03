# Migration inventory: tests/test_uninstall_commands.sh

Source read in full (457 lines). Ported to
`tests/bin/uninstall-commands.test.js`.

No behavior ID in `docs/baseline/traceability.md` references
`test_uninstall_commands` (confirmed by
`grep -c test_uninstall_commands docs/baseline/traceability.md` returning 0).
This inventory is the evidence that no assertion was dropped.

Shell line references below are `:N` against the deleted
`tests/test_uninstall_commands.sh`; port line references are `:N` against
`tests/bin/uninstall-commands.test.js`.

## Counting rules applied

The first six rules are reproduced from `bin-dispatch.md:10-25`, unchanged:

- Each `[ ... ] || { echo …; exit 1; }` guard is one assertion.
- Each `grep -Fq` / `grep -Fqx` is one assertion, including bare ones relied
  on by `set -e`.
- Each `if <command>; then echo …; exit 1; fi` negative guard is one
  assertion.
- A `for` loop over N commands performing one assertion each contributes N.
- The `command -v node` precondition at `bin-dispatch:9` is one assertion.
- A bare `[ ... ]` test with no `|| { ... }` handler, relied on by `set -e`
  exactly like a bare `grep`, is counted the same way — one assertion each.
  Two such bare tests exist here: `:270` and `:271`.

Two further rules are needed for this driver, stated explicitly rather than
folded silently into the six above:

- **Rule 7 — assertion helpers count at the call site, not at the
  definition.** This driver factors four assertion helpers out of its
  scenarios: `expect_fail` (`:126-132`), `assert_uninstall_tmp_empty`
  (`:134-140`), `assert_output_contains` (`:142-148`), and `assert_no_removes`
  (`:150-156`). Each helper body is exactly one rule-3 negative guard, so this
  is rule 3 applied at the point of use: one assertion per invocation, zero at
  the definition. Counting the definitions instead would report 4 assertions
  for 34 distinct scenario-level claims. `line_of` (`:158-160`) is a value
  extractor, not an assertion, and is not counted.
- **Rule 8 — a negative guard whose condition is a `||` chain of N
  independent `grep` tests counts N, not 1.** Rules 2 and 3 conflict at
  `:252-257`, where one `if … then echo …; exit 1; fi` wraps two separate
  `grep -Fq` calls joined by `||`. Rule 2 (per-grep) wins: the two greps are
  two independent claims — that the log names no legacy plugin id, and that it
  contains no legacy marketplace remove — sharing only a diagnostic block.
  The port makes them two assertions, so counting them as two keeps the
  mapping 1:1. This is the only occurrence in the file.

**`command -v` assignments are not assertions.** `:174-181` resolves
`python3`, `node`, and 15 coreutils to build the no-git PATH, using bare
`real=$(command -v "$tool")` assignments inside a `for` loop. These are the
`node_bin=$(command -v node)` form at `test_bin_dispatch.sh:10`, which
`bin-dispatch.md` did **not** count — not the guarded
`command -v node … || { echo …; exit 1; }` form at `:9`, which it counted as
its item 1. This driver has no guarded-precondition form, so rule 5
contributes 0 here and the loop contributes 0 under rule 4. Both readings, for
the record: **83** excluding them, **100** if the 17 loop/assignment
resolutions were counted. Decision: **excluded**, following the
`bin-dispatch.md:10` precedent for the unguarded form.

## Assertion inventory

<!-- inventory:mapped:start -->

### Source guards: no Codex ownership leaks into shared code (`:9-16`)

These two read the repository's own source, not a fixture snapshot, so the
port reads `ROOT` rather than the copied package root.

1. `scripts/uninstall` does not source `scripts/adapters/codex/lib.sh`
   (`:9-12`). Port: `:208`.
2. `scripts/core/lifecycle.sh` names neither `SPW_PLUGIN_ID` nor
   `SPW_MARKETPLACE_NAME` (`:13-16`). Port: `:217`.

### Selection-independent recovery (`:162-190`)

Malformed saved selection, no `git` on PATH, and `unsupported` update control
must not prevent owned-resource removal and verification.

3. The plugin remove reaches Codex: `plugin remove
   superpowers@superpowers-manager` (`:183`). Port: `:246`.
4. The marketplace remove reaches Codex: `plugin marketplace remove
   superpowers-manager` (`:184`). Port: `:247`.
5. Update control is never inspected — the adapter log holds no
   `inspect --view update-control` (`:185-189`). Port: `:250`. Non-vacuous
   because items 3-4 prove the adapter ran: only the adapter issues those
   Codex calls.
6. Stdout contains `uninstall complete` (`:190`). Port: `:255`.

### Missing python3: clear requirement error, no Codex calls (`:192-212`)

**Environment divergence.** The shell invoked this one scenario without
`SPW_ADAPTER` (`:198` sets only `PATH` and `SUPERPOWERS_CODEX`); the port's
`runScript` always exports `SPW_ADAPTER`, so it is set at `:266`. Immaterial to
all three assertions: `spw_require_command python3` runs at `scripts/uninstall:10`,
before the adapter is consulted at all, so the run dies before any adapter
invocation and item 9's empty-Codex-log claim is unaffected. Recorded because
this file's premise is line-level fidelity, and an unrecorded env difference is
indistinguishable from an unnoticed one. `SPW_ADAPTER` is not narrowed away
anywhere else — every other scenario set it in the shell too.

7. Uninstall fails when `python3` is absent from PATH (`:198-202`). Port:
   `:268`.
8. Output contains `required command not found: python3` (`:203-207`). Port:
   `:274`.
9. The Codex log is empty — no Codex call was made (`:208-212`). Port:
   `:279`.

### Missing Codex is a controlled ownership-inspect failure (`:214-232`)

10. Uninstall fails when the Codex binary is missing (`:220-225`). Port:
    `:294`.
11. The adapter log holds the exact line `inspect --view ownership`
    (`:226`). Port: `:300`.
12. Output holds the exact line `error: required Codex command not found:
    <path>` (`:227`). Port: `:302`.
13. Output does **not** contain `error: invalid adapter response:` — a
    missing Codex must stay a controlled inspect failure (`:228-232`). Port:
    `:308`. Non-vacuous because item 12 proves the output carries the
    adapter's diagnostics.

### Legacy-only state is never mutated and leaves guidance (`:234-242`)

14. No remove command reaches Codex (`:239`, `assert_no_removes`). Port:
    `:322`, helper at `:133`.
15. The adapter log holds the exact line `uninstall --plugin-present false
    --marketplace-present false` (`:240`). Port: `:324`.
16. Stdout holds the exact line `Legacy superpowers-wrapper Codex state
    remains installed.` (`:241`). Port: `:330`.
17. Stdout holds the exact line `Run: npx superpowers-wrapper@0.1.1
    uninstall` (`:242`). Port: `:342`. This literal is user-facing guidance
    owned by `scripts/core/lifecycle.sh:52,77`, not a dependency version that
    moves on someone else's schedule — the exact text is the contract.

### Mixed state removes manager resources only (`:244-259`)

18. The manager plugin remove reaches Codex (`:250`). Port: `:358`.
19. The manager marketplace remove reaches Codex (`:251`). Port: `:359`.
20. The Codex log never names `superpowers@superpowers-wrapper` (`:252`, the
    first grep of the rule-8 `||` chain). Port: `:362`.
21. The Codex log holds no `plugin marketplace remove superpowers-wrapper`
    (`:253`, the second grep of the same chain). Port: `:366`. Items 20-21
    are non-vacuous because items 18-19 prove removes reached the log.
22. Stdout holds the exact line `Legacy superpowers-wrapper Codex state
    remains installed.` (`:258`). Port: `:371`.
23. Stdout holds the exact line `Run: npx superpowers-wrapper@0.1.1
    uninstall` (`:259`). Port: `:378`.

### Both present: both removed, plugin before marketplace (`:261-289`)

24. The invocation TMPDIR is left empty — no leaked workspace or adapter
    sidecar (`:267`, `assert_uninstall_tmp_empty`). Port: `:393`, helper at
    `:159`. **Scope narrowed — see the note below.**

**TMPDIR scope narrowing (items 24 and 45).** The shell created
`$uninstall_tmp` once at `:20-21` and never cleared it in `reset`
(`:110-116`), so by the time `assert_uninstall_tmp_empty` ran at `:267` it was
proving that *every* run since `:162` — the recovery, missing-python3,
missing-Codex, legacy-only, and mixed-state scenarios too — had left no
residue. `assertTmpEmpty(c)` inspects one case's own TMPDIR, because
`createCase` gives every case a private one. The claim is therefore narrower
than the shell's at both call sites: it still catches a leak in the scenario
that makes it, but no longer sweeps up the scenarios that ran before it. This
is an unavoidable consequence of the per-case isolation this plan mandates —
shared mutable state between scenarios is exactly what the port exists to
remove — not an oversight. Restoring the wider claim would mean asserting an
empty TMPDIR in all 18 cases, which is a different (and strictly stronger)
design than the shell had; it is not proposed here.
25. The adapter log holds the exact line `inspect --view ownership`
    (`:268`). Port: `:395`.
26. The adapter log holds the exact line `uninstall --plugin-present true
    --marketplace-present true` (`:269`). Port: `:396`.
27. `inspect --view ownership` appears exactly twice (`:270`, bare `[ ... ]`
    per rule 6). Port: `:402`.
28. `uninstall --plugin-present true --marketplace-present true` appears
    exactly once (`:271`, bare `[ ... ]`). Port: `:406`.
29. The first ownership inspect precedes the adapter uninstall (`:275`).
    Port: `:422`.
30. The adapter uninstall precedes the last ownership inspect (`:276`).
    Port: `:426`. Items 29-30 use `firstIndex` and `lastIndex` respectively,
    mirroring the shell's `head -n1` and `tail -n1`.
31. The plugin remove reaches Codex (`:277`). Port: `:431`.
32. The marketplace remove reaches Codex (`:278`). Port: `:432`.
33. The plugin remove precedes the marketplace remove (`:281`). Port:
    `:433`, via `assertOrder`.
34. The Codex log never names `openai-curated` (`:282-285`). Port: `:442`.
    Non-vacuous and reachable: `openai-curated` is a real marketplace in
    `MARKETPLACE_PRESENT`, so an over-broad marketplace removal would log
    `plugin marketplace remove openai-curated` and turn this red.
35. The adapter log never names `other@x` — the adapter uninstall receives
    booleans, not provider names (`:286-289`). Port: `:446`.
    **Inherited-inert; adjudicated below.**

**Item 35 adjudication: inherited-inert.** The port is faithful — the shell
assertion at `:286-289` was equally inert, and porting it unchanged was the
right call — but it is not a live check, and recording it as merely
"non-vacuous" would be false. It gets the same two-part treatment
`bin-dispatch.md:27-36` gives a contested item, because that is what this is.

*(1) Why the violation is unreachable here.* The needle `other@x` appears in no
fixture in the port. The only plugin ids any fixture defines are
`superpowers@superpowers-manager` and `superpowers@superpowers-wrapper`; the
only marketplace names are `openai-curated`, `superpowers-manager`, and
`superpowers-wrapper`. The adapter log records `ARGS.join(" ")` for each
adapter invocation, and the arguments in this scenario are drawn entirely from
those fixtures plus the two literal booleans. No subject behavior, correct or
broken, can put `other@x` into the adapter log against the current fixture set,
so no mutation of `scripts/` can turn this assertion red. Contrast item 34,
which names a string a real fixture supplies and is therefore live.

*(2) What would make it reachable.* Two changes, either alone:

- Adding an unrelated third-party provider to `MARKETPLACE_PRESENT` or to a
  plugin fixture — literally `other@x`, or any id the assertion is generalised
  to name — restores the original intent, which was that the adapter uninstall
  receives `--plugin-present`/`--marketplace-present` booleans rather than a
  provider identity. Today no unrelated provider exists to leak.
- Changing `spw_adapter_uninstall` (`scripts/core/adapter.sh`) to pass resource
  *identities* instead of booleans. That is the regression the assertion was
  written against; it would surface as real ids in the adapter log, and the
  assertion would need to name one of the fixture ids to catch it — as written
  it would still pass.

Decision: **kept, unchanged, and flagged**. The formal mutation-proof pass in
the next task carries the adjudication of record for boundary guards; this
entry exists so no reader mistakes item 35 for a live check in the meantime.

### Plugin absent, marketplace present (`:291-302`)

36. No plugin remove reaches Codex — an absent plugin is not removed
    (`:296-299`). Port: `:461`. Non-vacuous because item 38 is asserted
    first in the port, proving the Codex log is non-empty.
37. The adapter log holds the exact line `uninstall --plugin-present false
    --marketplace-present true` (`:300`). Port: `:466`.
38. The marketplace remove reaches Codex (`:301`). Port: `:459` — hoisted
    above item 36 in the port so the negative cannot pass on an empty log.
39. Stdout reports `plugin not installed; skipping` (`:302`). Port: `:472`.

### Both absent: idempotent success, both skips reported (`:304-312`)

40. No remove command reaches Codex (`:309`). Port: `:483`, helper at
    `:133`.
41. The adapter log holds the exact line `uninstall --plugin-present false
    --marketplace-present false` (`:310`). Port: `:485`.
42. Stdout reports `plugin not installed; skipping` (`:311`). Port: `:491`.
43. Stdout reports `marketplace not registered; skipping` (`:312`). Port:
    `:492`.

### Plugin list query fails: abort, no removes (`:314-326`)

44. Uninstall fails (`:319`, `expect_fail`). Port: `:499`.
45. The invocation TMPDIR is left empty (`:320`). Port: `:505`, helper at
    `:159`. Same scope narrowing as item 24.
46. The adapter log holds no `uninstall --` line — the adapter uninstall must
    not run when ownership inspection fails (`:321-325`). Port: `:507`,
    helper at `:150`.
47. No remove command reaches Codex (`:326`). Port: `:512`, helper at
    `:133`.

### Malformed plugin list JSON: abort, no removes (`:328-338`)

48. Uninstall fails (`:332`). Port: `:519`.
49. The adapter log holds no `uninstall --` line (`:333-337`). Port: `:525`.
50. No remove command reaches Codex (`:338`). Port: `:530`.

### Malformed individual plugin entry: abort, no removes (`:340-351`)

51. Uninstall fails (`:344`). Port: `:537`.
52. The adapter log holds no `uninstall --` line (`:345-349`). Port: `:543`.
53. No remove command reaches Codex (`:350`). Port: `:548`.
54. Output contains `cannot parse output of` (`:351`,
    `assert_output_contains`). Port: `:550`.

### Marketplace list fails while the plugin is present (`:353-365`)

55. Uninstall fails (`:359`). Port: `:560`.
56. The adapter log holds no `uninstall --` line — abort before ANY remove,
    including the plugin's (`:360-364`). Port: `:566`.
57. No remove command reaches Codex (`:365`). Port: `:571`.

### Malformed individual marketplace entry (`:367-378`)

58. Uninstall fails (`:371`). Port: `:578`.
59. The adapter log holds no `uninstall --` line (`:372-376`). Port: `:584`.
60. No remove command reaches Codex (`:377`). Port: `:589`.
61. Output contains `cannot parse output of` (`:378`). Port: `:591`.

### Malformed marketplace list while the plugin is present (`:380-392`)

62. Uninstall fails (`:386`). Port: `:601`.
63. The adapter log holds no `uninstall --` line (`:387-391`). Port: `:607`.
64. No remove command reaches Codex (`:392`). Port: `:612`.

### Remove is a no-op: verify-after detects the still-present target (`:394-410`)

The shell's `: > "$state/remove_noop"` (`:399`) gated **both** the plugin
mutation (`:44`) and the marketplace mutation (`:68`), and its own comment
says "removes are logged but do not mutate the fixtures" — plural. It ports to
`{ removesMutateState: false }`, a deliberately global switch.

65. Uninstall fails (`:400`). Port: `:622`.
66. The adapter log holds the exact line `uninstall --plugin-present true
    --marketplace-present true` (`:401`). Port: `:629`.
67. `inspect --view ownership` appears exactly twice — verify-after re-runs
    ownership inspection after the adapter uninstall (`:402-406`). Port:
    `:635`.
68. The plugin remove was attempted and reached Codex (`:408`). Port:
    `:641`.
69. Output contains `still installed` — the plugin is still present on
    re-query, so uninstall must not succeed (`:410`). Port: `:645`.

### Verify-after schema drift: fail closed (`:412-426`)

70. Uninstall fails (`:418`). Port: `:653`.
71. The adapter log holds the exact line `uninstall --plugin-present true
    --marketplace-present true` (`:419`). Port: `:659`.
72. The plugin remove reached Codex (`:420`). Port: `:665`.
73. Output contains `cannot parse output of` (`:421`). Port: `:669`.
74. Output does **not** contain `uninstall complete` (`:422-426`). Port:
    `:672`. Non-vacuous because item 73 proves the output carries the
    subject's diagnostics.

### Marketplace remove fails after the plugin remove succeeds (`:428-455`)

75. Uninstall fails (`:435`). Port: `:683`.
76. The adapter log holds the exact line `uninstall --plugin-present true
    --marketplace-present true` (`:436`). Port: `:690`.
77. The plugin remove reached Codex (`:437`). Port: `:696`.
78. The marketplace remove reached Codex (`:438`). Port: `:697`.
79. Output does **not** contain `uninstall complete` (`:439-443`). Port:
    `:708`.
80. Output does **not** contain `error: invalid adapter response:` — one
    controlled adapter failure, not a protocol violation (`:444-448`). Port:
    `:713`.
81. Output replays the Codex stderr `marketplace remove exploded` (`:449`).
    Port: `:700`.
82. Output contains `error: codex plugin marketplace remove failed for
    superpowers-manager` (`:450`). Port: `:701`.
83. The Codex log never names `openai-curated` — a marketplace failure must
    not mutate unrelated providers (`:451-455`). Port: `:718`.

Items 81-82 are hoisted above items 79-80 in the port so that neither negative
can pass on empty output.

<!-- inventory:mapped:end -->

## Port-only assertions (outside the 1:1 mapping)

Items 1-6 are the same additive pattern `bin-dispatch.md` records: the shell
left the exit status implicit under `set -e` (a bare `run_uninstall >/dev/null`
or `out=$(run_uninstall)` with no explicit status test), and the port asserts
it explicitly.

Items 7-20 are non-vacuity guards with no shell analogue. The shell's `$log`
and `$adapter_log` were files the fakes appended to before doing anything else,
so `grep -Fq` over them could not silently degrade. `readLog` returns `[]` for
a missing file, so a fixture that never launched a fake at all would satisfy
every negative assertion over its log. Each guard asserts the log is non-empty
before filtering it; every call site runs a subject that reaches
`codex plugin list` (and, for the adapter, `inspect --view ownership`), so an
empty log there is a fixture fault, never a legitimate state.

<!-- inventory:port-only:start -->

1. Selection-independent recovery: `result.status === 0` (`:241`).
2. Legacy-only state: `result.status === 0` (`:320`).
3. Mixed state: `result.status === 0` (`:354`).
4. Both present: `result.status === 0` (`:387`).
5. Plugin absent, marketplace present: `result.status === 0` (`:455`).
6. Both absent: `result.status === 0` (`:481`).
7. `assertNoRemoves` non-vacuity guard (`:128`) at the legacy-only call site
   (`:322`).
8. `assertNoRemoves` non-vacuity guard at the both-absent call site (`:483`).
9. `assertNoRemoves` non-vacuity guard at the plugin-list-fails call site
   (`:512`).
10. `assertNoRemoves` non-vacuity guard at the malformed-plugin-list call site
    (`:530`).
11. `assertNoRemoves` non-vacuity guard at the malformed-plugin-entry call
    site (`:548`).
12. `assertNoRemoves` non-vacuity guard at the marketplace-list-fails call
    site (`:571`).
13. `assertNoRemoves` non-vacuity guard at the malformed-marketplace-entry
    call site (`:589`).
14. `assertNoRemoves` non-vacuity guard at the malformed-marketplace-list call
    site (`:612`).
15. `assertNoAdapterUninstall` non-vacuity guard (`:145`) at the
    plugin-list-fails call site (`:507`).
16. `assertNoAdapterUninstall` non-vacuity guard at the malformed-plugin-list
    call site (`:525`).
17. `assertNoAdapterUninstall` non-vacuity guard at the malformed-plugin-entry
    call site (`:543`).
18. `assertNoAdapterUninstall` non-vacuity guard at the marketplace-list-fails
    call site (`:566`).
19. `assertNoAdapterUninstall` non-vacuity guard at the
    malformed-marketplace-entry call site (`:584`).
20. `assertNoAdapterUninstall` non-vacuity guard at the
    malformed-marketplace-list call site (`:607`).

<!-- inventory:port-only:end -->

## Mutation proof

Task 4's sweep, run 2026-08-03. Design Decision 5: **inject the violation into
the fixture, not into the assertion**, then observe which assertions turn RED.
A guard that stays GREEN under an injection that genuinely violates it is not
proven — it is a boundary guard, and it is adjudicated below rather than
"proved" by breaking its own text.

Every mutation was applied to a tracked file, run with
`node --test tests/bin/uninstall-commands.test.js`, observed, then restored by
**editing the file back** (never `git checkout --`). `git diff --stat` was
empty and the suite re-ran 18/18 GREEN after every restore. No assertion text
in `tests/bin/uninstall-commands.test.js` was changed except at the three
ordering sites, which the subject alone controls and which therefore have no
fixture-side lever (rows O1-O3).

The task brief names six injections. That list is the floor: rows D1b-D8 were
derived from this inventory's own negative-assertion set, and they carry six
items and all twenty port-only guards that the brief's six do not reach. Rows
6a, 2a, and 5 diverge from the brief's prediction table; each divergence is
recorded under "Divergences" below, because a divergence is the finding, not
noise.

**Case abbreviations** below are the port's `test(` order: c2 recovery, c3
missing-python3, c4 missing-Codex, c5 legacy-only, c6 mixed, c7 both-present,
c8 plugin-absent, c9 both-absent, c10 plugin-list-fails,
c11 malformed-plugin-list, c12 malformed-plugin-entry,
c13 marketplace-list-fails, c14 malformed-marketplace-entry,
c15 malformed-marketplace-list, c16 remove-noop, c17 verify-after-drift,
c18 marketplace-remove-fails.

### Injection matrix

| Row | Injection (file, exact edit) | Observed RED — item @ port line |
|---|---|---|
| 1 | `lifecycle-config.js`: `UNINSTALL_DEFAULTS.spuriousMutation` `false` → `true`, forcing `plugin remove superpowers@spurious` into every Codex call's log | items 14 (`:322`), 40 (`:483`), 47 (`:512`), 50 (`:530`), 53 (`:548`), 57 (`:571`), 60 (`:589`), 64 (`:612`) — all 8 `assertNoRemoves` sites, 8/18 cases |
| 2a | `uninstall-fakes.js:124`: the `marketplaceRemove === "fail"` branch's `process.exit(1)` → `process.exit(0)`, stderr kept | item 82 (`:701`), c18 only |
| 2b | `uninstall-fakes.js:122`: branch condition `"fail"` → `"fail-disabled"`, so the failure path never fires and the remove genuinely succeeds | item 75 (`:683`), c18 only |
| 3 | `uninstall-fakes.js`: `plugin remove` branch prefixed with `writeJson("plugin_list.json", { installed: [], available: [] }); process.exit(0);` — verify-after always sees the plugin absent | items 69 (`:645`), 70 (`:653`) |
| 4 | `uninstall-fakes.js` `runAdapter`: log `inspect --view ownership` only on its first occurrence — the verify-after re-inspect is dropped from the log | items 27 (`:402`), 67 (`:635`) |
| 5 | `uninstall-fakes.js`: both list branches `process.exit(CONFIG.pluginListRc / marketplaceListRc)` → `process.exit(0)` — a failed ownership query no longer aborts | items 44 (`:499`), 55 (`:560`) |
| 6a | `uninstall-fakes.js` `runAdapter`: write `spw-sidecar-leak` into `$TMPDIR` | **none — 18/18 GREEN.** See Divergences |
| 6b | same, into `$TMPDIR/..` (the invocation TMPDIR the subject was handed) | items 24 (`:393`), 45 (`:505`) — both `assertTmpEmpty` ports |
| O1 | `uninstall-commands.test.js:422`: `firstInspect < uninstallAt` → `>` | item 29 (`:422`), "ownership inspect must precede adapter uninstall" |
| O2 | `uninstall-commands.test.js:426`: `uninstallAt < lastInspect` → `>` | item 30 (`:426`), "ownership re-inspect must follow adapter uninstall" |
| O3 | `uninstall-commands.test.js:433`: the two `assertOrder` needles swapped | item 33 (`:433`), `assertOrder` "out of order" |
| D1b | injection 1 with the payload string changed to `plugin remove superpowers@superpowers-wrapper` | item 20 (`:362`) in c6, plus the 8 row-1 sites |
| D1c | payload `plugin marketplace remove superpowers-wrapper` | item 21 (`:366`) in c6, plus the 8 row-1 sites |
| D1d | payload `plugin marketplace remove openai-curated` | items 34 (`:442`) in c7 and 83 (`:718`) in c18, plus the 8 row-1 sites |
| D1e | payload `plugin remove superpowers@superpowers-manager` | item 36 (`:461`) in c8, plus the 8 row-1 sites |
| D2 | `uninstall-fakes.js` `runAdapter`: extra `log("adapter.log", "uninstall --spurious")` on every adapter call | items 46 (`:507`), 49 (`:525`), 52 (`:543`), 56 (`:566`), 59 (`:584`), 63 (`:607`) — all 6 `assertNoAdapterUninstall` sites, and only those |
| D3 | same, payload `uninstall --plugin-present true --marketplace-present true` | item 28 (`:406`) in c7, plus the 6 D2 sites |
| D4 | same, payload `inspect --view update-control` | item 5 (`:250`) in c2, and only that |
| D5 | `uninstall-fakes.js`: `log("codex.log", ARGS.join(" "))` deleted from `runCodex` | port-only items 7-14, the `assertNoRemoves` emptiness guards, at `:322`, `:483`, `:512`, `:530`, `:548`, `:571`, `:589`, `:612` |
| D6 | `uninstall-fakes.js`: `log("adapter.log", ARGS.join(" "))` deleted from `runAdapter` | port-only items 15-20, the `assertNoAdapterUninstall` emptiness guards, at `:507`, `:525`, `:543`, `:566`, `:584`, `:607` |
| D7 | `uninstall-fakes.js`: `process.stdout.write("not a protocol envelope\n")` before the real adapter delegation | item 12 (`:302`) and 11 other cases; items 13 and 80 shadowed — see adjudication B |
| D8 | same line written **after** the delegation, so the envelope is intact and only trailing data is added | identical shape (`Extra data: line 2 column 1`); items 13 and 80 still shadowed |
| P1 | no tracked file touched: a `node --input-type=module` probe applied items 1-2's predicates to in-memory regression copies of `scripts/uninstall` and `scripts/core/lifecycle.sh` | predicate `true` on the real files, `false` on both regression copies — see adjudication E |

Row 1's `plugin remove superpowers@spurious` payload deliberately names no
real fixture resource, so it can only be caught by a guard that rejects *any*
remove; D1b-D1e reuse that single injection point with resource-specific
payloads to isolate the resource-specific negatives. D2's
`uninstall --spurious` follows the same discipline on the adapter side: it
lies inside the class `assertNoAdapterUninstall` names (`uninstall --`) while
matching none of the exact-line positives, which is what makes its RED set
exactly the six guards and nothing else.

### Divergences from the brief's prediction table

**Row 6a — predicted RED at every `assert_uninstall_tmp_empty` port; observed
18/18 GREEN.** `scripts/uninstall:12-21` creates its workspace under the
inherited `TMPDIR`, installs a removal trap on it (`:16`), and then
*re-exports* `TMPDIR` to point at that workspace. An adapter sidecar written
to `$TMPDIR` therefore lands inside the subject's own workspace and is swept
up by the subject's trap. Row 6b — writing to `$TMPDIR/..`, which is the
invocation TMPDIR `runScript` handed the subject — is RED at both ports.
Consequence for what items 24 and 45 claim: they assert the *invocation*
TMPDIR is left empty, which catches a leaked workspace or a sidecar dropped
beside it. They do **not** assert that the adapter created no temporary files
at all, because anything the adapter writes into the workspace is legitimately
cleaned by the trap. That is narrower than the brief assumed and is recorded
here so no later reader over-reads the assertion.

**Row 2a — predicted RED "at case 18"; observed RED at item 82, not at the
exit-status assertion.** Making the marketplace remove exit 0 while leaving
the fixture unmutated does not make uninstall succeed: verify-after re-queries,
finds the marketplace still registered, and fails with `error: owned
marketplace resource is still registered after removal`. Item 75
(`status !== 0`) stayed GREEN. Only row 2b — disabling the failure branch so
the remove genuinely succeeds — reaches item 75. The finding: item 82's exact
message is the discriminator for a marketplace remove that *lies* about
succeeding; the exit-status assertion alone would not have noticed.

**Row 5 — predicted RED "at cases 10, 13"; the cases match, but the failing
assertion does not.** Both went RED at their exit-status assertions (items 44
and 55), which precede the `assertNoAdapterUninstall` guards the row was aimed
at; node:test aborts a case at its first failing assertion, so items 46 and 56
never ran. Those six guards are proven instead by derived row D2, which
violates them without disturbing anything asserted earlier.

**Row 3 — predicted RED at cases 16 and 17; both went RED, at items 69 and
70.** c17 failed at its exit-status assertion (item 70), so items 73-74 were
shadowed. Recorded for completeness; the case set matches the prediction.

**Row 4** matched its prediction exactly (items 27 and 67).

### Adjudication: guards no injection turned RED

Each entry records **(1)** why the violation is unreachable at that point in
that scenario and **(2)** what future change would make it reachable. Form
follows `bin-dispatch.md:27-36`.

**A — item 9, "the Codex log is empty" (c3, `:279`).** *(1)* The case strips
PATH to a directory holding only `dirname`, and `scripts/uninstall:10` runs
`spw_require_command python3` before the workspace, the adapter, or Codex is
touched. The only writer to `codex.log` is `runCodex` in `uninstall-fakes.js`,
and that process never starts, so no fixture toggle in the file — including
`spuriousMutation`, whose payload is emitted from inside `runCodex` — can
execute. Confirmed empirically: c3 stayed GREEN under rows 1 and D1b-D1e,
which turn every other Codex-log negative RED. *(2)* Reachable the moment
`scripts/uninstall` moves `spw_require_command python3` below the workspace or
adapter setup, or a shared lifecycle helper consults Codex during requirement
checking — which is precisely the regression the assertion guards. It would
also become reachable if `runScript` or `createCase` ever pre-seeded a
`codex.log`; today neither does.

**B — items 13 (`:308`) and 80 (`:713`), "output does not contain
`error: invalid adapter response:`".** *(1)* Not vacuous and not inert — but
structurally shadowed. Rows D7 and D8 do produce the violation: under D7 the
c4 failure message, which is the port's `out` variable dumped verbatim, reads
`error: invalid adapter response: Expecting value: line 1 column 1 (char 0)`
and nothing else, so item 13's condition is demonstrably false in that run.
The reported failure is item 12 (`:302`), asserted six lines earlier, because
node:test aborts the case at its first failure. D8 confirms the mechanism is
not an artifact of *where* the corruption is injected: appending a non-JSON
line after an intact envelope yields the same whole-output replacement
(`Extra data: line 2 column 1`), because the subject parses the adapter
response as one strict JSON document. Any fixture corruption that produces the
forbidden text also destroys the controlled diagnostic item 12 requires, so
the two cannot be separated from the fixture side. The same argument covers
item 80 in c18, where D7 aborts the run at the ownership inspect and item 76
(`:690`) fires first. *(2)* Independently reachable when the subject can emit
*both* the controlled diagnostic and a protocol complaint in one run — for
example if `spw_inspect_ownership` grew a second, stricter parse of an already
reported response, or if the adapter began writing its envelope and a
non-envelope diagnostic to the same stream on a path that still satisfies
item 12. Either change satisfies every earlier assertion in the case and is
caught only by items 13 and 80.

**C — items 74 (`:672`) and 79 (`:708`), "output does not contain
`uninstall complete`".** *(1)* Every fixture injection that makes the subject
print the final success banner also makes it exit 0, and both cases assert
`status !== 0` first: row 2b drove c18 RED at item 75 (`:683`), and row 3 drove
c17 RED at item 70 (`:653`), in both instances shadowing the banner negative.
No fixture toggle can decouple the banner from the exit status, because
`scripts/uninstall:34` prints the banner only once
`spw_verify_uninstalled_resources` (`:30`) has passed under `set -eu`, and the
only statement after it (`:35`, an informational `echo`) cannot fail —
reaching the banner *is* exiting 0. *(2)* Reachable exactly when that coupling
breaks: if the banner moves above `spw_verify_uninstalled_resources`
(`scripts/uninstall:30`), or is emitted from an `EXIT` trap, or the script
prints it and then exits non-zero from a later step. That is a real regression
class, and the exit-status assertions alone do not catch it — which is why
both negatives are kept rather than folded into items 70 and 75.

**D — item 35 (`:446`), "the adapter log never names `other@x`":
inherited-inert.** The adjudication of record is the one already written at
item 35's entry above; this pass confirms it rather than restating it, and
adds one observation. A payload injection could trivially turn item 35 RED —
D2's mechanism with the literal `other@x` — but doing so would prove only that
`has()` matches a string the fixture itself planted. No *subject* behavior,
correct or broken, can put `other@x` into the adapter log while the fixture
set defines only `superpowers@superpowers-manager`,
`superpowers@superpowers-wrapper`, `openai-curated`, `superpowers-manager`,
and `superpowers-wrapper`. That gap between "an injection can redden it" and
"a regression can redden it" is exactly the inertness item 35's entry records,
and manufacturing the former would obscure it. Reachability conditions are
unchanged from that entry: add an unrelated third-party provider to a fixture,
or change `spw_adapter_uninstall` to pass resource identities instead of
booleans. Contrast item 34, reddened for real by row D1d because
`openai-curated` is a string a real fixture supplies.

**E — items 1 (`:208`) and 2 (`:217`), the source guards.** *(1)* Their
subjects are `scripts/uninstall` and `scripts/core/lifecycle.sh` themselves,
read from `ROOT`. There is no fixture in the path: the only mutation that
violates either is an edit to the production tree, which this task is scoped
out of. Row P1 therefore probed the predicates without touching a tracked
file, applying them in memory to the real file contents and to a regression
copy — a copy of `scripts/uninstall` with
`. "$root/scripts/adapters/codex/lib.sh"` appended to its source block, and a
copy of `scripts/core/lifecycle.sh` carrying an `SPW_PLUGIN_ID` default. Both
predicates returned `true` on the real files and `false` on the regression
copies, so neither is vacuous. *(2)* Reachable the moment someone lands either
edit for real — sourcing the Codex adapter library from the public
`scripts/uninstall`, or naming a Codex-owned identifier in shared lifecycle
code. Both are the exact regressions the guards were written against, and both
would be caught on the next suite run.

### Coverage ledger

Every negative, ordering, and cardinality assertion in the port is accounted
for. Proven RED by injection: items 5, 14, 20, 21, 24, 27, 28, 29, 30, 33, 34,
36, 40, 44, 45, 46, 47, 49, 50, 52, 53, 55, 56, 57, 59, 60, 63, 64, 67, 69,
70, 75, 82, 83, and all 20 port-only guards — rows D5-D6 for the fourteen
non-vacuity guards (port-only items 7-20), and row D7 for the six
`status === 0` assertions (port-only items 1-6), which went RED at `:241`,
`:320`, `:354`, `:387`, `:455`, and `:481` under the protocol corruption.
Adjudicated GREEN with both required parts: items 1, 2, 9,
13, 35, 74, 79, 80. No assertion in the file is left unclassified, and no RED
in this section was produced by editing an assertion's text outside rows
O1-O3.

## Cardinality

```json inventory
{
  "shellOriginal": 83,
  "portOnly": 20,
  "ports": { "tests/bin/uninstall-commands.test.js": 18 }
}
```

- Shell original: **83** assertions (2 source guards, 4
  selection-independent recovery, 3 missing-python3, 4 missing-Codex, 4
  legacy-only, 6 mixed state, 12 both-present, 4 plugin-absent, 4 both-absent,
  4 plugin-list-fails, 3 malformed-plugin-list, 4 malformed-plugin-entry, 3
  marketplace-list-fails, 4 malformed-marketplace-entry, 3
  malformed-marketplace-list, 5 remove-noop, 5 verify-after-drift, 9
  marketplace-remove-fails; sum:
  2+4+3+4+4+6+12+4+4+4+3+4+3+4+3+5+5+9 = 83).
- Port (`tests/bin/uninstall-commands.test.js`): 18 static `test(` call sites,
  one per shell scenario (17 `reset` call sites plus the source-guard block at
  `:9-16`, which precedes the first `reset`). No call site is data-driven, so
  the 18 static sites produce 18 runtime cases. They carry 83 assertions
  1:1-mapped to the shell, with no merges and no drops, plus 20 port-only
  assertions.
- Reconciliation: 1:1 for all 83 shell items. Two orderings differ from the
  shell — items 36/38 and items 79-82 — because the port asserts the
  positive claim before the negative one that depends on it; the set of
  assertions is unchanged. Three fidelity notes are recorded inline rather
  than left implicit: item 35 is **inherited-inert** (faithful to the shell,
  but unable to fail against any current fixture — full adjudication at its
  entry), items 24 and 45 carry a **narrowed TMPDIR scope** forced by per-case
  isolation, and the missing-python3 scenario runs with `SPW_ADAPTER` set where
  the shell left it unset. None changes the count. The 20 port-only assertions
  are strictly additive and are excluded from the 83/83 arithmetic above.
