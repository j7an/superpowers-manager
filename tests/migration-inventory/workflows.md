# Migration inventory: tests/test_workflows.sh

Source read in full (739 lines). Ported to `tests/bin/workflows.test.js` and
`tests/bin/action-pins.test.js`, with shared helpers in
`tests/bin/workflow-support.js`.

No behavior ID in `docs/baseline/traceability.md` references `test_workflows`
(confirmed by `grep -n 'test_workflows' docs/baseline/traceability.md` on
2026-08-02 — zero matches). This inventory, not the 121-ID count, is the
evidence that no assertion was dropped.

Design: `docs/superpowers/specs/2026-08-02-pr11.1-workflow-driver-migration-design.md`.

Numbering is fixed by Task 0 of the implementation plan and is **stable**:
later tasks fill entries in, and never renumber. A retired number leaves a
gap with a retirement note and is never reused.

## Counting rules applied

Per the task brief: an assertion is a check that can fail and thereby fail
the driver (a Ruby `raise`/`expect_equal`, a shell `if … return 1`, a bare
`grep -q` under `set -eu`, or a Python `raise SystemExit`). Ruby's
`expect_hash`, `fetch`, `expect_equal`, and `uses_target` helpers, the
shell's `spw_test_tmpdir`/`spw_test_root`, and every `echo "…: OK"` line are
scaffolding and are not separately counted. A fixture table counts as one
assertion per fixture. Where one construct makes two independent claims,
count two. Judgment calls made applying these rules to this file's specific
shape:

- **Definition-site raises inside the four named Ruby scaffolding helpers**
  (`expect_hash` `:13`, `fetch` `:18`, `expect_equal` `:22-25`, `uses_target`
  `:28`) are not counted. A call site chaining several of them into one
  comparison (e.g. `:58`'s `expect_equal(fetch(workflow, "permissions",
  "permissions"), {}, "permissions")`) is one assertion, not two or three.
- **`unique_step_target_index` (`:32-43`) and `unique_run_step_index`
  (`:45-54`)** are bespoke, file-specific uniqueness assertions, not among
  the four named scaffolding helpers. Each call site is counted once (e.g.
  items 50-51, 64-69).
- **`assert_no_forbidden` (`:197-210`)** is a bespoke assertion, not a named
  scaffolding helper. Its single call site (`:315`) is counted once (item
  83) even though its regex has several forbidden alternatives — the
  alternatives are one predicate ("contains any forbidden publish-config
  string"), not an enumerated fixture table in the source.
- **`assert_rejected_action_pin` (`:338-345`)**, defined in this file, is
  treated the same way as the four named Ruby helpers: its own `if …
  return 1` is the mechanism, not an extra assertion. Each of its 11 call
  sites (items 6-11, 13-16, and the near-miss at item 12) is one assertion.
- **Repository-content-vs-harness-input discriminator (controller
  adjudication, 2026-08-02).** A guard counts as an assertion if it makes a
  claim about repository content — a workflow YAML file under
  `.github/workflows/`, or a tracked fixture literal in this file that a
  maintainer edits by hand — even when the check happens inside a nested
  helper. A guard is scaffolding only if it validates the harness's own
  inputs (the embedded Ruby/Python scripts' own argv, or an internal
  invariant already guaranteed by the caller) and can never be triggered by
  anything checked into the repository. Applying that discriminator:
  - **Excluded as harness self-defense (upheld):** `collect_external_targets`'s
    "expected string at path.uses" type guard (`:218`) — directly analogous
    to `expect_hash`'s named-scaffolding type guard; `check_inventory`'s
    "workflow path outside root" guard (`:247`) — the caller always builds
    these paths from a glob rooted at `root`, so this is an internal
    invariant, never an externally-triggerable claim; the top-level
    `case domain` CLI dispatch guards (`:323-324`, `:328-329`, `:333`) —
    validate the embedded script's own argv, never triggered by any call
    this file makes.
  - **Reinstated as repository-content assertions (items 97-100, added on
    controller adjudication after this document's initial derivation):**
    `load_expected_external_pins`'s malformed-line (`:235-237`) and
    duplicate-entry (`:240`) guards parse the hardcoded external-pin
    manifest literal written in `write_expected_external_pins`
    (`:422-431`) — tracked source a maintainer edits by hand, so a
    malformed or duplicated row is a real, catchable defect in this file,
    not an unreachable defensive branch. `extract_bump_options`'s
    "duplicated" (`:632`) and "missing" (`:646`) guards parse the real
    `tag-release.yml` — unambiguously repository content.
- **Compound `unless A && B raise` at `:102-104`** is counted as 2 (items
  55-56): two independently named order relations (`harden_index <
  checkout_index`, `checkout_index < acceptance_index`) joined by one `&&`.
  This extends the brief's "shell construct, two claims, count two" rule to
  the equivalent Ruby idiom, there being no shell-level instance of that
  exact pattern in this file to apply it to literally — flagged here as the
  clearest candidate for that rule. By contrast, the six-step total-order
  check at `:167-183` is counted as 1 (item 70): it is expressed as one
  array-equality test against a sorted copy of itself, not a conjunction of
  explicit named relations.
- **Fixture-shaped constructs are unbundled into one assertion per fixture**
  even where the source implements them as a single combined comparison
  rather than a per-fixture call site: the 8 positive and 4 negative literal
  action-pin fixtures in `test_literal_action_pin_detector` (items 17-28),
  and the 8-row external-pin manifest consumed by
  `test_workflow_pin_contracts` (items 31-38).

## Test cases and assertions

### `test_action_pin_helper` — action-pin matcher (`:347-419`)

Ported to `actionPinPair` in `tests/bin/workflow-support.js`, exercised by
`tests/bin/action-pins.test.js`.

1. Unquoted `uses: <target>@<sha>` with an agreeing `# vX.Y.Z` comment
   resolves to the expected `<sha>\t<version>` pair via `action_pin_pair`.
   (`:355-362`)
