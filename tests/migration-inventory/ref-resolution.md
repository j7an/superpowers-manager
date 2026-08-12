# Migration inventory: tests/test_ref_resolution.sh

Source read in full (242 lines). Ported to
`tests/baseline/ref-resolution.test.js`.

## Counting rules applied

- Each `test "..." = "..."` line and each bare `grep -Fq`/`grep -Fqx`
  (including ones relied on by `set -e`) is one assertion — same rule as
  `bin-dispatch.md`.
- Each `if <command>; then echo …; exit 1; fi` negative guard, where
  succeeding is itself the failure, is one assertion — `bin-dispatch.md`'s
  rule, applied uniformly regardless of the guarded command's shape.
- The same negative-guard rule extends to the two structurally identical
  `if not …: raise SystemExit(...)` guards inside this file's embedded Python
  fixture (`:176-178`, `:185-186`): a negative guard is a negative guard
  whether its host language is `sh` or Python, and this file's own text
  contains both.
- Extending the bare-`[ ... ]`/bare-`grep` rule (`bin-dispatch.md:19-21`) to a
  third shape: a bare `git ... cat-file -e ...` invocation under `set -eu`
  with no other purpose than to verify a specific object exists in a specific
  repository is one assertion, exactly like a bare `[ -e ... ]` would be. One
  instance exists, at `:91`.
- A bare invocation of the subject under test with no explicit status check
  (`:90`, `spw_fetch_exact_commit ...`; `:236`, `spw_resolve_ref ... main`) is
  **not** counted — `install-commands.md:89`'s rule ("a bare `run_*` with no
  status test is not counted") applies unchanged: `set -eu` catches a
  non-zero exit either way, but that is not itself an assertion about what
  the call produced.

## Divergences from the derived 31

