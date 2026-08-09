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
    covered by `tests/bin/bin-dispatch.test.js:97` and recorded as port-only
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
    `tests/bin/bin-dispatch.test.js:89` (moved from `:81` when Task 6 added
    `track-latest`'s own standalone case immediately above it) and recorded
    as port-only item 21, since it is a different property than "reaches its
    script with its args".
12. `install --dry-run` → logs `install --dry-run ref=` (`:92-94`). Port:
    `:79`, `ROUTING_CASES[0]`. **Index updated** (PR 11.5 slice 3.4) from
    `ROUTING_CASES[1]` to `[0]`: the table shrank by one more when `prepare`
    (formerly index 0) was also removed — see item 8's retirement note.
    (Slice 2's Task 6 had already updated this from `[2]` to `[1]` when
    `probe` (formerly index 0) was removed — see item 7's retirement
    note. Slice 1's Task 7 had already updated this from `[3]` to `[2]` when
    `pin` was removed — see item 9's retirement note. Its Task 6 had already
    updated this from `[4]` to `[3]` when `track-latest` was removed — see
    item 10's retirement note. Its Task 5 had already updated this from `[5]`
    to `[4]` when `unpin` was removed — see item 11's retirement note.)
13. `uninstall --purge` → logs `uninstall --purge ref=` (`:96-98`). Port:
    `:79`, `ROUTING_CASES[1]`. **Index updated** (PR 11.5 slice 3.4)
    from `ROUTING_CASES[2]` to `[1]`, same cause as item 12.
14. A bare invocation routes to `update` → logs `update  ref=` (`:101-103`).
    Port: `:79`, `ROUTING_CASES[2]`. **Index updated** (PR 11.5 slice 3.4)
    from `ROUTING_CASES[3]` to `[2]`, same cause as item 12.

Each of items 7-14 is one `grep -Fqx` in the shell. The port's per-case
`assert.equal(result.status, 0)` at `:81` has no shell counterpart (the shell
never explicitly checked routing's exit status — see port-only entries 2-9)
and is not counted here.

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
    (`:144-145`). Port: `:197`. The port's vehicle moved from `probe` to
    `install` (PR 11.5 slice 2, Task 6): the property under test is that a
    spawned child's status reaches the caller unchanged, and an in-process
    command has no child whose status could propagate. The item stays mapped
    — only the command carrying it changed — and the port carries an inline
    comment saying so.

### Env passthrough (`:147-154`)

30. `SUPERPOWERS_REF=abc123` reaches the dispatched script: log line
    `update  ref=abc123` (`:153`). Port: `:178-181` (**merged** — see item
    31).
31. `SUPERPOWERS_VALIDATOR=/tmp/custom-validator.py` reaches the dispatched
    script: log line `update validator=/tmp/custom-validator.py` (`:154`).
    Port: `:178-181`. Items 30-31 are two separate `grep -Fqx` calls in the
    shell; the port asserts both lines in one `assert.deepEqual` over the
    full two-line log array, so both shell assertions map onto one JS
    assertion.

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
    Port: `:242`, `NO_GIT_CASES[0]`. **Index updated** (PR 11.5, Task 6) from
    `NO_GIT_CASES[1]` to `[0]`: the table shrank by one more when
    `track-latest` (formerly index 0) was also removed — see item 38's
    retirement note. (Task 5 had already updated this from `[2]` to `[1]`
    when `unpin` was removed — see item 39's retirement note.)

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
    bare `[ "$rc" -eq 1 ]`). Port: `:404`. Deliberately still carried by
    `probe` after PR 11.5 slice 2's in-process flip, unlike items 29's and
    the port-only backstop's vehicles: `COMMAND_REQUIREMENTS.probe` keeps
    `codex` (only `python3` left it), and preflight runs before dispatch
    either way, so this is the end-to-end net for that requirement row rather
    than a spawn vehicle.
43. Stderr contains `required command not found: codex` for `probe` (`:199`).
    Port: `:405`.
44. The dispatch log is empty — missing codex must not dispatch `probe`
    (`:200`). Port: `:406`. The per-case `scripts` override that mirrored the
    shell's `"probe ran"` stub was removed in PR 11.5 slice 2, Task 6: an
    in-process `probe` reaches no script, so a stub for one could never log
    and the override proved nothing. The shared `PACKAGE_ROOT`'s default
    `loggingStub` still logs unconditionally on invocation, so the assertion
    keeps its teeth exactly the way item 47's `install` case does.
45. Exit status is `1` when `codex` is absent and `install` is run (`:203`,
    bare `[ "$rc" -eq 1 ]`). Port: `:414`.
46. Stderr contains `required command not found: codex` for `install`
    (`:204`). Port: `:415`.
47. The dispatch log is empty — missing codex must not dispatch `install`
    (`:205`). Port: `:416`. The shell proves this with a `probe` override
    that logs unconditionally before its own logic runs (`:191-196`,
    `"probe ran"`), so "did not dispatch" is proven rather than assumed. The
    port's `install` case takes no `scripts` override and runs against the
    shared `PACKAGE_ROOT`'s default stub instead — but that default stub
    (`dispatch-fixture.js`'s `loggingStub`, `:101-116`) *also* logs
    unconditionally on invocation, before checking anything. That is what
    makes the assertion load-bearing here too: if `install` were mistakenly
    dispatched despite the missing-codex preflight, the default stub would
    still append to the log, and `assert.deepEqual(result.log, [])` at
    `:416` would catch it. It is sound; it is just less visually obvious
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
    `tests/bin/bin-dispatch.test.js:496` and recorded as port-only items
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
    `[ "$rc" -eq 1 ]`). Port: `:434`.
53. Stderr contains `missing script` (`:221`). Port: `:435`.

<!-- inventory:mapped:end -->

## Port-only assertions (outside the 1:1 mapping)

Every item below is additive: the shell left the condition implicit under
`set -e` (a bare `run_bin ... >/dev/null` or `x=$(run_bin ...)` with no
explicit exit-status test), so the shell would already abort on failure, but
no counted assertion (per the rules above) asserted it. The port makes each
of these explicit with its own `assert.equal(result.status, 0)`, or, for
item 1, a structural safety net with no shell analogue at all.

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
   The guard itself, and its rationale, are unchanged.
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
7. Routing case `install --dry-run`: `result.status === 0` (`:81`,
   `ROUTING_CASES[0]`). Port-only — same rationale as item 2. **Index
   updated** (PR 11.5 slice 3.4) from `ROUTING_CASES[1]` to `[0]`: the table
   shrank by one more when `prepare` (formerly index 0) was also removed.
   (Slice 2's Task 6 had already updated this from `[2]` to `[1]` when `probe`
   was removed; slice 1's Task 7 from `[3]` to `[2]` for `pin`; its Task 6
   from `[4]` to `[3]` for `track-latest`; its Task 5 from `[5]` to `[4]` for
   `unpin`.)
8. Routing case `uninstall --purge`: `result.status === 0` (`:81`,
   `ROUTING_CASES[1]`). Port-only — same rationale as item 2. **Index
   updated** (PR 11.5 slice 3.4) from `ROUTING_CASES[2]` to `[1]`, same
   cause as item 7.
9. Routing case bare invocation (`update`): `result.status === 0` (`:81`,
   `ROUTING_CASES[2]`). Port-only — same rationale as item 2. **Index
   updated** (PR 11.5 slice 3.4) from `ROUTING_CASES[3]` to `[2]`, same
   cause as item 7.
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
12. Env passthrough: `result.status === 0` (`tests/bin/bin-dispatch.test.js:177`,
    corrected from a stale `:157` citation — same pre-existing-citation
    history as item 10). Port-only — the shell's bare env-prefixed invocation
    at `:149-152` has no explicit exit-status test.
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
15. `NO_GIT_CASES` iteration `uninstall`: `result.status === 0` (`:247`).
    Port-only — the shell's `for` loop body at `:174-178` is a bare
    `run_bin "$cmd" >/dev/null` with no explicit exit-status test. **Index
    updated** (PR 11.5, Task 6): `NO_GIT_CASES` now has a single entry
    (`uninstall`) after `track-latest` also left the table — see item 13's
    relocation note.
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
    standalone codex-absent case at `tests/bin/bin-dispatch.test.js:496`:
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
    (`tests/bin/bin-dispatch.test.js:136`). Port-only, with no shell
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
42. **New** (PR 11.5 slice 2, Task 3). Same case: stderr is exactly
    `error: no in-process handler registered for: ${spawned}\n`, where
    `spawned` is item 41's derived vehicle command
    (`tests/bin/bin-dispatch.test.js:137-140`). Port-only, same rationale as
    item 41; the command named in that string is whatever `vehicleCommand`
    currently derives, not a literal to keep in sync by hand.
43. **New** (PR 11.5 slice 3.4, Task 3). `dispatchOverride` rejects an
    override that changes nothing: `runDispatch` throws
    (`tests/bin/bin-dispatch.test.js:152-162`). Port-only, with no shell
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
    no-op, not just that one victim was re-pointed.
44. **New** (PR 11.5 slice 3.4). Routing case `prepare`: `result.log` is empty
    (`tests/bin/bin-dispatch.test.js:95`). Port-only, with no shell
    counterpart of any kind, same rationale as item 21: the shell always
    dispatched to `scripts/prepare` and logged something for this case, so
    "ran without ever dispatching" was not expressible through it. This is
    the whole of what survives item 8 — the case asserts no status, for the
    reason recorded in item 3.
45. **New** (PR 11.5 slice 3.4). `prepare` with `codex` absent: stderr does
    not contain `required command not found: codex`
    (`tests/bin/bin-dispatch.test.js:502-505`). Port-only. The shell observed
    the same preflight fact indirectly, through a successful dispatch (item
    51); with no dispatch left to observe, the assertion moves onto the
    diagnostic preflight would have emitted, which is a direct statement of
    the property rather than a proxy for it.
46. **New** (PR 11.5 slice 3.4). Same case: `result.log` is empty (`:506`).
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
    (`tests/bin/bin-dispatch.test.js:475`). Port-only, same
    no-shell-counterpart rationale as item 47, and the half that must fire.
    Items 47-49 are the integration net for `commandRequirements(env)`:
    `tests/bin/units.test.js` unit-tests the accessor, but nothing else
    proves `preflight` reads it rather than the static table, and reverting
    it to the static table is invisible to every other case in this file
    because none configures a validator.
49. **New** (PR 11.5 slice 3.4). Same case: stderr is exactly
    `error: required command not found: python3 — install python3 and re-run`
    plus a newline (`tests/bin/bin-dispatch.test.js:476-479`). Port-only, same
    rationale as item 48. Exact rather than substring because the text is the
    contract: it must be preflight's own hand-written diagnostic, not a
    prepare-path failure that merely mentions `python3`.
50. **New** (PR 11.5 slice 3.4). Same case: `result.log` is empty (`:481`).
    Port-only, same rationale as item 21 — preflight completes before dispatch
    and before any Git or build effect.

<!-- inventory:port-only:end -->

## Cardinality

```json inventory
{
  "shellOriginal": 53,
  "portOnly": 50,
  "ports": { "tests/bin/bin-dispatch.test.js": 36 }
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
- Port (`tests/bin/bin-dispatch.test.js`): 36 static `test(` call sites (2 of
  them data-driven loops — `ROUTING_CASES` ×3 and `NO_GIT_CASES` ×1, both
  smaller than before PR 11.5 flipped `pin`, `track-latest`, `unpin`, `probe`,
  and `prepare` to in-process and removed all five from every table they used
  to occupy; `NO_CODEX_CASES` is gone entirely, emptied by the same flips —
  expanding to 38 runtime cases), carrying **41** of the 53 shell assertions
  mapped (two recorded merges:
  item 15 into the port's `status === 2` check, and items 30-31 into the
  port's two-line `assert.deepEqual`), plus **12 retired items** (7, 8, 9, 10,
  11, 38, 39, 41, 48, 49, 50, 51 — items 7, 8, 9, 10, 38, and 49 each asserted
  that `probe`, `prepare`, `pin`, or `track-latest` "dispatches ... and logs
  `<name>  ref=`"; items 11, 39, and 50 each asserted the analogous condition
  for `unpin`; item 48 asserted `pin` dispatches with `codex` absent and logs
  `pin v6.1.1 ref=`, and item 51 the same for `prepare`; item 41 asserted
  `unpin` dispatches with `python3`
  absent. PR 11.5's in-process flips (slice 1's Task 5 for `unpin`, Task 6
  for `track-latest`, and Task 7 for `pin`; slice 2's Task 6 for `probe`;
  slice 3.4's Task 5 for `prepare`)
  mean none of the five commands ever invokes its script or logs to the
  dispatch log any more, so each specific condition can no longer occur in
  either direction, and no JS assertion enforces any of them any more; see
  each item's retirement note for the analogous in-process property and where
  it is now tested). 41 mapped + 12 retired = 53. Plus 50 port-only
  assertions (44 additive `result.status === 0` / `result.log` / stderr checks
  the shell left implicit under `set -e` or that have no shell counterpart at
  all, plus one structural array-length guard, plus 2 assertions covering
  the in-process runtime backstop with no shell counterpart of any kind — see
  items 41-42, plus 1 assertion covering `patchDispatch`'s rejection of a
  no-op override — see item 43, plus 2 entries, items 3 and 20, that record
  their own assertion's removal rather than an assertion) with no shell
  counterpart.
- Reconciliation: 41 of the 53 shell items are mapped (some 1:1 to their own
  JS assertion, two pairs sharing one JS assertion via the recorded merges
  above), 12 are retired (noted above) — not drops, since a retirement is
  recorded with its own note explaining why no replacement assertion is
  possible, rather than silently disappearing. 41 + 12 = 53. The 50 port-only
  entries are strictly additive test coverage — not a reconciliation of
  any shell assertion — and are excluded from the 41/53 arithmetic above.
