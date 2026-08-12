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

**POINTER PROVENANCE — port `:N` pointers.** An item's identity is the
assertion text it quotes, not its line number; re-derive a pointer from that
text before relying on it. These numbers are not maintained. Slice 4b remapped
an unrecorded subset of the mapped region's pointers in `1abd231`, against
`tests/bin/uninstall-commands.test.js` as it stood at `733f4b5`, where that
file was 913 lines — the ``(was `:N`)`` notes mark part of that subset but not
all of it; no mapped-region pointer has been re-derived since, and later
slice-4b commits only dropped retired items' pointers. Neither SHA is
reachable from `main`; slice 4b squash-merged as `79851ea`. The port file is
994 lines at HEAD and grew in three places, so the shift is not uniform: `0`
to old line 33, `+1` through the early file, `+21` from about old line 425,
irregular between. No single offset applies. The port-only region below is
worse: only item 21's pointers were added at `79851ea`; the rest predate slice
4b, when that file was 723-841 lines. Shell `:N` references are unresolvable
by construction: `tests/test_uninstall_commands.sh` is deleted, so they are
historical claims about a file that no longer exists, which is intended, not a
defect. Nothing in CI reads any of these numbers:
`tests/bin/migration-inventory.test.js` validates the `json inventory` block's
counts, this file's entry numbering and its region structure, and never parses
one. Some items below mark their own pointer stale.

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
  for 23 distinct scenario-level claims. `line_of` (`:158-160`) is a value
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
`test_bin_dispatch.sh:10` precedent for the unguarded form.

## Assertion inventory

<!-- inventory:mapped:start -->

### Source guards: no Codex ownership leaks into shared code (`:9-16`)

These two read the repository's own source, not a fixture snapshot, so the
port reads `ROOT` rather than the copied package root.

1. `scripts/uninstall` does not source `scripts/adapters/codex/lib.sh`
   (`:9-12`). Port: `:285`.
2. `scripts/core/lifecycle.sh` names neither `SPW_PLUGIN_ID` nor
   `SPW_MARKETPLACE_NAME` (`:13-16`). Port: `:294`.

### Selection-independent recovery (`:162-190`)

Malformed saved selection, no `git` on PATH, and `unsupported` update control
must not prevent owned-resource removal and verification.

**Channel changed (Task 6, D4, 2026-08-10).** Calls `runUninstall`
in-process through an injected recording adapter
(`tests/bin/command-context.js`) rather than spawning `scripts/uninstall`
through the SPW_ADAPTER seam in `intercept` mode. The `updateControl:
"unsupported"` fixture config is gone with it: `runUninstall`
(`src/commands/uninstall.ts`) never calls `gatherProbe` and structurally
never issues an `inspect --view update-control` call at all — unlike
install/update, it does not route through probe — so item 5's claim is now a
fact about which operations the double answers (ownership and uninstall
only) rather than about a fixture value that used to make a fake adapter
refuse to answer that call. The malformed selection.json and the git-less
PATH are KEPT in the port (`tests/bin/uninstall-commands.test.js:332-345`)
for the property the case is named for — "selection-independent" — even
though the in-process double does not route through either mechanism; see
the port's own comment for why that is still meaningful documentation.

3. The plugin remove reaches Codex: `plugin remove
   superpowers@superpowers-manager` (`:183`). Port: `:386` (was `:331`), now
   the double's own recorded argv
   `uninstall --plugin-present true --marketplace-present true` — the same
   fact, since the adapter's `plugin remove` on the real Codex side is issued
   only when the adapter uninstall op it receives carries `--plugin-present
   true` (`src/adapter.ts:725-731`).
4. The marketplace remove reaches Codex: `plugin marketplace remove
   superpowers-manager` (`:184`). Port: `:386` (was `:332`), same reasoning
   as item 3, for `--marketplace-present true`.
5. Update control is never inspected — the adapter log holds no
   `inspect --view update-control` (`:185-189`). Port: `:386` (was `:335`),
   now `assert.deepEqual(adapter.calls.map(...), [ownership, uninstall,
   ownership])` — structurally stronger than the log negative it replaces:
   `runUninstall` cannot make the call at all, and the double would fail the
   case by exhaustion if it somehow tried. Non-vacuous for the same reason as
   before: items 3-4 are witnessed by the same exact-sequence assertion.
6. Stdout contains `uninstall complete` (`:190`). Port: `:396` (was `:340`).

**Port-only divergence in the second closing line (PR 11.5 slice 4b, Task 3;
recorded here at Task 10).** `scripts/uninstall:34-35` prints two lines after a
successful uninstall. The first (`uninstall complete`) ports verbatim and is
item 6 above. The second ends *"…remove them manually or regenerate with
`scripts/prepare`."*; the port ends *"…regenerate with
`npx superpowers-manager prepare`."* (`src/commands/uninstall.ts:279-283`). The
change is deliberate, per spec §3.6: the line is operator-facing output that
names a script 4c deletes, so the port must not instruct an operator to run it.
It is **not** one of the three frozen legacy-state strings
(`src/lifecycle.ts:26-40`), whose `npx superpowers-wrapper@0.1.1 uninstall`
remains a historical package coordinate and is never re-derived.

Recorded as prose rather than as a numbered item for two reasons, both of which
would otherwise put a number on something this inventory does not map. The
shell driver asserted no closing-note text at all — item 6 covers only
`uninstall complete` — so within the 1:1 mapping there is nothing for the new
wording to diverge *from*. And the assertion that pins the new wording,
*"the two closing lines port verbatim except for the prepare invocation"*, lives
in `tests/unit/commands-uninstall.test.js`, which is not this inventory's port
file (`tests/bin/migration-inventory.test.js`'s `DECLARED` maps
`uninstall-commands.md` to `tests/bin/uninstall-commands.test.js` alone).
Neither `shellOriginal`, `portOnly` nor `ports` moves.

### Missing python3: clear requirement error, no Codex calls (`:192-212`)

**Environment divergence — a shell-era note, kept as history.** *Marked as such 2026-08-11: every sentence in this paragraph is still true, but its subject is the shell scenario, and the scenario itself is retired by the note immediately below. Its neighbours carry historical markers and this one did not, which made it read as a live claim about the port.* The shell invoked this one scenario without
`SPW_ADAPTER` (`:198` sets only `PATH` and `SUPERPOWERS_CODEX`); the port's
`runScript` always exports `SPW_ADAPTER`, so it is set at `:266`. Immaterial to
all three assertions: `spw_require_command python3` runs at `scripts/uninstall:10`,
before the adapter is consulted at all, so the run dies before any adapter
invocation and item 9's empty-Codex-log claim is unaffected. Recorded because
this file's premise is line-level fidelity, and an unrecorded env difference is
indistinguishable from an unnoticed one. `SPW_ADAPTER` is not narrowed away
anywhere else — every other scenario set it in the shell too.

