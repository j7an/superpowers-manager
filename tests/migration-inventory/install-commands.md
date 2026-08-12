# Migration inventory: tests/test_install_commands.sh

Source read in full (782 lines). Ported to
`tests/bin/install-commands.test.js`.

No behavior ID in `docs/baseline/traceability.md` references
`test_install_commands` (confirmed by
`grep -c test_install_commands docs/baseline/traceability.md` returning 0).
This inventory is the evidence that no assertion was dropped.

Shell line references below are `:N` against the deleted
`tests/test_install_commands.sh`; port line references are `:N` against
`tests/bin/install-commands.test.js`.

**STALE POINTER WARNING — port `:N` pointers, as of 2026-08-11.** Commit
`1abd231` (PR 11.5 slice 4b, Task 6) rewrote
`tests/bin/install-commands.test.js` from 1472 to 1579 lines and remapped only
the pointers of the items it converted. Those carry an explicit ``(was
`:N`)`` note and are current. Every OTHER item's `Port:` pointer still names
the line it occupied at `7db289d` and no longer resolves. Measured: **80
pointers across 76 items** name a line whose content has moved; 76 of the 81
never-updated pointers landed on an assertion-shaped line at `7db289d` and
only 3 still do at HEAD. What is NOT affected: item numbering, the
retained/retired accounting, the merge enumeration, and everything
`tests/bin/migration-inventory.test.js` gates — none of which read a `:N`
pointer. Item 80 below is a separate, older, deliberately-unremapped pointer
with its own note. **Before trusting any `Port:` pointer in this file,
re-derive it** — the assertion text each item quotes is the reliable key, and
`git diff 7db289d..HEAD -- tests/bin/install-commands.test.js` gives the
shift. A wholesale remap is deferred to its own task rather than folded into a
prose fix: outside the mapped region, telling a port pointer from a shell
pointer needs item-by-item judgement, and a mechanically-offset pointer that
lands on an unrelated but assertion-shaped line is the exact failure item 80
records.

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
  Three such bare tests exist here: `:388`, `:399`, and `:415`.

Rules 7 and 8 are reproduced from `uninstall-commands.md:54-70`, unchanged:

- **Rule 7 — assertion helpers count at the call site, not at the
  definition.** This driver factors three assertion helpers out of its
  scenarios: `expect_fail` (`:289-295`), `assert_install_tmp_empty`
  (`:297-303`), and `assert_no_codex_mutation` (`:313-319`). Each body is one
  rule-1 or rule-3 guard, so this is that rule applied at the point of use.
  `line_of` (`:305-307`) and `adapter_line_of` (`:309-311`) are value
  extractors, not assertions, and are not counted. Neither are `reset`
  (`:226-235`), `set_update_control` (`:237-239`), `seed_installed_current`
  (`:241-251`), or the three `run_*` wrappers (`:253-287`).
- **Rule 8 — a negative guard whose condition is a `||` chain of N
  independent `grep` tests counts N, not 1.** Three occurrences here:
  `:561-563`, `:696-700`, and `:712-716`. The two greps in each are
  independent claims sharing only a diagnostic block, and the port makes each
  a separate assertion, so counting them separately keeps the mapping 1:1.

Two further rules are needed for this driver, stated explicitly rather than
folded silently into the eight above:

- **Rule 9 — a guard whose condition is an `&&` chain of N independent
  `[ ... ]` tests counts N, not 1.** This is rule 8 applied to the other
  operator, and it governs the five ordering guards at `:500`, `:527`, `:546`,
  `:578`, and `:729`. `{ [ "$a" -lt "$b" ] && [ "$b" -lt "$c" ]; } || { echo
  …; exit 1; }` makes two independent ordering claims about three separately
  extracted line numbers; the shell shares one diagnostic block between them
  purely for brevity. The port expresses each guard as a single `assertOrder`
  call, so N shell items map onto one port line — recorded per item below
  rather than merged away.
- **Rule 10 — an embedded `python3` heredoc counts one assertion per
  independent claim it can fail on, expanding a loop over a fixed literal
  tuple per literal.** That is rule 4 applied inside Python. Two heredocs
  carry assertions: `:11-42` (one unreadable-file guard, four forbidden
  literals, one `app-server` line guard = **6**) and `:759-768` (one
  40-hex-commit guard = **1**). The heredocs at `:118-127`, `:131-139`,
  `:150-158`, and `:458-467` mutate fixtures and assert nothing; they
  contribute 0.

**A bare `run_*` with no status test is not counted.** `:325`, `:398`, `:495`,
`:522`, `:541`, `:560`, `:574`, `:593`, `:724`, `:755`, and `:777` all take
the form `run_install >"$state/out"`, leaving the exit status to `set -e`.
`bin-dispatch.md` and `uninstall-commands.md` both treat that as implicit and
record the port's explicit `assert.equal(result.status, 0, …)` as port-only.
Same treatment here.

**`:600-602` is one assertion, not two.** The construct is
`[ ! -s "$log" ] || { assert_no_codex_mutation; }`. The `[ ]` is a condition
selecting whether to check, not a claim about the subject; the helper call is
the assertion (rule 7).

**Alternative reading, for the record.** Rules 9 and 10 are the two places a
reasonable reader could count differently. Collapsing every `&&`/`||` chain to
one assertion and counting only `raise SystemExit` sites inside `:11-42`
yields **112** rather than 124. Decision: **124**, following the rule-8
precedent already set by `uninstall-commands.md` — the port makes each claim
separately, and a 1:1 mapping is the property this file exists to certify.

## Assertion inventory

<!-- inventory:mapped:start -->

### Source guards: no hook-trust mutation surface in production scripts (`:11-42`)

These read the repository's own `scripts/`, not a fixture snapshot, so the
port reads `ROOT`.

1. An unreadable production script is a hard failure, never a skip
   (`:26-29`). Port: `:469`.
2. No production script contains `requirements.toml` (`:30-35`, literal 1 of
   4). Port: `:475`.
3. No production script contains `hooks.state` (literal 2 of 4). Port:
   `:475`.
4. No production script contains `trusted_hash` (literal 3 of 4). Port:
   `:475`.
5. No production script contains `--dangerously-bypass-hook-trust` (literal 4
   of 4). Port: `:475`.
6. No production script names `app-server` outside a comment (`:36-41`).
   Port: `:483`.

### Packaged root preconditions (`:77-82`)

7. `scripts/install` is executable in the packaged root (`:77`). Port:
   `:501`.
8. `scripts/adapters/codex/adapter` is executable (`:78`). Port: `:501`.
9. `dist/validate-generated-plugin-cli.js` is packaged (`:79`). Port: `:513`.
10. `dist/generated-plugin.js` is packaged (`:80`). Port: `:513`.
11. `dist/python-text.js` is packaged (`:81`). Port: `:513`.
12. `scripts/adapters/codex/validate-generated-plugin.py` is **not** packaged
    (`:82`). Port: `:519`.

### Prepare is capability-independent (`:321-336`)

**Channel changed (Task 6, D4, 2026-08-10).** This case now calls
`runPrepare` in-process through an injected recording adapter
(`tests/bin/command-context.js`) instead of spawning `scripts/prepare`
through the SPW_ADAPTER seam. All three items below survive as structural
claims over the double's own recorded `calls` rather than as reads of
`adapter.log` or `codex.log` — a channel change, not a behaviour change: the
double answers ONLY a `build` call and fails the case by exhaustion on any
other call, which is a stronger, not weaker, form of the same three
negatives. There is no `codex.log` at all in-process (nothing here spawns a
Codex fake), so item 15's claim is now subsumed by the double's own
exhaustiveness rather than witnessed by an empty file.

13. The adapter log holds no `inspect --view update-control` (`:326-330`).
    Port: `:697` (was `:545`), now
    `!adapter.calls.some((c) => c.join(" ") === "inspect --view update-control")`,
    subsumed into the same `deepEqual(calls.map((c) => c[0]), ["build"])`
    check items 14 and 15 also map onto.
14. The adapter log holds no `install --package-root` (`:331-335`). Port:
    `:697` (was `:550`), same `deepEqual` call as item 13.
15. No Codex mutation (`:336`, `assert_no_codex_mutation`). Port: `:697`
    (was `:557`). The strictly-stronger claim survives structurally: the
    double's own construction makes any call other than `build` fail the
    case by exhaustion, which is stronger than an empty-log read because it
    also rejects an unexpected SECOND `build` call the empty-log form could
    not see.

### Unsupported update control blocks the update fast path (`:338-347`)

