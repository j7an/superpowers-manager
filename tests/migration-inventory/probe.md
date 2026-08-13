# Migration inventory: tests/test_probe.sh
<!-- FROZEN: historical migration record. Declared historical against ad56569a4c161e7b122967442e2b026eeb6395f6. -->
<!-- Port pointers are NOT maintained. An item's identity is its quoted assertion text, not its number. -->
<!-- Resolve shell-original citations with: git show f58289ed00b95635ffc4ea589b845ce83a7404ba:tests/test_probe.sh -->

Source read in full (631 lines). Ported to `tests/baseline/probe.test.js`,
`tests/unit/commands-probe.test.js`, and `tests/unit/status.test.js`.

## Counting rules applied

- Each `test "..." = "..."` / `test ! -s ...` line, and each
  `grep -Fq`/`grep -Fxq` (including bare ones relied on by `set -e`), is one
  assertion — same rule as `bin-dispatch.md`.
- Each `if <command>; then echo …; exit 1; fi` negative guard, where
  succeeding is itself the failure, is one assertion — `bin-dispatch.md`'s
  rule. This file has four: `:47-50`, `:52-56`, `:80-83`, and `:513-516`.
- Extending the bare-`[ ... ]`/bare-`grep` rule (`bin-dispatch.md:19-21`) the
  same way `ref-resolution.md:20-25` extended it to a bare
  `git ... cat-file -e`: a bare invocation of a *predicate* under `set -eu`
  whose only purpose is its exit status is one assertion. This file has four,
  all `spw_commit_matches` (`:35-38`), two of them negated with `!`. This is
  the predicate shape, not the "bare `run_*` with no status test" shape below.
- **A bare `run_*` with no status test is not counted.** `:390`, `:437`,
  `:454`, `:462`, `:490-493`, `:508`, `:556`, `:562`, `:568`, `:579`, `:590`,
  `:598`, `:607`, and `:616` all take the form `output=$(run_probe)`, leaving
  the exit status to `set -e`. `install-commands.md:89`,
  `bin-dispatch.md:314-318`, and `uninstall-commands.md:446` all treat that as
  implicit. Same treatment here: the port's explicit
  `assert.equal(result.status, 0, result.stderr)` and
  `assert.equal(result.stderr, "")` on every successful run are additive, but
  at the counted-assertion granularity the shell asserted nothing there, so
  they add no item in either region.
- A named helper function whose *own body* contains a line the mechanical
  regex matches, called from one or more call sites the mechanical regex
  *also* matches, is counted once per call site, never once per call site
  *plus* once for the definition — `selection-commands.md`'s rule, itself an
  extension of `selection-state.md`'s item 2. Two helpers here have that
  shape: `assert_probe_porcelain` (`:317-329`) and `assert_preflight_failure`
  (`:521-535`).
- The converse case is new to this file and needs the same rule read the
  other way. `assert_probe_tmp_empty` (`:377-383`) has a matching body line
  (`:378`, the pipe-`grep -q` shape) but takes **no arguments**, so every one
  of its eight call sites is the bare token `assert_probe_tmp_empty` with no
  trailing space — invisible to the mechanical regex, which requires
  `assert_[a-z_]+ `. Counting once per call site means eight items where the
  mechanical count sees one definition.
- One call site is worth one item however many checks its body bundles —
  `selection-state.md`'s convention for `assert_effective`.
  `assert_probe_porcelain` bundles six checks (desired, generated, and
  installed commits, identity state, status, update control) and
  `assert_preflight_failure` bundles four (non-zero exit, the expected
  diagnostic, an empty Git log, an empty adapter log); each call site is still
  one item.
- A line with the shape the mechanical regex matches that checks the test
  driver's own bookkeeping rather than anything about probe is not an
  assertion at all — see the `:631` exclusion below, the same treatment
  `selection-commands.md` gave its `:271`.

## Divergences from the derived 113

The mechanical count
(`grep -cE '^[[:space:]]*(test |\[ |assert_[a-z_]+ |grep -[A-Za-z]*q)|\| *grep -[A-Za-z]*q' tests/test_probe.sh`)
returns **113**. Six divergences apply, in both directions:

1. **+4** (`:35-38`). The four `spw_commit_matches` predicate invocations —
   full-SHA match, 7-character-prefix match, mismatch, and the load-bearing
   empty-observed invariant, the last two negated with `!`. None starts with
   `test`, `[`, `assert_`, or `grep`, so the mechanical regex sees none of
   them; the file's own comment at `:33-34` enumerates exactly these four.
2. **+3** (`:47-50`, `:52-56`, `:80-83`). Three `if (spw_json_get …); then
   echo …; exit 1; fi` negative guards on the strict provenance reader — a
   non-standard JSON constant, a document nested 257 deep, and a non-object
   top level must each be rejected. All start with `if`.
3. **+1** (`:513-516`). `if run_probe >…; then echo "probe unexpectedly
   accepted malformed update-control inspection" >&2; exit 1; fi`. Starts
   with `if`.
4. **+8** (`:423`, `:450`, `:499`, `:582`, `:593`, `:601`, `:610`, `:623`).
   `assert_probe_tmp_empty`'s eight argument-less call sites, invisible to the
   mechanical regex for want of a trailing space. See the counting rule above.
