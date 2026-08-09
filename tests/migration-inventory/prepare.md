# Migration inventory: tests/test_prepare_with_fake_upstream.sh

Source read in full (1278 lines). Ported to `tests/baseline/prepare.test.js`,
`tests/unit/commands-prepare.test.js`, and `tests/unit/atomic.test.js`.

**The shell driver is retained and green in this slice.** `scripts/prepare` is
still executed by `scripts/install:25` and `scripts/update:23`, `DISPATCH.prepare`
is still `spawn`, and this file still runs under `tests/run.sh`. This inventory
records where each shell assertion's property now lives; it does not authorize
deleting the source. See "Surviving `scripts/prepare` references" below.

## Counting rules applied

- Each `test "..." = "..."` / `test -f ...` / `test ! -s ...` line, each bare
  `[ ... ]`, and each `grep -Fq`/`grep -Fxq`/`grep -q` (including bare ones
  relied on by `set -e`), is one assertion — same rule as `bin-dispatch.md`.
- Each `if <command>; then echo …; exit 1; fi` negative guard, where succeeding
  is itself the failure, is one assertion — `bin-dispatch.md`'s rule. This file
  has fifteen at top level; they are enumerated as divergence 1 below.
  The converse shape, `if [ <condition that means failure> ]; then echo …;
  exit 1; fi`, is the same thing written the other way round and is counted the
  same way; `:1255-1259` is the one instance whose condition is a captured exit
  status rather than a filesystem predicate.
- A named helper function whose *own body* contains a line the mechanical regex
  matches, called from one or more call sites the mechanical regex *also*
  matches, is counted once per call site, never once per call site *plus* once
  for the definition — `selection-commands.md`'s rule, itself an extension of
  `selection-state.md`'s item 2. Six helpers here have that shape and are
  enumerated as divergence 2.
- One call site is worth one item however many checks its body bundles —
  `selection-state.md`'s convention for `assert_effective`.
  `assert_hook_prepare_failure` (`:501-532`) bundles four checks (non-zero
  exit, the expected diagnostic, no Python traceback, the prior generated tree
  preserved), `assert_bad_manifest_error` (`:534-563`) bundles four,
  `assert_rejected_manifest_input` (`:565-590`) bundles three,
  `assert_prepare_preflight_failure` (`:731-749`) bundles four (non-zero exit,
  the diagnostic, an empty Git log, an empty adapter log, the sentinel), and
  `assert_generated_tree_matches` (`:459-479`) bundles one `cmp -s`. Each call
  site is still one item.
- A `for` loop's assertion lines are counted once, not once per iteration —
  the established "count the loop line, not the iterations" convention. The
  `BUILDER-SYMLINK-01` loop at `:11-20` runs twice and contributes two items,
  not four.
- Every helper here takes arguments, so no call site is invisible to the
  mechanical regex for want of a trailing space. `probe.md`'s
  `assert_probe_tmp_empty` divergence has no counterpart in this file.
- **Port vs `Retired` is decided by *where* the surviving witness lives, not by
  how closely the construction resembles the shell's.** An item is **Port**
  when the property is asserted inside one of the three files this inventory
  declares in its `ports` block, *even if the asserting case has a different
  trigger or fixture* — `probe.md` set this precedent when it mapped its item
  32 onto "every successful case in `tests/baseline/probe.test.js`" and its
  item 67 onto a deliberately stronger construction than the shell's. An item
  carries the `Retired` label when the surviving witness is outside those three
  files (another suite), when the property is a structural guarantee no runtime
  check could violate, or when the seam the assertion read through no longer
  exists.
  Applied here, items 14 and 149 both cite case 21 for a property the shell
  asserted under a different trigger, and both are therefore Port; before this
  rule was written down they carried opposite labels.

## Divergences from the derived 158

The mechanical count
(`grep -cE '^[[:space:]]*(test |\[ |assert_[a-z_]+ |grep -[A-Za-z]*q)|\| *grep -[A-Za-z]*q' tests/test_prepare_with_fake_upstream.sh`)
returns **158**. Two divergences apply, in both directions:

1. **+15** (`:656-660`, `:673-678`, `:701-704`, `:836-839`, `:903-906`,
   `:921-924`, `:925-929`, `:963-966`, `:1051-1055`, `:1057-1061`,
   `:1084-1087`, `:1110-1119`, `:1130-1143`, `:1208-1211`, `:1255-1259`).
   Fifteen top-level `if …; then echo …; exit 1; fi` guards. All start with
   `if`, so the mechanical regex sees none of them. Three of the fifteen wrap a
   whole `prepare` run that must fail (`:673`, `:1110`, `:1130`), one wraps a
   sourced `spw_json_get` invocation that must fail (`:1051`), two forbid an
   `ls-remote` in the recording Git log (`:656`, `:701`), eight are
   filesystem-shape predicates on the generated tree (`:836`, `:903`, `:921`,
   `:925`, `:963`, `:1057`, `:1084`, `:1208`), and one checks a captured exit
   status (`:1255`). The two guards that pipe `find` into `grep -q` (`:1145`,
   `:1202`) are **not** in this list: the mechanical regex's
   `\| *grep -[A-Za-z]*q` alternative already matches them.
2. **-10** (`:528`, `:559`, `:595`, `:602`, `:609`, `:618`, `:745`, `:746`,
   `:747`, `:748`). Six helper definitions' own matching body lines, each
   double-billed against call sites the ledger already credits:
   one for `assert_hook_prepare_failure` (`:528`, sixteen call sites at `:999`
   through `:1044`), one for `assert_bad_manifest_error` (`:559`, one call site
   at `:972`), one each for `assert_prepare_version` (`:595`),
   `assert_prepare_commit` (`:602`), `assert_prepare_upstream_manifest_version`
   (`:609`), and `assert_prepare_metadata_value` (`:618`) — all four wrap
   `assert_json_string`, and all four are called only from matched call sites —
   and four for `assert_prepare_preflight_failure` (`:745-748`, three call
   sites at `:754`, `:761`, `:765`).

Net: additions = +15. Subtractions = -10. Total: 15 - 10 = **+5**, written as
the shorthand +15/-10/net5. 158 + 5 = **163**, matching the executable
declaration below. There is no harness-bookkeeping exclusion in this file:
`probe.md`'s `:631` `[ "$failed" -eq 0 ] || exit "$failed"` line has no
counterpart, because this driver runs no `spw_section` and propagates nothing.

## Notes on four port constructions

**Why the fixture has eight upstream branches and the design said seven.**
`tests/baseline/prepare-fixture.js:131-270` builds a manifest-less base commit
on `main` plus seven manifest-bearing branches. The eighth exists because
`tests/fixtures/baseline/generated-tree/declared-hooks.txt` was captured from
the shell's `hooks-string-array` branch (`:212-217`, `:864-876`), whose manifest
declares **two** hook paths as a string array with both targets outside
`hooks/`. The design mapped that layout fixture onto the single-path
`upstream-active-hooks.json` branch, which cannot produce it: a single declared
path yields neither `config/` nor `alternate/`. So `REFS.declaredHooks` points
at a new `hooks-string-array` branch and `REFS.activeHooks` at the original
single-path one. **Case 6 (`GENERATED-HOOKS-DECLARED-01
GENERATED-UNKNOWN-FIELDS-01`) exercises both halves in one case**; every item
below that cites case 6 names which half.

**Why case 24's pinned half is not a splice-collapse assertion.** The pinned
half of "prepare keeps hostile git output off its stream on both fetch branches"
points a saved pin at a directory that is not a repository. Git writes five
lines, and it is tempting to read the case as pinning `oneLine()`'s collapse.
It does not: `UNAVAILABLE_OBJECT_RE` does not match git's "does not appear to be
a git repository", so `proveCommit` takes its **hand-written non-splicing
branch** at `src/upstream.ts:277` and git's output is discarded by the callee.
The case asserts the exact single-line message, which is strictly stronger than
a shape check, and no inventory item below claims a splice site is exercised.
`fetchExactCommit`'s three splice sites (`src/upstream.ts:334`, `:349`, and
`proveCommit`'s init at `:262`) are unreachable from outside the process; case
24's comment records the four input shapes that were tried.

**Why the `[ -d ]` predicate on the cache's `.git` maps to no item.**
`scripts/prepare:50` is `[ -d "$cache/.git" ]`, and
`src/commands/prepare.ts:310` is `directoryExists(join(cache, ".git"))` —
fidelity, not divergence. The shell never asserted it, so it contributes no
mapped item; `tests/unit/commands-prepare.test.js`'s "runPrepare takes the clone
branch, not fetch, when the cache's `.git` is a regular file" is coverage the
shell did not have. It is recorded here as prose rather than as a numbered
port-only entry, because counting it would overstate `portOnly`.