**Whole scenario retired (PR 11.5 slice 4b, Task 8).** `uninstall` flipped to
in-process dispatch and `COMMAND_REQUIREMENTS.uninstall` dropped from
`["python3", "codex"]` to `["codex"]` in the same commit: `python3` was
required only so `spw_invoke_adapter` could run `validate-adapter-response.py`
once per adapter call (`scripts/core/adapter.sh:37-44`), and the in-process
path has no validator process. The shell's own
`spw_require_command python3` (`scripts/uninstall:10`) has no port. All three
conditions below can therefore no longer occur in either direction. The port's
one `test(` call site is KEPT and carries the inverse property instead —
`uninstall` runs with `python3` absent and reaches Codex — so the static
call-site count is unchanged and no `ports` edit is owed. The PATH-stripping
survives verbatim, and now doubles as the case that proves `runScript`'s
retarget onto `process.execPath` kept the absolute-path property the `/bin/sh`
launch had.

7. Uninstall fails when `python3` is absent from PATH (`:198-202`).
   **Retired**: `uninstall` no longer requires `python3`, so the run succeeds.
   The successor asserts `status === 0`.
8. Output contains `required command not found: python3` (`:203-207`).
   **Retired**: the diagnostic is unreachable. The successor asserts its
   ABSENCE, made non-vacuous by item 9's successor proving the run completed.
9. The Codex log is empty — no Codex call was made (`:208-212`).
   **Retired**: the run no longer aborts before the adapter. The successor
   inverts it into the exact six-line ownership / remove / re-inspect sequence,
   which an empty log cannot satisfy.

### Missing Codex is a controlled ownership-inspect failure (`:214-232`)

**Channel changed (Task 6, D4, 2026-08-10).** Calls `runUninstall`
in-process. The double answers the ownership inspect with the same
well-formed `failureResult` (`command-not-found`,
`` required Codex command not found: <path> ``) the real adapter's
`requireCodex` check produces for a missing binary
(`src/adapter.ts:267-273`, `:180`) — not a transport-level fault, so it is
reachable through a double exactly as it was through the fixture. There was
never a re-anchor onto `codex.log` available for this case either way —
Codex is never reached by construction, so `codex.log` would be empty
regardless of channel — which is why item 11 has no re-anchor option and
instead moves to the double's own recorded calls.

**What item 12 proves after the conversion, and where the other half is
covered.** The case now *supplies* the exact message it then asserts (the
double builds `` required Codex command not found: <path> `` and the port
greps for `error: ` + that string), so item 12 proves RELAY — that the
command surfaces the adapter's diagnostic verbatim on its output — and no
longer proves PRODUCTION, that the real adapter emits that text for a missing
binary. That half is covered independently, and was verified against the tree
rather than assumed:

- `tests/unit/adapter.test.js:532-546` asserts that `mapCodexLaunchFailure`
  throws a failure whose `message` equals
  `` `required Codex command not found: ${codexBin}` `` for both `ENOENT` and
  `EACCES`; that literal is at `:542`.
- `tests/test_adapter_protocol.sh` runs the REAL adapter with
  `SUPERPOWERS_CODEX` pointing at a missing binary and requires the exact
  stderr line `error: required Codex command not found: $missing_codex` at
  `:672` (the `install` operation), `:692` (`inspect --view fingerprint`) and
  `:722` (inside the `for missing_case in ownership uninstall` loop, so both
  the ownership inspect this case uses and the uninstall op).

Neither is a `dist/` consumer, so neither is reachable by mutating `dist/`;
they are the production-side witnesses this case stopped being.

10. Uninstall fails when the Codex binary is missing (`:220-225`). Port:
    `:451` (was `:385`).
11. The adapter log holds the exact line `inspect --view ownership`
    (`:226`). Port: `:458-462` (was `:391`), now
    `adapter.calls.map((c) => c.join(" ")) === ["inspect --view ownership"]`
    — stronger than the original: it also proves this was the ONLY call
    made, where the log read proved only that this line appeared somewhere.
12. Output holds the exact line `error: required Codex command not found:
    <path>` (`:227`). Port: `:464-467` (was `:393`).
13. Output does **not** contain `error: invalid adapter response:` — a
    missing Codex must stay a controlled inspect failure (`:228-232`). Port:
    within `:427-472` (was `:399`). Non-vacuous because item 12 proves the
    output carries the adapter's diagnostics.

### Legacy-only state is never mutated and leaves guidance (`:234-242`)

14. No remove command reaches Codex (`:239`, `assert_no_removes`). Port:
    `:414`, helper at `:143`.
15. The adapter log holds the exact line `uninstall --plugin-present false
    --marketplace-present false` (`:240`). Port: `:324`.
    **Pointer stale, deliberately not remapped.** PR 11.5 slice 3.5
    re-anchored this assertion onto `codex.log`, replacing the exact
    adapter-log line this item describes, so the assertion named here no
    longer exists and no line number can honestly stand in for it. The
    property is still witnessed in the same case; re-deriving the claim and
    its pointer together is a re-disposition, not a pointer fix.
16. Stdout holds the exact line `Legacy superpowers-wrapper Codex state
    remains installed.` (`:241`). Port: `:436`.
17. Stdout holds the exact line `Run: npx superpowers-wrapper@0.1.1
    uninstall` (`:242`). Port: `:448`. This literal is user-facing guidance
    owned by `scripts/core/lifecycle.sh:52,77`, not a dependency version that
    moves on someone else's schedule — the exact text is the contract.

### Mixed state removes manager resources only (`:244-259`)

18. The manager plugin remove reaches Codex (`:250`). Port: `:464`.
19. The manager marketplace remove reaches Codex (`:251`). Port: `:465`.
20. The Codex log never names `superpowers@superpowers-wrapper` (`:252`, the
    first grep of the rule-8 `||` chain). Port: `:468`.
21. The Codex log holds no `plugin marketplace remove superpowers-wrapper`
    (`:253`, the second grep of the same chain). Port: `:472`. Items 20-21
    are non-vacuous because items 18-19 prove removes reached the log.
22. Stdout holds the exact line `Legacy superpowers-wrapper Codex state
    remains installed.` (`:258`). Port: `:477`.
23. Stdout holds the exact line `Run: npx superpowers-wrapper@0.1.1
    uninstall` (`:259`). Port: `:484`.

### Both present: both removed, plugin before marketplace (`:261-289`)

**Channel changed for items 25-27 and 29-30; items 28 and 35 DROPPED (Task 6,
D4, 2026-08-10).** Unlike the two cases above, `runScript` is KEPT here: every
surviving live claim in this section has a genuine Codex-level footprint, so
those claims re-anchor onto `codex.log` rather than converting to a double.