5. **-10** (`:323-328`, `:532-534`, `:378`). The three helper definitions'
   own matching body lines, each double-billed against call sites the ledger
   already credits: six for `assert_probe_porcelain` (eleven call sites at
   `:391`, `:438`, `:494`, `:509`, `:557`, `:563`, `:569`, `:580`, `:591`,
   `:599`, `:608`), three for `assert_preflight_failure` (three call sites at
   `:540`, `:546`, `:548`), and one for `assert_probe_tmp_empty` (whose eight
   call sites divergence 4 credits).
6. **-1** (`:631`). `[ "$failed" -eq 0 ] || exit "$failed"` propagates the two
   `spw_section` results into the driver's own exit status. It has the bare
   `[ ... ]` shape the mechanical regex matches, but it asserts nothing about
   probe — it is harness bookkeeping, so it contributes no item to the ledger
   below, neither ported nor retired, and is excluded outright.

Net: additions (divergences 1-4) = 4 + 3 + 1 + 8 = +16. Subtractions
(divergence 5) = -10. The `:631` exclusion = -1. Total: 16 - 10 - 1 = **+5**,
written as the shorthand +16/-11/net5. 113 + 5 = **118**, matching the
executable declaration below.

## Notes on two port constructions

**Why the replay-ordering case is driven by an exhausted listing sequence.**
`tests/baseline/probe.test.js`'s "adapter messages precede the error line on a
controlled failure" needs a *controlled* adapter failure whose envelope also
carries messages. The obvious lever, `pluginListRc: 1`, cannot supply one:
`listingCommand` (`src/adapter.ts:233-242`) logs only the child's **stderr**,
and the fake writes nothing there when it is merely returning a non-zero
status, so the envelope carries no messages at all and `error:` lands at index
0 — an ordering assertion built on it would pass vacuously or fail for the
wrong reason. Exhausting the configured listing sequence is the failure that
does write to the child's stderr (`tests/bin/lifecycle-fakes.js:145-167`), so
that one fixture proves both the replay ordering and `nextPluginList`'s
fail-closed branch: were the fake to repeat its last listing instead, the
ownership inspection would succeed and the run would exit 0.

**Why the identity matrix and scenario 1 need two listings per run.** Probe
issues `codex plugin list --json` twice per run — once for
`inspect --view fingerprint` (`src/adapter.ts:797`), once for
`inspect --view ownership` (`:871`) — as two separate processes with
byte-identical argv. The shell driver stubbed the *adapter* and so could feed
the two views independently (`SPW_PROBE_FINGERPRINT_JSON` vs
`SPW_PROBE_PLUGIN_JSON`, `:212-215`). The in-process port stubs only `codex`,
so `seedCodex` takes an ordered array and the fake advances an on-disk counter.
A case that runs probe twice needs four listings, not two.

## Assertion inventory

<!-- inventory:mapped:start -->

### `test_probe_status`: defensive source display (`:19-22`)

1. An acceptable source passes through `spw_display_source` unchanged
   (`:19-20`). **Retired**: `tests/unit/selection.test.js:156-160` asserts the
   identical property of `displaySource`, which is the function
   `src/commands/probe.ts:325` actually calls.
2. A credential-bearing source renders as `<redacted-source>` (`:21-22`).
   **Retired**: `tests/unit/selection.test.js:161-164`.

### `test_probe_status`: `spw_status_for_commits` branch order (`:24-31`)

3-10. The eight status rows — absent generated, stale generated, matching
   generated with no fingerprint, matching generated with a foreign
   fingerprint, stale generated with a matching fingerprint, stale generated
   with a matching short fingerprint, all three equal, and all three equal
   with a short fingerprint. Port: `tests/unit/status.test.js:39-46`, one
   assertion per shell line in the same order.

### `test_probe_status`: `spw_commit_matches` (`:35-38`)

11. A full SHA matches itself (`:35`). Port: `tests/unit/status.test.js:21`.
12. A 7-character prefix matches (`:36`). Port: `:22`.
13. A different commit does not match (`:37`). Port: `:26`.
14. An empty observed commit never matches (`:38`) — the load-bearing
    invariant, without which an absent generated tree reads as current. Port:
    `:34`.

### `PROV-READER-STRICT-01` strict provenance reader profile (`:43-99`)

Every item in this cluster is retired to `tests/unit/provenance.test.js:55`,
which this task's traceability re-point makes `PROV-READER-STRICT-01`'s
selector. The shell marker was a second home for behaviour already ported; no
new coverage is written for it here.

15. A non-standard JSON constant is rejected (`:47-50`). **Retired**:
    `tests/unit/provenance.test.js:79-86` rejects `NaN` and `Infinity`.
16. A document nested 257 deep is rejected (`:52-56`). **Retired**:
    `tests/unit/provenance.test.js:75-76`.
17. The depth diagnostic reads `JSON nesting exceeds limit` (`:57`).
    **Retired**: the strict reader's rejection is pinned by item 16's
    citation, which constrains the error class rather than its wording; the
    exact phrase survives only where it is still emitted, and is pinned there
    by `tests/unit/manifest-overlay.test.js:111` and
    `tests/baseline/selection-state.test.js:338`.
18. A document nested 255 deep is accepted and its field read (`:74-75`).
    **Retired**: `tests/unit/provenance.test.js:71-74`.
19. A duplicate key resolves to the last occurrence (`:77-78`). **Retired**:
    `tests/unit/provenance.test.js:60-63`.
