# Migration inventory: tests/test_selection_commands.sh

Source read in full (506 lines). Ported to
`tests/baseline/selection-commands.test.js`.

## Counting rules applied

- Each `test "..." = "..."` / `test ! -e ...` line, and each
  `grep -Fq`/`grep -Fxq` (including bare ones relied on by `set -e`), is one
  assertion — same rule as `bin-dispatch.md`.
- Each `if <command>; then echo …; exit 1; fi` negative guard, where
  succeeding is itself the failure, is one assertion — `bin-dispatch.md`'s
  rule, already extended to a Python `if not …: raise SystemExit(...)` guard
  of the same shape by `ref-resolution.md`. This file has one instance of
  each host language: `:76` (shell) and `:325` (the embedded Python fixture).
- A `case "$kind" in symlink) test -L ...;; ... esac` branch, where each
  branch is a `test` line the mechanical regex cannot see because a case
  label precedes it on the same line, is one assertion per branch — the same
  shape as a negative guard starting with `if` instead of `case`.
- **New to this file:** a named helper function whose *own body* contains a
  line the mechanical regex matches (`test ...`, `grep -Fq ...`, or the
  pipe-`grep -q` shape), called from one or more call sites that the
  mechanical regex *also* matches, is counted once per call site, not once
  per call site *plus* once for the definition. This extends
  `selection-state.md`'s item 2 (`assert_effective`'s 8-line definition
  double-counted against its 14 call sites) to a definition of any length,
  including length 1: the definition never executes except as a call site's
  body, so crediting both double-bills the same check. This file has four
  such helpers — see the divergences below.
- A line that happens to have the shape the mechanical regex matches (a bare
  `[ ... ]`) but checks the test driver's own debug-trace state rather than
  anything about pin/unpin/track-latest behavior is not an assertion at all
  — see the `:271` exclusion in the divergences below.

## Divergences from the derived 89

The mechanical count
(`grep -cE '^[[:space:]]*(test |\[ |assert_[a-z_]+ |grep -[A-Za-z]*q)|\| *grep -[A-Za-z]*q' tests/test_selection_commands.sh`)
returns **89**. Nine divergences apply, in both directions (net **-2**):

1. **+1** (`:76`). `if [ "$rc" -ne 2 ]; then echo …; exit 1; fi` — pin with no
   arguments must return usage status 2. Starts with `if`, invisible to the
   mechanical regex.
2. **+1** (`:273`). `if ! grep -Fq 'cannot fetch requested commit from
   <redacted-source>' "$tmpdir/out"; then echo …; exit 1; fi` — the raw
   verifier must use the redacted source display. Starts with `if`.
3. **+1** (`:278`). `if grep -Fq 'token@example.invalid' "$tmpdir/out"; then
   echo …; exit 1; fi` — a positive guard whose success (the credential
   showing up in the diagnostic) is itself the failure. Starts with `if`.
4. **+1** (`:325`, the embedded Python fixture). `if not marker.exists():
   process.kill(); raise SystemExit(...)` — the readiness guard for the
   interruption itself, the same shape `ref-resolution.md` item 5 already
   credits for its own embedded Python fixture.
5. **+1** (`:333`). `if [ "$rc" -ne 143 ]; then echo …; exit 1; fi` — the
   signal-interrupted raw verification's exit-status check. Starts with `if`.
6. **-1** (`:55`). `assert_pin_usage_failure`'s one-line body (`test "$rc" -eq
   2`) is matched by the mechanical regex once as the *definition*, in
   addition to its one call site (`:188`, itself a `for ref in ...` loop over
   six malformed refs — counted once per the established "count the loop
   line, not the iterations" convention). Crediting both double-bills the
   same check; see the counting rule above.
7. **-1** (`:60`). `assert_path_empty`'s one-line body (`if find "$path"
   -mindepth 1 -print | grep -q .; then ... exit 1; fi`, matched via the
   pipe-`grep -q` branch of the regex) is matched once as the definition, in
   addition to its five independent call sites (`:136,217,227,237,260`).
8. **-1** (`:69`). `assert_state_unchanged`'s one-line body (`test "$(cat
   ...)" = "$expected"`) is matched once as the definition, in addition to
   its seven independent call sites (`:198,206,216,226,236,259,340`).
