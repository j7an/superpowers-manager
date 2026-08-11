# Migration inventory: tests/test_bin_dispatch.sh

Source read in full (224 lines). Ported to `tests/bin/bin-dispatch.test.js`.

No behavior ID in `docs/baseline/traceability.md` references
`test_bin_dispatch` (confirmed by `grep -c '^\| *\`' docs/baseline/traceability.md`
returning 121 with zero `test_bin_dispatch` hits). This inventory, not the
121-ID count, is the evidence that no assertion was dropped.

## Counting rules applied

- Each `[ ... ] || { echo …; exit 1; }` guard is one assertion.
- Each `grep -Fq` / `grep -Fqx` is one assertion, including bare ones relied
  on by `set -e`.
- Each `if <command>; then echo …; exit 1; fi` negative guard is one
  assertion.
- A `for` loop over N commands performing one assertion each contributes N.
- The `command -v node` precondition at `:9` is one assertion.
- Extending the bare-`grep` rule by the same logic: a bare `[ ... ]` test with
  no `|| { ... }` handler, relied on by `set -e` exactly like a bare `grep`,
  is counted the same way — one assertion each. Five such bare `[ ... ]`
  tests exist: `:122`, `:128`, `:198`, `:203`, `:220`. Without this extension
  the stray-flag, `--help`, probe-missing-codex, install-missing-codex, and
  missing-script groups below would each be one assertion short, and the
  total would not reach 53.

**Precondition adjudication.** The `command -v node` guard at `:9` checks that
the *test harness* can run at all — it is not a claim about
`bin/superpowers-manager.js`'s behavior, since every other line in the file
already requires a working `node` to execute. `container-contract.md` counts
its 6 comparable preconditions as assertions, and following that precedent
keeps this inventory's counting rule uniform across the corpus rather than
carving out a file-specific exception. Decision: **included**, as item 1.
Both readings, for the record: **53** including it, **52** excluding it. The
port has no direct JS counterpart for this item — the guarantee is structural
(a `node:test` file only runs under `node`), not a runtime assertion.

**Marker legend.** An item may carry one bold prefix marker recording what
became of it. The names are spelled without their asterisks below, on purpose:
`tests/bin/migration-inventory.test.js` counts real markers across the whole
file and cross-checks them against this file's own stated counts, so a legend
that wrote them in bold would inflate those counts and make the check lie.

Mapped region — the shell original's assertions, numbered `1..shellOriginal`:

- `Retired` — the shell condition can no longer occur in either direction after
  an in-process flip, so no JS assertion enforces it. The note names the
  analogous surviving property and where it is now tested. Counted, and
  cross-checked against this file's stated count.
- `Merged` — the shell assertion is carried by a JS assertion that another item
  also maps to, rather than one of its own. Counted the same way.
- `Index updated` — the item still maps to a fixture-table row; only that row's
  index moved. Not counted.

Port-only region — additive JS assertions that map no shell item, numbered
`1..portOnly` and excluded from the reconciliation arithmetic:

- `New` — an assertion with no shell counterpart of any kind.
- `Relocated` — the same assertion survives, moved from a loop iteration into a
  standalone case.
- `Updated` — the assertion survives in place with a changed derivation.
- `Dropped` — the assertion itself is gone with no successor, and the entry
  records why. Deliberately *not* the mapped region's retirement marker: these
  were never shell assertions, so their removal changes no reconciliation
  arithmetic, and marking them retired would corrupt the retirement count the
  gate checks. No gate enforces this marker.

## Assertion inventory

<!-- inventory:mapped:start -->

### Precondition (`:9`)

1. `command -v node` succeeds before any other line runs. No JS counterpart
   (see adjudication above) — structurally guaranteed by running under
   `node --test`.

### An unbuilt checkout gets only the actionable build diagnostic (`:44-52`)

2. Exit status is `1` when `dist/cli.js` is absent (`:46-50`). Port:
   `tests/bin/bin-dispatch.test.js:26`.
3. Stderr contains the literal
   `` dist/ not built — run `pnpm install --frozen-lockfile && pnpm run build` ``
   (`:51-52`). Port: `:27-31`.

### A present module that fails during import keeps its real error (`:54-67`)

4. Exit status is non-zero when `dist/cli.js` throws on import (`:58-62`).
   Port: `:42`.
5. Stderr contains the literal `synthetic dist import failure` (`:63`). Port:
   `:43`.
6. Stderr does **not** contain `dist/ not built` — a real import failure must
   not be mislabeled as an unbuilt checkout (`:64-67`, `if grep ...; then
   echo ...; exit 1; fi`). Port: `:44-47`.

### Routing: each subcommand reaches its script with its args (`:71-103`)

7. `probe --porcelain` → logs `probe --porcelain ref=` (`:73-74`). **Retired**
   (PR 11.5 slice 2, Task 6): `probe` flipped to an in-process command
   (`src/cli.ts` `DISPATCH.probe`), so it never invokes `scripts/probe` and
   never logs to the dispatch log — the condition this item asserted can no
   longer occur, in either direction. `probe` was removed from
   `ROUTING_CASES`. Unlike items 9, 10, and 11, no standalone in-process case
   replaces it *in this port file*: `runDispatch`'s tool stubs are `exit 0`
   one-liners, and a `codex` that answers nothing is exactly what the
   in-process probe fails closed on, so "succeeds without ever reaching its
   script" is not writable through this fixture. The analogous property is
   covered end to end by `tests/baseline/probe.test.js` (see
   `tests/migration-inventory/probe.md`) and, at the routing level, by
   `tests/baseline/cli-parity.test.js`'s `CLI-COMMANDS-01`, whose in-process
   branch asserts `probe` succeeds and dispatches nothing.