2. The same unquoted block is accepted by `assert_action_pin`. (`:363`)
3. A single-quoted `uses: '<target>@<sha>'` variant of the same block is
   accepted. (`:365-366`)
4. A double-quoted `uses: "<target>@<sha>"` variant of the same block is
   accepted. (`:367-368`)
5. Two duplicate lines for the same target that agree on SHA and version
   still resolve to one pair. (`:370-378`)
6. A ref using a version string (`@v4.99.0`) instead of a SHA is rejected.
   (`:380-381`)
7. An uppercase-hex SHA is rejected. (`:382-383`)
8. A 39-character (short) SHA is rejected. (`:384-385`)
9. A 41-character (long) SHA is rejected. (`:386-387`)
10. A reference with no trailing `# vX.Y.Z` comment makes the reference
    count and the valid-pin count disagree, and the call throws.
    (`:388-389`) **Does not discriminate** the `reference_count++`-before-
    the-`" # "`-check ordering: this fixture has exactly one reference, so
    both orderings of the counter throw (just via different branches of the
    guard). The ordering property is discriminated only by the port-only
    "reference-count ordering" fixture below, which uses two references —
    see "Discovered gap" below.
11. A pin whose comment is not a full `vMAJOR.MINOR.PATCH` (`# v4`) is
    rejected. (`:390-391`)
12. A different target string (differing from the exact target only by
    punctuation, at the same length) is rejected. (`:393-396`) **Does not
    discriminate** anchored-prefix matching: the near-miss string is not a
    substring of the exact target at any offset, so an anchored and an
    unanchored match reject it identically — this asserts exact-target
    matching, not position. The anchoring property is discriminated only by
    the port-only "anchored prefix match" fixture below — see "Discovered
    gap" below.
13. Two lines for the same target with disagreeing SHA and version comment
    are rejected. (`:398-401`)
14. One valid pin plus one non-SHA (`@v7`) reference to the same target,
    unquoted, is rejected. (`:403-406`)
15. Same as 14, with the invalid line single-quoted. (`:408-411`)
16. Same as 14, with the invalid line double-quoted. (`:413-416`)

**Named merge (items 1-2).** The shell makes two assertions about the same
unquoted block: `:355-362` compares the returned pair against
`printf '%s\t%s'`, and `:363` calls `assert_action_pin`, which is
`action_pin_pair "$1" "$2" >/dev/null` — a strictly weaker form of the same
call. The port's single `assert.deepEqual(actionPinPair(block, TARGET), …)`
("action pin accepted: unquoted") subsumes both, so items 1 and 2 map to one
port assertion. The port is *stronger* than the source overall because it
applies that same `deepEqual` to the single- and double-quoted blocks (items
3-4) where the shell only called `assert_action_pin`. Nothing is dropped;
see "Cardinality" below.

**Named divergence — return-value carrier.** The awk emitted a single
tab-joined string (`sha \t comment`) because awk has one output channel; the
shell compared it against `printf '%s\t%s'`. The port returns
`{ sha, version }`. Same assertion content, different (JS-idiomatic)
carrier.

**Discovered gap in the shell corpus (not a port defect).** Mutation-testing
the port against all 16 shell-derived fixtures above (items 1-16) showed
that none of them discriminates any of the three properties a naive port of
`action_pin_pair` could silently lose: the anchored prefix match
(`index(line, target "@") != 1`, awk `:20`), the quote-close boundary
(`substr(ref, length(ref), 1) != quote`, awk `:33`), or the
`reference_count++`-before-`" # "`-check ordering (awk `:23` vs `:25-28`).
For each property, breaking it in the port left all 16 fixtures GREEN;
restoring the correct behavior and instead probing with a purpose-built
two-line or embedded-target case turned the corresponding new fixture RED.
This means the **original shell driver never exercised these three
properties either** — `test_action_pin_helper` has run since this file was
written without ever constructing a case that could tell a correct
implementation from a broken one on these three axes. The migration did not
lose this coverage; porting is what revealed it was never there. Three
port-only fixtures (below) close the gap; item 10 and item 12 above are
amended to say so precisely rather than repeat the (inaccurate) claim that
they test ordering or anchoring.

### `test_literal_action_pin_detector` — literal-pin detector (`:486-537`)

Ported to `findLiteralActionPinSnapshots` in `tests/bin/workflow-support.js`,
exercised by `tests/bin/action-pins.test.js`.