20. A missing field on an empty object reads as empty (`:85`). **Retired**:
    `tests/unit/provenance.test.js:65`.
21. A non-object top level is rejected (`:80-83`). **Retired**:
    `tests/unit/provenance.test.js:79-86` includes `"[]"`.
22. A document larger than 1 MiB is still read (`:98-99`). **Retired**:
    `tests/unit/provenance.test.js:99-104`.

### `PROV-READER-LENIENT-01` lenient commit reader profile (`:101-138`)

Retired to `tests/unit/provenance.test.js:106` for the same reason as the
strict cluster above.

23. A non-standard constant yields the empty string (`:105`). **Retired**:
    `tests/unit/provenance.test.js:120-133`.
24. A 2000-deep document yields the empty string (`:115`). **Retired**:
    `tests/unit/provenance.test.js:146-147`.
25. A duplicate key resolves to the last occurrence (`:117-118`). **Retired**:
    `tests/unit/provenance.test.js:113-114`.
26. A document larger than 1 MiB is still read (`:131-132`). **Retired**: the
    lenient unit test has no explicit >1 MiB case; both readers share
    `parseStrictJson`, which imposes no byte limit, and item 22's citation
    pins the acceptance on the strict side. This is the weakest retirement in
    the file — it rests on a shared code path rather than on a literal
    counterpart.
27. A 7-hex commit is not acceptable (`:134`). **Retired**:
    `tests/unit/provenance.test.js:121`.