8. `prepare --ref test` → logs `prepare --ref test ref=` (`:76-78`).
   **Retired** (PR 11.5 slice 3.4): `prepare` flipped to an in-process command
   (`src/cli.ts` `DISPATCH.prepare`), so it never invokes `scripts/prepare`
   and never logs to the dispatch log — the condition this item asserted can
   no longer occur, in either direction. `prepare` was removed from
   `ROUTING_CASES`; the analogous in-process property ("never reaches its
   script") is covered by `tests/bin/bin-dispatch.test.js:86` and recorded as
   port-only item 44. Unlike items 9, 10, and 11, the replacement case asserts
   no exit status: this fixture's `git` is an `exit 0` stub and its package
   root carries no upstream to clone or manifest template to build against, so
   `prepare` cannot succeed here and the routing property is all that survives
   — see port-only item 3.
9. `pin v6.1.1` → logs `pin v6.1.1 ref=` (`:80-82`). **Retired** (PR 11.5,
    Task 7): `pin` flipped to an in-process command (`src/cli.ts`
    `DISPATCH.pin`), so it never invokes `scripts/pin` and never logs to the
    dispatch log — the condition this item asserted can no longer occur, in
    either direction. `pin` was removed from `ROUTING_CASES`; the analogous
    in-process property ("succeeds without ever reaching its script") is
    covered by `tests/bin/bin-dispatch.test.js:123` (**re-derived from the
    file** at PR 11.5 slice 3.4; this read `:97`, which was `unpin`'s log
    assertion, not `pin`'s, and slice 3.4's new `prepare` case then shifted
    even that by 14 lines) and recorded as port-only
    item 37, since it is a different property than "reaches its script with
    its args". Unlike items 10 and 11 below, `pin`'s standalone case needs a
    real, resolvable local upstream to succeed — see
    `tests/bin/dispatch-fixture.js`'s `pinUpstream` option on `runDispatch`.
10. `track-latest` → logs `track-latest  ref=` (`:84-86`). **Retired** (PR
    11.5, Task 6): `track-latest` flipped to an in-process command
    (`src/cli.ts` `DISPATCH["track-latest"]`), so it never invokes
    `scripts/track-latest` and never logs to the dispatch log — the
    condition this item asserted can no longer occur, in either direction.
    `track-latest` was removed from `ROUTING_CASES`; the analogous
    in-process property ("succeeds without ever reaching its script") is
    covered by `tests/bin/bin-dispatch.test.js:81` and recorded as port-only
    item 27, since it is a different property than "reaches its script with
    its args".
11. `unpin` → logs `unpin  ref=` (`:88-90`). **Retired** (PR 11.5): `unpin`
    flipped to an in-process command (`src/cli.ts` `DISPATCH.unpin`), so it
    never invokes `scripts/unpin` and never logs to the dispatch log — the
    condition this item asserted can no longer occur, in either direction.
    `unpin` was removed from `ROUTING_CASES`; the analogous in-process
    property ("succeeds without ever reaching its script") is covered by
    `tests/bin/bin-dispatch.test.js:111` (**re-derived from the file** at
    PR 11.5 slice 3.4; this read `:89`, which was `track-latest`'s log
    assertion rather than `unpin`'s — the earlier "moved from `:81` when Task 6
    added `track-latest`'s own standalone case immediately above it" note
    advanced the citation by one case too few — and slice 3.4's new `prepare`
    case then shifted the correct line to `:111`) and recorded
    as port-only item 21, since it is a different property than "reaches its
    script with its args".
12. `install --dry-run` → logs `install --dry-run ref=` (`:92-94`).
    **Retired** (PR 11.5 slice 4b, Task 8): `install` flipped to an in-process
    command (`src/cli.ts` `DISPATCH.install`), so it never invokes
    `scripts/install` and never logs to the dispatch log — the condition this
    item asserted can no longer occur, in either direction. It was
    `ROUTING_CASES`'s first surviving entry; with items 13 and 14 leaving in
    the same commit the table emptied and it, its loop, and port-only item 1's
    length guard were deleted outright rather than left with zero iterations
    (the reasoning slice 3.4 applied to `NO_CODEX_CASES`). The analogous
    in-process property ("runs without ever reaching its script") is covered by
    `tests/bin/bin-dispatch.test.js`'s `` `install` runs in-process and
    dispatches nothing `` and recorded as port-only item 57. Like item 8, and
    unlike items 9, 10 and 11, the replacement case asserts no exit status:
    this fixture's tool stubs are `exit 0` one-liners and its package root has
    no upstream to clone, so `install` cannot succeed here.
13. `uninstall --purge` → logs `uninstall --purge ref=` (`:96-98`).
    **Retired** (PR 11.5 slice 4b, Task 8), same cause and same shape as item
    12. The analogous in-process property is covered by
    `` `uninstall` runs in-process and dispatches nothing `` and recorded as
    port-only item 58.
14. A bare invocation routes to `update` → logs `update  ref=` (`:101-103`).
    **Retired** (PR 11.5 slice 4b, Task 8), same cause as item 12. The
    surviving half — a bare invocation is still `update`, and it reaches no
    script — is covered by
    `` a bare invocation routes to `update`, in-process, dispatching nothing ``
    and recorded as port-only item 59. The "is still `update`" half is not
    observable through this fixture once nothing dispatches; it is asserted
    end to end by `tests/baseline/cli-parity.test.js`'s
    `CLI-MODE-DEFAULT-01`, which compares a bare invocation against an
    explicit `update` invocation in the same sandbox.

Each of items 7-14 is one `grep -Fqx` in the shell. The port's per-case
`assert.equal(result.status, 0)` had no shell counterpart (the shell
never explicitly checked routing's exit status — see port-only entries 2-9)
and was not counted here.

### An unknown subcommand fails with usage and dispatches nothing (`:105-114`)

15. Running `bogus` must not succeed (`:107-109`, `if run_bin bogus; then
    echo ...; exit 1; fi`). **Merged** into the port's single
    `assert.equal(result.status, 2)` at `:113`, which is strictly stronger
    (equal to 2 implies not equal to 0) and therefore subsumes this guard —
    no separate JS assertion exists for it.
16. Exit status is `2` for the unknown subcommand `bogus` (`:110-111`). Port:
    `:113`.
17. Stderr contains `unknown subcommand: bogus` (`:112`). Port: `:114`.
18. Stderr contains `usage:` (`:113`). Port: `:115`.
19. The dispatch log is empty — nothing was dispatched (`:114`). Port: `:116`.

### A stray flag must not fall through to update (`:116-122`)

20. Exit status is `2` for the stray flag `--porcelain` (`:118-119`). Port:
    `:123`.
21. Stderr contains `unknown subcommand: --porcelain` (`:120`). Port: `:124`.
22. Stderr contains `usage:` (`:121`). Port: `:125`.
23. The dispatch log is empty (`:122`, bare `[ ! -s "$log" ]`). Port: `:126`.

### `--help` and `--version` (`:124-136`)

24. Exit status is `0` for `--help` (`:125-126`). Port: `:133`.
25. Stdout contains `usage:` for `--help` (`:127`). Port: `:134`.
26. Stderr is empty for `--help` (`:128`, bare `[ ! -s "$tmpdir/help-err" ]`).
    Port: `:135`.
27. `--version` prints exactly `9.9.9-test` (`:129-130`). Port: `:141`.
28. `--version` through a symlinked bin (as npm/npx invoke bins) prints
    exactly `9.9.9-test` (`:133-136`). Port: `:151`.

### Exit-code propagation (`:138-145`)

29. A script's exit code (`42`) propagates unchanged through `probe`
    (`:144-145`). The port's vehicle had already moved from `probe` to
    `install` (PR 11.5 slice 2, Task 6), the property under test being that a
    spawned child's status reaches the caller unchanged. **Retired** (PR 11.5
    slice 4b, Task 8): with the last spawned command flipped, the CLI starts no
    child for any command, so there is no child status to propagate and the
    condition cannot occur in either direction. There is no successor of the
    same kind — `main` exits with the value its in-process handler returns,
    which is a property of each handler rather than of dispatch, and is
    asserted per command by
    `tests/unit/commands-{install,update,uninstall}.test.js`. The
    `scripts` option on `runDispatch` that this case used survives with no
    consumer.

### Env passthrough (`:147-154`)

30. `SUPERPOWERS_REF=abc123` reaches the dispatched script: log line
    `update  ref=abc123` (`:153`). **Retired** (PR 11.5 slice 4b, Task 8) —
    see item 31. The merge these two items used to share is gone with them.
31. `SUPERPOWERS_VALIDATOR=/tmp/custom-validator.py` reaches the dispatched
    script: log line `update validator=/tmp/custom-validator.py` (`:154`).
    **Retired** (PR 11.5 slice 4b, Task 8). Items 30-31 were two separate
    `grep -Fqx` calls in the shell that the port asserted in one
    `assert.deepEqual` over the two-line log array. `update` is in-process now,
    so no environment is handed to a child of the manager at all: the command
    reads `ctx.env`, which is `process.env` itself. "Passthrough to the
    dispatched script" therefore has no referent, in either direction. The
    surviving half — that a `SUPERPOWERS_*` variable actually changes what a
    command does — is carried by the two `prepare` cases in this file
    (`SUPERPOWERS_VALIDATOR` flipping preflight's `python3` requirement,
    port-only items 47-51), and, for the full ten-variable set against the one
    child the manager still spawns, by
    `tests/baseline/cli-parity.test.js`'s `CLI-ENV-01`.

### Preflight: missing git fails before any dispatch, names the tool (`:156-162`)

32. Exit status is `1` when `git` is absent from `PATH` (`:160`). Port:
    `:191`.
33. Stderr contains `required command not found: git` (`:161`). Port:
    `:192`.
34. The dispatch log is empty — preflight failure must not dispatch (`:162`).
    Port: `:193`.

### Invalid pin syntax precedes preflight (`:164-172`)

35. Exit status is `2` for `pin main` (an invalid ref) (`:168`). Port:
    `:222`.
36. Stderr contains
    `pin REF must be an exact v-prefixed SemVer tag or full 40-hex commit`
    (`:169-170`). Port: `:223-227`.
37. The dispatch log is empty — an invalid pin ref must not dispatch
    (`:171`). Port: `:228`.

### Commands that need no git (`:174-178`)

38. `track-latest` dispatches with `git` absent from `PATH` (loop iteration
    1). **Retired** (PR 11.5, Task 6): `track-latest` is now in-process and
    never logs to the dispatch log, so "dispatches ... and logs
    `track-latest  ref=`" can no longer occur. `track-latest` was removed
    from `NO_GIT_CASES`; the analogous in-process property ("succeeds with
    `git` absent") is covered by `tests/bin/bin-dispatch.test.js:252` and
    recorded as port-only item 28.
39. `unpin` dispatches with `git` absent from `PATH` (loop iteration 2).
    **Retired** (PR 11.5): `unpin` is now in-process and never logs to the
    dispatch log, so "dispatches ... and logs `unpin  ref=`" can no longer
    occur. `unpin` was removed from `NO_GIT_CASES`; the analogous in-process
    property ("succeeds with `git` absent") is covered by
    `tests/bin/bin-dispatch.test.js:261` (moved from `:217` when Task 6 added
    `track-latest`'s own standalone case immediately above it) and recorded
    as port-only item 22.
40. `uninstall` dispatches with `git` absent from `PATH` (loop iteration 3).
    **Retired** (PR 11.5 slice 4b, Task 8): `uninstall` is now in-process and
    never logs to the dispatch log, so "dispatches ... and logs
    `uninstall  ref=`" can no longer occur. It was `NO_GIT_CASES`'s last
    entry, so the table and its `for` loop were deleted outright rather than
    left with zero iterations — the same treatment `NO_CODEX_CASES` got at
    slice 3.4. The property this item actually protected (preflight does not
    require `git` for `uninstall`) is covered by
    `` `uninstall` runs in-process with git absent from PATH `` and recorded
    as port-only items 60-61. Like item 51's replacement, and unlike items 38
    and 39's, that case asserts no exit status: the `exit 0` `codex` stub
    answers no listing, so `runUninstall` fails closed on it.

### Missing python does not block unpin (`:181-186`)

41. `unpin` dispatches with `python3` absent from `PATH` (`:182-185`).
    **Retired** (PR 11.5): `unpin` is now in-process and never logs to the
    dispatch log, so "dispatches ... and logs `unpin  ref=`" can no longer
    occur. The analogous in-process property ("succeeds with `python3`
    absent" — the property this item actually protects) is covered by
    `tests/bin/bin-dispatch.test.js:279` (moved from `:235`; see item 39's
    citation note) and recorded as port-only item 23. That test also gains a
    sibling covering `sh` absent (`tests/bin/bin-dispatch.test.js:288`, moved
    from `:244`, port-only items 25-26), a property the shell could never
    test at all: the shell driver itself required `sh` to run.

    `track-latest` has no analogous item here: unlike `unpin`, the shell's
    `scripts/track-latest` genuinely required `python3`
    (`spw_require_command python3`, `scripts/track-latest:11`), so no shell
    counterpart to "succeeds with `python3` absent" ever existed for it.
    Task 6's in-process flip makes that newly true; it is recorded as
    port-only items 30-31 (`tests/bin/bin-dispatch.test.js:306`), with no
    shell-side item to retire.

### codex required for probe and install (`:188-205`)

42. Exit status is `1` when `codex` is absent and `probe` is run (`:198`,
    bare `[ "$rc" -eq 1 ]`). Port: `:441`. Deliberately still carried by
    `probe` after PR 11.5 slice 2's in-process flip, unlike items 29's and
    the port-only backstop's vehicles: `COMMAND_REQUIREMENTS.probe` keeps
    `codex` (only `python3` left it), and preflight runs before dispatch
    either way, so this is the end-to-end net for that requirement row rather
    than a spawn vehicle.
43. Stderr contains `required command not found: codex` for `probe` (`:199`).
    Port: `:442`.
44. The dispatch log is empty — missing codex must not dispatch `probe`
    (`:200`). Port: `:443`. The per-case `scripts` override that mirrored the
    shell's `"probe ran"` stub was removed in PR 11.5 slice 2, Task 6: an
    in-process `probe` reaches no script, so a stub for one could never log
    and the override proved nothing. The shared `PACKAGE_ROOT`'s default
    `loggingStub` still logs unconditionally on invocation, so the assertion
    keeps its teeth exactly the way item 47's `install` case does.
45. Exit status is `1` when `codex` is absent and `install` is run (`:203`,
    bare `[ "$rc" -eq 1 ]`). Port: `:451`.
46. Stderr contains `required command not found: codex` for `install`
    (`:204`). Port: `:452`.
47. The dispatch log is empty — missing codex must not dispatch `install`
    (`:205`). Port: `:453`. The shell proves this with a `probe` override
    that logs unconditionally before its own logic runs (`:191-196`,
    `"probe ran"`), so "did not dispatch" is proven rather than assumed. The
    port's `install` case takes no `scripts` override and runs against the
    shared `PACKAGE_ROOT`'s default stub instead — but that default stub
    (`dispatch-fixture.js`'s `loggingStub`, `:139-154`) *also* logs
    unconditionally on invocation, before checking anything. That is what
    makes the assertion load-bearing here too: if `install` were mistakenly
    dispatched despite the missing-codex preflight, the default stub would
    still append to the log, and `assert.deepEqual(result.log, [])` at
    `:453` would catch it. It is sound; it is just less visually obvious
    than the shell's explicit override, because the "logs unconditionally"
    property comes from the shared fixture rather than from a per-case
    script. Since PR 11.5 slice 2 the port's `probe` case (item 44) rests on
    the same shared stub, for the reason recorded there.

### Commands that need no codex (`:207-215`)

48. `pin v6.1.1` dispatches with `codex` absent from `PATH` (`:208-209`,
    standalone, not part of the shell's `for` loop). **Retired** (PR 11.5,
    Task 7): `pin` flipped to an in-process command (`src/cli.ts`
    `DISPATCH.pin`), so it never invokes `scripts/pin` and never logs to the
    dispatch log — the condition this item asserted can no longer occur, in
    either direction. `pin` was removed from `NO_CODEX_CASES`; the analogous
    in-process property ("succeeds with `codex` absent") is covered by
    `tests/bin/bin-dispatch.test.js:416` and recorded as port-only item 38.
49. `track-latest` dispatches with `codex` absent from `PATH` (shell loop
    iteration 1). **Retired** (PR 11.5, Task 6): `track-latest` is now
    in-process and never logs to the dispatch log, so "dispatches ... and
    logs `track-latest  ref=`" can no longer occur. `track-latest` was
    removed from `NO_CODEX_CASES`; the analogous in-process property
    ("succeeds with `codex` absent") is covered by
    `tests/bin/bin-dispatch.test.js:401` and recorded as port-only item 29.
50. `unpin` dispatches with `codex` absent from `PATH` (shell loop iteration
    2). **Retired** (PR 11.5): `unpin` is now in-process and never logs to
    the dispatch log, so "dispatches ... and logs `unpin  ref=`" can no
    longer occur. `unpin` was removed from `NO_CODEX_CASES`; the analogous
    in-process property ("succeeds with `codex` absent") is covered by
    `tests/bin/bin-dispatch.test.js:410` (moved from `:303` when Task 6 added
    `track-latest`'s own standalone case immediately above it) and recorded
    as port-only item 24.
51. `prepare` dispatches with `codex` absent from `PATH` (shell loop
    iteration 3). **Retired** (PR 11.5 slice 3.4): `prepare` is now in-process
    and never logs to the dispatch log, so "dispatches ... and logs
    `prepare  ref=`" can no longer occur. `prepare` was `NO_CODEX_CASES`'s
    last entry, so the table and its `for` loop were deleted outright rather
    than left with zero iterations; the property this item actually protects
    (preflight does not require Codex for `prepare`) is covered by
    `tests/bin/bin-dispatch.test.js:497` and recorded as port-only items
    45-46. Like item 8, and unlike items 48, 49, and 50, the replacement case
    asserts no exit status — see item 8's retirement note for why `prepare`
    cannot succeed through this fixture.

The shell's standalone `pin` assertion (item 48) and its 3-iteration `for`
loop (items 49-51) were originally ported as one 4-case data-driven loop
(`NO_CODEX_CASES`). Slice 3.4 retired that table's last entry (item 51), so
the table and its loop are gone entirely and all four properties now live in
standalone in-process cases (item 48's, 49's, 50's, and 51's analogous
properties) — see each item's retirement/relocation note.

### Missing script file: diagnostic, non-zero exit (`:217-222`)

52. Exit status is `1` when `scripts/uninstall` is missing (`:220`, bare
    `[ "$rc" -eq 1 ]`). **Retired** (PR 11.5 slice 4b, Task 8) — see item 53.
53. Stderr contains `missing script` (`:221`). **Retired** (PR 11.5 slice 4b,
    Task 8). `main` no longer looks for a `scripts/<command>` file for any
    command: the `existsSync` check and the `error: missing script: <path>`
    diagnostic it guarded were deleted from `src/cli.ts` with the spawn path,
    so neither condition can occur in either direction. There is no successor
    — a missing command module is an ESM import failure at load, which
    `bin/superpowers-manager.js` reports through the two dist-integrity cases
    at the top of this file (items 2-6), not through a per-command existence
    check. The `missingScripts` option on `runDispatch` survives with no
    consumer, and goes in slice 4c with `scripts/` itself.

<!-- inventory:mapped:end -->

## Port-only assertions (outside the 1:1 mapping)

No item below maps a counted shell assertion, so nothing here participates in
the mapped region's reconciliation arithmetic. Most are additive: the shell
left the condition implicit under `set -e` (a bare `run_bin ... >/dev/null` or
`x=$(run_bin ...)` with no explicit exit-status test), so the shell would
already abort on failure, but no counted assertion (per the rules above)
asserted it, and the port makes it explicit. The region is no longer uniform
in shape, and has not been for several slices — read each entry, not this
preamble, for what it asserts:

- Most entries are an `assert.equal(result.status, 0)` the shell left implicit.
- Item 1 is a structural array-length guard with no shell analogue at all.
- Entries added for the in-process flips assert `result.log` is empty — a
  property the shell could not express, since it always dispatched and logged.
- Items 41-43 and 47-50 assert stderr text or a non-zero status: the in-process
  runtime backstop, `patchDispatch`'s no-op rejection, and `prepare`'s
  conditional `python3` requirement have no `status === 0` form.
- Items 3 and 20 assert nothing at all. They are records of an assertion
  removed, kept numbered so the removal is visible rather than silent.
- Items 53, 54, and 56 assert against the sentinel *file* the `gitSentinel`
  option creates, not against `result.status`/`result.log`/`result.stderr`:
  item 53 is `existsSync` on the path, item 54 is
  `readFileSync(...).trim().length`, and item 56 is `assert.match` over the
  file's contents. No shell analogue is possible — the shell had no
  equivalent of a fixture-side recording stub between it and `git`.

<!-- inventory:port-only:start -->

1. `ROUTING_CASES.length === SPAWN_COMMANDS.length` (`:70-74`), asserted once
   at module load, before any `test(` runs. Port-only — the shell has no
   array to check the length of; this guards against a routing case silently
   added to or removed from the fixture table without a matching update to
   this inventory's item count for 7-14, the same "silent deletion" failure
   mode `tests/bin/migration-inventory.test.js`'s own docstring names for
   `test(` call sites. **Updated** (PR 11.5 slice 2, Task 6): the expected
   length is no longer a literal. It is derived from
   `dispatch-fixture.js`'s `SPAWN_COMMANDS`, the subset of the production
   `DISPATCH` table still marked `"spawn"` — 4 entries once `probe` left
   (see item 7's retirement note), 3 once `prepare` left at slice 3.4 (see
   item 8's), and self-updating for the slice still to come. (Slice 1's
   Task 7 had already dropped the literal from 6 to 5 when
   `pin` was removed — see item 9's retirement note; its Task 6 from 7 to 6
   for `track-latest`, item 10; its Task 5 from 8 to 7 for `unpin`, item 11.)
   **Dropped** (PR 11.5 slice 4b, Task 8): `install`, `uninstall` and `update`
   left `ROUTING_CASES` in one commit (items 12-14), emptying the table, and
   `dispatch-fixture.js`'s `SPAWN_COMMANDS` — the production-derived subset
   this guard compared against — is permanently empty at 8/8 in-process and is
   deleted with it. `0 === 0` over two things that can never differ again is a
   guard that cannot fail, so it goes rather than staying green forever.
2. Routing case `probe --porcelain`: `result.status === 0` (`ROUTING_CASES[0]`
   as it then was). **Relocated** (PR 11.5 slice 2, Task 6): `probe` left
   `ROUTING_CASES` (see item 7's retirement note), and — unlike items 4, 5,
   and 6 — it did not get a standalone case in this port file, because this
   fixture's `exit 0` tool stubs cannot satisfy a command that actually reads
   Codex state. The same underlying property (`probe` succeeds and dispatches
   nothing) is asserted by `tests/baseline/cli-parity.test.js`'s
   `CLI-COMMANDS-01` in-process branch, against a `codex` that answers the
   adapter's listing calls.
3. Routing case `prepare --ref test`: `result.status === 0` (as
   `ROUTING_CASES[0]`, latterly). **Dropped** (PR 11.5 slice 3.4), and
   deliberately not carried into `prepare`'s standalone in-process case at
   `tests/bin/bin-dispatch.test.js:86`: `prepare` really runs there, and this
   fixture gives it an `exit 0` `git` stub, no upstream to clone, and no
   manifest template, so it cannot succeed. Asserting a status here would
   pin an outcome the fixture cannot produce; the routing property item 8
   actually carried survives as port-only item 44. Being port-only, this
   entry was strictly additive coverage in the first place — nothing in the
   41/53 reconciliation below changes with it.
4. Routing case `pin v6.1.1`: `result.status === 0`. **Relocated** (PR 11.5,
   Task 7): `pin` left `ROUTING_CASES` (see item 9's retirement note) for its
   own standalone case, `tests/bin/bin-dispatch.test.js:103`. Same underlying
   property (`pin` succeeds); same rationale as item 2, just no longer a
   loop iteration — and, unlike items 5 and 6, it needs a real, resolvable
   local upstream rather than a bare dispatch stub (see
   `tests/bin/dispatch-fixture.js`'s `pinUpstream` option).
5. Routing case `track-latest`: `result.status === 0`. **Relocated** (PR
   11.5, Task 6): `track-latest` left `ROUTING_CASES` (see item 10's
   retirement note) for its own standalone case,
   `tests/bin/bin-dispatch.test.js:83`. Same underlying property
   (`track-latest` succeeds); same rationale as item 2, just no longer a
   loop iteration.
6. Routing case `unpin`: `result.status === 0`. **Relocated** (PR 11.5):
   `unpin` left `ROUTING_CASES` (see item 11's retirement note) for its own
   standalone case, `tests/bin/bin-dispatch.test.js:91` (moved from `:83`
   when Task 6 added `track-latest`'s own standalone case immediately
   above it). Same underlying property (`unpin` succeeds); same rationale
   as item 2, just no longer a loop iteration.
7. Routing case `install --dry-run`: `result.status === 0` (`ROUTING_CASES[0]`
   as it then was). **Dropped** (PR 11.5 slice 4b, Task 8), and deliberately
   not carried into `install`'s standalone in-process case: `install` really
   runs there, against `exit 0` tool stubs and a package root with no upstream
   to clone, so it cannot succeed. Asserting a status would pin an outcome the
   fixture cannot produce — item 3's reasoning for `prepare`, verbatim. The
   routing property item 12 carried survives as port-only item 57. Being
   port-only, this entry was strictly additive coverage, so the mapped
   reconciliation below is unaffected.
8. Routing case `uninstall --purge`: `result.status === 0` (`ROUTING_CASES[1]`
   as it then was). **Dropped** (PR 11.5 slice 4b, Task 8), same reasoning as
   item 7; the routing property item 13 carried survives as port-only item 58.
9. Routing case bare invocation (`update`): `result.status === 0`
   (`ROUTING_CASES[2]` as it then was). **Dropped** (PR 11.5 slice 4b, Task
   8), same reasoning as item 7; the routing property item 14 carried survives
   as port-only item 59.
10. `--version` (no symlink): `result.status === 0` (`tests/bin/bin-dispatch.test.js:140`,
    corrected from a stale `:120` citation that predated PR 11.5's in-process
    flips — citation predates PR 11.5, left as found until this correction).
    Port-only — the shell's `version_out=$(run_bin --version)` at `:129` has
    no explicit exit-status test (command substitution failure would trip
    `set -e` implicitly, but nothing at the counted-assertion granularity
    checks it).
11. `--version` through a symlink: `result.status === 0`
    (`tests/bin/bin-dispatch.test.js:150`, corrected from a stale `:130`
    citation — same pre-existing-citation history as item 10). Port-only —
    same rationale as item 10, for the shell's `:135` symlinked invocation.
12. Env passthrough: `result.status === 0`. Port-only — the shell's bare
    env-prefixed invocation at `:149-152` had no explicit exit-status test.
    **Dropped** (PR 11.5 slice 4b, Task 8) with the case it belonged to; see
    items 30-31's retirement note.
13. `NO_GIT_CASES` iteration `track-latest`: `result.status === 0`.
    **Relocated** (PR 11.5, Task 6): `track-latest` left `NO_GIT_CASES` (see
    item 38's retirement note) for its own standalone case,
    `tests/bin/bin-dispatch.test.js:257`. Same underlying property; same
    rationale as before, just no longer a loop iteration.
14. `unpin` succeeds with `git` absent: `result.status === 0`.
    **Relocated** (PR 11.5): `unpin` left `NO_GIT_CASES` (see item 39's
    retirement note) for its own standalone case,
    `tests/bin/bin-dispatch.test.js:266` (moved from `:228`-equivalent
    position when Task 6 added `track-latest`'s own standalone case
    immediately above it). Same underlying property; same rationale as
    item 13, just no longer a loop iteration.
15. `NO_GIT_CASES` iteration `uninstall`: `result.status === 0`. Port-only —
    the shell's `for` loop body at `:174-178` is a bare
    `run_bin "$cmd" >/dev/null` with no explicit exit-status test. **Dropped**
    (PR 11.5 slice 4b, Task 8), and deliberately not carried into
    `uninstall`'s standalone git-absent case, for item 7's reason: the
    `exit 0` `codex` stub answers no listing, so the in-process `uninstall`
    fails closed and no status is assertable. The property item 40 carried
    survives as port-only items 60-61.
16. `unpin` succeeds in-process with `python3` absent: `result.status === 0`
    (`:284`). **Relocated** (PR 11.5) from a bare `run_bin unpin >/dev/null`
    at shell `:184`; the property is unchanged ("succeeds with `python3`
    absent" — see item 41's retirement note) and only the JS site's shape
    changed, from checking dispatched log content to checking success
    directly.
17. `NO_CODEX_CASES` iteration `pin v6.1.1`: `result.status === 0`.
    **Relocated** (PR 11.5, Task 7): `pin` left `NO_CODEX_CASES` (see item
    48's retirement note) for its own standalone case,
    `tests/bin/bin-dispatch.test.js:422`. Port-only — the shell's standalone
    `run_bin pin v6.1.1 >/dev/null` at `:208` has no explicit exit-status
    test; same rationale as item 2, just no longer a loop iteration.
18. `NO_CODEX_CASES` iteration `track-latest`: `result.status === 0`.
    **Relocated** (PR 11.5, Task 6): `track-latest` left `NO_CODEX_CASES`
    (see item 49's retirement note) for its own standalone case,
    `tests/bin/bin-dispatch.test.js:406`. Same underlying property; same
    rationale as before, just no longer a loop iteration.
19. `unpin` succeeds with `codex` absent: `result.status === 0`.
    **Relocated** (PR 11.5): `unpin` left `NO_CODEX_CASES` (see item 50's
    retirement note) for its own standalone case,
    `tests/bin/bin-dispatch.test.js:412` (moved from `:305` when Task 6
    added `track-latest`'s own standalone case immediately above it). Same
    underlying property; same rationale as item 17, just no longer a loop
    iteration.
20. `NO_CODEX_CASES` iteration `prepare`: `result.status === 0` (as
    `NO_CODEX_CASES[0]`, latterly). **Dropped** (PR 11.5 slice 3.4), for the
    same reason as item 3 and deliberately not carried into `prepare`'s
    standalone codex-absent case at `tests/bin/bin-dispatch.test.js:497`:
    `prepare` really runs there and cannot succeed through this fixture. The
    property item 51 actually protected — preflight admits `prepare` without
    `codex` — survives as port-only items 45-46, asserted directly on the
    stderr and the dispatch log rather than through a status. `NO_CODEX_CASES`
    itself is gone with this entry.
21. **New** (PR 11.5). Routing case `unpin`: `result.log` is empty
    (`tests/bin/bin-dispatch.test.js:94`, moved from `:86` when Task 6 added
    `track-latest`'s own standalone case immediately above it). Port-only,
    with no shell counterpart of any kind: the shell's mechanism for this
    case always dispatched to `scripts/unpin` and logged something, so
    "successfully ran without ever dispatching" was not an expressible
    property. If routing regressed and dispatched `scripts/unpin` anyway,
    the shared `loggingStub` would append a line here, catching it.
22. **New** (PR 11.5). `unpin` with `git` absent: `result.log` is empty
    (`:267`, moved from `:223`-equivalent position). Port-only, same
    rationale as item 21.
23. **New** (PR 11.5). `unpin` with `python3` absent: `result.log` is empty
    (`:285`). Port-only, same rationale as item 21.
24. **New** (PR 11.5). `unpin` with `codex` absent: `result.log` is empty
    (`:413`, moved from `:306`-equivalent position). Port-only, same
    rationale as item 21.
25. **New** (PR 11.5). `unpin` succeeds with no POSIX shell on `PATH`:
    `result.status === 0` (`:294`). Port-only, with no shell counterpart of
    any kind: the shell driver itself required `sh` to execute at all, so
    "no POSIX shell on PATH" could never be exercised through it. Also newly
    *writable* through this fixture only after `dispatch-fixture.js` gained
    the `omitShell` opt-out (`sh` was previously symlinked onto every case's
    `PATH` unconditionally).
26. **New** (PR 11.5). `unpin` succeeds with no POSIX shell on `PATH`:
    `result.log` is empty (`:295`). Port-only, same rationale as items 21
    and 25.
27. **New** (PR 11.5, Task 6). Routing case `track-latest`: `result.log` is
    empty (`tests/bin/bin-dispatch.test.js:86`). Port-only, with no shell
    counterpart of any kind, same rationale as item 21: the shell always
    dispatched to `scripts/track-latest` and logged something for this case,
    so "successfully ran without ever dispatching" was not expressible
    through it.
28. **New** (PR 11.5, Task 6). `track-latest` with `git` absent: `result.log`
    is empty (`:258`). Port-only, same rationale as item 27.
29. **New** (PR 11.5, Task 6). `track-latest` with `codex` absent:
    `result.log` is empty (`:407`). Port-only, same rationale as item 27.
30. **New** (PR 11.5, Task 6). `track-latest` succeeds with `python3` and no
    POSIX shell on `PATH`: `result.status === 0` (`:312`). Port-only, with
    no shell counterpart of any kind: unlike `unpin`, the shell's
    `scripts/track-latest` genuinely required `python3`
    (`spw_require_command python3`, `scripts/track-latest:11`), so "succeeds
    with `python3` absent" was never true of the shell driver at all, let
    alone exercisable through it. Also newly writable for `sh` absent only
    after `dispatch-fixture.js` gained the `omitShell` opt-out, same as
    items 25-26.
31. **New** (PR 11.5, Task 6). `track-latest` succeeds with `python3` and no
    POSIX shell on `PATH`: `result.log` is empty (`:313`). Port-only, same
    rationale as item 30.
32. **New** (PR 11.5, Task 7). `pin` fails preflight when `git` is absent
    from `PATH`: `result.status === 1` (`tests/bin/bin-dispatch.test.js:208`).
    Port-only, with no shell counterpart of any kind: the shell's generic
    "missing git" driver (items 32-34 above) only ever exercised `install`,
    never `pin` specifically, and `pin`'s own preflight requirement changed
    in this same task (`COMMAND_REQUIREMENTS.pin` drops `python3` — see item
    35 below). This is the regression net for `git` staying required.
33. **New** (PR 11.5, Task 7). Same case: stderr contains
    `required command not found: git` (`:209`). Port-only, same rationale as
    item 32.
34. **New** (PR 11.5, Task 7). Same case: `result.log` is empty (`:210`).
    Port-only, same rationale as item 32.
35. **New** (PR 11.5, Task 7). `pin` succeeds in-process with `python3`
    absent from `PATH` while `codex` stays present: `result.status === 0`
    (`tests/bin/bin-dispatch.test.js:335`). Port-only, with no shell
    counterpart of any kind: the shell's `scripts/pin` genuinely required
    `python3` (`spw_require_command python3`, `scripts/pin:17`), so no shell
    counterpart to "succeeds with `python3` absent" ever existed for `pin`.
    Needs real git resolution to succeed — `pinUpstream: true` on
    `runDispatch` composes a real `git` and a real local upstream onto
    `fakeBin` alongside `tools`, rather than replacing `PATH` wholesale, so
    this case genuinely discriminates `python3`'s absence (`codex` stays
    listed in `tools`) instead of merely restating the routing case under a
    different name.
36. **New** (PR 11.5, Task 7). Same case: `result.log` is empty (`:336`).
    Port-only, same rationale as item 35.
37. **New** (PR 11.5, Task 7). Routing case `pin`: `result.log` is empty
    (`tests/bin/bin-dispatch.test.js:106`). Port-only, with no shell
    counterpart of any kind, same rationale as item 21: the shell always
    dispatched to `scripts/pin` and logged something for this case, so
    "successfully ran without ever dispatching" was not expressible through
    it.
38. **New** (PR 11.5, Task 7). `pin` succeeds in-process with `codex` absent
    from `PATH` while `python3` stays present: `result.log` is empty
    (`:423`). Port-only, same rationale as item 37; the corresponding
    `result.status === 0` check is item 17's relocation, not this item,
    since that property already existed in the shell (item 48). This case
    discriminates the same way item 35 does — `python3` stays listed in
    `tools` — rather than merely restating item 35 under a different name.
39. **New** (PR 11.5, Task 7). `pin` succeeds in-process with no POSIX shell
    on `PATH` while `python3` and `codex` both stay present:
    `result.status === 0` (`tests/bin/bin-dispatch.test.js:350`). Port-only,
    with no shell counterpart of any kind: the shell driver itself required
    `sh` to execute at all, matching items 25/30's rationale rather than any
    numbered shell item.
40. **New** (PR 11.5, Task 7). Same case: `result.log` is empty (`:351`).
    Port-only, same rationale as item 39.
41. **New** (PR 11.5 slice 2, Task 3). An in-process command with no
    registered handler fails closed: `result.status === 1`
    (`tests/bin/bin-dispatch.test.js:148`). Port-only, with no shell
    counterpart of any kind: the condition only exists because `src/cli.ts`'s
    `IN_PROCESS_HANDLERS` registry became exhaustiveness-checked in that
    task, making a `DISPATCH` entry without a registered handler a compile
    error through the real table. The case reaches the runtime backstop that
    remains for that guarantee by patching a case-local copy of the compiled
    `dist/cli.js`'s `DISPATCH` table (`dispatch-fixture.js`'s
    `dispatchOverride` option on `runDispatch`), never `src/cli.ts` itself.
    The command it patches is a vehicle and must be one `DISPATCH` still
    spawns; Task 6 re-pointed it by hand, from `probe` to `prepare`, when
    `probe` gained a registered handler and overriding an already-registered
    command stopped reaching the backstop at all. Slice 3.4's Task 3 replaced
    that hand-maintained literal with `vehicleCommand`
    (`tests/bin/dispatch-mode.js`), which derives the vehicle from the live
    table, so no future flip needs a manual re-point here again.
    **Dropped** (PR 11.5 slice 4b, Task 8, Step 5a): at 8/8 in-process there is
    no `"spawn"` mode literal for `patchDispatch` to rewrite, and it rejected a
    no-op override by design (item 43), so `dispatchOverride` could not
    construct the condition at all — `vehicleCommand` throws by design at
    exactly this moment, and `tests/bin/dispatch-mode.js` is deleted with its
    last consumer. The decision recorded for the backstop is option (b): the
    compile-time exhaustiveness of
    `IN_PROCESS_HANDLERS: Record<InProcessCommand, InProcessHandler>` is
    accepted as the whole protection, and `src/cli.ts`'s `!handler` guard stays
    as an unreachable, documented fail-closed backstop rather than being
    deleted. Reaching it now would require surgically deleting a key from a
    compiled registry, which asserts only that a hand-mutilated build reports
    rather than crashes.
42. **New** (PR 11.5 slice 2, Task 3). Same case: stderr is exactly
    `error: no in-process handler registered for: ${spawned}\n`, where
    `spawned` is item 41's derived vehicle command. Port-only, same rationale
    as item 41; the command named in that string was whatever `vehicleCommand`
    currently derived, not a literal to keep in sync by hand. **Dropped** (PR
    11.5 slice 4b, Task 8, Step 5a) with item 41.
43. **New** (PR 11.5 slice 3.4, Task 3). `dispatchOverride` rejects an
    override that changes nothing: `runDispatch` throws
    (`tests/bin/bin-dispatch.test.js:166-174`). Port-only, with no shell
    counterpart of any kind: the condition only exists because
    `dispatch-fixture.js`'s `patchDispatch` helper, introduced in slice 2's
    Task 3 (items 41-42), used to rewrite a `DISPATCH` entry to its own
    current value without complaint, so a stale `dispatchOverride` vehicle
    silently degraded into a no-op. That is not what happened to items
    41-42's own vehicle: a no-op override there still reaches an
    already-registered handler, so `result.status === 1` fails loudly, which
    is why Task 6 re-pointed it rather than leaving it stale. The precedent
    this guard actually answers to is `units.test.js`'s `buildSpawn` vehicle
    (Task 3, this slice) — a pure path computation with no path through
    `patchDispatch` at all — which kept passing silently while naming a
    command no longer spawned. This asserts the mechanism itself refuses a
    no-op, not just that one victim was re-pointed. **Dropped** (PR 11.5 slice
    4b, Task 8, Step 5a): with items 41-42 gone, this was `dispatchOverride`'s
    only remaining consumer and it is a test *of the fixture*, not of the
    subject. `dispatchOverride` and `patchDispatch` are deleted from
    `tests/bin/dispatch-fixture.js` with it — a fixture whose only remaining
    test is a test of itself is residue, not coverage.
44. **New** (PR 11.5 slice 3.4). Routing case `prepare`: `result.log` is empty
    (`tests/bin/bin-dispatch.test.js:95`). Port-only, with no shell
    counterpart of any kind, same rationale as item 21: the shell always
    dispatched to `scripts/prepare` and logged something for this case, so
    "ran without ever dispatching" was not expressible through it. This is
    the whole of what survives item 8 — the case asserts no status, for the
    reason recorded in item 3.
45. **New** (PR 11.5 slice 3.4). `prepare` with `codex` absent: stderr does
    not contain `required command not found: codex`
    (`tests/bin/bin-dispatch.test.js:503-506`). Port-only. The shell observed
    the same preflight fact indirectly, through a successful dispatch (item
    51); with no dispatch left to observe, the assertion moves onto the
    diagnostic preflight would have emitted, which is a direct statement of
    the property rather than a proxy for it.
46. **New** (PR 11.5 slice 3.4). Same case: `result.log` is empty (`:507`).
    Port-only, same rationale as item 21.
47. **New** (PR 11.5 slice 3.4). `prepare` does not require `python3` when no
    validator is configured: stderr does not contain
    `required command not found: python3`
    (`tests/bin/bin-dispatch.test.js:463-466`). Port-only, with no shell
    counterpart of any kind: the shell's `scripts/prepare` required `python3`
    unconditionally (`spw_require_command python3`, `scripts/prepare:38`), so
    "succeeds without `python3`" was never true of the shell driver. Slice
    3.4's flip makes `COMMAND_REQUIREMENTS.prepare` `["git"]` and moves
    `python3` behind `SUPERPOWERS_VALIDATOR`; this is the half of that
    conditional that must NOT fire.
48. **New** (PR 11.5 slice 3.4). `prepare` requires `python3` once
    `SUPERPOWERS_VALIDATOR` names one: `result.status === 1`
    (`tests/bin/bin-dispatch.test.js:476`). Port-only, same
    no-shell-counterpart rationale as item 47, and the half that must fire.
    Items 47-51 are the integration net for `commandRequirements(env)`:
    `tests/bin/units.test.js` unit-tests the accessor, but nothing else
    proves `preflight` reads it rather than the static table, and reverting
    it to the static table is invisible to every other case in this file
    because none configures a validator.
49. **New** (PR 11.5 slice 3.4). Same case: stderr is exactly
    `error: required command not found: python3 — install python3 and re-run`
    plus a newline (`tests/bin/bin-dispatch.test.js:477-480`). Port-only, same
    rationale as item 48. Exact rather than substring because the text is the
    contract: it must be preflight's own hand-written diagnostic, not a
    prepare-path failure that merely mentions `python3`.
50. **New** (PR 11.5 slice 3.4). Same case: `result.log` is empty (`:482`).
    Port-only, same rationale as item 21 — preflight completes before dispatch
    and before any Git or build effect.
51. **New** (PR 11.5 slice 3.4). Back on item 47's no-validator case:
    `result.log` is empty (`:467`). Port-only, same rationale as item 21. Item
    47's stderr check alone cannot distinguish "preflight admitted `prepare`
    without `python3`" from "preflight never ran a `python3` check because it
    dispatched instead"; this is the half that pins the second reading out,
    and it is the shape items 46 and 50 already give their own cases.
52. **New** (PR 11.5 slice 4a Task 7). Matrix row 13: `pinUpstream`'s `git`
    sits behind the same egress refusal `createSandbox` uses, instead of a
    symlink to a real, unfiltered `git`. `runDispatch({ pinUpstream: true,
    gitSentinel: true, ... })` against a network `SUPERPOWERS_UPSTREAM_URL`
    refuses before git runs: `result.stderr` matches the shim's refusal text
    (`tests/bin/bin-dispatch.test.js:554`). Port-only: no shell counterpart,
    since the shell driver never had a `pinUpstream` mode. Reverting the
    fixture to the old symlink does not fail this case through item 54's
    sentinel-emptiness check as might be expected — with the recording stub
    off `PATH`, `git` still runs, but against a real network target it fails
    with git's own DNS error rather than the shim's refusal text, so it is
    this item's `stderr` match that goes red under that mutation.
53. **New** (PR 11.5 slice 4a Task 7). Same case: the returned `gitSentinel`
    path — the log file a recording stub (wrapped by the shim in place of
    the real binary) appends every invocation to — was created (`:564`).
    Port-only, same rationale as item 52. Guards item 54 against reading a
    missing sentinel file as vacuously "empty".
54. **New** (PR 11.5 slice 4a Task 7). Same case: the sentinel file is empty
    (`:565-569`). Port-only, same rationale as item 52. The load-bearing
    check: an empty sentinel proves the refusal happened BEFORE anything
    reached git, not merely that the command failed — a non-zero status
    alone proves nothing, since a failing git produces one too.
55. **New** (PR 11.5 slice 4a Task 7). The positive control: the same
    fixture with no URL override (the fixture's local-path `PIN_UPSTREAM`
    default) succeeds, `result.status === 0` (`:580`). Port-only, same
    no-shell-counterpart rationale as item 52. Without this case, item 54's
    empty sentinel would be equally satisfied by a shim that refuses
    everything, which would break every real `pin` case while item 54 stayed
    green.
56. **New** (PR 11.5 slice 4a Task 7). Same case: the sentinel's contents
    match `/ls-remote|rev-parse|clone|tag/` (`:581-585`) — a deliberately
    loose matcher, so the entry pins that git ran at all rather than an argv
    detail. Port-only, same rationale as item 55. Proves the sentinel
    mechanism is non-vacuous, so item 54's empty sentinel means "refused",
    not "never wired". The alternation is slack, not a four-way choice the
    implementation makes: on this case's tag-ref path
    (`src/commands/pin.ts:50`) only `ls-remote` can land, from
    `resolveExactTag`'s single git call (`src/upstream.ts:209`), and `tag`
    matches merely as a substring of that call's `--tags`/`refs/tags/` argv.
57. **New** (PR 11.5 slice 4b, Task 8). `install` runs in-process:
    `result.log` is empty. Port-only, with no shell counterpart of any kind,
    same rationale as item 21: the shell always dispatched to
    `scripts/install` and logged something for this case, so "ran without ever
    dispatching" was not expressible through it. This is the whole of what
    survives item 12 — the case asserts no status, for the reason recorded in
    port-only item 7.
58. **New** (PR 11.5 slice 4b, Task 8). `uninstall` runs in-process:
    `result.log` is empty. Port-only, same rationale as item 57; the whole of
    what survives item 13.
59. **New** (PR 11.5 slice 4b, Task 8). A bare invocation runs in-process:
    `result.log` is empty. Port-only, same rationale as item 57; the whole of
    what survives item 14 *in this file*. That the bare invocation is
    specifically `update` is asserted elsewhere — see item 14's retirement
    note.
60. **New** (PR 11.5 slice 4b, Task 8). `uninstall` with `git` absent: stderr
    does not contain `required command not found: git`. Port-only. The shell
    observed the same preflight fact indirectly, through a successful dispatch
    (item 40); with no dispatch left to observe, the assertion moves onto the
    diagnostic preflight would have emitted — the same substitution item 45
    made for `prepare` and `codex`.
61. **New** (PR 11.5 slice 4b, Task 8). Same case: `result.log` is empty.
    Port-only, same rationale as item 21, and the half that distinguishes
    "preflight admitted `uninstall` without `git`" from "preflight never ran a
    `git` check because it dispatched instead" — exactly the pairing items
    45-46 and 47/51 already use.

<!-- inventory:port-only:end -->

## Cardinality

```json inventory
{
  "shellOriginal": 53,
  "portOnly": 61,
  "ports": { "tests/bin/bin-dispatch.test.js": 34 }
}
```

- Shell original: **53** assertions (1 precondition, 2 missing-dist, 3
  invalid-dist, 8 routing, 5 unknown-subcommand, 4 stray-flag, 3 `--help`, 1
  `--version`, 1 symlinked `--version`, 1 exit-code propagation, 2 env
  passthrough, 3 missing-git, 3 invalid-pin, 3 no-git loop, 1 no-python
  unpin, 3 probe-missing-codex, 3 install-missing-codex, 1
  pin-without-codex, 3 no-codex loop, 2 missing-script; sum:
  1+2+3+8+5+4+3+1+1+1+2+3+3+3+1+3+3+1+3+2 = 53). This count is historical —
  it describes the deleted shell script as it stood at the time it was
  ported — and does not change when the port's own structure changes.
- Port (`tests/bin/bin-dispatch.test.js`): 34 static `test(` call sites, none
  of them data-driven, so the 34 static sites produce 34 runtime cases. Every
  data-driven table this file ever had is now gone: `NO_CODEX_CASES` emptied at
  slice 3.4, and `ROUTING_CASES` and `NO_GIT_CASES` emptied at slice 4b's flip
  (Task 8) when `install`, `uninstall` and `update` went in-process — each
  deleted outright rather than left iterating over `[]`, which reports success
  without asserting anything. That same task removed four call sites and added
  four: out went the exit-code-propagation case (item 29), the env-passthrough
  case (items 30-31), the missing-script case (items 52-53), the
  unregistered-handler backstop and the `dispatchOverride` no-op case
  (port-only items 41-43); in came `install`, `uninstall` and bare-invocation
  in-process routing cases (port-only items 57-59) and `uninstall` with `git`
  absent (port-only items 60-61); net 37 − 6 + 3 = 34, the three
  loop-expansions having been runtime cases rather than call sites. The matrix
  row 13 regression case PR 11.5 slice 4a Task 7 added survives, its five
  assert calls being port-only items 52-56 — one entry per assertion, not one
  per case, matching items 32-34's precedent below. The 34 sites carry
  **32** of the 53 shell assertions
  mapped (**1** recorded merges:
  item 15 into the port's `status === 2` check), plus **21 retired items** (7,
  8, 9, 10, 11, 12, 13, 14, 29, 30, 31, 38, 39, 40, 41, 48, 49, 50, 51, 52, 53
  — items 7, 8, 9, 10, 12, 13, 14, 38, 40, and 49 each asserted that `probe`,
  `prepare`, `pin`, `track-latest`, `install`, `uninstall`, or `update`
  "dispatches ... and logs `<name>  ref=`"; items 11, 39, and 50 each asserted
  the analogous condition for `unpin`; item 48 asserted `pin` dispatches with
  `codex` absent and logs `pin v6.1.1 ref=`, and item 51 the same for
  `prepare`; item 41 asserted `unpin` dispatches with `python3` absent; items
  30-31 asserted that two `SUPERPOWERS_*` variables reach a dispatched script's
  environment; item 29 asserted a spawned child's exit status propagates
  unchanged; and items 52-53 asserted the diagnostic for a missing
  `scripts/<command>` file. PR 11.5's in-process flips (slice 1's Task 5 for
  `unpin`, Task 6 for `track-latest`, and Task 7 for `pin`; slice 2's Task 6
  for `probe`; slice 3.4's Task 5 for `prepare`; slice 4b's Task 8 for
  `install`, `update` and `uninstall`, which also deleted the spawn path
  itself) mean no command ever invokes a script or logs to the dispatch log any
  more, no child exists whose status could propagate, no environment is handed
  to such a child, and no `scripts/<command>` file is looked for at all — so
  each specific condition can no longer occur in either direction, and no JS
  assertion enforces any of them any more; see each item's retirement note for
  the analogous in-process property and where it is now tested). 32 mapped + 21
  retired = 53. Plus 61 port-only
  assertions (47 additive `result.status === 0` / `result.log` / stderr
  checks the shell left implicit under `set -e` or that have no shell
  counterpart at all, plus 3 checks against the `gitSentinel` *file* rather
  than `result.status`/`result.log`/`result.stderr` — see items 53, 54, and
  56, which have no shell analogue since the shell had no equivalent of a
  fixture-side recording stub — plus one structural array-length guard, plus
  2 assertions covering the in-process runtime backstop with no shell
  counterpart of any kind — see items 41-42, plus 1 assertion covering
  `patchDispatch`'s rejection of a no-op override — see item 43, plus 2
  entries, items 3 and 20, that record their own assertion's removal rather
  than an assertion, plus 5 entries, items 57-61, added at slice 4b's flip).
  Eleven of those 61 — items 1, 7, 8, 9, 12, 15, 41, 42 and 43 at slice 4b's
  flip, and items 3 and 20 before it — are `Dropped` records rather than live
  assertions; being port-only, none of them participates in the mapped
  arithmetic either way.
- Reconciliation: 32 of the 53 shell items are mapped (some 1:1 to their own
  JS assertion, one pair sharing one JS assertion via the recorded merge
  above), 21 are retired (noted above) — not *silent* drops, since a
  retirement is recorded with its own note explaining why no replacement
  assertion is possible, rather than disappearing unremarked. That is the only
  sense in which "drop" is pejorative here: it names an unrecorded
  disappearance, not the port-only `Dropped` category, whose entries
  are recorded exactly as carefully and are not shell items at
  all. 32 + 21 = 53. The 61 port-only
  entries are strictly additive test coverage — not a reconciliation of
  any shell assertion — and are excluded from the 32/53 arithmetic above.