Positive fixtures: eight literal-pin-shaped lines written to `source_file`
are each detected by `find_literal_action_pin_snapshots` at their correct
`file:line:content`. (`:494-521`) Ported as one `assert.deepEqual` over the
full `DETECTOR_POSITIVE_LINES` array against the whole expected
`path:line:content` block ("literal pin detector reports every embedded-pin
form"), which subsumes all eight per-fixture claims below — nothing is
dropped; see "Cardinality" below.

17. `assert_contains`-embedded fixture (`plain`) is detected.
18. Unquoted `uses:` fixture (`full`) is detected.
19. Single-quoted `uses:` fixture (`single`) is detected.
20. Double-quoted `uses:` fixture (`double`) is detected.
21. Escaped-double-quote fixture (`escaped`) is detected.
22. Parenthesis-wrapped fixture (`parenthesis`) is detected.
23. Backtick-wrapped fixture (`backtick`) is detected.
24. Semicolon-terminated fixture (`semicolon`) is detected.

Negative fixtures: none of four non-pin-shaped lines written to
`negative_file` triggers a false positive. (`:523-534`) Ported as one
`assert.deepEqual(findLiteralActionPinSnapshots([file]), [])` over the whole
`DETECTOR_NEGATIVE_LINES` array ("literal pin detector accepts the negative
fixtures").

25. A `HEAD_SHA=<sha>` assignment (not a `uses:` line) is not flagged. Rejected
    because the whole `owner/repo@hex` shape never matches — this fixture
    exercises neither the SHA-length check nor the boundary check.
26. A 39-character short-SHA `uses:` line is not flagged. **Does not
    discriminate** the boundary check (`delimiter ~ /[[:space:][:punct:]]/`,
    awk `:75`): the run of hex digits is only 39 characters long, so
    `length(sha) == 40` alone already rejects it regardless of what follows.
27. A 41-character long-SHA `uses:` line is not flagged. **Does not
    discriminate** the boundary check either, for the mirror reason: `match`
    is greedy, so the full 41-character hex run is captured as the candidate
    SHA, and `length(sha) == 40` alone already rejects it. (Same property gap
    noted in the brief's own hint — the length test does the rejecting here,
    not the boundary test.)
28. A non-SHA version ref (`@v7`) `uses:` line is not flagged, because `v` is
    not a hex digit, so `[0-9A-Fa-f]+` never matches at that position and the
    whole candidate shape fails — this exercises neither length nor boundary.

**Discovered gap in the shell corpus (not a port defect).** Mutation-testing
the port against all 12 shell-derived fixtures above (items 17-28) showed
that **none of them discriminates either of the two properties a naive port
of `find_literal_action_pin_snapshots` could silently lose**: the boundary
check (delimiter must be empty, whitespace, or punctuation; awk `:75`) and
"one finding per line" (awk's `next` at `:76`, which a `break`-instead-of-
`return` port would violate). For the boundary check: disabling it entirely
(accepting any delimiter once `length(sha) == 40`) left all 20
then-existing tests GREEN — items 26-27 above are rejected purely by the
length check, as noted, never reaching the boundary test. For one-finding-
per-line: letting the scan continue past the first per-line match (instead
of returning) also left all 20 tests GREEN, because no shell fixture places
two independently valid pins on the same line. This means **the original
shell driver never exercised either property** — `test_literal_action_pin_detector`
has run since this file was written without ever constructing a case that
tells a correct implementation apart from a broken one on these two axes.
The migration did not lose this coverage; porting is what revealed it was
never there. Two port-only fixtures (see "Port-only assertions" below) close
the gap. Each was proven discriminating by breaking the corresponding line
in `tests/bin/workflow-support.js`, observing that fixture (and only that
one) go RED, and restoring the correct behavior by editing the file back:
- Boundary check: breaking it turned "literal pin detector port-only: a sha
  immediately followed by a non-hex letter is not a boundary and is
  rejected" RED with `AssertionError [ERR_ASSERTION]: Expected values to be
  strictly deep-equal: ... - []` (actual had one finding), while all other
  21 tests, including items 17-28's ports, stayed GREEN.
- One-finding-per-line: breaking it turned "literal pin detector port-only:
  two valid pins on one line still produce exactly one finding" RED with the
  same line duplicated in `actual` (length 2) against an `expected` of
  length 1, while all other 21 tests stayed GREEN.

### `test_workflow_pin_source_policy` — source policy (`:539-550`)

Ported to the "no test source embeds a literal action pin snapshot" case in
`tests/bin/workflows.test.js`, using `findLiteralActionPinSnapshots` from
`tests/bin/workflow-support.js`.

29. No literal (un-parameterized) SHA-pinned `uses:`-shaped string exists
    anywhere in `tests/*.sh`, `tests/*.py`, `tests/lib/*.sh`, or
    `tests/lib/*.py`. (`:540-548`)

**Named divergence — scan scope widened.** The shell scanned `tests/*.sh`,
`tests/*.py`, `tests/lib/*.sh`, `tests/lib/*.py` — four non-recursive globs
that exclude JavaScript. Porting the driver to JS would have moved the
repository's densest collection of SHA-shaped fixtures (in
`tests/bin/action-pins.test.js`, added by Tasks 3-4) outside its own policy.
The port scans `tests/` recursively for `.sh`, `.py`, `.js`, and `.mjs`: a
strict superset. The design doc measured this on 2026-08-02, before Tasks 3
and 4 existed, at 65 files with zero findings. Re-measured on 2026-08-02
after those tasks landed their SHA-shaped fixtures: **68 files, zero
findings** — those fixtures construct SHA-shaped strings via
`padStart`/`repeat` rather than embedding literal 40-hex pins, so the
widened scan still passes. Verified empirically by running the port's own
test (`tests/bin/workflows.test.js`, "no test source embeds a literal
action pin snapshot") — GREEN — and by planting a literal 40-hex pin in a
throwaway `tests/bin/tmp-policy-probe.js`, confirming it goes RED naming
that file, then removing the probe and confirming GREEN again. Scope
deliberately stops at `tests/`; `src/` and `bin/` are product code and this
is a test-snapshot policy. The port also asserts the scan matched at least
one file, because an empty file list would otherwise pass the policy while
scanning nothing — proven discriminating by forcing the scan to return `[]`
and observing the guard's own message fire, distinctly from the "no
findings" assertion below it.

### `test_workflow_pin_contracts` — pin inventory (`:434-484`)

Ported to three cases in `tests/bin/workflows.test.js` — "external action
inventory matches the workflows", "every inventoried pin is a semantic
40-hex pin", and "all shared-workflows pins agree with one another" — built
on the `EXPECTED_EXTERNAL_PINS` fixture (the port's carrier for the 8-row
manifest) and `collectExternalTargets`, added to
`tests/bin/workflow-support.js` in this task.

30. The set of external (`uses:`) action targets discovered by scanning
    every `.github/workflows/*.yml`/`*.yaml` file exactly matches the
    hardcoded 8-row manifest (no extra, no missing, order-independent). Ruby
    `check_inventory`'s `expect_equal(actual.uniq.sort, expected.sort, ...)`
    (heredoc `:255`; invoked `:449`).
31. `action_pin_pair` resolves without error for the manifest row
    `.github/workflows/ci.yml` / `step-security/harden-runner`. (`:454-458`)
32. Same, for `.github/workflows/ci.yml` / `actions/checkout`. (`:454-458`)
33. Same, for `.github/workflows/ci.yml` / `actions/setup-node`.
    (`:454-458`)
34. Same, for `.github/workflows/dependency-safety.yml` /
    `j7an/shared-workflows/.../dependency-safety.yml`. (`:454-458`)
35. Same, for `.github/workflows/dependency-safety-non-bot-gate.yml` /
    `j7an/shared-workflows/.../dependency-safety-non-bot-gate.yml`.
    (`:454-458`)
36. Same, for `.github/workflows/release.yml` /
    `j7an/shared-workflows/.../publish-npm.yml`. (`:454-458`)
37. Same, for `.github/workflows/security.yml` /
    `j7an/shared-workflows/.../security-scan.yml`. (`:454-458`)
38. Same, for `.github/workflows/tag-release.yml` /
    `j7an/shared-workflows/.../tag-release.yml`. (`:454-458`)
39. All `j7an/shared-workflows/*` targets across the manifest are pinned to
    the same SHA+version pair. (`:459-470`)
40. Exactly 8 manifest rows were processed. (`:473-477`)
41. Exactly 5 of those rows target `j7an/shared-workflows/*`. (`:478-482`)

**Port shape note (items 31-38).** The shell calls `action_pin_pair` once
per manifest row inside one loop, and each row's non-throwing resolution is
one assertion (items 31-38). The port's "every inventoried pin is a
semantic 40-hex pin" case iterates `EXPECTED_EXTERNAL_PINS` with one
`assert.doesNotThrow` per row inside a `for` loop, preserving the 1:1
per-row shape rather than merging it into a single combined assertion, so
items 31-38 map onto eight distinct assertion sites in the port — no merge,
no drop. Per Task 5's brief: `actionPinPair` already throws unless the
reference is a 40-hex lowercase SHA with an agreeing semver comment, so
*not throwing is the assertion* — no `assert.match(pair.sha,
/^[0-9a-f]{40}$/)` is added, since the function already rejects everything
that pattern would catch and such a check could never fail.

**Never a literal SHA.** Items 39 and 41 assert *agreement* among the
`j7an/shared-workflows/*` pins and their count, never the current SHA value
— the SHA is Dependabot's to move, and naming it would red-light this test
on the next unrelated bump. Verified: mutating the real
`.github/workflows/security.yml` pin to a different (still validly
40-hex-pinned) SHA+version drove "all shared-workflows pins agree with one
another" RED with `shared-workflows pins disagree across callers` while the
other four cases in the file stayed GREEN; restoring the file (by editing
it back to the original pin, not `git checkout --`) turned it GREEN again
with a clean `git diff`.

### `test_ci_workflow` — ci.yml (`:552-567`)

Ported to four cases in `tests/bin/workflows.test.js` — "ci.yml declares the
expected top-level contract", "ci.yml `test` job runs the container
acceptance suite in order", "ci.yml `toolchain` job runs the checks in
order", and "ci.yml exists and blocking mode creates no compatibility
workflow" — using `requireMapping` (local to `workflows.test.js`) plus
`uniqueStepTargetIndex` and `uniqueRunStepIndex`, both added to
`tests/bin/workflow-support.js` in this task as 1:1 ports of Ruby's
`unique_step_target_index` (`:32-43`) and `unique_run_step_index` (`:45-54`).

42. `.github/workflows/ci.yml` exists. (`:557`)
43. `.github/workflows/codex-compatibility.yml` does **not** exist
    (blocking-mode invariant). (`:558-561`)

Ruby `check_ci`, invoked `:564`, defined in the heredoc at `:56-195`:

44. Top-level `permissions: {}`. (`:58`)
45. `jobs` keys are exactly `["test", "toolchain"]`. (`:61`)
46. `jobs.test` does not set `continue-on-error`. (`:64`)
47. `jobs.test.runs-on == "ubuntu-latest"`. (`:65`)
48. `jobs.test.permissions.contents == "read"`. (`:66-74`)
49. `jobs.test.steps` is an array. (`:77`)
50. Exactly one `jobs.test` step uses `step-security/harden-runner`. (`:79`)
51. Exactly one `jobs.test` step uses `actions/checkout`. (`:80`)
52. The retired `sh tests/container.sh codex-spike` invocation is forbidden.
    (`:92-94`)
53. Exactly one `sh tests/container.sh` run-step invocation exists.
    (`:95-97`)
54. That invocation's command is exactly `sh tests/container.sh` (no extra
    arguments). (`:99-100`)
55. The harden-runner step precedes the checkout step. (`:102-104`)
56. The checkout step precedes the container-acceptance step. (`:102-104`)
57. The harden-runner step's `with.egress-policy == "audit"`. (`:107-115`)
58. The checkout step's `with.persist-credentials == false`. (`:118-126`)
59. The container-acceptance step does not set `continue-on-error`. (`:129`)
60. `jobs.toolchain` does not set `continue-on-error`. (`:132`)
61. `jobs.toolchain.runs-on == "ubuntu-latest"`. (`:133-137`)
62. `jobs.toolchain.permissions.contents == "read"`. (`:138-149`)
63. `jobs.toolchain.steps` is an array. (`:152`)
64. Exactly one toolchain step uses `step-security/harden-runner`.
    (`:154-157`)
65. Exactly one toolchain step uses `actions/checkout`. (`:158`)
66. Exactly one toolchain step uses `actions/setup-node`. (`:159`)
67. Exactly one toolchain run-step is `corepack enable`. (`:160`)
68. Exactly one toolchain run-step is `pnpm install --frozen-lockfile`.
    (`:161-164`)
69. Exactly one toolchain run-step is `pnpm run check`. (`:165`)
70. The six toolchain steps (harden, checkout, setup-node, corepack, install,
    check) appear in that ascending order. (`:167-183`)
71. The `actions/setup-node` step's `with.node-version == "24"`.
    (`:186-194`)

**Named divergence: `expect_hash` / `fetch` scaffolding is not numbered.**
The Ruby checker's `expect_hash`, `fetch`, `expect_equal`, and `uses_target`
are type guards and comparison helpers, not assertions — matching this
document's existing rule that setup is "not assertions, and … not
numbered." The port replaces them with `requireMapping` plus `node:assert`.
`requireMapping` is load-bearing rather than cosmetic: Ruby's `fetch` raised
on a missing key, whereas JS optional chaining yields `undefined` and would
let every negative assertion in this section pass trivially. Proven for four
such negatives (items 46, 52, 59, 60 — `:64`, `:92-94`, `:129`, `:132`): in
each case, mutating `.github/workflows/ci.yml` so the node the negative
depends on does not exist (renaming `jobs.test`/`jobs.toolchain`, or
deleting the container-acceptance step) drove the corresponding
`node:test` case RED with a `requireMapping`/count-check failure message
(`expected a mapping at jobs.test`, `expected a mapping at jobs.toolchain`,
or `expected exactly one tests/container.sh invocation`) rather than a
silently-passing negative; restoring the file by hand (never `git checkout
--`) turned it GREEN again with a clean `git diff`. Each negative was also
proven to catch a true positive: setting `continue-on-error: true` on
`jobs.test`, `jobs.toolchain`, or the acceptance step, or reinstating `sh
tests/container.sh codex-spike`, drove the same case RED with the negative's
own message, then was restored the same way.

### `test_release_workflow` — release.yml (`:569-579`)

Ported to four cases in `tests/bin/workflows.test.js` — "release.yml
triggers only on version tags", "release.yml publish job delegates to the
shared workflow", "release.yml contains no forbidden publish
configuration", and the port-only "the forbidden-publish detector rejects
a planted violation" — using `requireMapping` (local to
`workflows.test.js`) plus `usesTarget` (already exported from
`tests/bin/workflow-support.js`) and `assertNoForbidden`, added to
`tests/bin/workflow-support.js` in this task as a 1:1 port of Ruby's
`assert_no_forbidden` (`:197-210`).

72. `.github/workflows/release.yml` exists. (`:573`)

Ruby `check_release`, invoked `:576`, defined in the heredoc at `:258-316`:

73. Exactly one active `on`/`true` mapping key. (`:260-261`)
74. `on.push.tags == ["v*.*.*"]`. (`:265`)
75. `jobs.publish.uses` target `== "j7an/shared-workflows/.github/workflows/publish-npm.yml"`.
    (`:270-274`)
76. `jobs.publish.permissions.contents == "write"`. (`:277`)
77. `jobs.publish.permissions.id-token == "write"`. (`:278`)
78. `jobs.publish.with.tag == "${{ github.ref_name }}"`. (`:312-314`, key
    `tag`)
79. `jobs.publish.with.package-name == "superpowers-manager"`. (`:312-314`,
    key `package-name`)
80. `jobs.publish.with.test-command` equals the exact expected
    `corepack enable && pnpm install --frozen-lockfile && pnpm run build &&
    sh tests/container.sh` string. (`:312-314`, key `test-command`)
81. `jobs.publish.with.pack-contents-script == "tests/assert_pack_contents.sh"`.
    (`:312-314`, key `pack-contents-script`)
82. `jobs.publish.with.verify-command` equals the exact expected
    six-attempt-retry npx-verification script. (`:312-314`, key
    `verify-command`)
83. No forbidden publish-configuration string (`--provenance`,
    `npm_config_provenance`, an `npm`/token variant, `node_auth_token`,
    `npm-bootstrap`, `superpowers-wrapper`, `npm publish`, or `--tag next`)
    appears anywhere in the release workflow. (`:197-210`, called `:315`)

**Named divergence: the `on` key.** The shell selected across both `"on"` and
boolean `true` (`tests/test_workflows.sh:260`) because Ruby's Psych is
YAML 1.1. The port asserts the string key is present and the boolean key
absent. The original's "exactly one active on mapping" assertion is preserved
in that stronger form.

**Port-only assertion (outside the 1:1 mapping): the forbidden-publish
detector rejects a planted violation.** `assert_no_forbidden` returning
silently is otherwise indistinguishable from it never inspecting anything.

**Negative-assertion proof (RED then GREEN, every mutation restored
bit-identical per `git diff --stat`).** Three release.yml-specific
negatives were proven, each in both directions — node-absence (does the
guard fire before the negative can pass vacuously?) and true-positive
(does the negative itself catch a real violation?):

1. **`!Object.hasOwn(release, "true")` (`:260-261`).**
   - True-positive: added a literal top-level `true: 1` key to
     `.github/workflows/release.yml`. RED: `AssertionError
     [ERR_ASSERTION]: found a boolean \`true\` key: the parser is applying
     YAML 1.1 coercion`. Restored by hand; `git diff --stat` empty; suite
     GREEN (15/15).
   - Node-absence: renamed the top-level `on:` key to `onx:`. RED:
     `AssertionError [ERR_ASSERTION]: expected the string key \`on\` —
     YAML 1.2 does not coerce it` — the preceding positive assertion fires
     first, so the `true`-key negative is never reached vacuously. Restored
     by hand; `git diff --stat` empty; suite GREEN (15/15).
2. **`with.verify-command` exact-string equality (`:281-303`).** Deleted a
   single leading space from the `if [ "$actual" = "$VERSION" ]; then` line
   inside `.github/workflows/release.yml`'s `verify-command:` block. RED:
   `AssertionError [ERR_ASSERTION]: Expected values to be strictly equal`,
   diff showing the missing space on that exact line. Restored by hand
   (never `git checkout --`); `git diff --stat` empty; suite GREEN (15/15).
   This proves the literal block scalar round-trips byte-for-byte through
   `yaml`, including its trailing newline — the one property a parser swap
   would silently break. (This is a positive equality assertion, not a
   negative one, but it is the brief's named "sharp edge" so it is recorded
   here alongside the negatives.)
3. **`assert_no_forbidden` over the whole document (`:315`).**
   - True-positive: added `extra-note: npm publish` under
     `jobs.publish.with` in the real `.github/workflows/release.yml`. RED:
     `Error: forbidden publish configuration at
     workflow.jobs.publish.with.extra-note: "npm publish"`, thrown from
     inside `assertNoForbidden`'s recursion and surfaced by
     `assert.doesNotThrow`. Restored by hand; `git diff --stat` empty;
     suite GREEN (15/15).
   - Non-vacuity: the synthetic planted-violation test (item above) proves
     `assertNoForbidden` itself throws given forbidden content, rather than
     `assert.doesNotThrow` passing merely because nothing was ever
     inspected — the failure mode a parser or traversal regression would
     produce silently.

Combined, these prove the detector both inspects real repository content
and actually recognizes the forbidden pattern, in the same alternation and
with the same `/i` flag as the Ruby original.

### `test_tag_release_workflow` — tag-release.yml (`:581-729`)

84. `.github/workflows/tag-release.yml` exists. (`:586`)
85. `.version-bump.json` exists. (`:587`)
86. `package.json` exists. (`:588`)
87. `tag-release.yml` contains `workflow_dispatch:`. (`:590`)
88. `tag-release.yml` contains the literal `bump: ${{ inputs.bump }}`.
    (`:591`)
89. `tag-release.yml` contains `tag-prefix: "v"`. (`:592`)
90. `tag-release.yml` contains
    `RELEASE_BOT_PRIVATE_KEY: ${{ secrets.RELEASE_BOT_PRIVATE_KEY }}`.
    (`:593`)
91. `.version-bump.json`'s content is exactly
    `{"files": [{"path": "package.json", "field": "version"}]}`.
    (`:606-608`)
92. The real `tag-release.yml`'s `bump` input options are exactly
    `["auto", "patch", "minor", "major"]`. (`:650-663`)
93. Self-test: a synthetic workflow fragment with a decoy `unrelated` choice
    input plus a 5-option `bump` input (including `prerelease`) is correctly
    rejected — proves the parser keys on the `bump` path specifically, not
    on any preceding sibling key. (`:665-692`)
94. Self-test: `parse_stable_semver` rejects a prerelease string
    (`"1.2.3-beta.1"`) — proves the stable-semver regex does not accept
    prerelease suffixes. (`:710-715`)
95. `package.json`'s `name == "superpowers-manager"`. (`:717-720`)
96. `package.json`'s `version` is a stable (non-prerelease) semver string.
    (`:722-725`)

### Reinstated on controller adjudication — pin inventory and tag-release.yml

Numbers 97-100 were reinstated after this document's initial derivation
excluded them as harness self-defense; see the "Repository-content-vs-
harness-input discriminator" note in "Counting rules applied" above.
Appended here rather than inserted into their logical subsections above, per
the stable-numbering rule: later tasks match by citation, never by position.

97. **Malformed external-pin manifest line is rejected.** `load_expected_external_pins`
    raises `malformed external-pin manifest line <n>: ...` when a manifest
    line does not split into exactly two non-empty tab-separated fields.
    Exercised against the hardcoded manifest literal in
    `write_expected_external_pins` (`:422-431`) — tracked repository source
    a maintainer edits directly, so a dropped tab or added blank field there
    is a real defect this driver catches today. Belongs to the pin-inventory
    subgroup (`test_workflow_pin_contracts`, `:434-484`). (`:235-237`)

    **Ported (Task 5, controller-flagged gap closed 2026-08-02) — option
    (a).** The shell's mechanism (parse a tab-separated manifest *file*,
    raise on a line that doesn't split into exactly two non-empty fields)
    does not exist in the port: `EXPECTED_EXTERNAL_PINS` in
    `tests/bin/workflows.test.js` is a JS array literal, not text parsed
    from a file, so there is no line to malform. The underlying **claim**
    survives unchanged, though: every entry must still have exactly two
    non-empty fields, and `@ts-check` does not enforce this —
    `EXPECTED_EXTERNAL_PINS` infers as `string[][]`, not a fixed-length
    tuple type, so a maintainer-introduced row with the wrong field count
    or an empty field passes typechecking silently. Ported as
    "external-pin manifest fixture entries are well-formed (item 97)",
    asserting `entry.length === 2` and that both fields are non-empty
    strings, for every row. Proven discriminating 2026-08-02: shrinking one
    entry to `[".github/workflows/ci.yml"]` (one field) drove this test RED
    with `EXPECTED_EXTERNAL_PINS[2] must have exactly two fields (path,
    target), got 1`; blanking a field to `["...", ""]` instead drove it RED
    with `EXPECTED_EXTERNAL_PINS[2] has an empty or non-string field`; all
    other cases in the file stayed unaffected by the assertion itself
    (collateral RED occurred in the two pin-matching tests, since the
    mutated row also stopped matching a real workflow file — expected, not
    a defect in this assertion). Restored by editing the file back; GREEN
    confirmed after each restoration.
98. **Duplicate external-pin manifest entry is rejected.** `load_expected_external_pins`
    raises `duplicate external-pin manifest entry` if any two manifest rows
    are identical after parsing. Same tracked-literal reasoning as item 97.
    Belongs to the pin-inventory subgroup. (`:240`)

    **Ported (Task 5, controller-flagged gap closed 2026-08-02) — option
    (a).** Same mechanism change as item 97 (array literal, not a parsed
    manifest file), but the claim is directly portable and was called out
    explicitly as such: a maintainer can still copy-paste a duplicate
    `(workflow, target)` row into `EXPECTED_EXTERNAL_PINS`, and nothing
    catches it structurally. Ported as "external-pin manifest fixture has
    no duplicate entries (item 98)", asserting
    `new Set(serialized).size === serialized.length` over the
    tab-joined rows. Proven discriminating 2026-08-02: replacing the
    `actions/setup-node` row with a second `actions/checkout` row (keeping
    the array at 8 entries, so the separate `EXPECTED_EXTERNAL_PINS.length
    === 8` self-check stayed green and did not mask this assertion) drove
    this test RED with `EXPECTED_EXTERNAL_PINS contains a duplicate
    (workflow, target) entry` (`7 !== 8`, the deduplicated-set size against
    the row count); restored by editing the file back; GREEN confirmed.

    **Pin-inventory subgroup count reconciled:** items 30-41 (12) + 97-98
    (2) = **14**, matching the subgroup total recorded in "Cardinality"
    below. Items 99-100 remain unaddressed by Task 5 — they belong to the
    `test_tag_release_workflow` subgroup (`:581-729`), owned by the task
    that ports `tag-release.yml`.
99. **Duplicate `bump` options block in `tag-release.yml` is rejected.**
    `extract_bump_options`, while walking the real `tag-release.yml` YAML
    text, raises `Tag Release bump options are duplicated` if the
    `on.workflow_dispatch.inputs.bump.options` key path is encountered a
    second time. Parses `tag-release.yml` directly — genuine repository
    content. Belongs to the tag-release.yml subgroup
    (`test_tag_release_workflow`, `:581-729`). (`:632`)
100. **Missing `bump` options block in `tag-release.yml` is rejected.**
    `extract_bump_options` raises `Tag Release bump options are missing` if
    the `on.workflow_dispatch.inputs.bump.options` key path is never
    encountered while walking the real `tag-release.yml` text. **Load-bearing
    for the port:** without this guard, a `tag-release.yml` that lost its
    `bump.options` block entirely yields no options list, and the caller
    (`assert_supported_bump_options`, item 92) would have nothing to compare
    against — a naive port that only asserts "options equal
    `[auto, patch, minor, major]`" can pass vacuously on `undefined`/`null`
    depending on how the comparison is written. **Whoever fills this entry
    in at Task 8 must write an assertion that a `tag-release.yml` fixture
    lacking the `bump.options` block fails distinctly and non-vacuously —
    not rely on item 92's exact-options comparison alone to catch both
    "missing" and "present but wrong."** Belongs to the tag-release.yml
    subgroup. (`:646`)

## Port-only assertions (outside the 1:1 mapping)

This section exists per the brief's skeleton and follows
`npm-pack-contents.md`'s convention: entries a later porting task adds here
have no shell counterpart, are additive test coverage, and are excluded from
the reconciliation arithmetic in "Cardinality" below.

1. **Workflow documents parse under YAML 1.2, keeping `on` a string key.**
   The shell had no equivalent assertion; it instead *worked around* the
   opposite behaviour, selecting across both `"on"` and boolean `true`
   (`on_keys = ["on", true].select { ... }`, `tests/test_workflows.sh:260`)
   because Ruby's Psych is YAML 1.1 and coerces the `on:` key to a boolean.
   The port reads `.github/workflows/ci.yml` with the `yaml` devDependency
   (YAML 1.2), asserts `Object.hasOwn(ci, "on")` is true and positively
   asserts `Object.hasOwn(ci, "true")` is false, so the inherited workaround
   becomes an executable, falsifiable statement that fires loudly if the
   parser is ever swapped for a YAML-1.1 one. Verified against the real
   file on 2026-08-02: `Object.keys(parse(ci))` is
   `["name","on","concurrency","permissions","jobs"]`. Mutation-tested:
   inverting the negation on the `"true"`-key check reproduces the failure
   this assertion exists to catch. Port-only — it has no shell counterpart
   and is outside the 1:1 mapping. (`tests/bin/workflows.test.js`)

2. **Anchored prefix match: a target embedded mid-line, not at the start, is
   rejected.** `actionPinPair` requires `line.indexOf(target + "@") === 0`
   after prefix/quote stripping — a target that merely *contains* the sought
   target string, but does not begin with it, must not match. No shell
   fixture discriminates this (see the "Discovered gap" note under
   `test_action_pin_helper` above): the shell's own near-miss fixture
   (item 12, `:393-396`) uses a target that is not a substring of the line
   at any offset, so it cannot tell an anchored check apart from an
   unanchored one. This fixture uses `prefix-actions/checkout@<sha>` against
   target `actions/checkout` instead. Mutation-tested 2026-08-02: replacing
   the anchored `indexOf(...) === 0` check with an unanchored
   "find `target@` anywhere and re-slice from that offset" implementation
   drove only this fixture RED (`AssertionError: Missing expected
   exception`); restoring the anchored check turned it GREEN again, with
   all other fixtures unaffected throughout. Port-only — it has no shell
   counterpart. (`tests/bin/action-pins.test.js`)
3. **Quote-close boundary: a reference opened with one quote and apparently
   closed with a different quote is rejected.** `actionPinPair` requires the
   character immediately before the `" # "` separator to equal the opening
   quote when the line opened with `'` or `"`. No shell fixture
   discriminates this — none of the shell's quoted fixtures (items 3-4,
   15-16) constructs a mismatched-quote line. This fixture opens with `'`
   and reaches `" # "` with a trailing `"` instead. Mutation-tested
   2026-08-02: disabling the closing-quote comparison (unconditionally
   stripping the last character without checking it matches the opening
   quote) drove only this fixture RED; restoring the check turned it GREEN
   again. Port-only — it has no shell counterpart.
   (`tests/bin/action-pins.test.js`)
4. **Reference-count ordering: a bare reference alongside a valid one to the
   same target forces a count disagreement.** `actionPinPair` increments
   `referenceCount` for every anchored match *before* checking for the
   `" # "` separator, so a same-target reference with no version comment
   still counts as a reference (just not a valid pin), forcing
   `validCount !== referenceCount`. No shell fixture discriminates this: the
   shell's own single-bare-reference fixture (item 10, `:388-389`) throws
   under either ordering, because with exactly one reference,
   `referenceCount === 0` triggers the same throw as
   `validCount !== referenceCount` would. This fixture uses two references —
   one valid, one bare — to the same target, which only a same-target
   full-vs-bare count mismatch can catch. Mutation-tested 2026-08-02: moving
   the `referenceCount += 1` increment to after the separator check (so a
   bare reference is never counted at all) drove only this fixture RED;
   restoring the original order turned it GREEN again. Port-only — it has
   no shell counterpart. (`tests/bin/action-pins.test.js`)
5. **Boundary check: a SHA immediately followed by a non-hex letter, with no
   intervening whitespace or punctuation, is rejected.**
   `findLiteralActionPinSnapshots` requires the character right after a
   40-hex candidate to be absent, whitespace, or POSIX punctuation
   (`PIN_BOUNDARY`, mirroring awk `:75`). No shell fixture discriminates
   this (see the "Discovered gap" note under `test_literal_action_pin_detector`
   above): the shell's 39- and 41-character SHA fixtures (items 26-27,
   `:523-534`) are both rejected by the SHA-length check alone, before the
   boundary check is ever reached. This fixture uses a full 40-character SHA
   immediately followed by the letter `z` (non-hex, non-punctuation,
   non-whitespace) instead. Mutation-tested 2026-08-02: disabling the
   boundary check (accepting any delimiter once `length(sha) === 40`) drove
   only this fixture RED (`AssertionError [ERR_ASSERTION]: Expected values
   to be strictly deep-equal: ... - []`, actual had one unwanted finding);
   restoring the check turned it GREEN again, with all other 21 fixtures
   unaffected throughout. Port-only — it has no shell counterpart.
   (`tests/bin/action-pins.test.js`)
6. **One finding per line: two independently valid pins on the same line
   still produce exactly one finding.** `findLiteralActionPinSnapshots`
   `return`s out of the per-line scan as soon as it reports a finding,
   matching awk's `next` (`:76`), rather than continuing to scan the same
   line for further candidates. No shell fixture discriminates this: none of
   the shell's eight positive fixtures (items 17-24, `:494-521`) places two
   valid pins on one line. This fixture uses one line with two distinct
   valid `actions/checkout@<sha>` references. Mutation-tested 2026-08-02:
   letting the scan continue past the first per-line match instead of
   returning drove only this fixture RED (the same line duplicated in
   `actual`, length 2, against an `expected` of length 1); restoring the
   early return turned it GREEN again, with all other 21 fixtures unaffected
   throughout. Port-only — it has no shell counterpart.
   (`tests/bin/action-pins.test.js`)

## Cardinality

- Shell original: **100** assertions.
- Subgroup totals: action-pin matcher **16**; literal-pin detector **12**;
  source policy **1**; pin inventory **14** (12 derived initially + items
  97-98 reinstated on controller adjudication); ci.yml **30**; release.yml
  **12**; tag-release.yml **15** (13 derived initially + items 99-100
  reinstated on controller adjudication). Sum check:
  16 + 12 + 1 + 14 + 30 + 12 + 15 = 100, matching the total above.
- Action-pin matcher port (`tests/bin/action-pins.test.js`): 15 `node:test`
  cases 1:1-reconciling the 16 shell assertions (3 accepted-form + 1
  agreeing-duplicate + 11 rejected cases), via one 2:1 merge — items 1-2
  both exercise the unquoted accepted block and are subsumed by the port's
  single `assert.deepEqual` case (see "Named merge" above) — **plus** 3
  port-only discriminating fixtures (anchored prefix match, quote-close
  boundary, reference-count ordering; items 2-4 in "Port-only assertions"
  above) that have no shell counterpart and are outside the 1:1 mapping.
  Reconciliation: 1:1 for all 16 original action-pin items via the one
  named merge, no drops; the 3 additional port-only fixtures are strictly
  additive coverage for a gap discovered in the shell corpus, not a
  reconciliation of any shell assertion.
- Literal-pin detector port (`tests/bin/action-pins.test.js`): 2 `node:test`
  cases 1:1-reconciling the 12 shell assertions (8 positive-form fixtures
  bundled into one `assert.deepEqual` over the full expected output block,
  plus 4 negative fixtures bundled into one emptiness `assert.deepEqual`) —
  **plus** 2 port-only discriminating fixtures (boundary check, one-finding-
  per-line; items 5-6 in "Port-only assertions" above) that have no shell
  counterpart and are outside the 1:1 mapping. Reconciliation: 1:1 for all
  12 original literal-pin-detector items via the two fixture-bundle merges,
  no drops; the 2 additional port-only fixtures are strictly additive
  coverage for a gap discovered in the shell corpus, not a reconciliation of
  any shell assertion.
- Port: filled in at Task 10.
