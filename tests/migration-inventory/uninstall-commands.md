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