28. Five malformed or wrong-typed documents each yield the empty string
    (`:137`, a loop counted once per the established "count the loop line,
    not the iterations" convention). **Retired**:
    `tests/unit/provenance.test.js:120-133`.

### `test_probe_status`: `spw_generated_commit_or_empty` (`:140-177`)

29. Malformed generated provenance yields the empty string (`:145`). Port:
    `tests/baseline/probe.test.js`'s "malformed generated provenance reads as
    absent rather than aborting", which asserts `generated_commit=` end to
    end.
30. A non-string commit yields the empty string (`:148`). **Retired**:
    `tests/unit/provenance.test.js:120-133` (`'{"commit":42}'`).
31. A non-commit-shaped string yields the empty string (`:151`). **Retired**:
    same citation.
32. A valid 40-hex commit is returned (`:154`). Port: every successful case in
    `tests/baseline/probe.test.js` asserts `generated_commit=<the seeded
    commit>`.
33. `spw_generated_metadata_path` does not clobber the caller's `$root`
    (`:160`). **Retired**: structurally impossible in the port —
    `generatedMetadataPath` is a pure function of its argument with no shell
    global namespace to leak into.
34. It does not clobber the caller's `$generated_root` (`:161`). **Retired**,
    same rationale.
35. It does not clobber the caller's `$generated_metadata` (`:162`).
    **Retired**, same rationale.
36. It prints the expected metadata path (`:163`). **Retired**:
    `tests/unit/provenance.test.js:207-211`.
37. `spw_generated_commit_or_empty` does not clobber the caller's `$root`
    (`:168`). **Retired**, same rationale as item 33.
38. It does not clobber the caller's `$generated_root` (`:169`). **Retired**,
    same rationale.
39. It does not clobber the caller's `$generated_metadata` (`:170`).
    **Retired**, same rationale.
40. It prints the expected commit (`:171`). **Retired**:
    `tests/unit/provenance.test.js:202-204`.
41. An unreadable metadata file reads as empty rather than aborting (`:175`).
    **Retired**: `readGeneratedCommitLenient` routes every read failure
    through one `catch`, and `tests/unit/provenance.test.js:199-200` pins that
    catch's result for the absent-file case. A mode-000 file is the same
    branch, and the shell itself guarded the case behind `[ ! -r ]` because it
    does not hold for root.

### `test_probe_commands` scenario 1: malformed installed metadata (`:385-423`)

42. Malformed installed provenance falls back to the manifest short SHA, with
    the generated tree current and identity `neither` (`:391`, one
    `assert_probe_porcelain` call site bundling six checks). Port:
    `tests/baseline/probe.test.js`'s "malformed installed metadata falls back
    to the manifest short SHA".
43. The adapter was invoked as `inspect --view fingerprint` (`:392`).
    **Retired**: the assertion reads the recording `SPW_ADAPTER`'s log, and
    in-process probe calls `runAdapter` as a function — there is no adapter
    process and no `SPW_ADAPTER` seam. `tests/bin/probe-fakes.js:23-29` turns
    any adapter *spawn* into a loud fixture failure, and the view's result
    (`installed_commit`) is asserted by item 42, so "this view ran" is now
    proved by its output rather than by a dispatch log.
44. The adapter was invoked as `inspect --view ownership` (`:393`).
    **Retired**, same rationale; the view's result is `identity_state`.
45. The adapter was invoked as `inspect --view update-control` (`:394`).
    **Retired**, same rationale; the view's result is `update_control`.
46. The porcelain key list is exactly the seventeen names, in order
    (`:413`, comparing against the literal block at `:395-411`). Port:
    `tests/baseline/probe.test.js` compares the emitted keys against
    `PROBE_PORCELAIN_KEYS` imported from `dist/commands/probe.js`, which is
    derived from the one ordered `fields()` table rather than a second
    hand-written list.
47. `selection_origin=environment` (`:414`). Port.
48. `selection_mode=override` (`:415`). Port.
49. `upstream_source_origin=environment` (`:416`). Port.
50. `effective_source` is the environment source (`:417`). Port.
51. `saved_mode=none` (`:418`). Port.
52. `saved_source` is empty (`:419`) — not `<redacted-source>`, which is what
    `displaySource("")` would render. Port: the assertion is annotated with
    that reasoning, and removing the conditional at
    `src/commands/probe.ts:329-330` turns it red.
53. `saved_requested_ref` is empty (`:420`). Port.
54. `saved_resolved_ref` is empty (`:421`). Port.
55. `saved_commit` is empty (`:422`). Port.
56. Probe's `TMPDIR` holds nothing afterwards (`:423`). **Retired**:
    in-process probe creates no invocation workspace of its own, so the
    assertion has no subject left — see port-only item 2. The adapter's own
    workspace lifecycle is `withWorkspace`'s contract, covered by
    `tests/unit/workspace.test.js`.

### `test_probe_commands`: a saved exact pin is authoritative (`:428-450`)

57. The pinned selection reports the manifest short SHA and stays current
    (`:438`, one `assert_probe_porcelain` call site). Port:
    `tests/baseline/probe.test.js`'s "a saved exact pin stays authoritative
    after its source disappears".
58. `selection_origin=user-config` (`:439`). Port.
59. `selection_mode=pinned` (`:440`). Port.
60. `upstream_source_origin=user-config` (`:441`). Port.
61. `effective_source` is the saved source (`:442`). Port.
62. `saved_mode=pinned` (`:443`). Port.
63. `saved_source` is the saved source (`:444`). Port.
64. `saved_requested_ref` is the saved requested ref (`:445`). Port.
65. `saved_resolved_ref` is the saved resolved ref (`:446`). Port.
66. `saved_commit` is the saved commit (`:447`). Port.
67. No Git process ran (`:448`, an empty recording-`git` log). Port: the port
    has no recording `git`, and uses the stronger construction the shell set
    up alongside it — the saved source is renamed away for the whole run, so
    any `ls-remote` would fail loudly, and the run still succeeds.
68. The adapter was invoked as `inspect --view update-control` (`:449`).
    **Retired**, same rationale as item 43.
69. Probe's `TMPDIR` holds nothing afterwards (`:450`). **Retired**, same
    rationale as item 56.

### `test_probe_commands`: an environment ref overrides only the ref (`:452-475`)

70. `selection_origin=environment` (`:456`). Port:
    `tests/baseline/probe.test.js`'s "an environment ref overrides only the
    ref side and the saved fields stay visible".
71. `upstream_source_origin=user-config` (`:457`). Port.
72. `saved_mode=pinned` (`:458`). Port.
73. `saved_commit` survives the override (`:459`). Port.
74. No Git process ran (`:460`). Port: same renamed-away-source construction
    as item 67 — a 40-hex `SUPERPOWERS_REF` resolves as `raw-commit` without
    Git (`src/upstream.ts:160-162`), and the run succeeds with the source
    absent.
75. Human output: `selection origin: environment` (`:464`). Port.
76. Human output: `selection mode: override` (`:465`). Port.
77. Human output: `upstream source origin: user-config` (`:466`). Port.
78. Human output: `effective source: <source>` (`:467`). Port.
79. Human output: `saved mode: pinned` (`:468`). Port.
80. Human output: `saved source: <source>` (`:469`). Port.
81. Human output: `saved requested ref: <ref>` (`:470`). Port.
82. Human output: `saved resolved ref: <ref>` (`:471`). Port.
83. Human output: `saved commit: <commit>` (`:472`). Port.
84. Human output: `update control: managed` (`:473`). Port.
85. Human output carries the mixed-origin warning verbatim (`:474-475`).
    Port.

### `test_probe_commands`: a dash-prefixed local source (`:479-499`)

**Narrowing, recorded for honesty (slice 2 fix wave).** The port's
dash-prefixed source is `join(c.dir, "-upstream")`
(`tests/baseline/probe.test.js:284`) — an *absolute path* whose basename
begins with `-`. `git` therefore never receives a token it could read as an
option, and the `--` terminator is not load-bearing in these cases. Items
86-89 are unaffected: they assert selection mode, effective source, and
`saved_source`, none of which depend on the terminator. Item 90, the one that
was about `--` placement, is retired below on a structural rationale. The
case that does put a bare relative `-upstream` on a Git command line is
`tests/baseline/selection-commands.test.js:504-542`.

86. A `track-latest` selection over a dash-prefixed source reports the
    manifest short SHA and stays current (`:494`, one
    `assert_probe_porcelain` call site). Port:
    `tests/baseline/probe.test.js`'s "a dash-prefixed local source saved by
    track-latest stays usable".
87. `selection_mode=track-latest` (`:495`). Port.
88. `effective_source` is the dash-prefixed path (`:496`). Port.
89. `saved_source` is the dash-prefixed path (`:497`). Port.
90. The recording `git` saw `ls-remote --tags -- <path> refs/tags/v*`
    (`:498`). **Retired**: the port has no recording `git` to read an argv
    from. `resolveRef` writes the `--` separator into a literal array
    (`src/upstream.ts:140-147`), so the placement is structural rather than
    something a run can vary; the port asserts the observable consequence
    instead — `requested_ref=latest-release`, `resolved_ref=v1.0.0`, and
    `desired_commit=<the tag's commit>`, which only hold if the ls-remote
    against the dash-prefixed source actually resolved.
91. Probe's `TMPDIR` holds nothing afterwards (`:499`). **Retired**, same
    rationale as item 56.

### `PROBE-FAIL-CLOSED-01` invalid selection and adapter evidence (`:501-550`)

92. An honestly `unsupported` update control is reportable rather than fatal
    (`:509`, one `assert_probe_porcelain` call site with
    `SPW_EXPECTED_UPDATE_CONTROL=unsupported`). **Retired**: the shell
    injected the value through the recording `SPW_ADAPTER` (`:216-227`).
    In-process, `runInspect` answers the `update-control` view itself and
    returns the literal `managed` (`src/adapter.ts:781-783`), so no seam to
    inject through survives.

    **Slice 5, read this before retiring anything.** The single surviving
    witness in the repository that any inspection can report
    `update_control=unsupported` at all is `tests/test_adapter_protocol.sh:99-101`
    (the `update-control-unsupported` adapter fixture). **There is no
    TypeScript counterpart yet**: `tests/unit/adapter-protocol.test.js`
    contains exactly three tests — command byte escaping (`:36`), message-log
    splitting (`:63`), and serializer shape (`:76`) — and not one occurrence
    of `update-control`, `update_control`, or `unsupported`. Retiring that
    shell suite without first porting `:99-101` would delete the property
    outright.

    Three nearby suites look like substitutes and are not. Each writes
    `unsupported` into a stubbed adapter *state* to prove a command **refuses
    to act** on it, which is gating, not reporting:
    `tests/baseline/cli-parity.test.js:1595-1615` (`UPDATE-CONTROL-01`,
    `update` refuses), `tests/bin/install-commands.test.js:504`/`:536`, and
    `tests/bin/uninstall-commands.test.js:223`. None of them exercises an
    inspection producing the value.
93. A malformed update-control inspection is an operational failure
    (`:513-516`). **Retired**: same injection seam, same slice-5 disposition
    owner. Nothing witnesses the `update-control`-specific injection any more,
    because the seam is gone; the nearest adapter-layer neighbour,
    `tests/test_adapter_protocol.sh:111-123`, drives a *controlled failure*
    envelope for that view rather than an unparseable one. What is *not* lost
    is the general fail-closed property for a malformed inspection response:
    the port drives it through the fingerprint view in
    `tests/baseline/probe.test.js`'s `PROBE-FAIL-CLOSED-01` clause 2, and the
    validator-layer rejection of a truncated envelope is pinned by
    `tests/test_adapter_protocol.py:608-618`.
94. A malformed `selection.json` fails before Git and adapter access
    (`:540`, one `assert_preflight_failure` call site bundling four checks).
    Port: `tests/baseline/probe.test.js`'s `PROBE-FAIL-CLOSED-01`, first
    sub-case; the empty-adapter-log check becomes `existsSync(c.codexLog)`
    being false, since the fake `codex` logs every invocation it receives.
95. An unsupported `schema_version` fails the same way (`:546`). Port: second
    sub-case.
96. A credential-bearing source fails the same way (`:548-550`). Port: third
    sub-case.

### `test_probe_commands`: every validated identity state (`:552-572`)

97. `identity_state=manager` (`:557`). Port:
    `tests/baseline/probe.test.js`'s "probe reports every validated identity
    state without mutating anything", first row.
98. `identity_state=legacy` (`:563`). Port: second row.
99. `identity_state=both` (`:569`). Port: third row. The port adds a fourth
    row for `neither` and a before/after tree snapshot on all four; both are
    inside this item, not new items.

### `test_probe_commands` scenario 1b: invalid provenance, valid manifest (`:574-582`)

100. Semantically invalid installed provenance falls through to the manifest
     fingerprint (`:580`). Port: `tests/baseline/probe.test.js`'s
     "semantically invalid installed provenance falls through to the
     manifest".
101. The adapter was invoked as `inspect --view fingerprint` (`:581`).
     **Retired**, same rationale as item 43.
102. Probe's `TMPDIR` holds nothing afterwards (`:582`). **Retired**, same
     rationale as item 56.

### `test_probe_commands` scenario 2: no active plugin (`:584-593`)

103. With no active plugin the fingerprint is null and the status is
     `needs install` (`:591`). Port: `tests/baseline/probe.test.js`'s "no
     active plugin yields a null fingerprint and needs install".
104. The adapter was invoked as `inspect --view fingerprint` (`:592`).
     **Retired**, same rationale as item 43.
105. Probe's `TMPDIR` holds nothing afterwards (`:593`). **Retired**, same
     rationale as item 56.

### `test_probe_commands` scenario 2b: no installed manifest (`:595-601`)

106. An absent manifest also yields a null fingerprint (`:599`). Port:
     `tests/baseline/probe.test.js`'s "an absent installed manifest also
     yields a null fingerprint".
107. The adapter was invoked as `inspect --view fingerprint` (`:600`).
     **Retired**, same rationale as item 43.
108. Probe's `TMPDIR` holds nothing afterwards (`:601`). **Retired**, same
     rationale as item 56.

### `test_probe_commands` scenario 3: stale generated provenance (`:603-610`)

109. Stale generated provenance outranks a null fingerprint and keeps the
     status at `needs prepare` (`:608`). Port:
     `tests/baseline/probe.test.js`'s "stale generated provenance outranks a
     null installed fingerprint".
110. The adapter was invoked as `inspect --view fingerprint` (`:609`).
     **Retired**, same rationale as item 43.
111. Probe's `TMPDIR` holds nothing afterwards (`:610`). **Retired**, same
     rationale as item 56.

### `test_probe_commands` scenario 4: malformed generated provenance (`:612-623`)

112. `desired_commit` still reports (`:617`). Port:
     `tests/baseline/probe.test.js`'s "malformed generated provenance reads
     as absent rather than aborting".
113. `generated_commit` is empty (`:618`). Port.
114. `installed_commit` is empty (`:619`). Port.
115. `identity_state=neither` (`:620`). Port.
116. `status=needs prepare` (`:621`). Port.
117. The adapter was invoked as `inspect --view fingerprint` (`:622`).
     **Retired**, same rationale as item 43.
118. Probe's `TMPDIR` holds nothing afterwards (`:623`). **Retired**, same
     rationale as item 56.

<!-- inventory:mapped:end -->

## Port-only assertions (outside the 1:1 mapping)

Three deliberate narrowings, none with a shell counterpart to map onto.

<!-- inventory:port-only:start -->

1. Strict argument rejection. `scripts/probe:42` tested only
   `[ "${1:-}" = "--porcelain" ]`, so a typo'd flag silently produced human
   output and a trailing argument was ignored outright. The port accepts
   exactly `[]` or `["--porcelain"]` and otherwise emits a usage error and
   exits 2.

   **Corrected in the slice 2 fix wave.** This entry previously cited only
   `src/commands/probe.ts:347-351` and claimed parity with the strict arity
   slice 1 gave `unpin` and `track-latest`. That was wrong on both counts: the
   handler-side guard writes `PROBE_USAGE` alone, with no usage block, and it
   runs *after* preflight — so on a machine without `codex` the same input
   exited 1, not 2. `unpin` and `track-latest` get their arity from
   `parseArgs`. The production path is now `src/cli.ts`'s `parseArgs` `probe`
   branch, which returns a `usage-error` before preflight and makes `main()`
   print `error: usage: superpowers-manager probe [--porcelain]` followed by
   the full usage block. `PROBE_USAGE` survives as the same
   unreachable-from-CLI duplicate its two siblings carry.

   Ports: `tests/bin/units.test.js` (four `parseArgs` usage-error inputs plus
   the exact message), `tests/baseline/cli-parity.test.js`'s `CLI-USAGE-01`
   (two end-to-end rows, plus a standalone block with `codex` genuinely absent
   that pins the before-preflight ordering), and
   `tests/unit/commands-probe.test.js:134` ("an unrecognised argument is a
   usage error on stderr") for the handler-side duplicate.
2. The absent invocation workspace. `assert_probe_tmp_empty`
   (`tests/test_probe.sh:377-383`) asserted that the `TMPDIR` handed to
   `scripts/probe` held nothing afterwards, which covered both probe's own
   `mktemp -d` workspace and any adapter sidecar left in the same directory.
   In-process probe creates no workspace at all, and the adapter's workspaces
   are rooted at `os.tmpdir()` — read from the *runner's* environment by
   `withWorkspace`'s caller (`src/adapter.ts:789`, `:863`), not from the
   context env a case controls — so an equivalent assertion on the case's own
   `TMPDIR` would be vacuously true no matter what either component did.
   The surviving property, that `withWorkspace` removes what it created, is
   covered by `tests/unit/workspace.test.js`. Items 56, 69, 91, 102, 105,
   108, 111, and 118 are retired against this entry.
3. The `process.exit()` sites in `tests/bin/install-fakes.js` and
   `tests/bin/uninstall-fakes.js`. PR 11.5 slice 2 extracted only the read
   side of the three lifecycle fakes into `tests/bin/lifecycle-fakes.js`,
   where every response-then-exit site uses `process.exitCode` plus a normal
   return so a pending pipe write cannot be truncated. PR 11.5 slice 4a
   converted the two fakes' remaining *mutation* branches the same way: all
   **31** sites — nineteen **originating in** `install-fakes.js`, twelve
   **originating in** `uninstall-fakes.js` — now use `process.exitCode` plus
   an explicit `return` wherever control previously terminated there and code
   follows. *The 19/12 split is the **pre-conversion origin** of the 31, not a
   census of either file at `HEAD`; ten of the 31 have since moved into the
   shared shell, as the next paragraph states.*
   An earlier revision of this entry said "33 sites across both files" and
   was wrong twice. **33** was a raw `grep -c 'process\.exit('` figure that
   also counted the header comment on line 9 of each file, which names
   `process.exit()` in prose rather than calling it; the true call-site count
   is 31. **"Across both files"** stopped being true when slice 4a's later
   shared-shell extraction moved each fake's `90`/`95`/`96`/`97`/`98`
   branches — five of the 31 per file, ten in all — into five shared sites in
   `tests/bin/lifecycle-fakes.js`, alongside the shared `94` adapter tripwire
   that was already `process.exitCode` before the conversion. Twenty-one of
   the 31 stayed put: fourteen in `install-fakes.js`, seven in
   `uninstall-fakes.js`. `install-fakes.js` and `uninstall-fakes.js` both
   cite this inventory at their `:8-9`, which is why the entry is recorded
   here rather than in an install- or uninstall-scoped file.

   `tests/unit/helpers/pipe-flush-child.js` proves the idiom is load-bearing
   on a pipe, not cosmetic: a 1 MiB write followed by `process.exit(0)`
   truncates to the 64 KiB POSIX pipe buffer (65536 of 1048576 bytes
   delivered), while the same write followed by `process.exitCode = 0`
   delivers all 1048576 bytes — deterministically, because the writer's own
   `process.exit()` discards its own queued write via a single
   `uv_try_write` that fills the pipe to capacity. This is truncation
   demonstrated by the writer's own exit call, with **no reader that closes
   the pipe mid-write** — the earlier text in this entry claiming such a
   reader was required was wrong, not merely stale.

   **Accepted coverage gap:** no test exercises a converted line itself.
   Both new tests (the pipe-flush mutation proof and the oversized-listing
   regression guard in `tests/bin/lifecycle-fixture.test.js`) pass with the
   slice 4a conversion reverted back to `process.exit()`, because neither
   spawns install-fakes.js/uninstall-fakes.js with a payload sized to exceed
   the pipe buffer through one of the 31 converted branches specifically.
   Nothing in this inventory's ports guards against a future regression to
   `process.exit()` at any of those 31 sites — in either mutating fake or in
   the shared shell they now delegate to; fall-through correctness at each
   one rests on the site-by-site audit slice 4a did, not on coverage.
   This gap is accepted rather than closed with a new test because these are
   test fakes, not product code: the failure mode is truncated stdout in the
   test harness (a fixture bug that would surface as a flaky or wrong-looking
   assertion), not shipped behaviour reaching a real user. This entry
   documents the carried defect and its resolution without a port citation —
   `tests/bin/lifecycle-fixture.test.js` is not one of this inventory's three
   port files (`tests/baseline/probe.test.js`, `tests/unit/commands-probe.test.js`,
   `tests/unit/status.test.js`), so it does not belong in `ports` below.

<!-- inventory:port-only:end -->

## Surviving `scripts/probe` references (PR 11.5 slice 2, Task 6)

Prose, deliberately not a numbered port-only entry: nothing below is an
assertion this port added, so counting any of it would overstate `portOnly`.

Task 6 flipped `DISPATCH.probe` to `in-process` and **deleted nothing**.
`scripts/probe` survives this slice, because
`scripts/install:18` and `scripts/update:8` still execute
`sh "$root/scripts/probe" --porcelain` and read `identity_state`, `status`,
and `update_control` back out of the porcelain through `spw_probe_field`.
The shell driver `tests/test_probe.sh` is deleted in Task 2 of slice 4c after
its replacement `tests/baseline/probe.test.js` was already landed in slice 2;
the historical source pointers below remain an inventory of what was retired.
Re-pointing those two callers at the in-process command is also rejected for
this slice: their lifecycle fakes stub `SPW_ADAPTER`, a seam only
`scripts/core/adapter.sh` honours and the in-process `runAdapter` does not, so
one command would resolve Codex state through two disagreeing sources. Delete
the script, both callers' probe steps, and `tests/test_probe.sh` together in
the slice that ports `install` and `update`.

Every `scripts/probe` and `test_probe` match in the tree, classified. Two
passes were run (full path and basename), plus a third over the bare `"probe"`
string in `tests/**/*.js`, because a spawn assumption expressed as
`runCli(sandbox, ["probe"], …)` matches neither of the first two patterns.

| Bucket | Site | Why |
|---|---|---|
| Live shell caller | `scripts/install:18`, `scripts/update:8` | Production; the Task 6 Step 9 guard in `tests/bin/units.test.js` asserts both references, and Step 9a proved it fires |
| Live shell caller | `tests/expected_tarball_contents.txt:58` | The script still ships, because those two callers execute it at runtime |
| Retired shell driver | `tests/test_probe.sh:346`, `:353` | Historical source pointers; the driver is deleted in slice 4c Task 2 and its replacement is `tests/baseline/probe.test.js` |
| Executable spawn assumption | `tests/baseline/cli-parity.test.js` — `CLI-ENV-CODEX-PREFLIGHT-01` and the four `CLI-CHILD-STATUS-01` blocks | Re-pointed to `install`, vehicle-only comment added |
| Executable spawn assumption | `tests/baseline/cli-parity.test.js` — `CLI-PREFLIGHT-01`'s requirements map | Replaced by a derivation over `commandRequirements()` and `DISPATCH`; the hand-written map encoded dispatch a second time through the presence of `sh` |
| Executable spawn assumption | `tests/baseline/cli-parity.test.js` — `CLI-COMMANDS-01`'s `probe` row | Now takes the in-process branch; given a local upstream, a 40-hex ref, and a listing-answering `codex`, since an `exit 0` stub and the package-default upstream URL are respectively unusable and non-hermetic for a command that actually reads Codex state |
| Executable spawn assumption | `tests/baseline/cli-parity.test.js` — `PROBE-READONLY-01` | Rewritten, not re-pointed: it drove the real script through an `SPW_ADAPTER` stub that no longer takes effect |
| Executable spawn assumption | `tests/bin/bin-dispatch.test.js` — `ROUTING_CASES[0]` | Removed; see `bin-dispatch.md` item 7's retirement note |
| Executable spawn assumption | `tests/bin/bin-dispatch.test.js` — exit-code propagation | Re-pointed to `install`; an in-process command has no child whose status could propagate |
| Executable spawn assumption | `tests/bin/bin-dispatch.test.js` — the no-registered-handler backstop | Re-pointed to `prepare`: `probe` now has a registered handler, so overriding its dispatch entry no longer reaches the backstop |
| Executable spawn assumption | `tests/bin/units.test.js:150-169` ("buildSpawn: POSIX executes the script directly") | `buildSpawn` path construction and argv passthrough, re-pointed to `prepare` at this slice. A pure path computation, so it kept passing while asserting the spawn path of a command that is no longer spawned. Slice 3.4 replaced the `prepare` literal with a `vehicleCommand(DISPATCH)` derivation, which is why the block no longer names a command |
| Historical prose | `src/commands/probe.ts` (7 sites), `src/effective-selection.ts:70`, `:91` | Provenance citations into the shell original, which still exists, so every citation still resolves |
| Historical prose | `tests/migration-inventory/probe.md`, `install-commands.md:746`, `:760`, `selection-state.md:237` | The migration record of what the shell did |
| Historical prose | `tests/unit/commands-probe.test.js:70`, `:77`, `:106`; `tests/baseline/probe.test.js:4`, `:155`, `:234`, `:398`; `tests/bin/probe-fakes.js:4`; `tests/baseline/selection-location.test.js:26`, `:788` | Comments citing the shell original as the source of a ported contract |
| Historical prose | `AGENTS.md:46` | "Keep `scripts/probe` read-only" still binds the surviving script, and `PROBE-READONLY-01` now holds the same property for the in-process command |

`tests/bin/units.test.js:18-22` (`parseArgs(["probe", "--porcelain"])`), `:88`
(the no-argument `run` loop), and `:194-199` (`preflight("probe", …)` must
report `codex`) mention `probe` and are deliberately unchanged: `parseArgs` is
dispatch-independent, and `COMMAND_REQUIREMENTS.probe` keeps `codex` — only
`python3` left it.
`tests/bin/bin-dispatch.test.js`'s "missing codex blocks `probe`" case also
stays on `probe`: it is the end-to-end net for that same requirement row, not
a spawn vehicle. See the note on `bin-dispatch.md` items 42-44.

## Cardinality

**POINTER PROVENANCE — shell-original pointers.** The deleting commit cannot
name its own SHA: a commit that deletes `tests/test_probe.sh` cannot also be
the commit in which that path is readable. The anchor for every shell-original
citation in this inventory is the last commit in which the driver existed:
`f58289ed00b95635ffc4ea589b845ce83a7404ba`. It was verified before deletion
with `git show f58289ed00b95635ffc4ea589b845ce83a7404ba:tests/test_probe.sh`
(resolves) and `git merge-base --is-ancestor
f58289ed00b95635ffc4ea589b845ce83a7404ba origin/main` (reachable). The
citations are therefore intentionally no longer resolvable at `HEAD`; use
`git show f58289ed00b95635ffc4ea589b845ce83a7404ba:tests/test_probe.sh` to
inspect the shell original.

```json inventory
{
  "shellOriginal": 118,
  "portOnly": 3,
  "ports": {
    "tests/baseline/probe.test.js": 14,
    "tests/unit/commands-probe.test.js": 11,
    "tests/unit/status.test.js": 4
  }
}
```

- Shell original: **118** assertions (41 in `test_probe_status`: 2 source
  display, 8 status branch order, 4 commit matching, 8 strict reader, 6
  lenient reader, 13 generated-commit reader; 77 in `test_probe_commands`: 15
  scenario 1, 13 saved pin, 16 environment override, 6 dash-prefixed source,
  5 `PROBE-FAIL-CLOSED-01`, 3 identity matrix, 3 scenario 1b, 3 scenario 2, 3
  scenario 2b, 3 scenario 3, 7 scenario 4; sum:
  2+8+4+8+6+13+15+13+16+6+5+3+3+3+3+3+7 = 118). See "Divergences from the
  derived 113" above for the full +16/-11/net5 derivation from the mechanical
  113.
- Ports: `tests/baseline/probe.test.js` has 14 static `test(` call sites (the
  hermeticity guard on the shared case environment, seven end-to-end scenario
  cases, the identity matrix, `PROBE-FAIL-CLOSED-01`, the unusable-Codex
  diagnostic case, and the replay-ordering/sequence-exhaustion case);
  `tests/unit/commands-probe.test.js` has 11 (formatting, arity, the frozen
  key list, and `replayEnvelope`); `tests/unit/status.test.js` has 4
  (`commitMatches` and `statusForCommits`).
- Reconciliation: 71 of the 118 shell items are mapped into those ports; the
  rest are **47 retired items** (1-2, 15-28, 30-31, 33-41, 43-45, 56, 68-69,
  90-93, 101-102, 104-105, 107-108, 110-111, 117-118), each with a citation
  to pre-existing coverage that already supersedes it, to a structural
  guarantee that makes a runtime check impossible to violate, or — for the two
  update-control injections and the nine adapter-dispatch-log checks — to the
  removal of the `SPW_ADAPTER` seam the assertion read through, naming the
  suite that still covers the underlying behaviour. 71 + 47 = 118. Plus 3
  port-only assertions with no shell counterpart.