***Corrected 2026-08-11 at slice 4b's closeout.*** *The sentence above read
"`runScript` is KEPT here (this case still dispatches through the shell and the
real fake-adapter/fake-Codex pipeline)". Keeping `runScript` is still true; what
`runScript` launches is not. Task 8's flip retargeted it to*
`process.execPath bin/superpowers-manager.js <command>`
*(`tests/bin/lifecycle-fixture.js:341-346`), and `src/cli.ts:73` dispatches*
`uninstall` *in-process, so this case's subject is `src/commands/uninstall.ts`
and the fake adapter is not in its path at all — which this file's own port-only
item 21 asserts directly, on this same scenario, by requiring the adapter log to
be empty. The `codex.log` re-anchor is unaffected: the fake Codex is still the
observation channel, because* `runUninstall` *reaches Codex through the same two
ownership inspections.* `inspect --view ownership` issues one
`plugin list --json` (`src/adapter.ts:871`) and then one
`plugin marketplace list --json` (`src/adapter.ts:883`), both inside
`:868-885`; the adapter uninstall op itself issues no listing, only the two
removes items 31-32 already witness — so items 25-27's
presence-and-exactly-twice claims collapse into
`ownershipInspections(codex) === 2`, the same `assertAdapterUninstallRan`
pattern this file already uses for the legacy-only, plugin-absent, both-
absent, remove-noop, and verify-after-drift cases. Items 29-30's bracketing
claim re-anchors onto the SAME two `plugin list --json` occurrences,
`firstIndex`/`lastIndex` against the plugin remove rather than against the
adapter's own `uninstall --plugin-present …` line.

**Item 28 is a DROP, not part of that collapse.** Items 25-28 were presented
together as "collapsing into" one assertion; that is accurate for 25, 26 and
27 and false for 28. Item 28's claim is that the adapter uninstall op appears
**exactly once**. Nothing surviving in the port observes it: a duplicated
adapter uninstall would emit duplicate `plugin remove` lines, which the
`has()` checks are membership tests and do not count, and
`ownershipInspections(codex)` would still be 2 because `scripts/uninstall`
brackets the op between exactly two ownership inspections either way. The
loss is narrow — items 25-27 and 31-33 still pin that the op ran, reached
Codex, and did so in order — but it is a loss, and recording it as a collapse
would overstate what survives. Restoring it would mean counting
`plugin remove superpowers@superpowers-manager` occurrences in `codex.log`
rather than testing membership; that is a strictly stronger assertion than
the shell had at this call site and is not proposed here.

Item 35 ("the adapter log never names `other@x`") is DROPPED outright, not
re-anchored, and the reason is stronger than "redundant": **it could never
have failed.** The needle `other@x` is defined by no fixture anywhere in this
repository — it occurs nowhere in `tests/`, `src/` or `scripts/` outside this
inventory's own prose about it — so no behaviour of the subject, correct or
defective, could ever have put it in the adapter log. The assertion was a
tautology; dropping it loses exactly zero coverage. Two weaker arguments were
recorded here previously and are **wrong on their own terms**, kept only so
they are not reinstated:

- `presenceFlag` (`src/commands/uninstall.ts`) is not in this case's path. As
  recorded at Task 6 this argument ran: "this is the one uninstall case that
  keeps `runScript`, so its subject is `scripts/uninstall`, not the TypeScript
  command module." It was the wrong reason for item 35's inertness even then,
  and Task 8's flip made it **factually false as well** — `runScript` launches
  `bin/superpowers-manager.js`, `uninstall` dispatches in-process
  (`src/cli.ts:73`), and `presenceFlag` is squarely in this case's path.
  *Restated 2026-08-11; the original wording is quoted above rather than
  silently replaced, because this bullet exists to stop the argument being
  reinstated.* The real adapter's own closed rejection
  (`src/adapter.ts:710-715`, `"--plugin-present must be true or false"`) is a
  true fact about the adapter, but neither it nor the path question is what
  makes item 35 inert. The tautology argument above is.
- "A defect would already fail the surrounding assertions" is beside the
  point, and slightly wrong: a presence-flag leak would put
  `superpowers@superpowers-manager` in the argv, not `other@x`, so item 35
  would not have caught it either.

See the port's own comment in the "both present" case
(`tests/bin/uninstall-commands.test.js`) for the same argument at the call
site.

**Reachable by `dist/` mutation as of Task 8's flip. This paragraph said the
opposite until 2026-08-11, and the exemption it granted is withdrawn.** It read:
*"This case keeps `runScript`, so its subject is `scripts/uninstall` plus the
real adapter and fake Codex — mutating `dist/**/*.js` cannot make it fail, and a
mutation sample taken against `dist/` will show it surviving every mutation …
while the shell is still the dispatched subject, a case that exercises the shell
is exactly what this file should keep."* That was accurate at Task 6 and is
false now. `runScript` launches
`process.execPath bin/superpowers-manager.js uninstall`
(`tests/bin/lifecycle-fixture.js:341-346`), which loads `dist/cli.js`, and
`src/cli.ts:73` dispatches `uninstall` in-process — so a `dist/**/*.js` mutation
sample **does** reach this case. **No future mutation sweep may skip it on this
paragraph's authority.** The same correction applies to the "Missing Codex"
section, which this paragraph paired itself with: its converted case calls
`runUninstall` imported from `dist/commands/uninstall.js`
(`tests/bin/uninstall-commands.test.js:46-48`), so it is inside `dist/`'s reach
too. See that section for where its production-side witnesses live.

24. The invocation TMPDIR is left empty — no leaked workspace or adapter
    sidecar (`:267`, `assert_uninstall_tmp_empty`). Port: `:592` (was
    `:508`), helper at `:236`. **Scope narrowed twice — see the note below,
    and the further narrowing the mutation proof's row 6a records.**

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
    (`:268`). Port: within `:597-600` (was `:510`), now
    `ownershipInspections(codex) === 2` via `assertAdapterUninstallRan`.
26. The adapter log holds the exact line `uninstall --plugin-present true
    --marketplace-present true` (`:269`). Port: within `:597-600` (was
    `:511`), same re-anchored assertion as item 25: the adapter uninstall op
    with both flags true is what makes the SECOND ownership inspection
    (the verify-after re-query) reachable at all.
27. `inspect --view ownership` appears exactly twice (`:270`, bare `[ ... ]`
    per rule 6). Port: within `:597-600` (was `:517`), same call as items
    25-26. This is the one exact-count claim of the four that the re-anchor
    does preserve — `ownershipInspections(codex) === 2` is a count, on the
    Codex-level witness of the same inspection. Item 28's is not; see its
    entry.
