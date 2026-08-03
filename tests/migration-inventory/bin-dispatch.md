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

7. `probe --porcelain` → logs `probe --porcelain ref=` (`:73-74`). Port:
   `:73`, `ROUTING_CASES[0]`.
8. `prepare --ref test` → logs `prepare --ref test ref=` (`:76-78`). Port:
   `:73`, `ROUTING_CASES[1]`.
9. `pin v6.1.1` → logs `pin v6.1.1 ref=` (`:80-82`). Port: `:73`,
   `ROUTING_CASES[2]`.
10. `track-latest` → logs `track-latest  ref=` (`:84-86`). Port: `:73`,
    `ROUTING_CASES[3]`.
11. `unpin` → logs `unpin  ref=` (`:88-90`). Port: `:73`, `ROUTING_CASES[4]`.
12. `install --dry-run` → logs `install --dry-run ref=` (`:92-94`). Port:
    `:73`, `ROUTING_CASES[5]`.
13. `uninstall --purge` → logs `uninstall --purge ref=` (`:96-98`). Port:
    `:73`, `ROUTING_CASES[6]`.
14. A bare invocation routes to `update` → logs `update  ref=` (`:101-103`).
    Port: `:73`, `ROUTING_CASES[7]`.

Each of items 7-14 is one `grep -Fqx` in the shell. The port's per-case
`assert.equal(result.status, 0)` at `:72` has no shell counterpart (the shell
never explicitly checked routing's exit status — see port-only entries 2-9)
and is not counted here.

### An unknown subcommand fails with usage and dispatches nothing (`:105-114`)

15. Running `bogus` must not succeed (`:107-109`, `if run_bin bogus; then
    echo ...; exit 1; fi`). **Merged** into the port's single
    `assert.equal(result.status, 2)` at `:81`, which is strictly stronger
    (equal to 2 implies not equal to 0) and therefore subsumes this guard —
    no separate JS assertion exists for it.
16. Exit status is `2` for the unknown subcommand `bogus` (`:110-111`). Port:
    `:81`.
17. Stderr contains `unknown subcommand: bogus` (`:112`). Port: `:82`.
18. Stderr contains `usage:` (`:113`). Port: `:83`.
19. The dispatch log is empty — nothing was dispatched (`:114`). Port: `:84`.

### A stray flag must not fall through to update (`:116-122`)

20. Exit status is `2` for the stray flag `--porcelain` (`:118-119`). Port:
    `:91`.
21. Stderr contains `unknown subcommand: --porcelain` (`:120`). Port: `:92`.
22. Stderr contains `usage:` (`:121`). Port: `:93`.
23. The dispatch log is empty (`:122`, bare `[ ! -s "$log" ]`). Port: `:94`.

### `--help` and `--version` (`:124-136`)

24. Exit status is `0` for `--help` (`:125-126`). Port: `:101`.
25. Stdout contains `usage:` for `--help` (`:127`). Port: `:102`.
26. Stderr is empty for `--help` (`:128`, bare `[ ! -s "$tmpdir/help-err" ]`).
    Port: `:103`.
27. `--version` prints exactly `9.9.9-test` (`:129-130`). Port: `:109`.
28. `--version` through a symlinked bin (as npm/npx invoke bins) prints
    exactly `9.9.9-test` (`:133-136`). Port: `:119`.

### Exit-code propagation (`:138-145`)

29. A script's exit code (`42`) propagates unchanged through `probe`
    (`:144-145`). Port: `:130`.

### Env passthrough (`:147-154`)

30. `SUPERPOWERS_REF=abc123` reaches the dispatched script: log line
    `update  ref=abc123` (`:153`). Port: `:146-149` (**merged** — see item
    31).
31. `SUPERPOWERS_VALIDATOR=/tmp/custom-validator.py` reaches the dispatched
    script: log line `update validator=/tmp/custom-validator.py` (`:154`).
    Port: `:146-149`. Items 30-31 are two separate `grep -Fqx` calls in the
    shell; the port asserts both lines in one `assert.deepEqual` over the
    full two-line log array, so both shell assertions map onto one JS
    assertion.

### Preflight: missing git fails before any dispatch, names the tool (`:156-162`)

32. Exit status is `1` when `git` is absent from `PATH` (`:160`). Port:
    `:159`.
33. Stderr contains `required command not found: git` (`:161`). Port:
    `:160`.
34. The dispatch log is empty — preflight failure must not dispatch (`:162`).
    Port: `:161`.

### Invalid pin syntax precedes preflight (`:164-172`)

35. Exit status is `2` for `pin main` (an invalid ref) (`:168`). Port:
    `:173`.
36. Stderr contains
    `pin REF must be an exact v-prefixed SemVer tag or full 40-hex commit`
    (`:169-170`). Port: `:174-178`.
37. The dispatch log is empty — an invalid pin ref must not dispatch
    (`:171`). Port: `:179`.

### Commands that need no git (`:174-178`)

38. `track-latest` dispatches with `git` absent from `PATH` (loop iteration
    1). Port: `:198`, `NO_GIT_CASES[0]`.
39. `unpin` dispatches with `git` absent from `PATH` (loop iteration 2).
    Port: `:198`, `NO_GIT_CASES[1]`.
40. `uninstall` dispatches with `git` absent from `PATH` (loop iteration 3).
    Port: `:198`, `NO_GIT_CASES[2]`.

### Missing python does not block unpin (`:181-186`)

41. `unpin` dispatches with `python3` absent from `PATH` (`:182-185`). Port:
    `:210`.

### codex required for probe and install (`:188-205`)

42. Exit status is `1` when `codex` is absent and `probe` is run (`:198`,
    bare `[ "$rc" -eq 1 ]`). Port: `:226`.
43. Stderr contains `required command not found: codex` for `probe` (`:199`).
    Port: `:227`.
44. The dispatch log is empty — missing codex must not dispatch `probe`
    (`:200`). Port: `:228`.
45. Exit status is `1` when `codex` is absent and `install` is run (`:203`,
    bare `[ "$rc" -eq 1 ]`). Port: `:236`.
46. Stderr contains `required command not found: codex` for `install`
    (`:204`). Port: `:237`.
47. The dispatch log is empty — missing codex must not dispatch `install`
    (`:205`). Port: `:238`. The shell proves this with a `probe` override
    that logs unconditionally before its own logic runs (`:191-196`,
    `"probe ran"`), so "did not dispatch" is proven rather than assumed. The
    port's `install` case takes no `scripts` override and runs against the
    shared `PACKAGE_ROOT`'s default stub instead — but that default stub
    (`dispatch-fixture.js`'s `loggingStub`, `:54-64`) *also* logs
    unconditionally on invocation, before checking anything. That is what
    makes the assertion load-bearing here too: if `install` were mistakenly
    dispatched despite the missing-codex preflight, the default stub would
    still append to the log, and `assert.deepEqual(result.log, [])` at
    `:238` would catch it. It is sound; it is just less visually obvious
    than the probe case's explicit override, because the "logs
    unconditionally" property comes from the shared fixture rather than
    from a per-case script.

### Commands that need no codex (`:207-215`)

48. `pin v6.1.1` dispatches with `codex` absent from `PATH` (`:208-209`,
    standalone, not part of the shell's `for` loop). Port: `:255`,
    `NO_CODEX_CASES[0]`.
49. `track-latest` dispatches with `codex` absent from `PATH` (shell loop
    iteration 1). Port: `:255`, `NO_CODEX_CASES[1]`.
50. `unpin` dispatches with `codex` absent from `PATH` (shell loop iteration
    2). Port: `:255`, `NO_CODEX_CASES[2]`.
51. `prepare` dispatches with `codex` absent from `PATH` (shell loop
    iteration 3). Port: `:255`, `NO_CODEX_CASES[3]`.

The shell's standalone `pin` assertion (item 48) and its 3-iteration `for`
loop (items 49-51) are ported as one 4-case data-driven loop
(`NO_CODEX_CASES`) rather than a standalone case plus a 3-case loop. The
per-case behavior asserted is identical; only the JS structuring differs.

### Missing script file: diagnostic, non-zero exit (`:217-222`)

52. Exit status is `1` when `scripts/uninstall` is missing (`:220`, bare
    `[ "$rc" -eq 1 ]`). Port: `:267`.
53. Stderr contains `missing script` (`:221`). Port: `:268`.

<!-- inventory:mapped:end -->

## Port-only assertions (outside the 1:1 mapping)

Every item below is additive: the shell left the condition implicit under
`set -e` (a bare `run_bin ... >/dev/null` or `x=$(run_bin ...)` with no
explicit exit-status test), so the shell would already abort on failure, but
no counted assertion (per the rules above) asserted it. The port makes each
of these explicit with its own `assert.equal(result.status, 0)`, or, for
item 1, a structural safety net with no shell analogue at all.

<!-- inventory:port-only:start -->

1. `ROUTING_CASES.length === 8` (`:63-67`), asserted once at module load,
   before any `test(` runs. Port-only — the shell has no array to check the
   length of; this guards against a routing case silently added to or
   removed from the fixture table without a matching update to this
   inventory's item count for 7-14, the same "silent deletion" failure mode
   `tests/bin/migration-inventory.test.js`'s own docstring names for
   `test(` call sites.
2. Routing case `probe --porcelain`: `result.status === 0` (`:72`,
   `ROUTING_CASES[0]`). Port-only — the shell's `run_bin probe --porcelain
   >/dev/null` at `:73` has no explicit exit-status test.
3. Routing case `prepare --ref test`: `result.status === 0` (`:72`,
   `ROUTING_CASES[1]`). Port-only — same rationale as item 2.
4. Routing case `pin v6.1.1`: `result.status === 0` (`:72`,
   `ROUTING_CASES[2]`). Port-only — same rationale as item 2.
5. Routing case `track-latest`: `result.status === 0` (`:72`,
   `ROUTING_CASES[3]`). Port-only — same rationale as item 2.
6. Routing case `unpin`: `result.status === 0` (`:72`, `ROUTING_CASES[4]`).
   Port-only — same rationale as item 2.
7. Routing case `install --dry-run`: `result.status === 0` (`:72`,
   `ROUTING_CASES[5]`). Port-only — same rationale as item 2.
8. Routing case `uninstall --purge`: `result.status === 0` (`:72`,
   `ROUTING_CASES[6]`). Port-only — same rationale as item 2.
9. Routing case bare invocation (`update`): `result.status === 0` (`:72`,
   `ROUTING_CASES[7]`). Port-only — same rationale as item 2.
10. `--version` (no symlink): `result.status === 0` (`:108`). Port-only —
    the shell's `version_out=$(run_bin --version)` at `:129` has no explicit
    exit-status test (command substitution failure would trip `set -e`
    implicitly, but nothing at the counted-assertion granularity checks it).
11. `--version` through a symlink: `result.status === 0` (`:118`). Port-only
    — same rationale as item 10, for the shell's `:135` symlinked
    invocation.
12. Env passthrough: `result.status === 0` (`:145`). Port-only — the
    shell's bare env-prefixed invocation at `:149-152` has no explicit
    exit-status test.
13. `NO_GIT_CASES` iteration `track-latest`: `result.status === 0` (`:197`).
    Port-only — the shell's `for` loop body at `:174-178` is a bare
    `run_bin "$cmd" >/dev/null` with no explicit exit-status test.
14. `NO_GIT_CASES` iteration `unpin`: `result.status === 0` (`:197`).
    Port-only — same rationale as item 13.
15. `NO_GIT_CASES` iteration `uninstall`: `result.status === 0` (`:197`).
    Port-only — same rationale as item 13.
16. Missing-python `unpin`: `result.status === 0` (`:209`). Port-only — the
    shell's bare `run_bin unpin >/dev/null` at `:184` has no explicit
    exit-status test.
17. `NO_CODEX_CASES` iteration `pin v6.1.1`: `result.status === 0` (`:254`).
    Port-only — the shell's standalone `run_bin pin v6.1.1 >/dev/null` at
    `:208` has no explicit exit-status test.
18. `NO_CODEX_CASES` iteration `track-latest`: `result.status === 0`
    (`:254`). Port-only — the shell's `for` loop body at `:210-214` is a
    bare `run_bin "$cmd" >/dev/null` with no explicit exit-status test.
19. `NO_CODEX_CASES` iteration `unpin`: `result.status === 0` (`:254`).
    Port-only — same rationale as item 18.
20. `NO_CODEX_CASES` iteration `prepare`: `result.status === 0` (`:254`).
    Port-only — same rationale as item 18.

<!-- inventory:port-only:end -->

## Cardinality

```json inventory
{
  "shellOriginal": 53,
  "portOnly": 20,
  "ports": { "tests/bin/bin-dispatch.test.js": 18 }
}
```

- Shell original: **53** assertions (1 precondition, 2 missing-dist, 3
  invalid-dist, 8 routing, 5 unknown-subcommand, 4 stray-flag, 3 `--help`, 1
  `--version`, 1 symlinked `--version`, 1 exit-code propagation, 2 env
  passthrough, 3 missing-git, 3 invalid-pin, 3 no-git loop, 1 no-python
  unpin, 3 probe-missing-codex, 3 install-missing-codex, 1
  pin-without-codex, 3 no-codex loop, 2 missing-script; sum:
  1+2+3+8+5+4+3+1+1+1+2+3+3+3+1+3+3+1+3+2 = 53).
- Port (`tests/bin/bin-dispatch.test.js`): 18 static `test(` call sites (3 of
  them data-driven loops — `ROUTING_CASES` ×8, `NO_GIT_CASES` ×3,
  `NO_CODEX_CASES` ×4 — expanding to 30 runtime cases), carrying 53
  assertions 1:1-mapped to the shell (two recorded merges: item 15 into the
  port's `:81` `status === 2` check, and items 30-31 into the port's
  `:146-149` two-line `assert.deepEqual`), plus 20 port-only assertions (all
  additive `result.status === 0` checks the shell left implicit under
  `set -e`, plus one structural array-length guard) with no shell
  counterpart.
- Reconciliation: 1:1 for all 53 shell items, two merges (noted above), no
  drops. The 20 port-only assertions are strictly additive test coverage —
  not a reconciliation of any shell assertion — and are excluded from the
  53/53 arithmetic above.