The mechanical count
(`grep -cE '^[[:space:]]*(test |\[ |assert_[a-z_]+ |grep -[A-Za-z]*q)|\| *grep -[A-Za-z]*q' tests/test_ref_resolution.sh`)
returns **31**. Eight divergences apply, all in the same direction (the
mechanical regex only matches lines starting with
`test `/`[ `/`assert_.../`grep -q`, so every guard shaped differently is
invisible to it) — none offsets another, unlike `selection-state.md`'s net-zero
pair:

1. **+1** (`:91`). `git -C "$exact_cache" cat-file -e "$release_commit^{commit}"`
   is a bare postcondition check relied on by `set -eu`, matching neither
   `test`/`[`/`grep -q` — see the counting rule above.
2. **+1** (`:99-103`). `if spw_fetch_exact_commit "$empty_repo" ...; then echo
   … unexpectedly used a cached object …; exit 1; fi`.
3. **+1** (`:110-114`). `if spw_fetch_exact_commit "$repo" "$blob_object" ...;
   then echo … unexpectedly accepted a blob; exit 1; fi`.
4. **+1** (`:117-121`). `if spw_fetch_exact_commit "$repo" "$release_tag_object"
   ...; then echo … unexpectedly accepted an annotated tag object; exit 1; fi`.
5. **+1** (`:176-178`). The embedded Python fixture's `if not marker.exists():
   process.kill(); raise SystemExit("exact fetch did not reach the signal
   fixture")` — the readiness guard for the interruption itself.
6. **+1** (`:185-186`). The same fixture's `if list(workspace_path.glob(...)):
   raise SystemExit("interrupted exact fetch did not clean its proof
   repository")` — the actual workspace-cleanup postcondition, gated behind a
   5-second retry loop (`:182-184`) the mechanical regex cannot see either
   (a bare `while` loop, not itself an assertion).
7. **+1** (`:203-206`). `if spw_resolve_ref "$tagless" "latest-release" ...;
   then echo … expected latest-release to fail without stable tags; exit 1;
   fi`.
8. **+1** (`:216-219`). `if grep -Fq INJECTED "$tmpdir/isolated.err"; then
   echo … upstream seam did not scrub NODE_OPTIONS; exit 1; fi`.

Net: 31 + 8 = **39**. Unlike `selection-state.md`'s pair of compensating
divergences, every one of these eight is a genuine undercount: the mechanical
regex simply cannot see any negative guard, in either language, or a bare
verification command that isn't `test`/`[`/`grep`.

Of the 39, four are retired rather than ported (see items 3, 4, 6, and 7
below) — not because their shell subject was removed (unlike
`bin-dispatch.md`'s retired `pin`/`unpin`/`track-latest` routing items), but
because each has already been fully superseded by existing coverage that
predates this task, and re-running the identical check here would add no
signal. 35 mapped + 4 retired = 39.

## Assertion inventory

<!-- inventory:mapped:start -->

### `BUILDER-GIT-01` deterministic tagged repository (`:14-22`)

Not a registered behavior ID: `BUILDER-GIT-01` matches no pattern in
`docs/baseline/traceability.md`'s `ID_PATTERN`
(`tests/baseline/traceability.test.js:15`). It exercises
`tests/builders/baseline-scenario.sh`'s `git-release-repo` scenario, not
`scripts/core/upstream.sh`.

1. The builder's `REPO=` output names a directory that is a git repository
   (`:21`). Port: `tests/baseline/ref-resolution.test.js:271`.
2. The builder's `STABLE_COMMIT=` output equals the peeled commit of its
   `refs/tags/v1.1.0` tag (`:22`). Port: `:272-278`.

### `spw_config_ref` variable isolation and value (`:24-32`)

Not a registered behavior ID either. `scripts/core/upstream.sh:6-13` wraps
`spw_config_ref` in an explicit `()` subshell so that calling it cannot
leak/clobber the caller's own `root`/`config_root` locals — a POSIX shell
function without that subshell would.

3. Calling `spw_config_ref` does not clobber the caller's own `root` local
   (`:30`). **Retired**: this hazard is a property of POSIX shell functions
   sharing a caller's variable namespace, which `readConfigRef(root, env)` —
   an ordinary TypeScript function taking both as arguments — cannot exhibit.
   JavaScript passes primitives by value and objects by reference; there is
   no mechanism by which calling a function rebinds a *caller's* local
   binding. The hazard class does not exist in the port, so there is no
   runtime property left to assert. See the port file's header comment.
4. Calling `spw_config_ref` does not clobber the caller's own `config_root`
   local (`:31`). **Retired**, same rationale as item 3.
5. With `SUPERPOWERS_REF` unset, `spw_config_ref` returns the packaged
   `config/upstream-ref` contents, trailing whitespace stripped (`:26,29,32`).
   Port: `tests/baseline/ref-resolution.test.js:286-291` (`readConfigRef`
   direct call).

### `REF-LATEST-STABLE-01` numeric stable release selection and peeling (`:34-75`)

6. `spw_manifest_version_for_ref latest-release latest-release v6.0.3
   $short_commit` equals `6.0.3+manager.896224c` (`:38`). **Retired**:
   `tests/unit/upstream.test.js:159-171`'s "manifestVersionForRef reproduces
   the shell derivation table" already exercises this exact
   (`requestedRef: "latest-release"`, `resolutionKind: "latest-release"`,
   `resolvedRef: "v6.0.3"`, `commit: "896224c4b1879920ab573417e68fd51d2ccc9072"`)
   tuple against this exact expected string. The shell driver's own comment
   at `:35-36` says as much ("the tag-grammar and version-derivation cases
   live in tests/unit/upstream.test.js").
7. `spw_manifest_version_for_ref main ref main
   def5678def5678def5678def5678def5678def56` equals
   `0.0.0-main+manager.def5678` (`:39`). **Retired**, same rationale as item
   6: `tests/unit/upstream.test.js:181-189` exercises this exact tuple against
   this exact expected string.
8. `resolveRef` selects the greatest stable tag (`v1.2.3`) for
   `latest-release`, peeled to its commit (`:59-60`). Port:
   `tests/baseline/ref-resolution.test.js:297-302`.
9. A malformed leading-zero tag (`v01.9.9`) does not participate in
   `latest-release` selection (`:62-66`). Port: `:304-312`.
10. `resolveRef` resolves a direct tag hit (`v1.2.3`) to its peeled commit
    (`:68-69`). Port: `:314-315`.
11. `resolveRef` resolves a lightweight tag (`v1.2.2`) to the commit it
    points at directly, with no peeling (`:71-72`). Port: `:317-322`.
12. `resolveRef` treats a 40-hex ref as a raw commit without querying
    (`:74-75`). Port: `:324-329`.

### `REF-GENERIC-FALLBACK-01` arbitrary refs fall back after tag lookup (`:77-81`)

13. `resolveRef` falls through to the generic ref lookup for a branch name
    (`main`) that is not a tag (`:78-79`). Port:
    `tests/baseline/ref-resolution.test.js:334-335`.
14. `resolveRef` falls through to the generic ref lookup for a branch named
    like a tag (`v9.9.9`), rather than matching it as a tag (`:80-81`). Port:
    `:336-341`.

### `REF-SOURCE-PROOF-01` selected source must supply a commit object (`:83-123`)

15. The persistent cache actually holds the requested commit object after a
    successful `fetchExactCommit` (`:91`). Port:
    `tests/baseline/ref-resolution.test.js:359-364` (see "Counting rules
    applied" above for why this bare `cat-file -e` line counts).
16. `fetchExactCommit`'s own inner proof workspace is removed on success,
    leaving only the caller's sibling (`:92`). Port: `:365`.
17. The sibling file is untouched by a successful `fetchExactCommit`
    (`:93`). Port: `:365` (`assertOnlySiblingKept` checks both in one call).
18. An empty (no-commit) source unexpectedly satisfying the request from a
    cached object is itself the failure (`:99-103`). **Merged** into the
    port's `assert.rejects` at `:369-380`, which is strictly stronger — a
    thrown error is not a success — same precedent as `bin-dispatch.md` item
    15.
19. The empty-source failure names the requested commit:
    `source cannot supply requested commit: $release_commit` (`:104-105`).
    Port: `:369-380`.
20. `fetchExactCommit`'s inner proof workspace is removed after the
    empty-source failure too (`:106`). Port: `:381`.
21. The sibling file is untouched by the empty-source failure (`:107`). Port:
    `:381`.
22. A blob object unexpectedly being accepted as the requested commit is
    itself the failure (`:110-114`). **Merged**, same rationale as item 18.
    Port: `:383-394`.
23. The blob-rejection failure names the blob object:
    `requested object is not a commit: $blob_object` (`:115`). Port:
    `:383-394`.
24. An annotated tag object unexpectedly being accepted as the requested
    commit is itself the failure (`:117-121`). **Merged**, same rationale as
    item 18. Port: `:396-407`.
25. The tag-object-rejection failure names the tag object:
    `requested object is not a commit: $release_tag_object` (`:122-123`).
    Port: `:396-407`.

### `REF-CLEANUP-01` interrupted source proof cleans only its workspace (`:125-193`)

26. The interrupted fetch must actually reach the signal fixture before the
    signal is sent, or the interruption proves nothing (`:176-178`, the
    embedded Python fixture's readiness guard). Port:
    `tests/baseline/ref-resolution.test.js:483-489` (`waitForMarker` plus the
    `assert.fail` on timeout).
27. The interrupted fetch's own proof workspace (`superpowers-manager.fetch.*`)
    is removed, allowing for asynchronous cleanup within a 5-second retry
    window (`:182-186`). **Merged** into item 30's single post-exit check
    below: Task 4a's `cleanupForSignal` (`src/workspace.ts:44-80`) cleans
    synchronously and re-raises only afterward, so by the time this port's
    `child.once("close", ...)` has already fired, cleanup is guaranteed
    complete — the retry loop this item hedges against an asynchrony that no
    longer exists on this path. Port:
    `tests/baseline/ref-resolution.test.js:525-530`.
28. The interrupted child's exit status is non-zero (`:189`, bare
    `test "$(cat signal-rc)" -ne 0`). **Merged** into the port's
    `assert.equal(result.signal, "SIGTERM")` / `assert.equal(result.code,
    null)` at `:505-506`, which is strictly stronger (asserting the exact
    cause of death, not merely that it was non-zero) — same precedent as
    `bin-dispatch.md` item 15.
29. The interrupted invocation is specifically the resolver's own inner
    proof-workspace fetch (`-C $signal_workspace/superpowers-manager.fetch.`),
    not some other call (`:190-191`). Port:
    `tests/baseline/ref-resolution.test.js:508-523`.
30. The interrupted fetch's workspace holds only the caller's sibling
    afterward (`:192`). Port: `:530` (also carries item 27's merge, per the
    synchronous-cleanup rationale above).
31. The sibling file is untouched (`:193`). Port: `:530`
    (`assertOnlySiblingKept` checks both in one call).

### An upstream with no stable tags (`:195-207`)

Not a registered behavior ID: no `BASELINE CASE` marker covers this cluster.

32. A source with no stable tags unexpectedly succeeding at `latest-release`
    resolution is itself the failure (`:203-206`). **Merged** into the port's
    `assert.rejects` at `tests/baseline/ref-resolution.test.js:549-554`, same
    rationale as item 18.
33. The failure names the reason: `no stable semver tag found for
    latest-release` (`:207`). Port: `:549-554`.

### The upstream seam scrubs ambient Node preload state (`:209-240`)

Not a registered behavior ID either. `scripts/core/common.sh:61-72`'s
`spw_node_cli` (unset `NODE_OPTIONS`/`NODE_PATH`, then exec `node`) has no
TypeScript counterpart: `resolveRef`/`fetchExactCommit` simply inherit
whatever environment Node was already given, and scrubbing that environment
before Node starts is `spw_node_cli`'s job alone. Ported by running a small
generated script against the still-live shell source, the same technique
`selection-state.md` item 48 uses for `spw_selection_state`.

34. `spw_resolve_ref`, run through the seam with an ambient `NODE_OPTIONS`
    preload injected, still resolves correctly (`:215`). Port:
    `tests/baseline/ref-resolution.test.js:587-588`.
35. The injected preload's own stderr marker (`INJECTED`) unexpectedly
    surviving into the resolver's stderr is itself the failure (`:216-219`).
    **Merged** into the port's exact-stdout equality plus the negative stderr
    check at `:587-589`, together strictly stronger than the shell's bare
    `grep -Fq` guard — same precedent as `bin-dispatch.md` item 15.
36. The pinned child's git invocation sees `LC_ALL=C` (`:237`). Port:
    `tests/baseline/ref-resolution.test.js:630`.
37. The pinned child's git invocation sees `GIT_TERMINAL_PROMPT=0` (`:238`).
    Port: `:631`.
38. The pinned child's git invocation sees `NODE_OPTIONS` scrubbed to unset
    (`:239`). Port: `:632`.
39. The pinned child's git invocation sees `NODE_PATH` scrubbed to unset
    (`:240`). Port: `:633`.

<!-- inventory:mapped:end -->

## Cardinality

```json inventory
{
  "shellOriginal": 39,
  "portOnly": 0,
  "ports": { "tests/baseline/ref-resolution.test.js": 8 }
}
```

- Shell original: **39** assertions (2 `BUILDER-GIT-01` builder, 3
  `spw_config_ref` isolation/value, 7 `REF-LATEST-STABLE-01`, 2
  `REF-GENERIC-FALLBACK-01`, 11 `REF-SOURCE-PROOF-01`, 6 `REF-CLEANUP-01`, 2
  no-stable-tags, 6 Node-preload-scrub; sum: 2+3+7+2+11+6+2+6 = 39). See
  "Divergences from the derived 31" above for why this is 31 plus eight
  undercounted guards, not the mechanical grep's 31 on its own.
- Port (`tests/baseline/ref-resolution.test.js`): 8 static `test(` call
  sites — one ordinary case each for the `BUILDER-GIT-01` builder and
  `readConfigRef`'s value, the four behavior-ID cases
  (`REF-LATEST-STABLE-01`, `REF-GENERIC-FALLBACK-01`, `REF-SOURCE-PROOF-01`,
  `REF-CLEANUP-01`), one ordinary case for the no-stable-tags cluster, and one
  ordinary case for the combined Node-preload-scrub cluster — carrying 35 of
  the 39 shell items mapped (seven recorded merges, at items 18, 22, 24, 27,
  28, 32, and 35, each a negative guard or a redundant retry loop subsumed by
  a stronger check that follows it, same precedent as `bin-dispatch.md` item
  15) and 4 retired (items 3, 4, 6, and 7). 35 mapped + 4 retired = 39. No
  port-only assertions were added: every port assertion restates a shell
  assertion at the same or a strictly stronger granularity.
- Reconciliation: 35 of 39 shell items are mapped; 4 are retired, each with a
  citation to the pre-existing coverage that already supersedes it (items 3-4
  to JavaScript's argument-passing semantics, items 6-7 to
  `tests/unit/upstream.test.js`'s existing `manifestVersionForRef` table) —
  unlike `bin-dispatch.md`'s retired items, none of these four lost a live
  shell subject; each simply has nothing left to prove that isn't already
  proven elsewhere. 35 + 4 = 39.