28. `uninstall --plugin-present true --marketplace-present true` appears
    exactly once (`:271`, bare `[ ... ]`). **No port counterpart as of Task 6
    (PR 11.5 slice 4b, 2026-08-10) — DROPPED, not collapsed with items 25-27.**
    `ownershipInspections(codex) === 2` is insensitive to a duplicated adapter
    uninstall op (the duplicate emits extra `plugin remove` lines, which the
    surviving checks test for membership rather than count, and leaves the
    ownership-inspection count at 2), so no surviving assertion witnesses the
    exactly-once claim. See the section note above for why this is recorded as
    a narrow deliberate loss rather than papered over as part of the collapse.
29. The first ownership inspect precedes the adapter uninstall (`:275`).
    Port: within `:607-620` (was `:537`), now
    `firstIndex(codex, "plugin list --json") < firstIndex(codex, "plugin remove …")`.
30. The adapter uninstall precedes the last ownership inspect (`:276`).
    Port: within `:607-620` (was `:541`). Items 29-30 still use `firstIndex`
    and `lastIndex` respectively, mirroring the shell's `head -n1` and
    `tail -n1`, now against `codex.log` rather than `adapter.log`.
31. The plugin remove reaches Codex (`:277`). Port: `:623` (was `:546`).
32. The marketplace remove reaches Codex (`:278`). Port: `:624` (was `:547`).
33. The plugin remove precedes the marketplace remove (`:281`). Port:
    `:625-631` (was `:548`), via `assertOrder`.
34. The Codex log never names `openai-curated` (`:282-285`). Port: `:633-636`
    (was `:557`). Non-vacuous and reachable: `openai-curated` is a real
    marketplace in
    `MARKETPLACE_PRESENT`, so an over-broad marketplace removal would log
    `plugin marketplace remove openai-curated` and turn this red.
35. The adapter log never names `other@x` — the adapter uninstall receives
    booleans, not provider names (`:286-289`). **No port counterpart as of
    Task 6 (PR 11.5 slice 4b, 2026-08-10) — DROPPED, not retired at a gap in
    the Class-2 sense install-commands.md items 22-24/107-111 use: this item
    was already adjudicated inherited-inert below BEFORE Task 6 touched it,
    and Task 6's removal is that same adjudication acted on rather than a new
    finding. See the section note above ("Both present...") for the full
    argument that no regression can turn it red without also turning
    something that survives red.**

**Item 35 adjudication: inherited-inert (pre-Task-6 finding; the item is now
dropped, not merely inert — see its entry above).** The port was faithful
before Task 6 — the shell assertion at `:286-289` was equally inert, and
porting it unchanged was the right call at the time — but it was not a live
check, and recording it as merely "non-vacuous" would have been false. It got
the same two-part treatment this file's adjudication section applies to
every contested item, because that is what this was. Retained below as the
record of that finding, which is what motivated Task 6 to drop the item
rather than re-anchor it.

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

Decision at the time: **kept, unchanged, and flagged**. The formal
mutation-proof pass in the next task (below) carried the adjudication of
record for boundary guards. **Superseded by Task 6 (2026-08-10): dropped.**
An inherited-inert guard that stays flagged forever is exactly the kind of
residue this file's own adjudication convention exists to surface for a
later task to act on, and Task 6 is that later task acting on it — see the
"Both present" section note above.

### Plugin absent, marketplace present (`:291-302`)

36. No plugin remove reaches Codex — an absent plugin is not removed
    (`:296-299`). Port: `:576`. Non-vacuous because item 38 is asserted
    first in the port, proving the Codex log is non-empty.
37. The adapter log holds the exact line `uninstall --plugin-present false
    --marketplace-present true` (`:300`). Port: `:466`.
    **Pointer stale, deliberately not remapped.** PR 11.5 slice 3.5
    re-anchored this assertion onto `codex.log`, replacing the exact
    adapter-log line this item describes, so the assertion named here no
    longer exists and no line number can honestly stand in for it. The
    property is still witnessed in the same case; re-deriving the claim and
    its pointer together is a re-disposition, not a pointer fix.
38. The marketplace remove reaches Codex (`:301`). Port: `:574` — hoisted
    above item 36 in the port so the negative cannot pass on an empty log.
39. Stdout reports `plugin not installed; skipping` (`:302`). Port: `:589`.

### Both absent: idempotent success, both skips reported (`:304-312`)

40. No remove command reaches Codex (`:309`). Port: `:601`, helper at
    `:143`.
41. The adapter log holds the exact line `uninstall --plugin-present false
    --marketplace-present false` (`:310`). Port: `:485`.
    **Pointer stale, deliberately not remapped.** PR 11.5 slice 3.5
    re-anchored this assertion onto `codex.log`, replacing the exact
    adapter-log line this item describes, so the assertion named here no
    longer exists and no line number can honestly stand in for it. The
    property is still witnessed in the same case; re-deriving the claim and
    its pointer together is a re-disposition, not a pointer fix.
42. Stdout reports `plugin not installed; skipping` (`:311`). Port: `:609`.
43. Stdout reports `marketplace not registered; skipping` (`:312`). Port:
    `:610`.

### Plugin list query fails: abort, no removes (`:314-326`)

44. Uninstall fails (`:319`, `expect_fail`). Port: `:617`.
45. The invocation TMPDIR is left empty (`:320`). Port: `:623`, helper at
    `:236`. Same scope narrowing as item 24, including the further narrowing
    the mutation proof's row 6a records.
46. The adapter log holds no `uninstall --` line — the adapter uninstall must
    not run when ownership inspection fails (`:321-325`). Port: `:625`,
    helper at `:193`.
    **Claim is historical.** PR 11.5 slice 3.5 re-anchored this assertion
    onto `codex.log`: `assertNoAdapterUninstall` (`:193-203`) no longer
    filters the adapter log for `uninstall --`, it asserts
    `ownershipInspections(codex) === 1`. The pointer is correct; the
    sentence describes an assertion that no longer exists.
    `tests/bin/uninstall-commands.test.js:170-186` states the accepted gap
    in terms. Re-deriving the claim is out of scope here.
47. No remove command reaches Codex (`:326`). Port: `:630`, helper at
    `:143`.

### Malformed plugin list JSON: abort, no removes (`:328-338`)

48. Uninstall fails (`:332`). Port: `:637`.
49. The adapter log holds no `uninstall --` line (`:333-337`). Port: `:643`.
    **Claim is historical.** PR 11.5 slice 3.5 re-anchored this assertion
    onto `codex.log`: `assertNoAdapterUninstall` (`:193-203`) no longer
    filters the adapter log for `uninstall --`, it asserts
    `ownershipInspections(codex) === 1`. The pointer is correct; the
    sentence describes an assertion that no longer exists.
    `tests/bin/uninstall-commands.test.js:170-186` states the accepted gap
    in terms. Re-deriving the claim is out of scope here.