**Channel changed (Task 6, D4, 2026-08-10).** Calls `runUpdate` in-process
with a double answering `inspect --view update-control` with `unsupported`,
reachable through the real production switch
(`src/lifecycle.ts`'s `requireManagedUpdateControl`) exactly as it was
through the fixture. "current" is now established by answering the
fingerprint inspect with the commit `prepareGeneratedTree` wrote, replacing
`seedInstalledCurrent`'s real fake-Codex-cache seed.

16. Update fails (`:344`). Port: within `:705-757` (was `:582`).
17. Output contains `adapter cannot guarantee manager-controlled updates`
    (`:345`). Port: within `:705-757` (was `:587`).
18. Output does **not** contain `manager is current` (`:346`). Port: within
    `:705-757` (was `:594`). Non-vacuous: item 17 proves the output carries
    the subject's diagnostics.
19. No Codex mutation (`:347`). Port: within `:705-757` (was `:599`), now
    `!adapter.calls.some((c) => c[0] === "install" || c[0] === "build")` —
    there is no `codex.log` at all in-process, so the claim re-anchors onto
    the double's own calls rather than onto Codex.

### Unsupported update control blocks a direct install (`:349-352`)

**Channel changed (Task 6, D4).** Calls `runInstall` in-process with the same
`unsupported` double, on the needs-install path (fingerprint defaults to
`null`).

20. Install fails (`:351`). Port: within `:759-791` (was `:614`).
21. No Codex mutation (`:352`). Port: within `:759-791` (was `:618`), same
    structural re-anchor as item 19.

### Malformed update-control output exits exactly 1 (`:354-364`) — **RETIRED**

**RETIRED at the gap (Task 6, D4, 2026-08-10).** This case's subject is
gone: `updateControl: "malformed"` drove the FAKE ADAPTER PROCESS to write a
bare `{` to stdout — a transport-level, non-JSON-parseable fault at the OS
process boundary. `ctx.adapter` (`CommandContext.adapter`,
`src/commands/context.ts`) is an in-process function call that returns an
already-typed `AdapterResult` object; there is no serialization step between
the command module and its adapter for a double to corrupt, so nothing can
reproduce "the adapter emitted invalid JSON" through this seam. The covering
cases for "an adapter response can be reported as a failure" now live at the
production layer that still has a real transport — `tests/unit/adapter.test.js`,
which drives `runAdapter` (the REAL adapter, `src/adapter.ts`) against a
genuinely unparseable Codex listing. Named explicitly, as Task 6's brief
requires, rather than described:

- **"the fingerprint view rejects an invalid-UTF-8 plugin listing"**
  (`tests/unit/adapter.test.js:421-437`) — asserts `envelope.ok === false`,
  `error.code === "inspect-failed"`, and the exact message
  `cannot parse output of '<codex> plugin list --json'`.
- **"the ownership view rejects an invalid-UTF-8 plugin listing"**
  (`tests/unit/adapter.test.js:442-458`) — the same three claims for the
  ownership view, whose fail-open would otherwise be silent.
- **"install rejects an invalid-UTF-8 marketplace listing without mutating"**
  (`tests/unit/adapter.test.js:464-485`) — `error.code === "install-failed"`,
  the parse diagnostic for `plugin marketplace list --json`, and
  `deepStrictEqual(await sandbox.commands(), ["plugin marketplace list
  --json"])`, i.e. no mutation followed the unparseable read.

Together these are the in-process analogue of "the thing downstream of the
adapter sees a failure it must report, not silently swallow", with the parse
failure occurring at the one boundary that still has a real transport. Note
that the shell's own diagnostic literal, `invalid adapter response`, exists in
exactly one place in the product — `scripts/core/validate-adapter-response.py:279`,
a shell-only artefact — so the retired subject has no in-process producer to
cover. No port `test(`
call site carries this case any longer; `tests/bin/install-commands.test.js`'s
static count dropped by one for it (32 → 30, shared with item 107-111's
retirement below).

**There are exactly TWO Class-2 retirements, not three — recorded here so
slice 4c does not go looking for a missing third.** Task 6's brief predicted
three transport-fault cases. Two exist: this one and "Scenario 8b — malformed
fingerprint inspection output" below. The transport-fault lever is a fixture
config that makes the FAKE ADAPTER PROCESS write a bare `{` to stdout, and the
whole fixture schema offers exactly two — `updateControl: "malformed"`
(`tests/bin/install-fakes.js:222-226`) and `fingerprintInspect: "malformed"`
(`tests/bin/install-fakes.js:273-277`). Those are also the only two
`process.stdout.write("{")` sites anywhere under `tests/bin/`.
`tests/bin/lifecycle-config.js:38-57` pins the enum surface that can reach
them: `updateControl` accepts `managed`, `unsupported`, `malformed`, `failure`,
`managed-then-unsupported`; `fingerprintInspect` accepts `ok` and `malformed`.
The uninstall driver has no such lever at all — its malformed-evidence cases
write malformed *files*, not malformed adapter transport
(`tests/bin/lifecycle-config.js:75`). The brief's third was almost certainly
`updateControl: "failure"` ("Failed update-control inspection exits exactly 1",
items 25-27 below), which emits a well-formed `ok: false` envelope
(`tests/bin/install-fakes.js:227-241`) rather than a transport fault, and was
therefore CONVERTED rather than retired — the correct disposition. Nothing was
missed.

22. Install does not succeed (`:357-362`). **No port counterpart — gap,
    accepted above.**
23. The exit status is exactly 1 (`:363`). **No port counterpart — gap,
    accepted above.**
24. No Codex mutation (`:364`). **No port counterpart — gap, accepted
    above.**

### Failed update-control inspection exits exactly 1 (`:366-375`)

**Channel changed (Task 6, D4).** Calls `runUpdate` in-process.
`updateControl: "failure"` is NOT the transport fault items 22-24 named: the
fixture answered it with a well-formed `ok: false` envelope, which is exactly
what `failureResult(...)` (`dist/adapter-protocol.js`) builds directly —
reachable through a double with no loss of fidelity.

25. Update does not succeed (`:368-373`). Port: within `:792-818` (was
    `:647`).
26. The exit status is exactly 1 (`:374`). Port: within `:792-818` (was
    `:647`). Merged with item 25, as before.
27. No Codex mutation (`:375`). Port: within `:792-818` (was `:653`), same
    structural re-anchor as item 19.

### A needs-prepare install reinspects after prepare (`:377-392`)

**Channel changed (Task 6, D4).** Calls `runInstall` in-process.
`runInstall` calls `runPrepare` internally on the needs-prepare branch,
through the SAME `ctx.adapter`, so the double also answers `build`. The
`managed-then-unsupported` drift is now a call-counted function
(`(call) => call === 1 ? "managed" : "unsupported"`) rather than a
fixture-side counter file.

28. Install rejects capability drift after prepare (`:383-386`). Port: within
    `:819-868` (was `:672`).
29. Stdout contains `prepared v1.0.0` (`:387`). Port: within `:819-868` (was
    `:678`).
30. Update control was inspected exactly twice (`:388`, bare `[ ... ]` per
    rule 6). Port: within `:819-868` (was `:680`), now
    `adapter.calls.filter((c) => c.join(" ") === "inspect --view update-control").length === 2`.
31. The build line precedes the second update-control inspection (`:391`).
    Port: within `:819-868` (was `:690`), now `firstIndex`/`lastIndex` over
    `adapter.calls.map((c) => c.join(" "))` rather than over `adapter.log`.
32. No Codex mutation (`:392`). Port: within `:819-868` (was `:695`), now
    `!adapter.calls.some((c) => c[0] === "install")` — build itself is
    expected here (that is the point of the case), so only the mutation
    stage, not the whole `ADAPTER_MUTATION` class, is excluded.

### The needs-install path inspects freshly, then installs (`:394-404`)

**Channel changed (Task 6, D4).** Calls `runInstall` in-process. The
interceptor's on-disk `update-control-count` file is gone; the double's own
`calls` array supplies the count directly, and the fingerprint answer is
call-counted (`null` on probe's initial inspect, the generated commit on
gatherInstallStages' post-install re-inspect).

33. Update control was inspected exactly twice (`:399`, bare `[ ... ]`).
    Port: within `:869-915` (was `:713`).
34. The last ownership inspection precedes the last update-control gate
    (`:403`). Port: within `:869-915` (was `:720`).
35. The last update-control gate precedes the adapter install (`:404`). Port:
    within `:869-915` (was `:724`).

### The fresh gate, not the probe, controls mutation authority (`:406-416`)

**Channel changed (Task 6, D4).** Calls `runInstall` in-process on the
needs-install path, with the same call-counted `managed-then-unsupported`
double as items 28-32.

36. Install rejects capability drift before adapter install (`:411-414`).
    Port: within `:916-949` (was `:741`).
37. Update control was inspected exactly twice (`:415`, bare `[ ... ]`).
    Port: within `:916-949` (was `:750`).
38. No Codex mutation (`:416`). Port: within `:916-949` (was `:752`), now
    `!adapter.calls.some((c) => c[0] === "install")`.

### Legacy and mixed identity state stop before mutation (`:425-451`)

The `for legacy_state in legacy both` loop contributes 6 assertions per
iteration (rule 4). Items 39-44 are the `legacy` iteration, items 45-50 the
`both` iteration. Both port to the shared helper, `assertLegacyIdentityStops`;
the call sites are `:950` and `:959`.

**Channel changed (Task 6, D4, 2026-08-10).** The helper itself now calls
`runInstall` in-process (was: `runScript(c, "install")`, spawning the shell
through the SPW_ADAPTER seam), with an injected double supplying
`identity_state` directly (`"legacy"` or `"both"`) rather than driving it
through real `plugin_list.json`/`marketplace_list.json` fixtures and the real
adapter's ownership computation. `runInstall` calls `gatherProbe`
unconditionally, so the double answers all three of probe's own inspects
(fingerprint, ownership, update-control); `requireNoLegacyState` fires
immediately after, before any workspace or adapter mutation stage, so those
three calls are the only ones that should ever reach the double. Item
43/49's `^build `/`^install ` negative — which had no Codex-level footprint
because the adapter's build operation issues no Codex command at all — is now
`!adapter.calls.some((c) => c[0] === "build" || c[0] === "install")`, and item
44/50's Codex-mutation claim is dropped as a SEPARATE assertion: there is no
`codex.log` at all in-process (nothing here spawns a Codex fake), and the
double never reaching `install` structurally means the adapter's own
unconditional `codex plugin add` (`src/adapter.ts:668-673`, the
`["plugin", "add", PLUGIN_ID]` mutation at `:671`) was impossible to reach
either — the same fact items 43/49 and 44/50 both named is now proven once,
not twice.

39. Install rejects the `legacy` identity state (`:438-441`). Port: within
    `:547-608` (helper body, was `:410`).
40. Output holds the exact line `Legacy superpowers-wrapper Codex state is
    installed.` (`:442`). Port: within `:547-608` (was `:419`).
41. Output holds the exact line `Run: npx superpowers-wrapper@0.1.1
    uninstall` (`:443`). Port: within `:547-608` (was `:423`). This literal is
    user-facing guidance owned by `scripts/core/lifecycle.sh:52`, not a
    dependency version that moves on someone else's schedule — the exact
    text is the contract.
42. Output holds the exact line `Then run: npx superpowers-manager install`
    (`:444`). Port: within `:547-608` (was `:424`).
43. The adapter log holds no `^build ` or `^install ` line (`:445-449`).
    Port: within `:547-608` (was `:439`), now
    `!adapter.calls.some((c) => c[0] === "build" || c[0] === "install")`.
44. No Codex mutation (`:450`). **Subsumed into item 43's structural form —
    see the channel-change note above; not a separately witnessed claim
    in-process.**
45. Install rejects the `both` identity state (`:438-441`, iteration 2). Port:
    within `:547-608` (helper) via `:959` (was `:410` via `:774`).
46. The same exact `Legacy superpowers-wrapper …` line (`:442`, iteration 2).
    Port: within `:547-608` via `:959` (was `:419` via `:774`).
47. The same exact `Run: npx superpowers-wrapper@0.1.1 uninstall` line
    (`:443`, iteration 2). Port: within `:547-608` via `:959` (was `:423` via
    `:774`).
48. The same exact `Then run: npx superpowers-manager install` line (`:444`,
    iteration 2). Port: within `:547-608` via `:959` (was `:424` via `:774`).
49. No `^build ` or `^install ` adapter line (`:445-449`, iteration 2). Port:
    within `:547-608` via `:959` (was `:439` via `:774`).
50. No Codex mutation (`:450`, iteration 2). **Subsumed into item 49's
    structural form, same as item 44.**

### Built-in validation failure leaves Codex untouched (`:453-476`)

51. Install fails on built-in validation (`:468-472`). Port: `:794`.
52. Output contains ``field `name` must equal `superpowers` `` (`:473`).
    Port: `:800`.
53. No Codex mutation (`:474`). Port: `:802`.

### Additional-validator failure leaves Codex untouched (`:478-487`)

54. Install fails on additional validation (`:481-485`). Port: `:816`.
55. Output contains `additional plugin validation failed` (`:486`). Port:
    `:822`.
56. No Codex mutation (`:487`). Port: `:824`.

### Scenario 1 — fresh install (`:489-512`)

57. Prepare generated the tree: the package root carries
    `.superpowers-upstream.json` (`:496`). Port: `:854`.
58. `plugin marketplace list` precedes `plugin marketplace add <pkg>`
    (`:500`, first `[ ]` of the rule-9 chain). Port: `:861`, via
    `assertOrder`.
59. `plugin marketplace add <pkg>` precedes `plugin add
    superpowers@superpowers-manager` (`:500`, second `[ ]`). Port: `:861`,
    same call.
60. Stdout contains `manager updated` (`:502`). Port: `:871`.
61. The invocation TMPDIR is left empty (`:503`,
    `assert_install_tmp_empty`). Port: `:873`, helper at `:338`. **Scope
    narrowed twice — see the note below, and the further narrowing the
    mutation proof's row 13a records.**
62. The Codex log holds no `marketplace remove` (`:504-506`). Port: `:876`.
63. The Codex log holds no `plugin remove superpowers@superpowers-manager`
    (`:507-509`). Port: `:880`.
64. The Codex log never names `openai-curated` (`:510-512`). Port: `:884`.
    Items 62-64 are non-vacuous because items 58-59 prove all three expected
    commands reached the log.

**TMPDIR scope narrowing (items 61 and 94).** The shell created
`$install_tmp` once at `:96-97` and `reset` (`:226-235`) never cleared it, so
by `:503` the check proved that *every* run since the top of the file had left
no residue. `assertTmpEmpty(c)` inspects one case's own TMPDIR, because
`createCase` gives every case a private one. The claim is therefore narrower
at both call sites: it still catches a leak in the scenario that makes it, but
no longer sweeps up the scenarios that ran before it. This is an unavoidable
consequence of per-case isolation, not an oversight; it mirrors the identical
narrowing recorded at `uninstall-commands.md:316-329`.

### Scenario 1b — a current manager is reconciled, not skipped (`:514-532`)

65. The adapter log holds `install --package-root <pkg>` (`:523`). Port:
    `:812`.
    **Pointer stale, deliberately not remapped.** PR 11.5 slice 3.5
    re-anchored this assertion onto `codex.log`, so the adapter-log line
    this item describes is no longer asserted anywhere and no line number
    can honestly stand in for it. Re-deriving the claim and its pointer
    together is a re-disposition, not a pointer fix.
66. `plugin marketplace list` precedes `plugin marketplace add <pkg>`
    (`:527`, first `[ ]`). Port: `:914`.
67. `plugin marketplace add <pkg>` precedes `plugin add
    superpowers@superpowers-manager` (`:527`, second `[ ]`). Port: `:914`.

### Scenario 1c — a matching fingerprint at a different root (`:534-551`)

68. The adapter log holds `install --package-root <pkg>` (`:542`). Port:
    `:844`.
    **Pointer stale, deliberately not remapped.** PR 11.5 slice 3.5
    re-anchored this assertion onto `codex.log`, so the adapter-log line
    this item describes is no longer asserted anywhere and no line number
    can honestly stand in for it. Re-deriving the claim and its pointer
    together is a re-disposition, not a pointer fix.
69. `plugin marketplace remove superpowers-manager` precedes `plugin
    marketplace add <pkg>` (`:546`, first `[ ]`). Port: `:947`.
70. `plugin marketplace add <pkg>` precedes `plugin add
    superpowers@superpowers-manager` (`:546`, second `[ ]`). Port: `:947`.

### Scenario 2 — the same physical root via a symlink (`:553-567`)

71. The Codex log holds no `marketplace add` (`:561`, first grep of the
    rule-8 `||` chain). Port: `:984`.
72. The Codex log holds no `marketplace remove` (`:561`, second grep of the
    same chain). Port: `:988`.
73. The Codex log holds `plugin add superpowers@superpowers-manager`
    (`:564`). Port: `:979` — hoisted **above** items 71-72 in the port so
    neither negative can pass on an empty log.
74. The Codex log holds no `plugin remove superpowers@superpowers-manager`
    (`:565-567`). Port: `:993`.

### Scenario 3 — a different registered root (`:569-585`)

75. `plugin marketplace remove superpowers-manager` precedes `plugin
    marketplace add <pkg>` (`:578`, first `[ ]`). Port: `:1018`.
76. `plugin marketplace add <pkg>` precedes `plugin add
    superpowers@superpowers-manager` (`:578`, second `[ ]`). Port: `:1018`.
77. The Codex log holds no `marketplace remove openai-curated` (`:580-582`).
    Port: `:1028`.
78. The Codex log holds no `plugin remove superpowers@superpowers-manager`
    (`:583-585`). Port: `:1032`.

### Scenario 3b — update stays read-only when probe reports current (`:587-602`)

79. Stdout contains `manager is current` (`:594`). Port: `:1054`.
80. The adapter log holds no `install --package-root` (`:595-599`). Port:
    `:947`.
    **Pointer stale, deliberately not remapped.** PR 11.5 slice 3.5
    re-anchored scenario 3b onto `codex.log`: the adapter-log negative and
    its `nonEmpty` guard were both deleted, subsumed into the
    `assertNoCodexMutation` call item 81 cites. `:947` reads as valid and is
    not: at the time this note was written it landed on an unrelated
    `assertOrder`, and at HEAD (after Task 6) it lands on the closing `);` of
    the "no call named install reached the double" guard in the fresh-gate
    case — a different unrelated site. Re-deriving the claim is a
    re-disposition, not a pointer fix.
81. No Codex mutation (`:600-602`). Port: `:1066`. **Divergence:** the shell
    wrapped the helper in `[ ! -s "$log" ] ||`, so an empty Codex log
    satisfied the scenario. The port drops that escape hatch —
    `assertNoCodexMutation`'s emptiness guard reports an empty log as the
    fixture fault it would be, since probe always reaches
    `codex plugin list`. Strictly stronger, and recorded so the difference is
    not mistaken for an oversight.

### Scenario 3c — update rejects mixed legacy state while current (`:604-620`)

**Channel changed (Task 6, D4, 2026-08-10).** Same treatment as the
legacy/mixed identity helper above, inlined rather than shared (this case
dispatches `runUpdate`, not `runInstall`, so it cannot reuse
`assertLegacyIdentityStops`). Calls `runUpdate` in-process with a double
supplying `identity_state: "both"` and the fingerprint the fixture's
`seedInstalledCurrent` used to establish through a real Codex cache (the case
is named "even when the fingerprint is current": the legacy check runs
before the status switch that would otherwise report it).

82. Update fails (`:610-613`). Port: within `:1236-1274` (was `:1088`).
83. Output holds the exact line `Then run: npx superpowers-manager install`
    (`:614`, `grep -Fxq`). Port: within `:1236-1274` (was `:1094`).
84. The adapter log holds no `^build ` or `^install ` line (`:615-619`).
    Port: within `:1236-1274` (was `:1102`), now
    `!adapter.calls.some((c) => c[0] === "build" || c[0] === "install")`.
85. No Codex mutation (`:620`). **Subsumed into item 84's structural form —
    same reasoning as items 44/50 above: there is no `codex.log` at all
    in-process, and the double never reaching `install` already proves the
    Codex mutation is unreachable.**

### Scenario 4 — remove succeeds, add fails (`:622-634`)

86. Install fails (`:629`, `expect_fail`). Port: `:1127`.
87. Output names the root it failed to add: `plugin marketplace add <pkg>`
    (`:630`). Port: `:1134`.
88. Output names the previous root it had already removed (`:631`). Port:
    `:1135`.
89. The Codex log holds no `plugin add superpowers@superpowers-manager` — the
    plugin add was never attempted (`:632-634`). Port: `:1138`.

### Scenario 5 — malformed marketplace listing (`:636-646`)

90. Install fails (`:641`). Port: `:1157`.
91. The Codex log holds no `marketplace (add|remove)` and no `^plugin
    (add|remove)` (`:642-646`). Port: `:1164`. The ERE here is wider than
    `assert_no_codex_mutation`'s — `marketplace (add|remove)` is unanchored —
    so the port carries it as its own pattern rather than reusing
    `CODEX_MUTATION`.

### Scenario 6 — plugin add refreshes nothing (`:648-659`)

92. Install fails (`:654`). Port: `:1183`.
93. Output contains `fingerprint is not detectable` (`:655`). Port: `:1189`.
94. The invocation TMPDIR is left empty (`:656`). Port: `:1191`. Same scope
    narrowing as item 61, including the further narrowing the mutation proof's
    row 13a records.
95. Output does **not** contain `manager updated` (`:657-659`). Port:
    `:1194`. Non-vacuous: item 93 proves the output carries the subject's
    verification diagnostics.

### Scenario 7 — the installed fingerprint stays stale (`:661-674`)

96. Install fails (`:669`). Port: `:1212`.
97. Output contains `does not match the prepared plugin` (`:670`). Port:
    `:1218`.
98. Output contains `SUPERPOWERS_INSTALL_REFRESH_MODE=remove-add` (`:671`).
    Port: `:1222`. The hint text is owned by `src/adapter.ts:641-643` and
    replayed from the adapter result by `scripts/core/lifecycle.sh:109,121`;
    core holds no copy of it.
99. Output does **not** contain `manager updated` (`:672-674`). Port:
    `:1224`.

### Scenario 8 — the missing-fingerprint replay hint (`:676-685`)

100. Install fails (`:683`). Port: `:1242`.
101. Output contains `fingerprint is not detectable` (`:684`). Port: `:1248`.
102. Output contains `verify with 'codex plugin list --json'` (`:685`,
     `src/adapter.ts:645`). Port: `:1250`.

### Scenario 8a — fingerprint inspection command failure (`:687-700`)

103. Install fails (`:694`). Port: `:1281`.
104. Output contains `fingerprint inspection` (`:695`). Port: `:1289`.
     **Re-based, and the narrowing lifted with it.** The shell drove this
     scenario by making the fake ADAPTER fail (`fingerprintInspect: "fail"`),
     and the earlier port carried that fixture forward — which is what the
     mutation proof's row 8 caught: the fake's own stderr line
     `fingerprint inspection failed in adapter fixture` carried the needle, so
     the assertion proved the string appeared, not that the subject produced
     it.
     PR 11.5 slice 3.5 replaced the mechanism with a lever below the fixture.
     `pluginAdd: "orphan"` makes the fake CODEX register the plugin as
     installed at 1.0.0 without materialising its cached tree, so the **real**
     adapter's fingerprint handler resolves an active version
     (`src/adapter.ts:790-797`), builds the installed root for it (`:815-820`),
     finds nothing readable there — `installedCommitFromRoot` returns `""`
     (`src/codex-state.ts:67-84`) — and returns a controlled `inspect-failed`
     envelope. The port now asserts the **subject-owned** whole line
     `error: installed manager fingerprint inspection failed after install.`
     (`scripts/core/lifecycle.sh:92`), which no fixture emits. The claim is
     the shell's, discharged by a stronger witness; the item is not narrowed.
     The `fingerprintInspect: "fail"` config value and the fake-adapter branch
     behind it were retired in the same commit, having lost their only
     consumer.
105. Output does **not** contain `fingerprint is not detectable` (`:696`,
     first grep of the rule-8 `||` chain). Port: `:1298`.
106. Output does **not** contain `manager updated` (`:697`, second grep of
     the same chain). Port: `:1302`. Items 105-106 are non-vacuous because
     item 104 proves `out` carries the subject's diagnostic stream — which,
     since the re-base, it does: the line it matches has exactly one emitter
     and that emitter is `scripts/core/lifecycle.sh`, not the fixture.

### Scenario 8b — malformed fingerprint inspection output (`:702-716`) — **RETIRED**

**RETIRED at the gap (Task 6, D4, 2026-08-10).** Same reasoning as
"Malformed update-control output exits exactly 1" (items 22-24) above:
`fingerprintInspect: "malformed"` drove the FAKE ADAPTER PROCESS to write a
bare `{` to stdout — a transport-level fault with no analogue through
`ctx.adapter`, which returns an already-typed `AdapterResult` with nothing to
garble in between. `tests/bin/install-commands.test.js`'s static `test(`
count dropped by one for this retirement, alongside items 22-24's (32 → 30
combined).

107. Install fails (`:709`). **No port counterpart — gap, accepted above.**
108. Output contains `invalid adapter response` (`:710`). **No port
     counterpart — gap, accepted above.**
109. Output contains `fingerprint inspection` (`:711`). **No port
     counterpart — gap, accepted above.**
110. Output does **not** contain `fingerprint is not detectable` (`:712`,
     first grep of the rule-8 chain). **No port counterpart — gap, accepted
     above.**
111. Output does **not** contain `manager updated` (`:713`, second grep).
     **No port counterpart — gap, accepted above.**

### Scenario 9 — remove-add refresh mode (`:718-736`)

112. `plugin marketplace list` precedes `plugin marketplace add <pkg>`
     (`:729`, first `[ ]` of the rule-9 chain). Port: `:1357`.
113. `plugin marketplace add <pkg>` precedes `plugin remove
     superpowers@superpowers-manager` (`:729`, second `[ ]`). Port: `:1357`.
114. `plugin remove superpowers@superpowers-manager` precedes `plugin add
     superpowers@superpowers-manager` (`:729`, third `[ ]`). Port: `:1357`.
115. The Codex log never names `openai-curated` (`:734-736`). Port: `:1368`.
     Non-vacuous via items 112-114.

### Scenario 10 — invalid refresh mode (`:738-745`)

116. Install fails (`:744`, `expect_fail`). Port: `:1387`.
117. No Codex mutation (`:745`). Port: `:1393`.

### Scenario 11 — install remediates malformed generated provenance (`:747-768`)

118. Stdout contains `prepared v1.0.0` (`:756`). Port: `:1418`. `v1.0.0` is
     the tag the fixture creates for itself (`lifecycle-fixture.js:116-125`),
     an input this test owns — not a version whose source of truth lives
     elsewhere.
119. Stdout contains `manager updated` (`:757`). Port: `:1420`.
120. The adapter log holds `install --package-root <pkg>` (`:758`). Port:
     `:1235`.
    **Pointer stale, deliberately not remapped.** PR 11.5 slice 3.5
    re-anchored this assertion onto `codex.log`, so the adapter-log line
    this item describes is no longer asserted anywhere and no line number
    can honestly stand in for it. Re-deriving the claim and its pointer
    together is a re-disposition, not a pointer fix.
121. The regenerated provenance carries a `commit` that is a string of
     exactly 40 hex digits (`:759-768`, rule 10). Port: `:1435`, helper at
     `:385`.

### Scenario 12 — update takes the same remediation path (`:770-780`)

122. Stdout contains `prepared v1.0.0` (`:778`). Port: `:1455`.
123. Stdout contains `manager updated` (`:779`). Port: `:1457`.
124. The adapter log holds `install --package-root <pkg>` (`:780`). Port:
     `:1261`.
    **Pointer stale, deliberately not remapped.** PR 11.5 slice 3.5
    re-anchored this assertion onto `codex.log`, so the adapter-log line
    this item describes is no longer asserted anywhere and no line number
    can honestly stand in for it. Re-deriving the claim and its pointer
    together is a re-disposition, not a pointer fix.

<!-- inventory:mapped:end -->

## Preconditions the shell established by scenario ordering

The shell driver established several preconditions implicitly, through the
state one scenario left behind for the next. Per-case isolation destroys that
inheritance silently, so each is reconstructed explicitly. Recorded here
because a case that passes for a different reason than the original is exactly
the defect this migration exists to eliminate.

- **A valid generated tree in `$pkg`.** The teardown at `:420-423` stripped
  the package root back to a bare `plugin.template.json`; the fresh install at
  `:495` put a valid generated tree back, and nothing removed it again. Every
  scenario from `:519` to `:745` therefore reached the subject with that tree
  present. The port rebuilds it with `prepareGeneratedTree(c)` (`:210`).
  Measured on this fixture: a fresh case probes `needs prepare`, after
  `prepareGeneratedTree` it probes `needs install`, and after
  `seedInstalledCurrent` as well it probes `current`.
- **The `current` branch.** Scenarios 1b (`:519`), 1c (`:538`), 3b (`:591`),
  and 3c (`:607`) add `seed_installed_current` on top of that tree. Ports at
  `:799`, `:831`, `:935`, and `:961`. In the port, 1b and 1c pin the branch
  with `assertNoPrepareRan` (`:907`, `:942`); 3b is pinned by ported item 79,
  since `manager is current` is printed only by `scripts/update:20`. 3c cannot
  be pinned from its output — `scripts/update:11` rejects the mixed identity
  state before the status `case` is reached — so its `current` precondition
  rests on the same construction 3b proves live.
- **Empty logs.** `reset` (`:233-234`) truncated `codex.log` and `adapter.log`
  before each scenario, so a scenario's logs held only its own subject's
  calls. `prepareGeneratedTree` runs *inside* the case here, so `clearLogs(c)`
  (`:276`) restores that. Not cosmetic: without it, prepare's own
  `build --upstream-root` adapter line sits in the log item 84 reads, and item
  84 fails. Verified by removing the call and observing exactly that failure.
- **No generated tree.** Scenario 1 (`:493`) is the one case in this range
  that must *not* have the tree, because item 57 is a claim about the subject
  generating it. Its port omits `prepareGeneratedTree` deliberately.
- **A tree to corrupt.** Scenarios 11 and 12 overwrite the provenance with `{`
  in a package root that already carried a full generated tree, so the
  remediation exercises `spw_replace_generated_tree`'s replace-an-existing-
  tree path (`scripts/core/lifecycle.sh:7-26`). The ports call
  `prepareGeneratedTree(c)` before corrupting, preserving that.

**Fixture-precondition assertions are excluded from both counts.** The
`assert` calls inside `prepareGeneratedTree` (`:212`, `:219`, `:223`) and
`seedInstalledCurrent` (`:123`) verify that the fixture reached the state the
shell inherited. They are claims about the harness, not about the subject,
and follow `uninstall-commands.md:72-82`'s treatment of `command -v`
resolution.

## Port-only assertions (outside the 1:1 mapping)

Items 6, 16, 23, 24, 26, 28, 29, 30, 37, 39, and 40 are the additive pattern
`bin-dispatch.md` records: the shell left the exit status implicit under
`set -e`, and the port asserts it explicitly.

Items 1-5, 7, 9, 11-15, 18, 20-22, 31-36, and 38 are non-vacuity guards with
no shell analogue. The shell's `$log` and `$state/adapter.log` were files the
fakes appended to before doing anything else, so `grep` over them could not
silently degrade; `readLog` returns `[]` for a missing file, so a negative
over an empty log would pass whether or not the property holds.

Items 8, 10, 17, 19, 25, and 27 are `assertNoPrepareRan` precondition guards,
described in the section above.

Item 41 extends the shell's install-path provenance check to the update path.

Item 42 (Task 9, PR 11.5 slice 4b, 2026-08-11) has no shell original at all:
the shell had no in-process subject whose non-spawning could be guarded, so
there is nothing for it to be additive, non-vacuous, or channel-changed
*relative to*. It is row 18's consumer — see `tests/bin/lifecycle-fakes.js`'s
`tripwireTriggered` and its callers in `tests/bin/install-fakes.js`.

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

1. `assertLegacyIdentityStops` adapter-log non-vacuity guard (`:435`) at the
   `legacy` call site (`:762`).
2. The same guard at the `both` call site (`:774`).
3. `assertNoCodexMutation` emptiness guard (`:179`), reached through the
   helper at `:445`, at the `legacy` call site (`:762`).
4. The same guard at the `both` call site (`:774`).
5. `scripts/` held at least one file, so the source scan proved something
   (`:489`).
6. Prepare exits 0 (`:538`; shell `:325` left it implicit).
7. The adapter log holds `build --upstream-root`, hoisting items 13-14 above
   an empty log (`:543`).
8. `assertNoPrepareRan` at the unsupported-update-fast-path case (`:585`).
9. `assertNoCodexMutation` emptiness guard at `:599`.
10. `assertNoPrepareRan` at the unsupported-direct-install case (`:616`).
11. `assertNoCodexMutation` emptiness guard at `:618`.
12. `assertNoCodexMutation` emptiness guard at `:636`.
13. `assertNoCodexMutation` emptiness guard at `:653`.
14. The build line exists at all (`:689`); the shell's `[ "$build_line" -lt
    … ]` would have errored on an empty extraction rather than said so.
15. `assertNoCodexMutation` emptiness guard at `:695`.
16. Install exits 0 on the needs-install path (`:709`; shell `:398`).
17. `assertNoPrepareRan` at the needs-install case (`:711`).
18. The adapter install line exists at all (`:719`).
19. `assertNoPrepareRan` at the fresh-gate case (`:748`).
20. `assertNoCodexMutation` emptiness guard at `:752`.
21. `assertNoCodexMutation` emptiness guard at `:802`.
22. `assertNoCodexMutation` emptiness guard at `:824`.
23. Install exits 0 in scenario 1 (`:852`; shell `:495`).
24. Install exits 0 in scenario 1b (`:901`; shell `:522`).
25. `assertNoPrepareRan` at scenario 1b (`:907`).
26. Install exits 0 in scenario 1c (`:940`; shell `:541`).
27. `assertNoPrepareRan` at scenario 1c (`:942`).
28. Install exits 0 in scenario 2 (`:975`; shell `:560`).
29. Install exits 0 in scenario 3 (`:1015`; shell `:574`).
30. Update exits 0 in scenario 3b (`:1049`; shell `:593`).
31. `nonEmpty` adapter-log guard in scenario 3b (`:946`), hoisting item 80.
    **Stale, deliberately not remapped.** The `nonEmpty` adapter-log guard
    no longer exists: slice 3.5's re-anchoring of scenario 3b deleted it
    along with the negative it hoisted above an empty log.
32. `assertNoCodexMutation` emptiness guard at `:1066`.
33. Adapter ownership non-vacuity guard in scenario 3c (`:1098`), hoisting
    item 84.
34. `assertNoCodexMutation` emptiness guard at `:1108`.
35. `nonEmpty` Codex-log guard in scenario 4 (`:1137`), hoisting item 89.
36. `nonEmpty` Codex-log guard in scenario 5 (`:1163`), hoisting item 91.
37. Install exits 0 in scenario 9 (`:1354`; shell `:724`).
38. `assertNoCodexMutation` emptiness guard at `:1393`.
39. Install exits 0 in scenario 11 (`:1415`; shell `:755`).
40. Update exits 0 in scenario 12 (`:1453`; shell `:777`).
41. The regenerated provenance carries a 40-hex `commit` after the **update**
    remediation path (`:1470`). The shell ran this check only for install
    (`:759-768`); update reaches the same remediation through
    `scripts/update:22-25`, so the same claim is asserted there.
42. `adapterSeam: "tripwire"` armed on a fresh install: the subject's own exit
    status is 0, the fake adapter's log holds no line at all, and a direct
    spawn of that same case's fake adapter is then refused with exit 94 and
    the tripwire's own message, leaving in the log the one line the emptiness
    check demanded be absent (`:1609`, within `:1609-1639`). Appended at the
    end of the file rather than beside the fresh-install case it is
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

Task 8's sweep, run 2026-08-03. Design Decision 5: **inject the violation into
the fixture, not into the assertion**, then observe which assertions turn RED.
A guard that stays GREEN under an injection that genuinely violates it is not
proven — it is a boundary guard, and it is adjudicated below rather than
"proved" by breaking its own text.

**Historical as of Task 6 (PR 11.5 slice 4b, 2026-08-10).** Everything below
this line describes the tree as it stood before Task 6 converted the seam-
dependent cases and retired two of them: "32/32 GREEN" below is what the
suite reported THEN, against 32 cases; the file now has 30. None of the
injections below still target the fixture mechanism they describe for the
cases Task 6 converted (`INSTALL_DEFAULTS.spuriousMutation`, the
`updateControl`/`fingerprintInspect` config surface reached through
SPW_ADAPTER interception, and the `update-control-count` sidecar file) —
those cases now inject through a double's own handler instead, and re-running
this exact matrix against the current tree is not proposed here. Retained
because it is the record of the mutation-testing pass that certified the
PRE-Task-6 port, and later readers auditing that certification need to know
what it certified and when.

Every mutation was applied to a tracked file, run with
`node --test tests/bin/install-commands.test.js`, observed, then restored by
**editing the file back** (never `git checkout --`). `git diff --stat` was
empty and the suite re-ran 32/32 GREEN after every restore. No assertion text
in `tests/bin/install-commands.test.js` was changed except at the ordering
sites (rows O1-O3), which the subject alone controls and which therefore have
no fixture-side lever.

Two rows edit `tests/bin/install-commands.test.js` without touching an
assertion, and are called out so no reader mistakes them for manufactured
REDs. Row 14 short-circuits `prepareGeneratedTree` (`:224`), a
fixture-precondition helper, to model a lost precondition — the same technique
the "Preconditions" section above used for `clearLogs`. Rows O1-O3 are the
ordering exception.

**Restore discipline within a family.** Rows 1-1e share one injection point
(the `spuriousMutation` block in `runCodex`) and were run as a family with
`INSTALL_DEFAULTS.spuriousMutation` held at `true` throughout, changing only
the payload string between runs; each run therefore also re-verifies that the
previous payload's sites returned GREEN, and a full 32/32 GREEN verification
followed the family's restore. Row 13a produced no RED, so it was converted
in place into row 13b rather than restored and re-verified between the two.
Every other row was restored and re-verified GREEN on its own.

The task brief names eight injections. That list is the floor: rows 1b-1e, 4,
5, 6, 10, 13b, 14, and 15 were derived from this inventory's own negative and
port-only assertion sets, and they carry items and guards the brief's eight do
not reach. Rows 8, 13a, 1c, 5 and 14 diverge from the brief's prediction
table; each divergence is recorded under "Divergences" below, because a
divergence is the finding, not noise.

**Case abbreviations** below are the port's `test(` order: c1 source guards,
c2 packaged-root, c3 prepare, c4 unsupported-update-fast-path,
c5 unsupported-direct-install, c6 malformed-update-control,
c7 failed-update-control, c8 needs-prepare-drift, c9 needs-install,
c10 fresh-gate, c11 legacy-identity, c12 mixed-identity,
c13 built-in-validation, c14 additional-validator, c15 fresh-install,
c16 current-reconciled, c17 matching-fingerprint-other-root,
c18 symlink-same-root, c19 different-registered-root, c20 update-read-only,
c21 update-rejects-mixed, c22 marketplace-add-fails,
c23 malformed-marketplace-listing, c24 plugin-add-noop, c25 stale-fingerprint,
c26 missing-fingerprint-hint, c27 fingerprint-inspect-fails,
c28 fingerprint-inspect-malformed, c29 remove-add, c30 invalid-refresh-mode,
c31 install-remediation, c32 update-remediation.

**The brief's case numbering is not this one.** It merges c11 and c12 (they
share one helper) into a single case, so from c13 onward its numbers run one
lower: its "case 21" is c22, its "cases 23, 25" are c24 and c26, its "case 24"
is c25, its "cases 26, 27" are c27 and c28, and its "cases 14, 23" are c15 and
c24. Its "cases 3, 8, 9, 10" match c3, c8, c9, c10 directly.

### Injection matrix

| Row | Injection (file, exact edit) | Observed RED — item @ port line |
|---|---|---|
| 1 | `lifecycle-config.js`: `INSTALL_DEFAULTS.spuriousMutation` `false` → `true`, forcing `plugin add superpowers@spurious` into every Codex call's log | items 19 (`:599`), 21 (`:618`), 24 (`:636`), 27 (`:653`), 32 (`:695`), 38 (`:752`), 44 (`:445` via `:762`), 50 (`:445` via `:774`), 53 (`:802`), 56 (`:824`), 81 (`:1066`), 85 (`:1108`), 117 (`:1393`) — all 13 `assertNoCodexMutation` sites — plus item 91 (`:1164`); 14/32 cases |
| 1b | payload → `plugin marketplace remove openai-curated` | row 1's 14 sites, plus items 62 (`:876`), 72 (`:988`), 77 (`:1028`), 115 (`:1368`) |
| 1c | payload → `plugin remove superpowers@superpowers-manager` | row 1's 14 sites, plus items 63 (`:880`), 74 (`:993`), 78 (`:1032`), and c29's `assertOrder` (`:1357`) as an injection artifact — see Divergences |
| 1d | payload → `plugin marketplace add /spurious-root` | row 1's 14 sites, plus item 71 (`:984`) |
| 1e | payload → `plugin marketplace list openai-curated`, which matches neither `CODEX_MUTATION` nor `PARSE_ABORT_MUTATION` | items 64 (`:884`) and 115 (`:1368`), and nothing else |
| 2 | `install-fakes.js` `runAdapter`: extra `log("adapter.log", "install --package-root /spurious")` on every adapter call | items 14 (`:550`), 43 (`:439` via `:762`), 49 (`:439` via `:774`), 80 (`:947`, stale — see its entry), 84 (`:1102`) — **item 80's entry is historical: slice 3.5 re-anchored scenario 3b onto `codex.log`, so this row records an observation HEAD's assertions cannot produce** |
| 3 | `install-fakes.js` `runAdapter`: `if (joined.startsWith("build ")) log("adapter.log", "inspect --view update-control")` | item 13 (`:545`), and only that |
| 4 | `install-fakes.js` `runAdapter`: extra `log("codex.log", "plugin list --json")` on every adapter call | item 15 (`:557`), and only that |
| 5 | `install-fakes.js`: `log("adapter.log", ARGS.join(" "))` deleted from `runAdapter` | port-only 1 (`:435` via `:762`), 2 (`:435` via `:774`), 7 (`:543`), 14 (`:689`), 18 (`:719`), 31 (`:357` via `:946`, stale — see its entry), 33 (`:1098`); items 65 (`:812`), 68 (`:844`), 120 (`:1235`), 124 (`:1261`) — **all four stale, see their entries** |
| 6 | `install-fakes.js`: `log("codex.log", ARGS.join(" "))` deleted from `runCodex` | port-only 3, 4, 9, 11, 12, 13, 15, 20, 21, 22, 32, 34, 38 — all 13 `assertNoCodexMutation` emptiness guards, at `:445` (×2), `:599`, `:618`, `:636`, `:653`, `:695`, `:752`, `:802`, `:824`, `:1066`, `:1108`, `:1393` — plus port-only 35 (`:1137`), 36 (`:1163`), item 73 (`:979`), and all five `assertOrder` sites (`:861`, `:914`, `:947`, `:1018`, `:1357`) on "needle never appears" |
| 7 | `install-fakes.js` `runAdapter`: the observable `update-control-count` frozen at `1` while the real count moves to a shadow file, so the `managed-then-unsupported` flip is unchanged and only the counter stops advancing | items 30 (`:680`), 33 (`:713`), 37 (`:750`) |
| 8 | `install-fakes.js` `runAdapter`: the codex-home existence condition dropped from the fingerprint intercept | item 109 (`:1330`) in c28 only — see Divergences |
| 9 | `install-fakes.js` `runCodex`: the `marketplaceAdd === "fail"` branch's `process.exit(1)` → `process.exit(0)`, so the add reports success without registering | item 86 (`:1127`), c22 only |
| 10 | `install-fakes.js` `runCodex`: the `marketplaceAdd === "fail"` branch logs `plugin add superpowers@superpowers-manager` before exiting 1, modelling a subject that proceeds past the failure | item 89 (`:1138`), and only that |
| 11 | `install-fakes.js` `runCodex`: `if (CONFIG.pluginAdd === "noop") process.exit(0);` deleted, so a `noop` add really refreshes | items 92 (`:1183`), 100 (`:1242`) |
| 12 | `install-fakes.js` `runCodex`: the `pluginAdd === "stale"` branch condition → `"stale-disabled"`, so the real commit is written | item 96 (`:1212`) |
| 13a | `install-fakes.js` `runAdapter`: writes `spw-sidecar-leak` into `$TMPDIR` | **none — 32/32 GREEN.** See Divergences |
| 13b | same, into `$TMPDIR/..` (the invocation TMPDIR the subject was handed) | items 61 (`:339` via `:873`), 94 (`:339` via `:1191`) — both `assertTmpEmpty` ports |
| 14 | `install-commands.test.js`: `prepareGeneratedTree` (`:224`) short-circuited to a no-op, so the generated-tree precondition is lost at all of its call sites | port-only 8 (`:585`), 10 (`:616`), 17 (`:711`), 19 (`:748`), 25 (`:907`), 27 (`:942`) — all six `assertNoPrepareRan` guards — plus item 79 (`:1054`). The injection added one line, so the runner reported each of these one higher; the numbers here are against the restored file |
| 15 | `lifecycle-fixture.js` `buildSnapshot` (`:46-65`): `scripts/adapters/codex/validate-generated-plugin.py` planted in the snapshot every per-case package root is copied from (`:225`) | item 12 (`:519`), and only that |
| O1 | first adjacent needle pair swapped at each of the five `assertOrder` sites, plus `buildLine < secondControlLine` → `>` and `lastOwnership < lastControl` → `>` | items 31 (`:690`), 34 (`:720`), 58 (`:861`), 66 (`:914`), 69 (`:947`), 75 (`:1018`), 112 (`:1357`) |
| O2 | second adjacent pair swapped at the same five sites, plus `lastControl < installLine` → `>` | items 35 (`:724`), 59 (`:861`), 67 (`:914`), 70 (`:947`), 76 (`:1018`), 113 (`:1357`) |
| O3 | third adjacent pair swapped at the four-needle site | item 114 (`:1357`) |
| P1 | no tracked file touched: a `node` probe applied the source-guard and packaged-root predicates to the real file contents and to in-memory regression copies | predicates `true` on the real inputs, `false` on every regression copy — see adjudication D |

Row 1's `plugin add superpowers@spurious` payload deliberately names no real
fixture resource, so it can only be caught by a guard that rejects *any*
Codex mutation; rows 1b-1e reuse that single injection point with
resource-specific payloads to isolate the resource-specific negatives. Row 2's
`install --package-root /spurious` follows the same discipline on the adapter
side: it lies inside the class `ADAPTER_MUTATION` names (`^install `) while
matching none of the exact-line positives, which is what makes its RED set
exactly those five items.

**The eight ordering sites, reconciled with the brief.** The brief names
"cases 8, 9 (two assertions), 14, 16, 18, 28, and the build-before-second-inspect
check". There are exactly eight ordering *sites* in the port — c8's one
comparison, c9's two, and five `assertOrder` calls — carrying fourteen
inventory *items*, because rule 9 maps two or three ordering claims onto each
`assertOrder`. The brief's enumeration names c8 and "the
build-before-second-inspect check" as separate entries although they are the
same site, and omits the `assertOrder` in c16. Rows O1-O3 mutate all eight
sites and turn all fourteen items RED.

**Why O1 and O2 batch across cases.** Each row mutates several sites at once,
but never two sites in the same case, so `node:test` reports each mutation as
its own case failure at its own port line — the same attribution a
one-site-at-a-time sweep would produce. Batching two sites into one case would
have shadowed the second, and was not done.

### Divergences from the brief's prediction table

**Row 13a — predicted RED at every `assert_install_tmp_empty` port; observed
32/32 GREEN.** `scripts/install:38-45` creates its workspace under the
inherited `TMPDIR`, installs a removal trap on it (`:42`), and then
*re-exports* `TMPDIR` to point at that workspace; `scripts/prepare:35-36` and
`scripts/probe:22-23` do the same for their own workspaces. An adapter sidecar
written to `$TMPDIR` therefore lands inside a workspace the subject itself
sweeps up. Row 13b — writing to `$TMPDIR/..`, which is the invocation TMPDIR
`runScript` handed the subject — is RED at both ports. Consequence for what
items 61 and 94 claim: they assert the *invocation* TMPDIR is left empty,
which catches a leaked workspace or a sidecar dropped beside it. They do
**not** assert that the adapter created no temporary files at all. That is
narrower than the brief assumed, it is narrower again than the per-case
narrowing already recorded at `:256-264`, and forward pointers are carried at
both items. Identical in mechanism to `uninstall-commands.md:564-576`.

**Row 8 — predicted RED at the brief's cases 26 and 27 (c27 and c28); observed
RED only in c28, and at a positive rather than a negative.** Dropping the
codex-home condition makes the fingerprint intercept fire at
`scripts/probe:33` — before any install — instead of at
`spw_verify_installed_fingerprint`. In c28 (`fingerprintInspect: "malformed"`)
the subject then dies with a bare `error: invalid adapter response: Expecting
property name enclosed in double quotes: line 1 column 2 (char 1)`, which
carries no fingerprint context, so item 108 (`invalid adapter response`,
`:1328`) stayed GREEN and item 109 (`fingerprint inspection`, `:1330`) went
RED. That is the fake's own comment (`install-fakes.js:270-273`) proved live.

**Superseded for c27 by the slice-3.5 re-base — kept because it is the finding
that motivated the fix, not because it still describes the tree.** The
`fingerprintInspect: "fail"` fixture this paragraph analyses no longer exists;
c27 is now driven from the fake Codex by `pluginAdd: "orphan"` and asserts a
subject-owned line. See item 104 for the current disposition. What follows is
the observation as recorded at the time.

c27 (`fingerprintInspect: "fail"`) stayed GREEN, and an out-of-band probe —
one case reproduced outside the suite, touching no tracked file — shows why.
Its whole captured output under the injection is:

```
Note: remove or disable conflicting Superpowers providers yourself before relying on manager skills.
fingerprint inspection failed in adapter fixture
error: invalid adapter response: Expecting value: line 1 column 1 (char 0)
```

The only text carrying item 104's needle is the **fixture's own stderr line**,
not the subject's diagnostic. `grep -rn 'fingerprint inspection' scripts/ src/`
returns exactly two sites, `scripts/core/lifecycle.sh:92` and `:96`, both
inside `spw_verify_installed_fingerprint` — so in the baseline the needle has
two possible sources and item 104 cannot tell them apart. **Item 104 was
therefore narrower than it read**: it proved the string appeared, not that the
subject produced it. Recorded here at the time as faithful-to-the-shell; slice
3.5 subsequently removed the ambiguity at its source rather than living with
it, by re-basing the case onto a lower lever and asserting the whole
subject-owned line. Items 103, 105 and 106 were unaffected then, and item 106's
non-vacuity rationale was strengthened by the re-base.

**Row 1c — an injection artifact, recorded so it is not read as evidence.**
The payload `plugin remove superpowers@superpowers-manager` is itself one of
c29's `assertOrder` needles, so `firstIndex` found the injected line at index 1
and the call failed "out of order" at `:1357`. That RED says nothing about
item 113, which is proven by row O2 instead.

No other row's payload collides with a needle **in a way that perturbs
first-occurrence order**. One benign collision exists and is named here so the
reader is not relying on a broader claim than was checked: row 1e's payload
`plugin marketplace list openai-curated` contains the needle
`plugin marketplace list` used by the `assertOrder` calls at `:861`, `:914`,
and `:1357`. It is harmless because the injected line is appended on *every*
Codex call, starting with probe's `plugin list --json`, so `firstIndex`
(`lifecycle-fixture.js:317-319`) resolves that needle *earlier* than the real
`plugin marketplace list` line rather than later, and every following needle
still comes after it — the pairwise check at `lifecycle-fixture.js:356-362` is
unaffected. Row 1e
produced no RED at any of the three sites, which is the observed confirmation.

**Row 5 — the hoisted non-vacuity guards shadowed the negatives they protect,
which is them working.** Items 13 and 14 (prepare's adapter-log negatives)
stayed GREEN because port-only 7 (`:543`) fires six lines earlier; items 80 and
84 stayed GREEN behind port-only 31 (`:946`, stale — see its entry) and 33
(`:1098`). Each of those
four negatives is proven independently by rows 2 and 3.

**Row 14 — two findings beyond the six guards it was aimed at.** Item 79
(`:1054`, `manager is current`) also turned RED, confirming live the claim at
`:450-457` that item 79 doubles as scenario 3b's precondition pin. And c21
(scenario 3c) stayed GREEN under the same lost precondition, confirming the
same passage's statement that 3c's `current` precondition *cannot* be pinned
from its output — `scripts/update:11` rejects the mixed identity state before
the status `case` is reached, so nothing in 3c's output distinguishes the
branch it took.

**Row 6 — a property worth stating.** Beyond the emptiness guards, all five
`assertOrder` sites turned RED on `"…" never appears in the log`, which is
`assertOrder`'s missing-needle-is-an-error contract
(`lifecycle-fixture.js:346-363`) exercised for real. An `assertOrder` call can
therefore not pass on a log that never carried its needles.

**Rows 9, 11 and 12 matched their predictions** (the brief's cases 21; 23 and
25; and 24 respectively), landing on each case's exit-status assertion.
**Rows 1, 7 and 13b matched exactly.**

### Adjudication: guards no injection turned RED

Each entry records **(1)** why the violation is unreachable at that point in
that scenario and **(2)** what future change would make it reachable. This
two-part form is introduced here; `bin-dispatch.md:27-36` is the
counting-decision adjudication it generalises.

**A — items 95 (`:1194`), 99 (`:1224`), 106 (`:1302`) and 111 (`:1336`),
"output does not contain `manager updated`".** *(1)* Structurally shadowed by
each case's own exit-status assertion. `scripts/core/lifecycle.sh:102` prints
the banner and `:103` immediately `return 0`s, and `scripts/install:57-59`
exits 1 only when that function returns non-zero — so when the **subject**
prints `manager updated`, it is exiting 0. Every config toggle that makes the
subject print the banner therefore makes `status === 0` too, and each of the
four cases asserts `status !== 0` first: row 11 drove c24 and c26 RED at items
92 and 100, and row 12 drove c25 RED at item 96, in each instance shadowing
the banner negative.

A fixture-side lever nevertheless exists, and adjudication C's disposition
applies here too: a fake writing `manager updated` to **stderr** would turn all
four RED while `status !== 0` still holds, because each case asserts over
`result.stdout + result.stderr` (`:1181`, `:1210`, `:1279`, `:1320`) and
fixture stderr reaches that capture — the retired `fingerprintInspect: "fail"`
branch in `install-fakes.js` was the same mechanism row 8 exercised, and the
lever survives its removal because any fixture write to stderr reaches the
capture. That manufacture is deliberately not performed,
because it would prove only that a fixture can print the banner, not that the
subject reported success while failing. *(2)* Reachable, by the subject rather
than a fixture, exactly when the coupling breaks: if the banner moved above the
fingerprint-match test at `lifecycle.sh:101-104`, or were emitted from an
`EXIT` trap, or `scripts/install` grew a step after `:57-59` that can fail.
That is a real regression class the exit-status assertions do not catch, which
is why all four negatives are kept rather than folded into items 92, 96, 100
and 104.

**B — item 18 (`:594`), "output does not contain `manager is current`".**
*(1)* Same coupling, on the update side. `scripts/update:17-21` runs
`spw_require_managed_update_control` *before* `echo "manager is current"`, and
the `current)` branch has no step after the echo that can fail — so when the
**subject** prints the banner it is exiting 0, which item 16 (`:582`) asserts
against and would report first. Under c4's `updateControl: "unsupported"` the
gate rejects before the echo; under any toggle that lets the gate pass, item 16
fires. The same declined fixture lever as in adjudication A applies here: c4
asserts over `result.stdout + result.stderr` (`:580`), so a fake writing
`manager is current` to stderr would turn item 18 RED without proving anything
about the subject. *(2)*
Reachable if the echo moved above `spw_require_managed_update_control`, if the
banner were emitted from a trap, or if a failing step were added after it.
Item 17 (`:587`) already proves `out` carries the subject's diagnostics, so
item 18 is not vacuous — only shadowed.

**C — items 105 (`:1298`) and 110 (`:1332`), "output does not contain
`fingerprint is not detectable`".** *(1)* The two states are mutually
exclusive in the subject. `spw_verify_installed_fingerprint` returns at
`lifecycle.sh:92` when the inspection fails and at `:96` when its result
cannot be parsed; the `not detectable` message at `:118` is reachable only
after a *successful* inspection that yielded an empty fingerprint. The
`fingerprintInspect` config surface offers exactly `ok | malformed` since the
slice-3.5 re-base retired `fail`, and `malformed` lands on the early return at
`:92`, so no value of it can produce both. The re-based c27 reaches the same
early return from a real `inspect-failed` envelope, so the disposition is
unchanged by the re-base. A fixture *could* be made to emit the failure diagnostic on
stderr and a valid empty-fingerprint envelope on stdout at once, which would
turn item 105 RED — that manufacture is deliberately not performed, because it
would prove only that the fixture can print two contradictory things, not that
the subject reported unverifiable state as absence. *(2)* Reachable when the
subject can reach `:117` after a failed or unparseable inspection — for
example if the early returns at `:92`/`:96` became warnings, or if a future
adapter reported inspection failure inside an `ok: true` envelope with an
empty `fingerprint`. Either change satisfies every earlier assertion in c27
and c28 and is caught only by items 105 and 110.

**D — items 1-6 (`:469`, `:475`, `:483`) and port-only 5 (`:489`), the
source-tree guards.** *(1)* Their subject is the repository's own `scripts/`
tree, read from `ROOT` at `:455` — **not** a per-case package root. There is no
fixture in the path for these six items: the only mutation that violates any of
them is an edit to the production tree, which this task is scoped out of. Row
P1 therefore probed the predicates without touching a tracked file, applying
them in memory to the real contents of `scripts/install` and to regression
copies. Results: each of the four forbidden literals is absent from the real
file (`true`) and detected in a copy carrying it (`false`); the `app-server`
line predicate is `true` on the real file, `false` on a copy with a bare
`codex app-server` line, and `true` again on a copy where that line is
commented — so the comment exemption at `:484` is live rather than an accident.
Item 1's catch branch was probed separately: `readFileSync` on a mode-`000`
scratch file does throw, so the `assert.fail` at `:469` is live code and not
dead — no file in `scripts/` is unreadable today, which is why the scan never
enters it. Port-only 5 (`scanned > 0`) is unreachable while `scripts/` holds
any file. *(2)* Reachable the moment someone lands the corresponding edit for
real: adding one of the four hook-trust literals to a production script,
invoking `codex app-server` outside a comment, making a script in `scripts/`
unreadable, or emptying `scripts/` entirely. Two caveats worth recording:
`grep -rn app-server scripts/` returns nothing today, so item 6's *positive*
half (a commented mention staying legal) is exercised only by row P1's probe,
never by real content; and the recursive scan reads whatever `scripts/`
contains at run time, so it needs no maintenance when files are added.

**Item 12 is deliberately not adjudicated here.** Unlike items 1-6 it reads
`c.pkg` (`:512`, `:519-524`), a fixture-built snapshot
(`lifecycle-fixture.js:218-223`, copied from `buildSnapshot` at `:44-63`), so
it does have a fixture lever. Row 15 pulls it: planting
`scripts/adapters/codex/validate-generated-plugin.py` in the snapshot turns
item 12 RED at `:519` and nothing else. It is a proven guard, not a boundary
guard.

### Coverage ledger

**Classes covered by this pass:** every negative, ordering, and cardinality
assertion in the mapped inventory (64 of the 124 items), and 29 of the 41
port-only assertions — every non-vacuity guard (port-only 1-5, 7, 9, 11-15, 18,
20-22, 31-36, 38, the set named at `:494-498`) and every `assertNoPrepareRan`
precondition guard (port-only 8, 10, 17, 19, 25, 27).

**Not classified:** the remaining 60 mapped items, which are positives, and the
twelve exit-status and provenance port-only positives — port-only 6, 16, 23,
24, 26, 28, 29, 30, 37, 39, 40, 41. No claim is made about either class. Eleven
mapped positives did turn RED incidentally (items 65, 68, 73, 79, 86, 92, 96,
100, 109, 120, 124), which is recorded as observation, not as coverage.

Proven RED by injection: items 12, 13, 14, 15, 19, 21, 24, 27, 30, 31, 32, 33,
34, 35, 37, 38, 43, 44, 49, 50, 53, 56, 58, 59, 61, 62, 63, 64, 66, 67, 69, 70,
71, 72, 74, 75, 76, 77, 78, 80, 81, 84, 85, 89, 91, 94, 112, 113, 114, 115, 117,
and port-only 1, 2, 3, 4, 7, 8, 9, 10, 11, 12, 13, 14, 15, 17, 18, 19, 20, 21,
22, 25, 27, 31, 32, 33, 34, 35, 36, 38.

Adjudicated GREEN with both required parts: items 1, 2, 3, 4, 5, 6, 18, 95, 99,
105, 106, 110, 111, and port-only 5.

No RED in this section was produced by editing an assertion's text outside rows
O1-O3.

**Prior observation, retained.** One targeted observation was made while
writing the port, and justifies a structural choice rather than an assertion:
removing `clearLogs(c)` from the scenario-3c port turns item 84 RED with
`build --upstream-root …` as the sole offender, confirming that the log
truncation `reset` performed is load-bearing and not decorative.

## Cardinality

```json inventory
{
  "shellOriginal": 124,
  "portOnly": 42,
  "ports": { "tests/bin/install-commands.test.js": 31 }
}
```

- Shell original: **124** assertions (6 source guards, 6 packaged-root
  preconditions, 3 prepare, 4 unsupported-update-fast-path, 2
  unsupported-direct-install, 3 malformed-update-control, 3
  failed-update-control, 5 needs-prepare-drift, 3 needs-install, 3
  fresh-gate, 12 legacy/mixed identity, 3 built-in-validation, 3
  additional-validator, 8 scenario 1, 3 scenario 1b, 3 scenario 1c, 4
  scenario 2, 4 scenario 3, 3 scenario 3b, 4 scenario 3c, 4 scenario 4, 2
  scenario 5, 4 scenario 6, 4 scenario 7, 3 scenario 8, 4 scenario 8a, 5
  scenario 8b, 4 scenario 9, 2 scenario 10, 4 scenario 11, 3 scenario 12;
  sum: 6+6+3+4+2+3+3+5+3+3+12+3+3+8+3+3+4+4+3+4+4+2+4+4+3+4+5+4+2+4+3 = 124).
  Unchanged by Task 6: this is a fact about the deleted shell file, not about
  the port.
- Port (`tests/bin/install-commands.test.js`): **31** static `test(` call
  sites as of Task 9 (PR 11.5 slice 4b, 2026-08-11; was 32 before Task 6, then
  30, now 31), counted with `migration-inventory.test.js`'s own `stripInert` +
  `/(?<![A-Za-z0-9_$.])test\(/g` method rather than a naive grep. Task 6's drop
  of two was the two retirements below, each deleting its case's `test(` call
  site outright rather than converting it. Task 9 added exactly one call
  site — the row-18 tripwire case, port-only item 42 — and no other task
  between them added or removed one. No remaining call site is data-driven,
  so the 31 static sites produce 31 runtime cases. The `for legacy_state in
  legacy both` loop at `:426` is still expanded into two explicit call sites
  (`:950`, `:959`) sharing one helper.
- Reconciliation: **116 of 124** shell items retain a port counterpart; the
  remaining **8** are retired at the gap, each recorded at its own entry
  above with its reasoning rather than renumbered away — items 22-24
  ("Malformed update-control output exits exactly 1") and items 107-111
  ("Scenario 8b — malformed fingerprint inspection output"). Both retired
  cases shared the same root cause: their fixture drove the FAKE ADAPTER
  PROCESS to emit non-JSON bytes across a process boundary that no longer
  exists once `ctx.adapter` is an in-process function call returning an
  already-typed `AdapterResult`. Numbers are never reused — the mapped region
  below still runs `1..124` with no gap and no duplicate, and each retired
  item's own entry states plainly that it has no port counterpart, rather
  than being silently dropped from the list.

  Of the 116 that survive, the mapping is **not** 1:1 throughout. **103**
  items map onto a port assertion of their own; the remaining **13 share 6**,
  across six merges recorded inline. One is a status merge — items 25/26
  collapse onto one `assert.equal(status, 1)`, since `=== 1` implies `!== 0`.
  (Items 22/23 were a seventh merge of exactly that kind before Task 6. Both
  numbers are retired with their case, so that merge leaves the count
  entirely rather than staying in it as a moot entry — the arithmetic here is
  over surviving items only.) Five are rule-9 ordering guards — items 58-59,
  66-67, 69-70, 75-76, and 112-114 — each collapsing onto one `assertOrder`
  call, which asserts every one of those ordering claims plus the presence
  of each needle. Two orderings differ from the shell: items 71-73 and items
  62-64 assert the positive claim before the negatives that depend on it.

  **How to reproduce these three figures**, since the gate does not read this
  prose and an earlier revision of this paragraph was wrong by three: retired
  = the items whose entry says "No port counterpart" (22, 23, 24, 107, 108,
  109, 110, 111 — **8**), so retained = 124 − 8 = **116**; shared = the
  merges enumerated in the previous paragraph (25/26 plus the five rule-9
  guards = **13** items over **6** merges), so own = 116 − 13 = **103**.
  Items that share only a static line because the port loops over a literal
  tuple (2-5 at one `assert.ok`, 7-8, 9-11) are **not** merges — counting
  rule 4 makes each iteration its own assertion — and are counted in the 103.
  So are the three SUBSUMED items (44, 50, 85), which are retained because
  the claim survives inside a sibling item's structural assertion, not
  because each has a private line; the SUBSUMED note below is the detail.

  Several items changed **channel**, not **behaviour** — a distinction
  worth stating explicitly, per Task 6's own instruction, because a reader
  who cannot tell the two apart cannot audit the slice. Every item in the
  "Prepare is capability-independent" (13-15), "Unsupported update control…"
  (16-21), "Failed update-control inspection…" (25-27), "A needs-prepare
  install reinspects…" (28-32), "The needs-install path…" (33-35), "The
  fresh gate…" (36-38), "Legacy and mixed identity state…" (39-50), and
  "Scenario 3c…" (82-85) sections now asserts a structural claim over an
  injected recording adapter's own recorded calls (Task 6, D4,
  `tests/bin/command-context.js`) rather than a `readLog(c.adapterLog)` read
  — each section's own note above states which channel it moved to and why
  no behavioural change accompanies it. Four items (44, 50, 85, and item
  15's Codex-emptiness half) are SUBSUMED rather than separately witnessed
  in-process: there is no `codex.log` at all when the whole command is
  called directly with a double, so a claim that used to be witnessed twice
  (once at the adapter level, once at the Codex level) is now witnessed once,
  structurally, and the second witness is recorded as subsumed rather than
  silently dropped.

  Two fidelity notes carried over from before Task 6 are unaffected by it:
  items 61 and 94 carry a **narrowed TMPDIR scope** forced by per-case
  isolation, and item 81 **drops the shell's empty-log escape hatch**,
  making the claim strictly stronger. Neither changes the count. The 42
  port-only assertions (41 before Task 9, plus item 42's tripwire case) are
  strictly additive and are excluded from the 124-item accounting above.
