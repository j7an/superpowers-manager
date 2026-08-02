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
- **The following raises/guards are excluded as scaffolding**: they validate
  the Ruby/Python helper scripts' own CLI arguments or the test's own
  hardcoded fixtures, are never triggered by any call this file actually
  makes, and assert nothing about repository/workflow content: the top-level
  `case domain` dispatch guards (`:323-324`, `:328-329`, `:333`);
  `check_inventory`'s "workflow path outside root" guard (`:247`);
  `collect_external_targets`'s "expected string at path.uses" type guard
  (`:218`); `load_expected_external_pins`'s malformed-line and
  duplicate-entry guards (`:235-237`, `:240`); `extract_bump_options`'s
  "duplicated"/"missing" guards (`:632`, `:646`).
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
10. A pin with no trailing `# vX.Y.Z` comment is rejected. (`:388-389`)
11. A pin whose comment is not a full `vMAJOR.MINOR.PATCH` (`# v4`) is
    rejected. (`:390-391`)
12. A near-miss target string that differs from the exact target only by
    punctuation is not treated as a match (no false positive from
    substring/prefix matching). (`:393-396`)
13. Two lines for the same target with disagreeing SHA and version comment
    are rejected. (`:398-401`)
14. One valid pin plus one non-SHA (`@v7`) reference to the same target,
    unquoted, is rejected. (`:403-406`)
15. Same as 14, with the invalid line single-quoted. (`:408-411`)
16. Same as 14, with the invalid line double-quoted. (`:413-416`)

### `test_literal_action_pin_detector` — literal-pin detector (`:486-537`)

Positive fixtures: eight literal-pin-shaped lines written to `source_file`
are each detected by `find_literal_action_pin_snapshots` at their correct
`file:line:content`. (`:494-521`)

17. `assert_contains`-embedded fixture (`plain`) is detected.
18. Unquoted `uses:` fixture (`full`) is detected.
19. Single-quoted `uses:` fixture (`single`) is detected.
20. Double-quoted `uses:` fixture (`double`) is detected.
21. Escaped-double-quote fixture (`escaped`) is detected.
22. Parenthesis-wrapped fixture (`parenthesis`) is detected.
23. Backtick-wrapped fixture (`backtick`) is detected.
24. Semicolon-terminated fixture (`semicolon`) is detected.

Negative fixtures: none of four non-pin-shaped lines written to
`negative_file` triggers a false positive. (`:523-534`)

25. A `HEAD_SHA=<sha>` assignment (not a `uses:` line) is not flagged.
26. A 39-character short-SHA `uses:` line is not flagged.
27. A 41-character long-SHA `uses:` line is not flagged.
28. A non-SHA version ref (`@v7`) `uses:` line is not flagged.

### `test_workflow_pin_source_policy` — source policy (`:539-550`)

29. No literal (un-parameterized) SHA-pinned `uses:`-shaped string exists
    anywhere in `tests/*.sh`, `tests/*.py`, `tests/lib/*.sh`, or
    `tests/lib/*.py`. (`:540-548`)

### `test_workflow_pin_contracts` — pin inventory (`:434-484`)

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

### `test_ci_workflow` — ci.yml (`:552-567`)

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

### `test_release_workflow` — release.yml (`:569-579`)

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

## Port-only assertions (outside the 1:1 mapping)

None yet. This section exists per the brief's skeleton and follows
`npm-pack-contents.md`'s convention: entries a later porting task adds here
have no shell counterpart, are additive test coverage, and are excluded from
the reconciliation arithmetic in "Cardinality" below.

## Cardinality

- Shell original: **96** assertions.
- Subgroup totals: action-pin matcher **16**; literal-pin detector **12**;
  source policy **1**; pin inventory **12**; ci.yml **30**; release.yml
  **12**; tag-release.yml **13**. Sum: 16 + 12 + 1 + 12 + 30 + 12 + 13 = 96,
  matching the total above.
- Port: filled in at Task 10.