50. No remove command reaches Codex (`:338`). Port: `:648`.

### Malformed individual plugin entry: abort, no removes (`:340-351`)

51. Uninstall fails (`:344`). Port: `:655`.
52. The adapter log holds no `uninstall --` line (`:345-349`). Port: `:661`.
    **Claim is historical.** PR 11.5 slice 3.5 re-anchored this assertion
    onto `codex.log`: `assertNoAdapterUninstall` (`:193-203`) no longer
    filters the adapter log for `uninstall --`, it asserts
    `ownershipInspections(codex) === 1`. The pointer is correct; the
    sentence describes an assertion that no longer exists.
    `tests/bin/uninstall-commands.test.js:170-186` states the accepted gap
    in terms. Re-deriving the claim is out of scope here.
53. No remove command reaches Codex (`:350`). Port: `:666`.
54. Output contains `cannot parse output of` (`:351`,
    `assert_output_contains`). Port: `:668`.

### Marketplace list fails while the plugin is present (`:353-365`)

55. Uninstall fails (`:359`). Port: `:678`.
56. The adapter log holds no `uninstall --` line — abort before ANY remove,
    including the plugin's (`:360-364`). Port: `:684`.
    **Claim is historical.** PR 11.5 slice 3.5 re-anchored this assertion
    onto `codex.log`: `assertNoAdapterUninstall` (`:193-203`) no longer
    filters the adapter log for `uninstall --`, it asserts
    `ownershipInspections(codex) === 1`. The pointer is correct; the
    sentence describes an assertion that no longer exists.
    `tests/bin/uninstall-commands.test.js:170-186` states the accepted gap
    in terms. Re-deriving the claim is out of scope here.
57. No remove command reaches Codex (`:365`). Port: `:689`.

### Malformed individual marketplace entry (`:367-378`)

58. Uninstall fails (`:371`). Port: `:696`.
59. The adapter log holds no `uninstall --` line (`:372-376`). Port: `:702`.
    **Claim is historical.** PR 11.5 slice 3.5 re-anchored this assertion
    onto `codex.log`: `assertNoAdapterUninstall` (`:193-203`) no longer
    filters the adapter log for `uninstall --`, it asserts
    `ownershipInspections(codex) === 1`. The pointer is correct; the
    sentence describes an assertion that no longer exists.
    `tests/bin/uninstall-commands.test.js:170-186` states the accepted gap
    in terms. Re-deriving the claim is out of scope here.
60. No remove command reaches Codex (`:377`). Port: `:707`.
61. Output contains `cannot parse output of` (`:378`). Port: `:709`.

### Malformed marketplace list while the plugin is present (`:380-392`)

62. Uninstall fails (`:386`). Port: `:719`.
63. The adapter log holds no `uninstall --` line (`:387-391`). Port: `:725`.
    **Claim is historical.** PR 11.5 slice 3.5 re-anchored this assertion
    onto `codex.log`: `assertNoAdapterUninstall` (`:193-203`) no longer
    filters the adapter log for `uninstall --`, it asserts
    `ownershipInspections(codex) === 1`. The pointer is correct; the
    sentence describes an assertion that no longer exists.
    `tests/bin/uninstall-commands.test.js:170-186` states the accepted gap
    in terms. Re-deriving the claim is out of scope here.
64. No remove command reaches Codex (`:392`). Port: `:730`.

### Remove is a no-op: verify-after detects the still-present target (`:394-410`)

The shell's `: > "$state/remove_noop"` (`:399`) gated **both** the plugin
mutation (`:44`) and the marketplace mutation (`:68`), and its own comment
says "removes are logged but do not mutate the fixtures" — plural. It ports to
`{ removesMutateState: false }`, a deliberately global switch.

65. Uninstall fails (`:400`). Port: `:740`.
66. The adapter log holds the exact line `uninstall --plugin-present true
    --marketplace-present true` (`:401`). Port: `:629`.
    **Pointer stale, deliberately not remapped.** PR 11.5 slice 3.5
    re-anchored this assertion onto `codex.log`, replacing the exact
    adapter-log line this item describes, so the assertion named here no
    longer exists and no line number can honestly stand in for it. The
    property is still witnessed in the same case; re-deriving the claim and
    its pointer together is a re-disposition, not a pointer fix.
67. `inspect --view ownership` appears exactly twice — verify-after re-runs
    ownership inspection after the adapter uninstall (`:402-406`). Port:
    `:754`.
68. The plugin remove was attempted and reached Codex (`:408`). Port:
    `:759`.
69. Output contains `still installed` — the plugin is still present on
    re-query, so uninstall must not succeed (`:410`). Port: `:761`.

### Verify-after schema drift: fail closed (`:412-426`)

70. Uninstall fails (`:418`). Port: `:769`.
71. The adapter log holds the exact line `uninstall --plugin-present true
    --marketplace-present true` (`:419`). Port: `:659`.
    **Pointer stale, deliberately not remapped.** PR 11.5 slice 3.5
    re-anchored this assertion onto `codex.log`, replacing the exact
    adapter-log line this item describes, so the assertion named here no
    longer exists and no line number can honestly stand in for it. The
    property is still witnessed in the same case; re-deriving the claim and
    its pointer together is a re-disposition, not a pointer fix.
72. The plugin remove reached Codex (`:420`). Port: `:786`.
73. Output contains `cannot parse output of` (`:421`). Port: `:788`.
74. Output does **not** contain `uninstall complete` (`:422-426`). Port:
    `:791`. Non-vacuous because item 73 proves the output carries the
    subject's diagnostics.

### Marketplace remove fails after the plugin remove succeeds (`:428-455`)

75. Uninstall fails (`:435`). Port: `:802`.
76. The adapter log holds the exact line `uninstall --plugin-present true
    --marketplace-present true` (`:436`). Port: `:690`.
    **Pointer stale, deliberately not remapped.** PR 11.5 slice 3.5
    re-anchored this assertion onto `codex.log`, replacing the exact
    adapter-log line this item describes, so the assertion named here no
    longer exists and no line number can honestly stand in for it. The
    property is still witnessed in the same case; re-deriving the claim and
    its pointer together is a re-disposition, not a pointer fix.
77. The plugin remove reached Codex (`:437`). Port: `:814`.
78. The marketplace remove reached Codex (`:438`). Port: `:815`.
79. Output does **not** contain `uninstall complete` (`:439-443`). Port:
    `:826`.
80. Output does **not** contain `error: invalid adapter response:` — one
    controlled adapter failure, not a protocol violation (`:444-448`). Port:
    `:831`.
81. Output replays the Codex stderr `marketplace remove exploded` (`:449`).
    Port: `:818`.