9. **-3** (`:481-483`). `assert_unpin_refuses`'s three-line body (`test "$rc"
   -eq 1`; `grep -Fq 'remove it manually after inspecting' ...`; `test -e
   ... || test -L ...`) is matched three times as the definition, in addition
   to its three independent call sites (`:492,495,498`). The body's own
   `case "$kind" in symlink) test -L ...;; directory) test -d ...;; special)
   test -p ...;; esac` (`:484-488`) adds three *more* checks per call — each
   on the same line as its case label, so invisible to the mechanical regex
   either way — but those are not a tenth divergence needing a `+3`: they are
   the reason each of the three call sites is worth one assertion covering
   four checks (rc, message, existence, and the kind-specific type check)
   rather than three, the same "one call site, however many checks it
   bundles" convention `selection-state.md` item 2 established for
   `assert_effective`. The case branches change what a call site is worth;
   they do not add call sites.

There is a tenth line the mechanical regex counts that is not itself an
assertion: `:271`'s `[ "$trace_was_enabled" = false ] || set -x` restores the
shell test driver's *own* `set -x` tracing state, disabled two lines earlier
(`:265-266`) so the driver's debug trace does not itself leak the embedded
credential the surrounding block exists to test. It has the bare-`[ ... ]`
shape the mechanical regex matches, but it asserts nothing about
pin/unpin/track-latest — it is test-harness bookkeeping, not a check of the
subject under test, so it contributes no item to the ledger below (neither
ported nor retired) and is excluded outright: **-1**.

Net: additions (items 1-5) = +5. Subtractions (items 6-8, three at -1 each,
plus item 9 at -3) = -6. The `:271` exclusion = -1. Total: 5 - 6 - 1 = **-2**.
89 - 2 = **87**, matching the executable declaration below.

## Assertion inventory

<!-- inventory:mapped:start -->

### Public argument-shape and malformed-ref early guards (`:72-112`)

Not a registered behavior ID. Every check in this cluster exercises
`src/cli.ts`'s `parseArgs` — the `TAG_RE`/`COMMIT_INPUT_RE` gate that now runs
strictly before any handler, tool lookup, or Git access (`main()` exits on a
`"usage-error"` result at `:322-326`, before `preflight`/dispatch ever run).
`tests/baseline/cli-parity.test.js`'s `CLI-USAGE-01` (`:594-628`) and
`CLI-PIN-REF-01` (`:630-716`) already exercise this exact boundary with far
more inputs than this driver's three malformed refs, including the
numeric-component grammar (`v01.2.3`, `v1.02.3`, `v1.2.03`) that makes the
CR/LF-embedded shapes here redundant: `TAG_RE`/`COMMIT_INPUT_RE` are
whole-string anchored with no `m` flag, so an embedded CR or LF cannot match
either regex — the same structural guarantee that already retired
`ref-resolution.md`'s `spw_config_ref` items.

1. Pin with no arguments returns usage status 2 (`:76`, an `if`-shaped
   negative guard). **Retired**: `CLI-USAGE-01`'s `["pin"]` case (`:598`).
2. Pin with two arguments returns usage status 2 (`:84`). **Retired**:
   `CLI-USAGE-01`'s `["pin", "v1.2.3", "extra"]` case (`:600-601`).
3. A CR-embedded tag, an LF-embedded tag, and an LF-embedded commit each
   return usage status 2 (`:107`, looped over three malformed refs).
   **Retired**: `CLI-PIN-REF-01`'s `refused` array (`:641-655`) exercises the
   same anchored-regex boundary.
4. The usage diagnostic names the exact grammar (`:108`). **Retired**, same
   citation: `CLI-PIN-REF-01` asserts the identical diagnostic text
   (`:710-711`).
5. No early Git invocation occurs for a malformed ref (`:110`). **Retired**:
   structurally guaranteed by `src/cli.ts`'s ordering alone — `parseArgs`
   (`:305`) returns a `"usage-error"` result that `main()` exits on at
   `:322-326`, strictly before `preflight` is ever reached at `:327` — not by
   `CLI-USAGE-01`'s `readDispatchLog(sandbox)` deepEqual `[]` check (`:625`).
   That log records script *dispatch*, and `pin` is in-process now, so it
   would read empty on a **successful** pin too; it is not evidence that no
   Git process ran. The port keeps the observable-Git-invocation technique
   (a fake `git` that logs its own invocations) for the three pre-Git guards
   that do reach real work (items 61-69 below); here, "no Git process ran"
   is unasserted, resting on the ordering guarantee alone.
6. Saved state is unchanged after a malformed-ref attempt (`:111`).
   **Retired**, same rationale as item 5: no handler capable of writing state
   is ever reached.

### `REF-PIN-SOURCE-01` exact tag and raw commit pins prove selected source (`:114-281`)

7. Pinning `v1.0.0` prints the confirmation naming the resolved ref and
   commit (`:117`). Port: `tests/baseline/selection-commands.test.js:443-446`.
8-12. The saved record's `mode`, `source`, `requested_ref`, `resolved_ref`,
   and `commit` all match the exact-tag pin (`:118-122`). **Merged** into one
   `assert.deepEqual` (`:457-464`), strictly stronger than five separate
   field checks — it also proves no unexpected field survived.
13. The saved `requested_ref` for the annotated pre-release tag equals the
    tag itself (`:125`). Port: `:472`.
14. The saved `resolved_ref` for the annotated pre-release tag equals the tag
    itself (`:126`). Port: `:473`.
15. The saved `commit` for the annotated pre-release tag is the tag's peeled
    commit, not the tag object (`:127`). Port: `:474`.
16. A mixed-case 40-hex raw commit's saved `requested_ref` is lowercased
    (`:133`). Port: `:493`.
17. The saved `resolved_ref` is likewise lowercased (`:134`). Port: `:494`.
18. The saved `commit` is likewise lowercased (`:135`). Port: `:495`.
19. The raw-commit verification workspace's parent holds nothing after a
    successful pin (`:136`). Port: `:496` (`assertWorkspaceParentEmpty`).
20-21. A relative local source's saved `source` (the raw env value, not the
    resolved absolute path) and `commit` are correct for a raw-commit pin
    (`:148-149`). Port: `:524-525` (first loop iteration).
22-23. The same, for a dash-prefixed local source (`:160-161`). Port:
    `:524-525` (second loop iteration).
24-25. The same two fields for a relative local source, exact-tag pin
    (`:173-174`). Port: `:538-539` (first loop iteration).
26-27. The same, dash-prefixed, exact-tag pin (`:184-185`). Port: `:538-539`
    (second loop iteration).
28. Six malformed ref shapes (`1.2.3`, `v1.2`, `v1.2.3+build.4`,
    `latest-release`, `main`, a truncated commit) each fail with usage status
    2 (`:188`, `assert_pin_usage_failure`'s one call site). **Retired**:
    `CLI-PIN-REF-01`'s `refused` array covers the same anchored
    `TAG_RE`/`COMMIT_INPUT_RE` boundary, with a literal or near-literal
    counterpart for five of the six: `1.2.3` verbatim, `v1.2.3+build` for the
    build-metadata rejection, `latest-release` and `main` verbatim, and a
    39-hex-character commit for the truncation case. The sixth, `v1.2`
    (missing its patch component), has no literal counterpart there — the
    closest entries (`v01.2.3`/`v1.02.3`/`v1.2.03`) test leading zeros within
    a full three-component tag, not a missing component. `v1.2`'s rejection
    rests on the same anchored-regex structural guarantee
    (`SEMVER_BASE_SOURCE` requires all three numeric components) rather than
    on a covered example, so the risk of this retirement is low but not the
    same "literal counterpart" claim as the other five.
29. A branch named like a tag (`v9.9.9`) fails the exact-tag pin with status
    1 (`:196`). Port: `tests/baseline/selection-commands.test.js:554`.
30. The failure names the ref: `upstream tag not found: v9.9.9` (`:197`).
    Port: `:555`.
31. Saved state is unchanged after the branch-like-tag failure (`:198`). Port:
    `:556`.
32. An unreachable upstream source fails the exact-tag pin with status 1
    (`:204`). Port: `:578`.
33. The failure names the ref: `cannot query exact upstream tag v1.0.0`
    (`:205`). Port: `:579-582`.
34. Saved state is unchanged (`:206`). Port: `:583`.
35. A commit absent from the source fails the raw-commit pin with status 1
    (`:214`). Port: `:594`.
36. The failure names the reason: `source cannot supply requested commit`
    (`:215`). Port: `:595-598`.
37. Saved state is unchanged (`:216`). Port: `:599`.
38. The raw-commit verification workspace's parent is empty after the
    unavailable-object failure (`:217`). Port: `:600`.
39-42. A blob object is rejected (status 1, message, state unchanged,
    workspace-parent empty) (`:224-227`). Port: `:610-613`.
43-46. An annotated tag object is rejected, the same four checks (`:234-237`).
    Port: `:623-626`.
47-50. A simulated transport failure at the raw-commit fetch step (status 1,
    message naming the source, state unchanged, workspace-parent empty)
    (`:257-260`). Port: `:640-648`.
51. The raw verifier (`verifyRawCommit`), called directly and below pin's own
    public source validation, rejects a transport failure (`:272`,
    `assert.rejects`'s own throw is the port of the bare `rc -eq 1` check).
    Port: `:664-682`.
52. The rejection's message uses the redacted source display rather than the
    raw credential-bearing URL (`:273`, an `if`-shaped negative guard). Port:
    `:672-675`.
53. The rejection's message never contains the raw credential (`:278`, a
    positive guard whose success is the failure). Port: `:676-679`.

### `REF-PIN-CLEANUP-01` interrupted pin proof cleans only its workspace (`:283-340`)

54. The interrupted raw-commit fetch must actually reach the signal fixture
    before the signal is sent, or the interruption proves nothing (`:325`,
    the embedded Python fixture's readiness guard). Port:
    `tests/baseline/selection-commands.test.js:802-807` (`waitForMarker` plus
    the `assert.fail` on timeout).
55. The interrupted child's exit status is non-zero (`:333`, `if [ "$rc" -ne
    143 ]`). **Merged** into the port's `assert.equal(result.signal,
    "SIGTERM")` / `assert.equal(result.code, null)` (`:824-825`), strictly
    stronger — it asserts the exact cause of death, not merely a non-zero
    exit, the same precedent `ref-resolution.md` item 28 already applies to
    `fetchExactCommit`'s own signal-interruption case.
56. The sibling file's content is untouched by the interruption (`:338`).
    Port: `:829` (`assertOnlySiblingKept`).
57. The interrupted verification workspace holds exactly the one sibling
    (`:339`). Port: `:829` (same call, second half of the pairing).
58. Saved state is unchanged by the interruption (`:340`,
    `assert_state_unchanged "$before"`). Port: `:837` — the assertion this
    behavior ID exists to prove distinctly from `REF-CLEANUP-01`: ported here
    against an absent "before" (this fixture's config directory starts
    empty, so a completed pin WOULD have created `selection.json`) rather
    than a populated one, making the check falsifiable — if the interruption
    landed even slightly later, after `attemptPin`'s write step, the file
    would exist and this assertion would go red.

### The writer revalidates saved state after Git verification (`:342-374`)

Not a registered behavior ID. Proves that `src/selection-store.ts`'s
`writeSelectionState`'s own re-read-before-write (`readSelectionState` on the
same path, immediately before committing a proposed record) actually catches
a change injected *during* the Git verification window between
`src/commands/pin.ts`'s `attemptPin`'s initial `loadSavedSelection` and its
final write — a fake `git` mutates the state file the instant `ls-remote`
runs, strictly earlier than the write.

59. A conflicting write injected during `ls-remote` (malformed bytes, or a
    schema the port does not understand) makes the pin attempt fail with
    status 1, for both conflict shapes (`:368`, looped). Port:
    `tests/baseline/selection-commands.test.js:872`.
60. The conflicting write survives untouched — not silently overwritten by
    the pin attempt's own proposed record — for both conflict shapes
    (`:373`, looped). Port: `:873`.

### Pre-Git fail-closed guards (`:376-416`)

Not a registered behavior ID. Proves that malformed existing state, an
existing state of an unrecognized schema, and a credential-bearing source
each fail before any Git process runs at all — not merely that they fail.

61. A malformed existing selection record fails the pin attempt with status 1
    (`:393`). Port: `tests/baseline/selection-commands.test.js:904`.
62. No Git process is invoked (`:394`). Port: `:905`.
63. The malformed bytes are unchanged (`:395`). Port: `:906`.
64. An existing record of an unrecognized `schema_version` fails the pin
    attempt with status 1 (`:404`). Port: `:916`.
65. No Git process is invoked (`:405`). Port: `:917`.
66. The unrecognized-schema bytes are unchanged (`:406`). Port: `:918`.
67. A credential-bearing `SUPERPOWERS_UPSTREAM_URL` fails the pin attempt
    with status 1 (`:414`). Port: `:935`.
68. The failure names the reason: `HTTP(S) source must not include userinfo`
    (`:415`). Port: `:936-939`.
69. No Git process is invoked (`:416`). Port: `:940`.

### track-latest source capture and guards (`:418-455`)

Not a registered behavior ID. The shell's `:420-428` PATH-starvation fixture
(a directory stocked with only `dirname`/`mktemp`/`rm`/`python3`/`node`)
proved a shell property that no longer exists to prove: `runTrackLatest`
(`src/commands/track-latest.ts`) never spawns a child process at all, so
"needs no Git" is now a structural fact about the absence of any
`child_process` import in that module, not a runtime PATH-starvation
property — it has no port here.

70. track-latest with an explicit `SUPERPOWERS_UPSTREAM_URL` prints the
    one-line confirmation (`:432`). **Retired**:
    `tests/unit/commands-track-latest.test.js`'s "track-latest writes the
    record and prints one line" (`:20-46`) exercises the identical message
    text against the identical code path.
71. The saved `mode` is `track-latest` (`:434`). **Retired**, same citation.
72. The saved `source` equals the explicit URL (`:435`). **Retired**, same
    citation.
73. With no `SUPERPOWERS_UPSTREAM_URL` at all, the saved `source` defaults to
    the official upstream (`:441`). Port:
    `tests/baseline/selection-commands.test.js:964` — the one behavior in
    this cluster the cited unit test does not exercise (it always sets an
    explicit URL).
74. An existing record of an unrecognized `schema_version` fails the
    track-latest attempt with status 1 (`:449`). Port: `:990`. Not retired
    against `tests/unit/commands-track-latest.test.js`'s "track-latest
    refuses to overwrite a corrupt saved record" (`:67-92`): that test's
    fixture is `{ not json` and asserts `error: invalid JSON in ${state}:
    line 1 column 3: …` — `validateRecord`'s JSON-*parse*-failure branch, not
    the `schema_version must equal integer 1` branch this item's fixture
    (`schema_version: 2`, otherwise well-formed JSON) actually reaches. Ported
    instead, symmetric with pin's own newer-schema guard (items 64-66 above).
    The port also asserts the diagnostic itself (`:991`,
    `error: schema_version must equal integer 1`, read from a real run of
    this exact fixture) — a strictly-stronger check with no shell
    counterpart (the shell asserted no message for this cluster either), and
    the empirical proof of the branch claim above, kept as evidence once
    tests/test_selection_commands.sh itself is gone.
75. The unrecognized-schema bytes are unchanged (`:450`). Port: `:992`.
76. track-latest with an extra argument fails with usage status 2 (`:455`).
    **Retired**: `tests/unit/commands-track-latest.test.js`'s "track-latest
    rejects extra arguments with exit 2" (`:94-109`) exercises the identical
    diagnostic and status, and `CLI-USAGE-01`'s `["track-latest", "extra"]`
    case (`:609-611`) covers the same `parseArgs` boundary independently.

### `FS-SELECTION-UNPIN-TYPES-01` unpin rejects unsafe path types (`:457-505`)

77-79. Removing an existing selection prints the confirmation naming the
    packaged fallback, plus a note for each active override
    (`SUPERPOWERS_REF`, `SUPERPOWERS_UPSTREAM_URL`) (`:466-468`). **Merged**
    into one exact-text `assert.equal`
    (`tests/baseline/selection-commands.test.js:1016-1021`), strictly
    stronger than three separate `grep -Fxq`/`grep -Fq` checks — it also
    proves nothing else was printed.
80. The selection state file is actually removed (`:469`). Port: `:1024`.
81. A sibling file in the same directory is untouched by the removal
    (`:470`). Port: `:1025`.
82. With no existing selection, unpin prints the "no saved upstream
    selection" message naming the same fallback (`:473`). Port: `:1039`.
83. The sibling file remains untouched (`:474`). Port: `:1040`.
84. unpin refuses a symlinked state path, bundling the exit status, the
    diagnostic, and the proof that the path is still a symlink afterward
    (`:492`, one `assert_unpin_refuses` call). Port:
    `:1046-1072` (`assertUnpinRefuses`'s definition), called at `:1075`.
85. The same, for a directory (`:495`). Port: `:1046-1072`, called at
    `:1079`.
86. The same, for a named pipe (`:498`). Port: `:1046-1072`, called at
    `:1083`.
87. unpin with an extra argument fails with usage status 2 (`:504`).
    **Retired**: `CLI-USAGE-01`'s `["unpin", "extra"]` case (`:613-614`)
    exercises the identical `parseArgs` boundary and diagnostic.

<!-- inventory:mapped:end -->

## Cardinality

```json inventory
{
  "shellOriginal": 87,
  "portOnly": 0,
  "ports": { "tests/baseline/selection-commands.test.js": 6 }
}
```

- Shell original: **87** assertions (6 arity/early-guard, 47
  `REF-PIN-SOURCE-01`, 5 `REF-PIN-CLEANUP-01`, 2 revalidation, 9 pre-Git
  guards, 7 track-latest, 11 `FS-SELECTION-UNPIN-TYPES-01`; sum:
  6+47+5+2+9+7+11 = 87). See "Divergences from the derived 89" above for the
  full +5/-7/net-2 derivation from the mechanical 89.
- Port (`tests/baseline/selection-commands.test.js`): 6 static `test(` call
  sites — the three named behavior-ID cases (`REF-PIN-SOURCE-01`,
  `REF-PIN-CLEANUP-01`, `FS-SELECTION-UNPIN-TYPES-01`) plus three unregistered
  cases (the writer's revalidation-under-race proof, the pre-Git fail-closed
  guards, and track-latest's official-default source plus its own
  newer-schema guard) — carrying 75 of the 87 shell items mapped (3 recorded
  merges: items 8-12 combined into one `assert.deepEqual`, item 55 combined
  into the signal/code assertion, and items 77-79 combined into one
  exact-text equality). The rest are **12 retired items** (1-6, 28, 70-72,
  76, 87). 75 mapped + 12 retired = 87.
- Reconciliation: 75 of 87 shell items are mapped into the port; 12 are
  retired, each with a citation to the pre-existing coverage (either
  `tests/baseline/cli-parity.test.js`'s `CLI-USAGE-01`/`CLI-PIN-REF-01`, or
  `tests/unit/commands-track-latest.test.js`) that already supersedes it, or
  to a structural guarantee (`parseArgs`'s ordering, for items 5-6) that
  makes a runtime check unnecessary — unlike `bin-dispatch.md`'s retired
  items, none of these lost a live shell subject; each simply has nothing
  left to prove that isn't already proven elsewhere or true by construction.
  75 + 12 = 87.