**Three diagnostics whose only witness is still this shell file.** Recorded
here so slice 3.5 cannot delete them by accident.

*(a) `hook subtree escapes or is broken`.* `src/hooks.ts:279` and `:303` emit
it, and no TypeScript test in the repository asserts that string — a full-tree
grep for `escapes or is broken` finds only `symlink escapes or is broken`
(`tests/unit/hooks.test.js:376`, `:393`), `materialized hook destination escapes
or is broken` (`:460`, `:493`), and `generated hook symlink escapes or is
broken` (the validator's own, `tests/unit/generated-plugin.test.js:714`). Items
125, 127, and 128 are retired against a diagnostic with no other witness.

*(b) `hook classification failed:` — the adapter's wrapper prefix.*
`src/adapter.ts:364` emits it, and a full-tree grep finds it **nowhere else
outside this shell file** (`:1001`, `:1004`, `:1007`, `:1010`, `:1013`, `:1016`,
`:1019`, `:1022`). Items 113-120 are the shell's only assertions of that
prefix. Each of them retires to a `classifyHooks` unit test whose *inner*
message is message-exact — that half genuinely holds — but no unit test goes
through the adapter wrapper, so the prefix itself is unwitnessed. The asymmetry
is easy to miss because the materialization twin **is** ported:
`src/adapter.ts:373`'s `hook materialization failed:` is asserted by
`tests/baseline/prepare.test.js:336` and
`tests/baseline/cli-parity.test.js:1622`. Items 121-128 therefore keep a
witnessed prefix; items 113-120 do not.

*(c) The accepted contained relative hooks-root symlink.* `src/hooks.ts:359-360`
recreates such a symlink in the candidate rather than dereferencing it, and
**nothing in the repository exercises the accepting path on either side.** On
the materializing side, `tests/unit/hooks.test.js` covers only the rejecting
root shapes (`:337` absolute, `:351` not a directory). On the validating side,
the only place the hooks *root* is a symlink is the twelve-case matrix in
`tests/baseline/generated-plugin-corpus.test.js`'s "the hook subtree rejects
unsafe symlinks for allowing policies" (`:812-880`), whose `location === "root"`
arm symlinks `hooks` itself and whose every one of the twelve cases asserts
`status === 1`. The two corpus cases items 83-85 lean on do **not** symlink the
root: both "the hook subtree follows a contained directory symlink" (`:886`)
and "the hook subtree accepts contained materialized relative symlinks"
(`:907`) call `mkdirSync(join(state.plugin, "hooks"))`, so `hooks/` is a real
directory and the contained symlink is an *entry inside* it — and `:886` is
itself a rejection case, ending in
`assertRejected(state, "generated hook symlink must be relative")`.

## Assertion inventory

<!-- inventory:mapped:start -->

### `BUILDER-SYMLINK-01` deterministic broken and escaping symlinks (`:10-20`)

1. The builder produced the scenario root for each of `broken-symlink` and
   `escaping-symlink` (`:18`). **Retired**:
   `tests/baseline/cli-parity.test.js`'s `FS-SYMLINK-01 escaping and broken
   symlinks fail closed` (`:1601-1602`) drives the same two
   `tests/builders/baseline-scenario.sh` scenarios and fails if the builder
   stops producing either tree. The parent spec's §11 lists porting
   `baseline-scenario.sh` to Node as unscheduled, so the builder itself is not
   this slice's subject.
2. The scenario target is a symlink (`:19`). **Retired**, same citation: the
   `FS-SYMLINK-01` rows assert the symlink's *effect* — an escaping or broken
   link fails closed — which cannot hold if the link is absent.

### A saved exact pin is authoritative (`:642-662`)

3. The generated provenance carries the saved commit (`:652`). Port:
   `tests/baseline/prepare.test.js`'s "prepare honours a pinned saved
   selection", which asserts `provenance.commit` against the saved record and
   sets no `SUPERPOWERS_REF`, so it is the branch that reaches
   `fetchExactCommit`.
4. The provenance `source` is the saved source (`:653`). Port: same case.
5. The provenance `requested_ref` is the saved requested ref (`:654`). Port:
   the same case asserts the saved ref on stdout (`prepared <ref> at
   <commit>`); the provenance field itself is pinned by "prepare writes
   complete provenance and is idempotent", which asserts all five keys and
   both ref values.
6. The provenance `resolved_ref` is the saved resolved ref (`:655`). Port:
   same two citations.
7. No `ls-remote` ran — a saved exact pin must not be re-resolved (`:656-660`).
   **Retired**: the port has no recording `git` to read an argv log from.
   `tests/unit/effective-selection.test.js`'s "a saved pin short-circuits
   resolution and reports tag kind" asserts the property directly against
   `computeEffectiveSelection`, which is the function
   `src/commands/prepare.ts:290` calls.
8. The recording Git log shows `fetch --no-tags -- <source> <commit>` (`:661`).
   **Retired**: no recording `git`, and the argv is a literal array in
   `fetchExactCommit` (`src/upstream.ts:262-272`), so its shape is structural
   rather than something a run can vary. The observable consequence — the cache
   holds the requested commit object after an exact fetch — is asserted by
   `tests/baseline/ref-resolution.test.js`'s `REF-SOURCE-PROOF-01 selected
   source must supply a commit object`.
9. The recording adapter saw `--requested-ref v6.0.3 --resolved-ref v6.0.3
   --commit <commit>` (`:662`). **Retired**: in-process `prepare` calls
   `runAdapter` as a function, so there is no adapter process and no
   `SPW_ADAPTER` seam. The argv is a literal array at
   `src/commands/prepare.ts:395-414`, and the three values it passes are the
   provenance record items 3-6 assert.

### A cached object is not source proof (`:664-682`)

10. The primed cache really holds the requested commit object (`:669`).
    **Retired**: `tests/baseline/ref-resolution.test.js`'s `REF-SOURCE-PROOF-01`
    makes the identical check — a verification-only `git cat-file -e
    <commit>^{commit}` against the cache `fetchExactCommit` just populated.
11. A source override that cannot supply the saved commit fails (`:673-678`).
    **Retired**: `REF-SOURCE-PROOF-01` re-runs `fetchExactCommit` against a
    freshly `init --bare` empty repository using the *same already-primed
    cache*, which is exactly this construction, and rejects.
12. The failure names the reason: `source cannot supply requested commit:
    <commit>` (`:679`). **Retired**: `REF-SOURCE-PROOF-01` asserts that exact
    message with an error-matching function.
13. The prior generated tree survives the failure (`:681`). Port:
    `tests/baseline/prepare.test.js`'s "prepare keeps hostile git output off its
    stream on both fetch branches" seeds a sentinel tree on its pinned half and
    compares `snapshotTree` byte-for-byte afterwards.
14. The adapter never ran — failure precedes adapter access (`:682`). Port:
    no `SPW_ADAPTER` log survives, so the in-process equivalent is an empty
    stdout — an adapter build always replays `generated plugin validation
    passed: …`. "prepare rejects a directory as the fallback manifest template
    before building" asserts `result.stdout === ""` and that no cache directory
    was created for a pre-build failure. That case's *trigger* is a template
    failure rather than this line's source-proof failure; under the
    same-property rule in the counting rules above, a different case inside a
    declared port file is still a port.

### Ref and source overrides stay independent (`:684-704`)

15. An environment ref resolves against the *saved* source (`:689`).
    **Retired**, and the citation is narrower than the property. The
    composition half — an environment ref combined with the saved source — is
    `tests/baseline/probe.test.js`'s "an environment ref overrides only the ref
    side and the saved fields stay visible", which asserts
    `selection_origin=environment` alongside `upstream_source_origin=user-config`
    and `effective_source=<the saved source>`. The *resolution* half is not
    witnessed there: that case passes a 40-hex `SUPERPOWERS_REF` and renames
    the source directory away (`tests/baseline/probe.test.js:216`, `:239`), so
    a raw-commit short-circuit means no ref is ever resolved against the saved
    source. Ref resolution itself is `tests/unit/upstream.test.js`'s
    `resolveRef` cluster and `tests/baseline/ref-resolution.test.js`. Both
    halves are covered; the *combination* the shell drove here — a non-40-hex
    environment ref resolved against a saved source — has no counterpart.
16. The provenance `source` is still the saved source (`:690`). **Retired**,
    same citation.
17. The provenance `requested_ref` is the environment ref (`:691`).
    **Retired**, same citation (`selection_origin=environment`,
    `selection_mode=override`).
18. An environment source can supply the still-authoritative saved pin
    (`:698`). **Retired**: the mirror-image half. The saved pin's authority is
    `tests/unit/effective-selection.test.js`'s "a saved pin short-circuits
    resolution and reports tag kind"; that an environment
    `SUPERPOWERS_UPSTREAM_URL` is what gets used and validated when a record is
    saved is asserted by the same file's "source validation precedes ref
    resolution", which overrides the saved source and shows the *override* is
    the value rejected.
19. The provenance `source` is the environment source (`:699`). **Retired**,
    same citation.
20. The provenance `requested_ref` is still the saved requested ref (`:700`).
    **Retired**, same citation.
21. An environment source does not cause the saved pin to be re-resolved
    (`:701-704`). **Retired**: no recording `git`; same short-circuit citation
    as item 7.

### A dash-prefixed local source stays usable (`:706-727`)

**Narrowing, recorded for honesty.** `tests/baseline/prepare.test.js` has no
dash-prefixed-source case: every case's `SUPERPOWERS_UPSTREAM_URL` is an
absolute path under the case scratch tree, which the fixture's own hermeticity
guard requires (`tests/baseline/prepare-fixture.js:378-382`, whose
`startsWith("/")` predicate is at `:380`). Items 22-26 are
therefore the weakest cluster in this file — each rests on the shared
`gitSafeSource` code path plus a sibling suite's dash-prefixed case, not on a
prepare-level counterpart.

22. A `track-latest` selection over a dash-prefixed source prepares the release
    commit (`:721`). **Retired**: `tests/baseline/probe.test.js`'s "a
    dash-prefixed local source saved by `track-latest` stays usable" proves the
    same selection resolves, and `prepare` consumes the identical
    `computeEffectiveSelection` result.
23. The provenance `source` is the dash-prefixed path verbatim (`:722`).
    **Retired**, same citation: probe's port asserts
    `saved_source=<dash-prefixed path>` and `effective_source` likewise.
24. The recording Git log shows `ls-remote --tags -- <physical>/-upstream
    refs/tags/v*` (`:723`). **Retired**: no recording `git`, and the `--`
    terminator is written into a literal array
    (`src/upstream.ts:140-147`). `tests/unit/upstream.test.js`'s "gitSafeSource
    anchors bare relative paths and leaves others alone" pins the anchoring,
    and `tests/baseline/selection-commands.test.js:504-542` is the one case that
    actually puts a bare relative `-upstream` on a Git command line.
25. The recording Git log shows `clone -- <physical>/-upstream <cache>` — the
    initial clone (`:724`). **Retired**: same reason. `prepare` passes
    `gitSafeSource(selection.effectiveSource)` (`src/commands/prepare.ts:309`)
    into the clone at `:330`, so the anchoring citation above covers the
    clone argument; that the clone branch is taken at all on a cold cache is
    asserted by "prepare clones once and then fetches into the same cache".
26. The recording Git log shows `fetch --tags --prune -- <physical>/-upstream`
    — the second run's cache fetch (`:726`). **Retired**: same reason; the
    fetch branch on a warm cache is the second half of "prepare clones once and
    then fetches into the same cache", which proves it by inode identity.

### Invalid selection state fails before Git and adapter access (`:729-768`)

27. A malformed `selection.json` fails closed, with an empty Git log, an empty
    adapter log, and the prior tree intact (`:754`, one
    `assert_prepare_preflight_failure` call site bundling five checks).
    **Retired**: `tests/unit/effective-selection.test.js`'s "an invalid saved
    record rejects rather than defaulting to none" pins the rejection.
    Ordering is structural in the port:
    `src/commands/prepare.ts:290` calls `computeEffectiveSelection` before the
    cache-parent `mkdir` at `:298` and before any Git at `:311`/`:330`, and
    "prepare rejects a directory as the fallback manifest template before
    building" witnesses that ordering one line later by asserting no cache
    directory exists.
28. An unsupported `schema_version` fails the same way (`:761`). **Retired**:
    `tests/baseline/selection-location.test.js:760` and
    `tests/baseline/selection-commands.test.js:984-998` both pin
    `schema_version must equal integer 1`; the same ordering argument as item
    27 applies.
29. A credential-bearing source fails the same way (`:765`). **Retired**:
    `tests/unit/effective-selection.test.js`'s "source validation precedes ref
    resolution" asserts `HTTP(S) source must not include userinfo` and is
    constructed specifically to prove the ordering; `tests/unit/selection.test.js:132-134`
    pins the userinfo matrix.

### The recorded adapter build invocation (`:770-778`)

30. The adapter received `build --upstream-root <cache>/superpowers` (`:776`).
    **Retired**: no `SPW_ADAPTER` seam; the argv is a literal array at
    `src/commands/prepare.ts:395-414`. The value is observable instead — that
    the build read the cache repository is what "prepare clones once and then
    fetches into the same cache" and `CLI-ENV-PREPARE-PATHS-01` establish by
    asserting the cache path the run actually populated.
31. The adapter received `--upstream-manifest-version 6.0.3` (`:777`).
    **Retired**, same seam. Port equivalent for the value:
    `MANIFEST-READER-UPSTREAM-01 upstream manifest version reaches provenance`
    asserts it against the committed fixture read at test time.
32. The adapter received `--fallback-manifest
    <pkg>/plugins/superpowers/.codex-plugin/plugin.template.json` (`:778`).
    **Retired**, same seam. The value's two observable consequences are
    asserted: a manifest-less ref really renders the template
    (`GENERATED-FALLBACK-01`), and a template path that is not a regular file
    is rejected before any build ("prepare rejects a directory as the fallback
    manifest template before building", plus its unit twin).

### `CLI-ENV-PREPARE-PATHS-01` relative paths use the invocation cwd (`:780-805`)

33. The adapter log shows both roots resolved against the physical invocation
    cwd, with a `.superpowers.prepare.` candidate (`:800`). **Retired**: no
    adapter log. Both halves are asserted elsewhere:
    `CLI-ENV-PREPARE-PATHS-01` runs with `cwd: c.dir` and relative
    `SUPERPOWERS_CACHE_DIR`/`SUPERPOWERS_PLUGIN_ROOT` and asserts both resolved
    trees exist under that cwd, and "prepare runs the additional plugin
    validator inside the staging workspace" asserts the staging directory's
    basename matches `/^\.superpowers\.prepare\./` and its parent is the plugin
    root's parent.
34. The adapter log shows `/superpowers --requested-ref` (`:803`).
    **Retired**, same seam; the `requested_ref` value is pinned by "prepare
    writes complete provenance and is idempotent".
35. The relative run wrote `out-relative/.codex-plugin/plugin.json` (`:804`).
    Port: `CLI-ENV-PREPARE-PATHS-01` asserts exactly this, plus that the
    package root's own generated tree is unchanged.
36. The relative run wrote `out-relative/.superpowers-upstream.json` (`:805`).
    Port: `CLI-ENV-PREPARE-PATHS-01` asserts only the manifest half, so the
    provenance file's existence and full contents come from "prepare writes
    complete provenance and is idempotent", which reads it and compares its key
    set.

### The `latest-release` build's manifest and provenance (`:807-831`)

37. Core reads the upstream manifest exactly once (`:814`, a `python3` argv
    log). **Retired**: there is no `python3` child to count.
    `src/commands/prepare.ts:373-375` is the one call site, guarded by a single
    `regularFileExists`, so "exactly once" is structural; the shell needed the
    count because `spw_json_get` re-read and re-parsed the file per field.
    `tests/unit/commands-prepare.test.js`'s "readUpstreamManifestVersion mirrors
    `spw_json_get` for the three shapes" pins what that one read returns.
38. The provenance commit is the release commit (`:820`). Port: "prepare writes
    complete provenance and is idempotent" asserts `provenance.commit` against
    the fixture's own `rev-list`. The `latest-release` resolution that produced
    it is retired to `tests/unit/upstream.test.js`'s "selectLatestRelease picks
    the greatest stable tag and prefers peeled shas" and "resolveRef selects
    the greatest stable tag for latest-release".
39. The generated manifest version is `6.0.3+manager.<short>` (`:821`).
    **Retired**: `tests/unit/upstream.test.js`'s "manifestVersionForRef
    reproduces the shell derivation table" asserts this exact form as its first
    row, against `shortCommit` computed in the same test.
40. The upstream `description` survives into the generated manifest (`:822`).
    **Retired**: `tests/unit/manifest-overlay.test.js`'s "sets version and
    skills, preserving unknown fields and key order" is the overlay's contract
    for every field it does not own, and
    `tests/baseline/generated-plugin-corpus.test.js`'s "the valid candidate and
    an unknown manifest field pass" is the validator's end of it.
41. The generated manifest `skills` is `./skills/` (`:824`). Port:
    `GENERATED-FALLBACK-01` asserts it on the fallback path.
42. The upstream `x_future_manifest` survives byte-equal (`:825`). Port: case 6
    asserts it on both halves, deep-equal to the committed fixture read at test
    time rather than to a literal.
43. The generated manifest `hooks` is the upstream declared path (`:827`).
    Port: case 6's single-path half, deep-equal to
    `upstream-active-hooks.json`'s own `hooks` value.
44. `hooks/hooks-codex.json` was materialized (`:829`). Port: case 6's
    single-path half asserts it directly.
45. `hooks/session-start-codex` was materialized (`:830`). Port: case 5's
    byte-exact listing comparison against `default-hooks.txt`, which enumerates
    it; case 6's `declared-hooks.txt` comparison does too.
46. `hooks/support/helper.txt` was materialized (`:831`). Port: same two
    listing comparisons.

### `GENERATED-HOOKS-FORBID-01` an exact empty hooks object (`:833-839`)

47. The generated manifest `hooks` is the exact empty object (`:835`). Port:
    `GENERATED-HOOKS-FORBID-01 an exact empty hooks object stays hook-free`,
    deep-equal to `upstream-empty-hooks.json`'s own value.
48. No `hooks/` subtree was copied (`:836-839`). Port: the same case asserts
    `existsSync(join(generated(c), "hooks")) === false`.

### `GENERATED-HOOKS-DEFAULT-01` empty-array default discovery (`:841-852`)

49. The generated manifest `hooks` is the empty array (`:843`). Port:
    `GENERATED-HOOKS-DEFAULT-01 GENERATED-HOOKS-DEFAULT-LAYOUT-01 empty-array
    default discovery`, deep-equal to `upstream-default-hooks.json`'s value.
50. `hooks/hooks.json` was materialized (`:844`). Port: the same case's listing
    comparison, which lists it.
51. `hooks/hooks-codex.json` was materialized (`:845`). Port: same listing.
52. `hooks/session-start-codex` was materialized (`:846`). Port: same listing.
53. `hooks/support/helper.txt` was materialized (`:847`). Port: same listing.
54. `GENERATED-HOOKS-DEFAULT-LAYOUT-01`: the whole generated tree matches
    `default-hooks.txt` (`:850`). Port: the same case reads the committed
    fixture and compares the full listing string.

### `GENERATED-HOOKS-DECLARED-01` declared path and inline hook forms (`:854-892`)

55. The single declared path reaches the generated manifest (`:856`). Port:
    case 6's single-path half.
56. `GENERATED-UNKNOWN-FIELDS-01`: the declared-hooks manifest's
    `x_future_manifest` survives (`:859`). Port: case 6, both halves.
57. The declared hook file was materialized (`:862`). Port: case 6's
    single-path half.
58. A two-element string array reaches the generated manifest verbatim
    (`:865`). Port: case 6's multi-path half, compared against
    `DECLARED_HOOK_PATHS` exported by the fixture that wrote the files, never a
    second literal.
59. `config/hooks-first.json`'s copied bytes are the fixture's (`:868`).
    **Retired**: case 6's multi-path half asserts the file's *presence* through
    the `declared-hooks.txt` listing but not its bytes.
    `tests/unit/hooks.test.js`'s "materializeHooks copies a declared file"
    asserts the copy's content directly, which is the property this line was
    about.
60. `alternate/hooks-second.json`'s copied bytes are the fixture's (`:871`).
    **Retired**, same citation.
61. The whole generated tree matches `declared-hooks.txt` (`:874`). Port: case
    6's multi-path half compares the full listing string against the committed
    fixture.
62. An inline hooks object reaches the generated manifest (`:879`).
    **Retired**: no port case uses the inline form. Three citations, because
    the line has three parts. `tests/unit/hooks.test.js`'s "classifyHooks
    treats an inline object as a subtree copy" pins the classification;
    `tests/baseline/generated-plugin-corpus.test.js`'s "upstream hook shapes
    are accepted" pins the validator's acceptance; and the part neither of
    those covers — that the overlay *carries the declared value through* into
    the generated manifest — is `tests/unit/manifest-overlay.test.js`'s "sets
    version and skills, preserving unknown fields and key order", the same
    citation items 40 and 70 rely on.
63. The inline form still copies `hooks/hooks-codex.json` (`:882`).
    **Retired**: `tests/unit/hooks.test.js`'s "materializeHooks copies a
    regular hook subtree" is the subtree-copy contract the inline
    classification selects.
64. The inline form still copies `hooks/session-start-codex` (`:883`).
    **Retired**, same citation.
65. The inline form still copies `hooks/support/helper.txt` (`:884`).
    **Retired**, same citation — it is the nested entry that case asserts by
    content.
66. An inline hooks *array* reaches the generated manifest (`:887`).
    **Retired**: `tests/unit/hooks.test.js`'s "classifyHooks treats an object
    array as a subtree copy".
67. The inline-array form copies `hooks/hooks-codex.json` (`:890`).
    **Retired**: "materializeHooks copies a regular hook subtree".
68. The inline-array form copies `hooks/session-start-codex` (`:891`).
    **Retired**, same citation.
69. The inline-array form copies `hooks/support/helper.txt` (`:892`).
    **Retired**, same citation.

### Absent declaration with and without `hooks/hooks.json` (`:894-906`)

70. An absent `hooks` key stays absent from the generated manifest (`:895`).
    **Retired**: `tests/unit/hooks.test.js`'s "classifyHooks default-discovers
    when hooks is absent" pins the classification, and
    `tests/unit/manifest-overlay.test.js`'s "sets version and skills,
    preserving unknown fields and key order" pins that the overlay adds no key
    it does not own.
71. Default discovery copies `hooks/hooks.json` (`:896`). **Retired**:
    "classifyHooks default-discovers when hooks is absent" plus
    "materializeHooks copies a regular hook subtree".
72. Default discovery copies `hooks/hooks-codex.json` (`:897`). **Retired**,
    same citation.
73. Default discovery copies `hooks/session-start-codex` (`:898`).
    **Retired**, same citation.
74. Default discovery copies `hooks/support/helper.txt` (`:899`).
    **Retired**, same citation.
75. An absent declaration *without* `hooks/hooks.json` keeps the key absent
    (`:902`). **Retired**: `tests/unit/hooks.test.js`'s "classifyHooks default
    discovery needs a regular hooks.json".
76. …and copies no `hooks/` subtree (`:903-906`). **Retired**: same
    classification citation for the decision; the no-subtree consequence is
    asserted end to end by `GENERATED-FALLBACK-01` and
    `GENERATED-HOOKS-FORBID-01`, which both assert
    `existsSync(join(generated(c), "hooks")) === false`.

### A declared hook path outside the hooks subtree (`:908-915`)

77. A declared path under `config/` reaches the generated manifest (`:909`).
    Port: case 6's multi-path half declares two paths, both outside `hooks/`.
    The single-string spelling of the same shape is pinned by
    `tests/unit/hooks.test.js`'s "classifyHooks accepts a string declaration".
78. The declared file was copied to `config/` (`:912`). Port: case 6's
    `declared-hooks.txt` listing enumerates `config/hooks-first.json`.
79. The `hooks/` subtree is copied *as well* (`:913`). Port: the same listing
    contains `hooks/hooks-codex.json` alongside `config/` and `alternate/`, so
    the byte-exact comparison is what holds this.
80. …including `hooks/session-start-codex` (`:914`). Port: same listing.
81. …including `hooks/support/helper.txt` (`:915`). Port: same listing.

### A contained hooks root that targets materialized content (`:917-932`)

82. The inline declaration reaches the generated manifest (`:919`).
    **Retired**: `tests/unit/hooks.test.js`'s "classifyHooks treats an inline
    object as a subtree copy" — the declaration shape is the same inline object
    item 62 covers.
83. The hooks root remains a symlink in the candidate (`:921-924`).
    **Retired** with **no equivalent witness anywhere** — see note (c) above,
    which is the honest statement of this gap. The nearest coverage is
    `tests/baseline/generated-plugin-corpus.test.js`'s "the hook subtree
    accepts contained materialized relative symlinks" (`:907`), and it does
    **not** symlink the hooks root: it calls
    `mkdirSync(join(state.plugin, "hooks"))` and puts contained relative
    symlinks *inside* that real directory. The one place the root itself is a
    symlink is the twelve-case matrix at `:812-880`, where every case asserts
    `status === 1`. So the accepting root-symlink path is exercised by nothing
    on either side: not `src/hooks.ts:359-360` (the materializer), not the
    validator. **Slice 3.5, read this before deleting the shell file.**
84. The hooks root preserves its relative target verbatim (`:925-929`).
    **Retired**, same gap and same warning: `readlink` equality is precisely
    what `src/hooks.ts:360` implements, and no test on either side asserts it.
85. Content behind the contained root is reachable in the candidate (`:930`).
    **Retired**, and this one holds only in a weak sense: "the hook subtree
    accepts contained materialized relative symlinks" (`:907`) does require a
    contained relative symlink's target content to be present and valid, but on
    a candidate whose `hooks/` is a real directory. The reachability property
    survives; the root-is-a-symlink premise it was asserted under does not.

### Every ref shape's commit and manager version (`:934-970`)

86. An exact prerelease tag prepares its commit (`:936`). **Retired**: exact
    tag resolution is `tests/unit/upstream.test.js`'s `resolveExactTag`
    cluster ("reports a query failure", "reports the tag as not found when
    absent from otherwise-valid output", "prefers the peeled entry over the
    direct one"); that the resolved commit reaches provenance is item 38's
    port.
87. Its manager version is `6.1.0-beta.1+manager.<short>` (`:937`).
    **Retired**: "manifestVersionForRef reproduces the shell derivation table",
    second row.
88. A branch ref prepares its head commit (`:941`). **Retired**: generic ref
    resolution is `tests/baseline/ref-resolution.test.js`'s
    `REF-GENERIC-FALLBACK-01 arbitrary refs fall back after tag lookup` and
    `tests/unit/upstream.test.js`'s "resolveRef falls through to the first
    generic ls-remote entry".
89. `main`'s manager version is `0.0.0-main+manager.<short>` (`:942`).
    **Retired**: the derivation table's third row.
90. `main`'s `upstream_manifest_version` is the upstream manifest's version
    (`:943`). Port: `MANIFEST-READER-UPSTREAM-01 upstream manifest version
    reaches provenance`, which reads the expected value from the committed
    fixture at test time.
91. A slashed branch ref prepares its head commit (`:947`). **Retired**: same
    generic-ref citations as item 88.
92. `feature/foo`'s manager version is
    `0.0.0-ref-feature-foo+manager.<short>` (`:948`). **Retired**: the
    derivation table's fourth row, which uses this exact ref.
93. A leading-zero branch ref prepares its head commit (`:952`). **Retired**:
    same generic-ref citations as item 88;
    `tests/unit/upstream.test.js`'s "selectLatestRelease ignores malformed
    leading-zero tags" covers the tag side of the same hazard.
94. `042`'s manager version is `0.0.0-ref-042+manager.<short>` (`:953`).
    **Retired**: the derivation table's fifth row, which uses this exact ref.
95. `GENERATED-FALLBACK-01`: a manifest-less tag prepares its commit (`:958`).
    **Retired**: `GENERATED-FALLBACK-01 manifest-less upstream uses the manager
    fallback` asserts the commit only through stdout's
    `prepared v5.0.0 at <40 hex>` shape rather than against the fixture's own
    `rev-list`; the commit-into-provenance property is item 38's port and
    "prepare honours a pinned saved selection" asserts it for `v5.0.0`
    specifically.
96. Its manager version is `5.0.0+manager.<short>` (`:959`). **Retired**: the
    derivation table has no exact-stable-`tag` row, but `latest-release` and
    `tag` fall through to one shared branch
    (`src/upstream-version.ts:29-38`), and both of the rows that reach it are
    asserted — the first row is `resolutionKind: "latest-release"` with a
    stable `resolvedRef: "v6.0.3"`, producing exactly this
    `<base>+manager.<short>` shape, and the second is `resolutionKind: "tag"`
    with a prerelease.
97. Its `upstream_manifest_version` is empty (`:960`). **Retired**: structural
    — `src/commands/prepare.ts:371-376` initializes the value to `""` and
    assigns it only when `regularFileExists(upstreamManifest)` holds, so a
    manifest-less ref cannot produce anything else.
    `tests/unit/commands-prepare.test.js`'s "readUpstreamManifestVersion
    mirrors `spw_json_get` for the three shapes" pins the empty-string result
    for the two shapes that *do* reach the reader.
98. The fallback manifest's `skills` is `./skills/` (`:961`). Port:
    `GENERATED-FALLBACK-01` asserts `manifest.skills === "./skills/"`.
99. The fallback manifest has no `hooks` key (`:962`). **Retired**:
    `tests/unit/hooks.test.js`'s "classifyHooks allows a fallback manifest
    without hooks" and "classifyHooks rejects hooks in a fallback manifest"
    are the policy's two halves.
100. The fallback plugin has no `hooks/` directory (`:963-966`). Port:
     `GENERATED-FALLBACK-01` asserts
     `existsSync(join(generated(c), "hooks")) === false`, annotated with
     AGENTS.md's hook policy.
101. A raw 40-hex ref prepares that commit (`:969`). **Retired**:
     `tests/unit/upstream.test.js`'s "resolveRef treats a 40-hex ref as a raw
     commit without querying" — and the port relies on that branch throughout,
     because `cloneUpstream` returns a commit every negative case passes as
     `SUPERPOWERS_REF` precisely to reach no Git resolution.
102. A raw commit's manager version is `0.0.0+manager.<short>` (`:970`).
     **Retired**: the derivation table's `raw-commit` row.

### `MANIFEST-READER-UPSTREAM-01` upstream manifest reader profile (`:972-996`)

**Narrowing, recorded for honesty.** `assert_bad_manifest_error` (`:549`)
required the diagnostic to carry a *location* — `invalid JSON in
…/plugin.json: line N column M`. The port's message is exactly
`error: invalid manifest JSON in <path>\n`, with no line or column: the
diagnostics convention forbids interpolating the parser's own text into a
prepare-owned message. The line/column property survives where it is still
emitted, pinned by `tests/unit/manifest-overlay.test.js`'s "a malformed
manifest reports line and column".

103. A malformed upstream manifest fails closed with a JSON diagnostic, no
     traceback, and the prior tree intact (`:972`, one
     `assert_bad_manifest_error` call site bundling four checks). Port:
     "prepare rejects a malformed upstream manifest", which asserts the exact
     stderr, runs `assertNoLeakedInternals` (which forbids `Traceback` and
     every errno name), and compares the seeded prior tree byte-for-byte.
104. A non-standard JSON constant is rejected (`:975`). Port: "prepare rejects
     an upstream manifest carrying NaN", same four-part contract;
     `tests/unit/commands-prepare.test.js`'s "readUpstreamManifestVersion
     delegates every read and parse failure to readManifest" is the unit half.
105. A document nested 257 deep is rejected (`:976`). Port: "prepare rejects an
     upstream manifest nested beyond the depth limit", which builds 257 nested
     arrays and cites the 256-container profile.
106. A document nested exactly 256 deep is accepted and its ref-derived version
     computed (`:981`). **Retired**: acceptance at the boundary is
     `tests/unit/manifest-overlay.test.js`'s "nesting at exactly 256 is
     accepted"; the version form is the derivation table's generic-ref row.
107. …and its `upstream_manifest_version` is read out of it (`:984`).
     **Retired**: `tests/unit/hooks.test.js`'s "MANIFEST-READER-MATERIALIZE-01
     hook manifest reader complete matrix" pins the reader's profile at the
     boundary, and item 37's citation pins that an accepted manifest's
     `version` reaches the caller.
108. `GENERATED-WRONG-NAME-01`: a manifest whose `name` is not `superpowers`
     is rejected (`:986`). Port: `GENERATED-WRONG-NAME-01 wrong upstream
     manifest name is rejected`, which asserts the adapter's own rejection line
     replayed verbatim plus prepare's trailer, and that the prior tree
     survives.
109. A manifest larger than 1 MiB is still read and its unknown field
     preserved (`:990`). **Retired**:
     `tests/unit/manifest-overlay.test.js`'s "trailing whitespace beyond 1 MiB
     is accepted" pins the size acceptance and "sets version and skills,
     preserving unknown fields and key order" pins the preservation.
110. A manifest that cannot be read is rejected (`:994`). Port: "prepare
     reports an unreadable upstream manifest without an errno", which chmods
     the cached manifest to `0o000` between two runs and asserts the exact
     `cannot read manifest JSON in <path>` message.
111. A manifest holding an unencodable `version` is rejected (`:995`).
     **Retired**, and this is the weakest retirement in the file. The shell's
     `cannot output JSON value from` came from a `UnicodeError` raised by
     Python's `print()` when `spw_json_get` wrote the value out
     (`scripts/core/provenance.sh:62-65`); `readUpstreamManifestVersion` parses
     the value and returns it without re-encoding, so that failure class does
     not exist at that site and nothing asserts what an unpaired surrogate in
     `version` does downstream. The nearest witness is
     `tests/unit/generated-plugin.test.js`'s "an unpaired surrogate in a
     manifest path fails during resolution", which is a different field on a
     different reader. **Slice 3.5, read this before deleting the shell file.**
112. A document nested 2000 deep is rejected (`:996`). Port: "prepare rejects
     an upstream manifest nested beyond the depth limit" — the same branch, one
     step past the boundary rather than 2000 past it; `tests/baseline/generated-plugin-corpus.test.js`'s
     "JSON rejects excessive nesting without a traceback" is the validator's
     end.

### `FS-HOOK-CONTAINMENT-01` unsafe hook paths and symlinks (`:998-1046`)

Each item is one `assert_hook_prepare_failure` call site bundling four checks:
a non-zero exit, the expected diagnostic, no Python traceback, and the prior
generated tree preserved.

**Items 113-120 lose the wrapper prefix, not the classification.** All eight
shell diagnostics begin `hook classification failed:` — `src/adapter.ts:364`'s
wrapper — and that prefix is asserted **nowhere outside this shell file**; see
note (b) above. Each item's *inner* message is message-exact in the
`classifyHooks` unit test it cites, so the classification logic is fully
carried; what is unwitnessed is that the adapter wraps it with that prefix on
the way out. Items 121-128's `hook materialization failed:` twin does not have
this problem — it is asserted by `tests/baseline/prepare.test.js:336`.
**Slice 3.5, read this before deleting the shell file.**

113. A scalar `hooks` value is rejected (`:999`). **Retired**:
     `tests/unit/hooks.test.js`'s "classifyHooks rejects scalar, mixed, and
     null declarations" — inner message only; wrapper prefix unwitnessed.
114. A mixed array is rejected (`:1002`). **Retired**, same citation — that
     test's name enumerates this case. Inner message only.
115. An unprefixed declared path is rejected (`:1005`). **Retired**:
     "classifyHooks rejects an unprefixed declared path". Inner message only.
116. An absolute declared path is rejected (`:1008`). **Retired**:
     "classifyHooks rejects an absolute declared path". Inner message only.
117. A traversing declared path is rejected (`:1011`). **Retired**:
     "classifyHooks rejects a traversing declared path". Inner message only.
118. A missing declared path is rejected (`:1014`). **Retired**:
     "classifyHooks rejects a missing declared path". Inner message only.
119. A declared directory is rejected (`:1017`). **Retired**: "classifyHooks
     rejects a declared directory". Inner message only.
120. A declared symlink escaping upstream is rejected (`:1020`). **Retired**:
     "classifyHooks rejects a declared symlink that escapes upstream". Inner
     message only.
121. A declared symlink contained in upstream but dangling in the candidate is
     rejected (`:1023`). **Retired**: "materializeHooks rejects a declared
     symlink that dangles in the candidate".
122. An escaping symlink inside the hook subtree is rejected (`:1026`). Port:
     `FS-HOOK-CONTAINMENT-01 an escaping hook symlink fails closed` drives this
     end to end — the exit status, the `hook materialization failed: symlink
     escapes` line, prepare's own trailer, `assertNoLeakedInternals`, and the
     prior tree byte-compare.
123. A source-contained subtree symlink that dangles in the candidate is
     rejected (`:1029`). **Retired**: "materializeHooks rejects a
     source-contained symlink that dangles in the candidate".
124. A dangling subtree symlink is rejected (`:1032`). **Retired**:
     "materializeHooks rejects an escaping symlink inside the subtree" — the
     same `symlink escapes or is broken` branch, reached by a broken link
     rather than an escaping one.
125. A hooks root symlinked to source-only content is rejected (`:1035`).
     **Retired** against `src/hooks.ts:279`/`:303`'s `hook subtree escapes or
     is broken`, which **no TypeScript test asserts** — see the note above the
     ledger. The nearest witness is `tests/unit/hooks.test.js`'s
     "materializeHooks rejects a subtree that is not a directory", a different
     branch with a different message. **Slice 3.5, read this before deleting
     the shell file.**
126. An absolute hooks-root symlink is rejected (`:1038`). **Retired**:
     "materializeHooks rejects an absolute subtree symlink", which asserts the
     `absolute subtree symlink is not allowed` message.
127. A broken relative hooks-root symlink is rejected (`:1041`). **Retired**,
     same unwitnessed diagnostic as item 125.
128. An escaping relative hooks-root symlink is rejected (`:1044`).
     **Retired**, same unwitnessed diagnostic as item 125.

### The JSON reader on an unreadable path (`:1048-1061`)

129. `spw_json_get` refuses a path it cannot read as JSON (`:1051-1055`). Port:
     `tests/unit/commands-prepare.test.js`'s "readUpstreamManifestVersion
     delegates every read and parse failure to readManifest", whose fourth
     fixture is a mode-`0o000` file and which asserts the rejection rather than
     a value.
130. The diagnostic names the input: `cannot read JSON in <path>` (`:1056`).
     Port: the same case asserts `cannot read manifest JSON in <path>` by exact
     equality. The wording gained `manifest` because the port's reader is
     manifest-specific; the property — a hand-written message naming the input
     — is the same one.
131. The diagnostic carries no Python traceback (`:1057-1061`). Port: the same
     case additionally asserts
     `doesNotMatch(error.message, /EACCES|EPERM|errno|open .../)`, and
     "prepare reports an unreadable upstream manifest without an errno" runs
     `assertNoLeakedInternals`, whose pattern includes `Traceback` and sixteen
     enumerated errno names (`tests/baseline/prepare.test.js:75`).

### The complete generated tree (`:1063-1081`)

132. `skills/brainstorming/SKILL.md` is present (`:1067`). Port: case 5's and
     case 6's byte-exact listing comparisons both enumerate it.
133. `assets/superpowers-small.svg` is present (`:1068`). Port: same listings.
134. `hooks/hooks-codex.json` is present (`:1069`). Port: same listings.
135. `hooks/session-start-codex` is present (`:1070`). Port: same listings.
136. `hooks/support/helper.txt` is present (`:1071`). Port: same listings.
137. `LICENSE` is present (`:1072`). Port: same listings, and "prepare rejects
     an upstream missing any required path" proves its *absence* is fatal.
138. `README.md` is present (`:1073`). Port: same two citations.
139. `CODE_OF_CONDUCT.md` is present (`:1074`). Port: same two citations.
140. `.codex-plugin/plugin.template.json` is carried into the staged tree, so
     the atomic swap does not delete a tracked file (`:1078`). Port: both
     listing fixtures enumerate it, so the byte-exact comparison fails if the
     staged tree drops it.
141. The generated manifest `hooks` value again (`:1080`). Port: case 6's
     single-path half. This line re-asserts item 43 after the tree checks; it
     is counted because it is a distinct matched assertion, and it maps to the
     same port.

### The additional plugin validator (`:1083-1120`)

142. The test `HOME` provides no Codex plugin-creator validator, so only the
     shipped one can run (`:1084-1087`). **Retired**: structural in the port —
     `createCase` gives every case a fresh `HOME` under the suite's `mkdtemp`
     scratch tree, and `tests/baseline/prepare-fixture.js:372-377` fails the
     case outright if the child environment omits `HOME` or any other name in
     `REQUIRED_ENV`, so no ambient `HOME` can leak in.
143. Built-in validation runs before the additional validator (`:1102`).
     **Retired**: structural — `src/commands/prepare.ts` runs the adapter build
     and its validation at `:395` and reaches the additional-validator block
     only at `:444`. `tests/baseline/cli-parity.test.js`'s `PREPARE-VALIDATE-01
     validation completes before activation` is the surviving end-to-end
     witness for the ordering, and it still drives the shell script this slice.
144. An explicit additional validator really runs (`:1107`). Port: "prepare
     runs the additional plugin validator inside the staging workspace" clause
     (a), which asserts the validator's own stdout line reached
     `result.stdout`.
145. A configured additional validator path that does not exist is rejected
     (`:1110-1119`). Port: the same case's clause (c).
146. The diagnostic is `additional plugin validator not found` (`:1120`).
     Port: clause (c) asserts the exact stderr, including the path.

### A built-in validation failure blocks everything downstream (`:1122-1160`)

147. Invalid skill frontmatter is rejected (`:1130-1143`). **Retired**: the
     frontmatter rule is
     `tests/baseline/generated-plugin-corpus.test.js`'s "the required tree and
     skill structure fail closed" and "frontmatter uses the first closing fence
     and owned keys only"; the end-to-end shape of a built-in validation
     failure — exit 1, the validator's line replayed, prepare's trailer, the
     prior tree intact — is `GENERATED-WRONG-NAME-01`'s port.
148. The diagnostic is `exactly one top-level \`description:\`` (`:1144`).
     **Retired**: `tests/baseline/generated-plugin-corpus.test.js`'s
     "frontmatter uses the first closing fence and owned keys only" asserts
     `exactly one top-level \`name:\`` at `:962` and `:965`. Both strings come
     from the one interpolated template at `src/generated-plugin.ts:632`, so
     the `description:` spelling is the same site with a different key; the
     literal `description:` variant is not itself asserted.
149. The failure removes its own staged plugin tree (`:1145-1148`). Port:
     "prepare rejects a directory as the fallback manifest template before
     building" asserts no `.superpowers.prepare.` entry remains under the
     plugin root's parent, and `tests/unit/workspace.test.js`'s two
     `FS-CLEANUP-01` cases pin `withWorkspace`'s removal on both the success
     and the callback-failure path.
150. The failure does not remove another invocation's staged tree
     (`:1149-1152`). **Retired**: `tests/unit/workspace.test.js`'s
     "`REF-CLEANUP-01` / `REF-PIN-CLEANUP-01` signals clean only active
     workspaces" is the invocation-scoping contract, and
     `tests/baseline/cli-parity.test.js`'s `FS-CLEANUP-01 interrupted state
     cleanup is invocation-scoped` is its end-to-end net.
151. The additional validator does not run after a built-in failure
     (`:1153-1156`). **Retired**: structural — the built-in failure returns
     `failed(...)` at `src/commands/prepare.ts:428-441` — `:425` is the
     adjacent `catch` for a thrown adapter cause, a different branch — before
     the validator block opens at `:444`. `GENERATED-WRONG-NAME-01`'s port asserts the failing run's
     stderr by pattern over two lines only, so no validator output can appear
     between them.
152. The failure preserves the previous generated tree (`:1157-1160`). Port:
     `GENERATED-WRONG-NAME-01`'s port seeds a sentinel tree and compares
     `snapshotTree` byte-for-byte afterwards — as does every other negative
     case in the driver.

### `FS-ATOMIC-SWAP-01` failed activation restores the prior tree (`:1162-1205`)

This cluster is the one **same-layer** re-point in the file. The shell case
called `spw_replace_generated_tree` directly (`:1191-1196`) through a
`sh -c` that sourced `scripts/core/lifecycle.sh`; it was never an end-to-end
`prepare` case. Its TypeScript counterpart is therefore a unit test of
`atomicReplaceDir`, not a driver case. PR 11.5 slice 3 Task 2 re-pointed
`docs/baseline/traceability.md:104` to
`tests/unit/atomic.test.js::FS-ATOMIC-SWAP-01 EXDEV activation restores the
prior tree`.

153. The failed activation exits non-zero (`:1198`). Port:
     `FS-ATOMIC-SWAP-01 EXDEV activation restores the prior tree` asserts the
     rejection with a validating matcher that requires a `SafetyError`.
154. The failure says `previous tree restored` (`:1199`). Port: the same case
     matches that phrase, with a comment recording that this exact line is the
     one assertion the shell made that the unit test previously did not.
155. The live tree's bytes are the prior tree's (`:1200`). Port: the same case
     reads the marker back and asserts `"before"`.
156. The candidate is gone (`:1201`). Port: the same case asserts
     `stat(candidate)` rejects with `ENOENT`.
157. No `.superpowers.bak.*` backup was left behind (`:1202-1205`). Port: the
     same case asserts no entry in the parent contains `.bak.`; the converse —
     a rollback failure that *must* preserve and report the backup — is
     `FS-ATOMIC-SWAP-01 rollback failure preserves and reports the backup`.

### Test hygiene (`:1207-1211`)

158. The committed manifest template was not mutated by the run
     (`:1208-1211`). **Retired**: structural — every case points
     `SUPERPOWERS_MANIFEST_TEMPLATE` at its own package copy
     (`tests/baseline/prepare-fixture.js:355-358`), never at the repository's
     file, and `CLI-ENV-PREPARE-PATHS-01` additionally snapshots the package
     root's generated tree before the run and asserts it unchanged after.

### The `spw_node_cli` scrub seam (`:1213-1277`)

Every item in this cluster is retired together, and the cluster splits into two
properties that must not be conflated.

**The dispatcher boundary.** In-process there is no `exec`, so the manager
cannot scrub itself — the preload has already run. The parent spec's §11 lists
"Restoring `NODE_OPTIONS` scrubbing for the dispatcher" as **not scheduled**,
so that half is retired with that citation rather than silently. This half is
settled.

**The child-clean boundary, which is NOT settled.** `scripts/core/common.sh:71`
runs helpers as `exec /bin/sh -c 'unset NODE_OPTIONS NODE_PATH; exec node "$@"'`,
so on the shell path the Codex subprocess really is spawned from a scrubbed
environment. **The TypeScript path has no equivalent today.**
`grep -rn 'NODE_OPTIONS\|NODE_PATH' src/` returns **zero hits**, and
`runCommand` (`src/adapter.ts:106-142`) passes the `env` it is handed straight
into `execFile` untouched; `common.sh:71` is the only scrubbing site in the
system. The parent spec's paragraph that reads "`runCommand` … therefore
deletes `NODE_OPTIONS` and `NODE_PATH` … covered by a unit test" is written in
the **prescriptive** voice — it is the change the spec schedules, and two lines
earlier the same paragraph states the current fact, "`src/` filters these
variables nowhere". **This branch has not landed that change.** So items
161-163 retire assertions about a property the shell path has and the
TypeScript path does not yet have. **Slice 3.5, read this before deleting the
shell file** — this is the same class of gap as items 83-85, 111, and 125, and
it is the only one of the four that is a behaviour regression rather than a
missing test.

159. The adapter really routes through `spw_node_cli` rather than bare `node`
     (`:1216`) — the structural half. **Retired**: the seam is
     `scripts/adapters/codex/adapter`'s, and in-process `prepare` never
     launches it. Parent spec §11.
160. A prepare run under a hostile `NODE_OPTIONS`/`NODE_PATH` still succeeds
     (`:1255-1259`). **Retired**, same citation.
161. The node shim observed an `adapter-cli.js` launch at all (`:1262`) — the
     guard that keeps the two assertions below from passing vacuously.
     **Retired**: there is no `adapter-cli.js` launch to observe, because the
     adapter runs in-process.
162. `NODE_OPTIONS` was unset for that launch (`:1267`) — the behavioural
     half, and a **child-clean** assertion, not a dispatcher one.
     **Retired**, against nothing: `src/` scrubs `NODE_OPTIONS` nowhere, so the
     property this line asserted does not hold on the in-process path. The §11
     citation does *not* cover this — §11 declines to restore the *dispatcher*
     boundary, whereas this asserts the child's. See the cluster note above.
163. `NODE_PATH` was unset for that launch (`:1272`). **Retired**, against
     nothing, same reasoning: zero `NODE_PATH` references in `src/`.

<!-- inventory:mapped:end -->

## Port-only assertions (outside the 1:1 mapping)

Five deliberate divergences and narrowings, none with a shell counterpart to
map onto.

<!-- inventory:port-only:start -->

1. A non-string manifest `version` fails closed. `spw_json_get` printed any
   JSON value through Python's `print()` (`scripts/core/provenance.sh:63`), so
   a numeric `"version": 6` became the string `"6"` and flowed into both the
   provenance record and `--upstream-manifest-version`. The port rejects it
   with a hand-written message naming the manifest path. Spec divergence 7.
   Ports: `tests/baseline/prepare.test.js`'s "prepare rejects a non-string
   upstream manifest version" (case 20) end to end, and
   `tests/unit/commands-prepare.test.js`'s "readUpstreamManifestVersion fails
   closed on a non-string version" at the reader.
2. Validator stdout and stderr are captured and written through `ctx` at
   command end rather than streamed live through inherited stdio.
   `scripts/prepare:110` let `python3` inherit stdio; in-process, inheriting
   would bypass the injected `ctx.stdout`/`ctx.stderr` that make the command
   testable without spawning. **Ordering relative to the adapter's messages and
   the `error:` line is unchanged** — only the timing is. Spec divergence 8.
3. The adapter build no longer runs under the staging tree's `TMPDIR`.
   `scripts/prepare:35-36` exported `TMPDIR="$prepare_workspace"`, so every
   child confined its temporary files to the tree the workspace trap removed.
   The one child `prepare` still spawns — the additional validator — keeps that
   fidelity, because `runValidator` builds an explicit child environment and
   sets `TMPDIR` to the workspace. The adapter does not: `runAdapter` runs
   in-process, `src/adapter.ts:318-320` calls `withWorkspace(tmpdir(), …)`, and
   `os.tmpdir()` reads `process.env` rather than the `env` it is handed, so the
   build workspace lands in the ambient temp directory. The residue is bounded
   — `withWorkspace` removes the adapter's own workspace on both the success
   and failure paths — and a `SIGKILL` defeated the shell's trap equally. Spec
   divergence 9. Case 12 clause (a) asserts the **ported** half: it prints
   `TMPDIR` from inside the validator child and asserts it is neither the
   case's own `TMPDIR` nor anything but a `.superpowers.prepare.` directory
   under the plugin root's parent. **This entry was added after Task 1's
   review; it is a preamble line the port's line-by-line reading of the script
   body did not cover.**
4. Every prepare-owned filesystem failure carries a hand-written message naming
   the path, with the raw `ErrnoException` attached only as `cause`. The shell
   let `set -e` abort with the tool's own text, so there was no message to
   assert. Ports: case 18 ("prepare reports an unreadable upstream manifest
   without an errno") and case 23 ("prepare reports a failed upstream copy
   without an errno"), each asserting the exact stderr and running
   `assertNoLeakedInternals`.
5. The prior generated tree is asserted byte-identical on **every** failure
   path, not only the swap's. The shell asserted a surviving tree only for
   `FS-ATOMIC-SWAP-01`, and elsewhere only that a sentinel *file* still
   existed. The port's `snapshotTree` records `path\tkind[\tsha256]` for every
   entry, and every negative case in `tests/baseline/prepare.test.js` seeds a
   tree and compares the full snapshot afterwards.

<!-- inventory:port-only:end -->

## Surviving `scripts/prepare` references (PR 11.5 slice 3)

Prose, deliberately not a numbered port-only entry: nothing below is an
assertion this port added, so counting any of it would overstate `portOnly`.

This slice adds the in-process command module and its drivers and **deletes
nothing**. `DISPATCH.prepare` is still `spawn`, `COMMAND_REQUIREMENTS` is
unchanged, and `src/cli.ts` is untouched across the branch. `scripts/prepare`
and `tests/test_prepare_with_fake_upstream.sh` both survive, because
`scripts/install:25` and `scripts/update:23` still execute
`sh "$root/scripts/prepare"`. Two couplings keep the script alive beyond those
callers: the lifecycle test fakes stub `SPW_ADAPTER`, a seam only
`scripts/core/adapter.sh` honours and the in-process `runAdapter` does not; and
roughly twenty `prepare` cases in `tests/baseline/cli-parity.test.js` are
calibrated against the synthetic adapter at
`tests/fixtures/baseline/bin/stateful-adapter` rather than a real build. Slice
3.4 re-derives those cases and flips dispatch; slice 3.5 re-bases the fakes and
deletes the script. `tests/bin/units.test.js` carries the retention guard,
which asserts the relationship — the script exists and both callers still
invoke it — rather than a line number, and it was mutation-proved once per
caller.

**Traceability.** Ten rows in `docs/baseline/traceability.md` still cite
`tests/test_prepare_with_fake_upstream.sh` (`:31`, `:66`, `:96`-`:102`,
`:107`), and they stay that way this slice: the shell test is retained and
green, so every one of those anchors still resolves. Slice 3.5 re-points them
when it deletes the file, and the case *names* it will need are the ones this
ledger cites — `CLI-ENV-PREPARE-PATHS-01`, `MANIFEST-READER-UPSTREAM-01`,
`GENERATED-UNKNOWN-FIELDS-01` and `GENERATED-HOOKS-DECLARED-01` (both on case
6), `GENERATED-WRONG-NAME-01`, `GENERATED-FALLBACK-01`,
`GENERATED-HOOKS-FORBID-01`, `GENERATED-HOOKS-DEFAULT-01` and
`GENERATED-HOOKS-DEFAULT-LAYOUT-01` (both on case 5), and
`FS-HOOK-CONTAINMENT-01`. `FS-ATOMIC-SWAP-01` is the one row that already
moved, to `tests/unit/atomic.test.js` (Task 2); `BUILDER-SYMLINK-01` has no
traceability row at all, and its two assertions are retired against
`FS-SYMLINK-01`.

## Cardinality

```json inventory
{
  "shellOriginal": 163,
  "portOnly": 5,
  "ports": {
    "tests/baseline/prepare.test.js": 26,
    "tests/unit/commands-prepare.test.js": 6,
    "tests/unit/atomic.test.js": 8
  }
}
```

- Shell original: **163** assertions (2 builder scenarios; 7 saved exact pin; 5
  cached-object source proof; 7 ref/source override independence; 5
  dash-prefixed source; 3 selection preflight; 3 recorded adapter build; 4
  relative paths; 10 the `latest-release` manifest and provenance; 2 exact
  empty hooks; 6 empty-array default discovery; 7 declared path and
  string-array forms; 8 inline and inline-array forms; 7 absent-declaration
  discovery; 5 declared path outside the subtree; 4 contained hooks root; 17
  ref-shape commits and manager versions; 10 the upstream manifest reader
  profile; 16 hook containment; 3 the JSON reader on an unreadable path; 10 the
  complete generated tree; 5 the additional validator; 6 built-in failure
  containment; 5 the atomic swap; 1 test hygiene; 5 the scrub seam; sum:
  2+7+5+7+5+3+3+4+10+2+6+7+8+7+5+4+17+10+16+3+10+5+6+5+1+5 = 163). See
  "Divergences from the derived 158" above for the full +15/-10/net5 derivation
  from the mechanical 158.
- Ports: `tests/baseline/prepare.test.js` has 24 static `test(` call sites (8
  named for the baseline case IDs they own, and 16 further end-to-end cases —
  the pinned saved selection, clone-then-fetch, the required-path matrix, the
  additional validator's three clauses, provenance completeness and
  idempotence, seven manifest-rejection shapes, two directory-as-path
  rejections, the failed upstream copy, and the two hostile-git fetch
  branches); `tests/unit/commands-prepare.test.js` has 6 (three for
  `readUpstreamManifestVersion` and three for `runPrepare`'s `-f`/`-d`
  predicates); `tests/unit/atomic.test.js` has 8 (five for `atomicWriteFile`
  and three for `atomicReplaceDir`, two of which carry `FS-ATOMIC-SWAP-01`).
- Reconciliation: 66 of the 163 shell items are mapped into those ports — 59
  into `tests/baseline/prepare.test.js`, 2 into
  `tests/unit/commands-prepare.test.js`, and 5 into
  `tests/unit/atomic.test.js`, with items 104, 105, 110, 112, and 131
  additionally witnessed in the unit file. The rest are **97 retired items**
  (1-2, 7-12, 15-34, 37, 39-40, 59-60, 62-76, 82-89, 91-97, 99, 101-102,
  106-107, 109, 111, 113-121, 123-128, 142-143, 147-148, 150-151, 158-163),
  each with a citation to pre-existing coverage that already supersedes it, to
  a structural guarantee that makes a runtime check impossible to violate, or
  — for the adapter-argv, recording-`git`, `python3`-argv and `spw_node_cli`
  clusters — to the removal of the seam the assertion read through, naming the
  suite that still covers the underlying behaviour. 66 + 97 = 163. Plus 5
  port-only assertions with no shell counterpart.
- **Five findings are flagged for slice 3.5 rather than settled.** Ordered by
  severity, because one of them is not a missing test:
  1. Items 162-163 — the **child-clean** `NODE_OPTIONS`/`NODE_PATH` property.
     `scripts/core/common.sh:71` gives it to the shell path; `src/` scrubs
     neither variable anywhere, and `runCommand` passes `env` through
     untouched. This is a behaviour difference the parent spec prescribes
     closing and this branch has not closed, not merely an unwitnessed one.
     §11's "not scheduled" covers only the *dispatcher* half.
  2. Items 113-120 — `hook classification failed:` (`src/adapter.ts:364`), the
     adapter's wrapper prefix, asserted nowhere outside the shell file. The
     inner classification messages are message-exact in their cited unit
     tests; only the wrapper is lost. Its materialization twin *is* ported.
  3. Items 83-85 — an accepted contained relative hooks-root symlink
     (`src/hooks.ts:359-360`) is exercised by nothing on either the
     materializing or the validating side; every root-symlink case in the
     corpus asserts rejection.
  4. Items 125/127/128 — `hook subtree escapes or is broken`
     (`src/hooks.ts:279`, `:303`) has no TypeScript witness at all.
  5. Item 111 — the unencodable-`version` failure class no longer exists at
     that site and nothing replaces it.

  Items 22-26 are the weakest *cluster* rather than a flagged finding: the
  property holds, but it rests on a sibling suite's dash-prefixed case rather
  than a prepare-level one. Item 15 is narrower than its citation in the same
  way — both halves are covered, the combination is not.