82. Output contains `error: codex plugin marketplace remove failed for
    superpowers-manager` (`:450`). Port: `:819`.
83. The Codex log never names `openai-curated` — a marketplace failure must
    not mutate unrelated providers (`:451-455`). Port: `:836`.

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

Item 21 (Task 9, PR 11.5 slice 4b, 2026-08-11) has no shell original at all:
the shell had no in-process subject whose non-spawning could be guarded, so
there is nothing for it to be additive, non-vacuous, or channel-changed
*relative to*. It is row 18's consumer — see `tests/bin/lifecycle-fakes.js`'s
`tripwireTriggered` and its callers in `tests/bin/uninstall-fakes.js`.

Be precise about what that consumer witnesses, because the obvious reading is
wrong. A subject that never spawns the adapter cannot, by running correctly,
observe the tripwire fire: on the passing path the fake adapter's process does
not exist. As first committed (`94794bd`) the case therefore passed unchanged
with `tripwireTriggered` forced to return `false` — it constrained the port,
not the tripwire. The case now carries a second half that spawns the SAME
case's fake adapter directly, through `lifecycle-fixture.js`'s
`spawnFakeAdapter`, and pins the refusal: exit 94, the tripwire's own message
on stderr, and the recorded line in the log the first half required to be
empty. That half dies when the tripwire is disarmed, which is what earns the
first half its meaning — the same non-vacuity argument items 7-20 above make
for their own logs. The tripwire firing is still observed through a direct
spawn rather than through the subject, because post-flip no subject can
produce one; what changed is that the direct spawn now runs inside the case
whose emptiness claim depends on it, with that case's own executable, state
and seam.

<!-- inventory:port-only:start -->

1. Selection-independent recovery: `result.status === 0` (`:326`).
2. Legacy-only state: `result.status === 0` (`:411`).
3. Mixed state: `result.status === 0` (`:460`).
4. Both present: `result.status === 0` (`:502`).
5. Plugin absent, marketplace present: `result.status === 0` (`:570`).
6. Both absent: `result.status === 0` (`:598`).
7. `assertNoRemoves` non-vacuity guard (`:138`) at the legacy-only call site
   (`:414`).
8. `assertNoRemoves` non-vacuity guard at the both-absent call site (`:601`).
9. `assertNoRemoves` non-vacuity guard at the plugin-list-fails call site
   (`:630`).
10. `assertNoRemoves` non-vacuity guard at the malformed-plugin-list call site
    (`:648`).
11. `assertNoRemoves` non-vacuity guard at the malformed-plugin-entry call
    site (`:666`).
12. `assertNoRemoves` non-vacuity guard at the marketplace-list-fails call
    site (`:689`).
13. `assertNoRemoves` non-vacuity guard at the malformed-marketplace-entry
    call site (`:707`).
14. `assertNoRemoves` non-vacuity guard at the malformed-marketplace-list call
    site (`:730`).
15. `assertNoAdapterUninstall` non-vacuity guard (`:194`) at the
    plugin-list-fails call site (`:625`).
16. `assertNoAdapterUninstall` non-vacuity guard at the malformed-plugin-list
    call site (`:643`).
17. `assertNoAdapterUninstall` non-vacuity guard at the malformed-plugin-entry
    call site (`:661`).
18. `assertNoAdapterUninstall` non-vacuity guard at the marketplace-list-fails
    call site (`:684`).
19. `assertNoAdapterUninstall` non-vacuity guard at the
    malformed-marketplace-entry call site (`:702`).
20. `assertNoAdapterUninstall` non-vacuity guard at the
    malformed-marketplace-list call site (`:725`).
21. `adapterSeam: "tripwire"` armed on a both-present uninstall: the subject's
    own exit status is 0, the fake adapter's log holds no line at all, and a
    direct spawn of that same case's fake adapter is then refused with exit 94
    and the tripwire's own message, leaving in the log the one line the
    emptiness check demanded be absent (`:963`, within `:963-993`). Appended
    at the end of the file rather than beside the both-present case it is
    thematically closest to, so adding it does not shift any other item's
    pointer. Two things, not one — an exit status alone cannot distinguish
    "refused" from "delegated, then failed" — mirroring
    `tests/bin/lifecycle-fakes.test.js`'s own precedent for the same subject.
    Counted as ONE port-only item, as it was when it held three assertions:
    the added half is this item's own non-vacuity guard, not a separate
    claim, and splitting it would move `portOnly` for no change in what the
    inventory maps.

<!-- inventory:port-only:end -->

## Mutation proof

Task 4's sweep, run 2026-08-03. Design Decision 5: **inject the violation into
the fixture, not into the assertion**, then observe which assertions turn RED.
A guard that stays GREEN under an injection that genuinely violates it is not
proven — it is a boundary guard, and it is adjudicated below rather than
"proved" by breaking its own text.

**Historical as of Task 6 (PR 11.5 slice 4b, 2026-08-10).** Everything below
this line describes the tree as it stood before Task 6 converted three
seam-dependent cases (selection-independent recovery, missing-Codex, and
both-present) and dropped item 35. The 18/18 GREEN figure below is unchanged
in count — Task 6 converted cases in place rather than adding or removing a
`test(` call site — but rows D4, 2, 3, and D3, which target the
SPW_ADAPTER-intercepted fixture surface those three cases used
(`install-fakes.js`/`uninstall-fakes.js` `runAdapter` interception, the
`updateControl` config, and the log lines items 25-28 used to name), no
longer describe a mechanism those cases route through. Retained because it
is the record of the mutation-testing pass that certified the PRE-Task-6
port, and later readers auditing that certification need to know what it
certified and when. Re-running this exact matrix against the current tree is
not proposed here.

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
| 1 | `lifecycle-config.js`: `UNINSTALL_DEFAULTS.spuriousMutation` `false` → `true`, forcing `plugin remove superpowers@spurious` into every Codex call's log | items 14 (`:414`), 40 (`:601`), 47 (`:630`), 50 (`:648`), 53 (`:666`), 57 (`:689`), 60 (`:707`), 64 (`:730`) — all 8 `assertNoRemoves` sites, 8/18 cases |
| 2a | **Historical, as run.** `uninstall-fakes.js:124` at the revision this matrix was built against (`343534b`, a 178-line file): the `marketplaceRemove === "fail"` branch's `process.exit(1)` → `process.exit(0)`, stderr kept. The construct no longer exists: PR 11.5 slice 4a converted every mutation branch to `process.exitCode` plus `return`, so the file is 113 lines and the branch sits at `:61-65`. The present-day equivalent is `process.exitCode = 1` → `= 0` at `:63`, leaving the `return` at `:64` in place — that pair reproduces the original's observable effect exactly (stderr written, status 0, no state mutation), whereas dropping the `return` would fall through into the `removesMutateState` block and be a different injection. Not re-run. | item 82 (`:819`), c18 only |
| 2b | **Historical, as run.** `uninstall-fakes.js:122` at the same revision: branch condition `"fail"` → `"fail-disabled"`, so the failure path never fires and the remove genuinely succeeds. This injection survives the conversion unchanged in form — the condition is now at `:61` — because it defeats the branch rather than its exit mechanism. Not re-run. | item 75 (`:802`), c18 only |
| 3 | `uninstall-fakes.js`: `plugin remove` branch prefixed with `writeJson("plugin_list.json", { installed: [], available: [] }); process.exit(0);` — verify-after always sees the plugin absent | items 69 (`:761`), 70 (`:769`) |
| 4 | `uninstall-fakes.js` `runAdapter`: log `inspect --view ownership` only on its first occurrence — the verify-after re-inspect is dropped from the log | items 27 (`:517`), 67 (`:754`) |
| 5 | `uninstall-fakes.js`: both list branches `process.exit(CONFIG.pluginListRc / marketplaceListRc)` → `process.exit(0)` — a failed ownership query no longer aborts | items 44 (`:617`), 55 (`:678`) |
| 6a | `uninstall-fakes.js` `runAdapter`: write `spw-sidecar-leak` into `$TMPDIR` | **none — 18/18 GREEN.** See Divergences |
| 6b | same, into `$TMPDIR/..` (the invocation TMPDIR the subject was handed) | items 24 (`:508`), 45 (`:623`) — both `assertTmpEmpty` ports |
| O1 | `uninstall-commands.test.js:537`: `firstInspect < uninstallAt` → `>` | item 29 (`:537`), "ownership inspect must precede adapter uninstall" |
| O2 | `uninstall-commands.test.js:541`: `uninstallAt < lastInspect` → `>` | item 30 (`:541`), "ownership re-inspect must follow adapter uninstall" |
| O3 | `uninstall-commands.test.js:548`: the two `assertOrder` needles swapped | item 33 (`:548`), `assertOrder` "out of order" |
| D1b | injection 1 with the payload string changed to `plugin remove superpowers@superpowers-wrapper` | item 20 (`:468`) in c6, plus the 8 row-1 sites |
| D1c | payload `plugin marketplace remove superpowers-wrapper` | item 21 (`:472`) in c6, plus the 8 row-1 sites |
| D1d | payload `plugin marketplace remove openai-curated` | items 34 (`:557`) in c7 and 83 (`:836`) in c18, plus the 8 row-1 sites |
| D1e | payload `plugin remove superpowers@superpowers-manager` | item 36 (`:576`) in c8, plus the 8 row-1 sites |
| D2 | `uninstall-fakes.js` `runAdapter`: extra `log("adapter.log", "uninstall --spurious")` on every adapter call | items 46 (`:625`), 49 (`:643`), 52 (`:661`), 56 (`:684`), 59 (`:702`), 63 (`:725`) — all 6 `assertNoAdapterUninstall` sites, and only those — **historical: these six assertions were re-anchored onto `codex.log`; see items 46-63** |
| D3 | same, payload `uninstall --plugin-present true --marketplace-present true` | item 28 (`:521`) in c7, plus the 6 D2 sites |
| D4 | same, payload `inspect --view update-control` | item 5 (`:335`) in c2, and only that |
| D5 | `uninstall-fakes.js`: `log("codex.log", ARGS.join(" "))` deleted from `runCodex` | port-only items 7-14, the `assertNoRemoves` emptiness guards, at `:414`, `:601`, `:630`, `:648`, `:666`, `:689`, `:707`, `:730` |
| D6 | `uninstall-fakes.js`: `log("adapter.log", ARGS.join(" "))` deleted from `runAdapter` | port-only items 15-20, the `assertNoAdapterUninstall` emptiness guards, at `:625`, `:643`, `:661`, `:684`, `:702`, `:725` — **historical: these six assertions were re-anchored onto `codex.log`; see items 46-63** |
| D7 | `uninstall-fakes.js`: `process.stdout.write("not a protocol envelope\n")` before the real adapter delegation | item 12 (`:393`) and 11 other cases; items 13 and 80 shadowed — see adjudication B |
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
that scenario and **(2)** what future change would make it reachable. This
two-part form is introduced here; `bin-dispatch.md:27-36` is the
counting-decision adjudication it generalises.

**A — item 9, "the Codex log is empty" (c3, `:364`).** *(1)* The case strips
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

**B — items 13 (`:399`) and 80 (`:831`), "output does not contain
`error: invalid adapter response:`".** *(1)* Not vacuous and not inert — but
structurally shadowed. Rows D7 and D8 do produce the violation: under D7 the
c4 failure message, which is the port's `out` variable dumped verbatim, reads
`error: invalid adapter response: Expecting value: line 1 column 1 (char 0)`
and nothing else, so item 13's condition is demonstrably false in that run.
The reported failure is item 12 (`:393`), asserted six lines earlier, because
node:test aborts the case at its first failure. D8 confirms the mechanism is
not an artifact of *where* the corruption is injected: appending a non-JSON
line after an intact envelope yields the same whole-output replacement
(`Extra data: line 2 column 1`), because the subject parses the adapter
response as one strict JSON document. Any fixture corruption **of the
adapter's stdout envelope** that produces the forbidden text also destroys the
controlled diagnostic item 12 requires, so the two cannot be separated by that
class of injection. A separate fixture lever does exist and is deliberately
declined: item 12 is an exact-line match (`hasLine`, `:393`) while item 13 is
a substring match (`:399`) over the same `stdout + stderr` capture (`:383`),
so a fake writing the forbidden text to **stderr** would redden item 13 while
item 12 still passes. That manufacture is refused for the item-35 reason — it
would prove only that a fixture can print a string it planted, not that the
subject emitted a protocol complaint. The same argument covers item 80 in
c18, where D7 aborts the run at the ownership inspect and item 76
(`:690`, stale — see its entry) fires first. *(2)* Independently reachable when the subject can emit
*both* the controlled diagnostic and a protocol complaint in one run — for
example if `spw_inspect_ownership` grew a second, stricter parse of an already
reported response, or if the adapter began writing its envelope and a
non-envelope diagnostic to the same stream on a path that still satisfies
item 12. Either change satisfies every earlier assertion in the case and is
caught only by items 13 and 80.

**C — items 74 (`:791`) and 79 (`:826`), "output does not contain
`uninstall complete`".** *(1)* Every fixture injection that makes the subject
print the final success banner also makes it exit 0, and both cases assert
`status !== 0` first: row 2b drove c18 RED at item 75 (`:802`), and row 3 drove
c17 RED at item 70 (`:769`), in both instances shadowing the banner negative.
No change to the **subject's own output stream** can decouple the banner from
the exit status, because `scripts/uninstall:34` prints the banner only once
`spw_verify_uninstalled_resources` (`:30`) has passed under `set -eu`, and the
only statement after it (`:35`, an informational `echo`) cannot fail —
reaching the banner *is* exiting 0. The same declined fixture lever as in
adjudication B applies: both cases assert over `stdout + stderr` (`:767`,
`:800`), so a fake writing `uninstall complete` to stderr would redden items
74 and 79 without proving anything about the subject. *(2)* Reachable exactly
when that coupling breaks: if the banner moves above
`spw_verify_uninstalled_resources` (`scripts/uninstall:30`), or is emitted
from an `EXIT` trap, or the script
prints it and then exits non-zero from a later step. That is a real regression
class, and the exit-status assertions alone do not catch it — which is why
both negatives are kept rather than folded into items 70 and 75.

**D — item 35 (`:561`), "the adapter log never names `other@x`":
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

**E — items 1 (`:285`) and 2 (`:294`), the source guards.** *(1)* Their
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

**Classes covered by this pass:** every negative, ordering, and cardinality
assertion in the port. Proven RED by injection: items 5, 14, 20, 21, 24, 27,
28, 29, 30, 33, 34, 36, 40, 45, 46, 47, 49, 50, 52, 53, 56, 57, 59, 60, 63,
64, 67, 83, and all 20 port-only guards — rows D5-D6 for the fourteen
non-vacuity guards (port-only items 7-20), and row D7 for the six
`status === 0` assertions (port-only items 1-6), which went RED at `:326`,
`:411`, `:460`, `:502`, `:570`, and `:598` under the protocol corruption.

Adjudicated GREEN with both required parts: items 1, 2, 9, 13, 35, 74, 79, 80.

**Not classified:** the 41 remaining mapped items, which are positives — 3, 4,
6, 7, 8, 10, 11, 12, 15, 16, 17, 18, 19, 22, 23, 25, 26, 31, 32, 37, 38, 39,
41, 42, 43, 48, 51, 54, 58, 61, 62, 65, 66, 68, 71, 72, 73, 76, 77, 78, 81. No
claim is made about that class. Six mapped positives did turn RED
incidentally — items 44 (`:617`), 55 (`:678`), 69 (`:761`), 70 (`:769`), 75
(`:802`) and 82 (`:819`) — which is recorded as observation, not as coverage.

No RED in this section was produced by editing an assertion's text outside
rows O1-O3.

## Cardinality

```json inventory
{
  "shellOriginal": 83,
  "portOnly": 21,
  "ports": { "tests/bin/uninstall-commands.test.js": 19 }
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
- Port (`tests/bin/uninstall-commands.test.js`): **19** static `test(` call
  sites as of Task 9 (PR 11.5 slice 4b, 2026-08-11; was 18 before Task 9), one
  per shell scenario plus one port-only case with no shell scenario at all
  (17 `reset` call sites, the source-guard block at `:9-16` which precedes the
  first `reset`, and Task 9's row-18 tripwire case). No call site is
  data-driven, so the 19 static sites produce 19 runtime cases. Unchanged by
  Task 6 (PR 11.5 slice 4b, 2026-08-10): three cases converted in place
  (selection-independent recovery and missing-Codex to an injected double;
  both-present re-anchored onto `codex.log`, still via `runScript`), so the
  static count neither grew nor shrank. Unchanged by Task 8 (PR 11.5 slice 4b,
  2026-08-11) for the same reason: the missing-python3 case was rewritten in
  place onto the inverse property when the flip removed `python3` from
  `COMMAND_REQUIREMENTS.uninstall`, so again the static count neither grew nor
  shrank. Task 9 added exactly one call site — the row-18 tripwire case,
  port-only item 21 — and no other task besides Task 9 added or removed one.
  The 18 pre-Task-9 sites carry **78 of the 83** shell assertions, **72 of
  them 1:1** and **6 sharing 2** merged assertions, plus **20** of the 21
  port-only assertions; the 21st is item 21, which lives in the 19th site
  and is the only port-only assertion Task 9 added. Items 28 and 35 (below)
  have no port counterpart as of Task 6, and items 7, 8 and 9 are retired as
  of Task 8.
- Reconciliation: **78 of the 83** shell items retain a port counterpart;
  **2 are dropped** — item 35 ("the adapter log never names `other@x`") and
  item 28 ("the adapter uninstall op appears exactly once") — and **3 retired
  items** (7, 8, 9), whose shell condition can no longer occur in either
  direction after `uninstall` stopped requiring `python3`. All five keep their
  numbers and are marked at their own entries rather than renumbered away.
  Item 35 is dropped because it was inert: its needle is defined by no
  fixture in this repository, so nothing the subject could do would have
  turned it red. Item 28 is a genuine, narrow loss: the re-anchor that
  collapses items 25-27 does not observe an exactly-once count. Both
  arguments are at the entries and in the "Both present" section note.

  The remaining 78 are **not** 1:1 throughout, contrary to what this bullet
  claimed before Task 6: **72 items map onto a port assertion of their own**
  and **6 share 2**, across the two merges Task 6 created and recorded
  inline —

  - items **3, 4, 5** collapse onto the single `assert.deepEqual` over the
    double's recorded call sequence at `:386`; and
  - items **25, 26, 27** collapse onto the single `assertAdapterUninstallRan`
    call at `:597-600` (`ownershipInspections(codex) === 2`).

  **How to reproduce these figures**, since the gate does not read this
  prose: dropped = the items whose entry says "No port counterpart" (28 and
  35 — **2**); retired = the items carrying a bold `Retired` marker (7, 8 and
  9 — **3**), so retained = 83 − 2 − 3 = **78**; shared = the two merges above
  (**6** items over **2** merges), so own = 78 − 6 = **72**. Items 29 and 30
  are *not* a merge despite the ranges they cite: they are two distinct
  `assert.ok` calls inside the same re-anchored block.

  Two orderings differ from the
  shell — items 36/38 and items 79-82 — because the port asserts the
  positive claim before the negative one that depends on it; the set of
  assertions is otherwise unchanged. Three further fidelity notes are
  recorded inline rather than left implicit: items 24 and 45 carry a
  **narrowed TMPDIR scope** forced by per-case isolation, the missing-python3
  scenario runs with `SPW_ADAPTER` set where the shell left it unset, and
  several items in the selection-independent-recovery, missing-Codex, and
  both-present sections changed **channel** (adapter-log read → injected
  double, or adapter-log read → codex.log re-anchor) without changing what
  they assert — each section's own note says which. None of this changes the
  count. The 21 port-only assertions (20 before Task 9, plus item 21's
  tripwire case) are strictly additive and are excluded from the 83-item
  arithmetic above.
