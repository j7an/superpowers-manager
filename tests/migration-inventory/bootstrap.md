# Migration inventory: tests/test_bootstrap.sh
<!-- FROZEN: historical migration record. Declared historical against ad56569a4c161e7b122967442e2b026eeb6395f6. -->
<!-- Port pointers are NOT maintained. An item's identity is its quoted assertion text, not its number. -->
<!-- Resolve shell-original citations with: git show 0b6d50e1e9c688397285c6fa274dc8c9437d8ba3:tests/test_bootstrap.sh -->

Source read in full (226 lines). Ported to `tests/bin/bootstrap.test.js`.

No behavior ID in `docs/baseline/traceability.md` references `test_bootstrap`
(confirmed by grep on 2026-07-31 — zero matches). This inventory, not the
121-ID count, is the evidence that no assertion was dropped.

`assert_file` = path exists as a file under repo root. `assert_contains` =
file contains the literal text. `assert_not_contains` = file does not
contain the literal text. Numbers below map 1:1 to `node:test` assertions in
the port unless a merge is called out.

## File-presence and negative-existence assertions (`:34-45`)

<!-- inventory:mapped:start -->

1. `.gitignore` exists
2. `config/upstream-ref` exists
3. `.agents/plugins/marketplace.json` exists
4. `plugins/superpowers/.codex-plugin/plugin.template.json` exists
5. `scripts/adapters/codex/adapter` does **not** exist. The 4c deletion inverts
   the port into the shared absence set.
6. `src/generated-plugin.ts` exists
7. `src/validate-generated-plugin-cli.ts` exists
8. `scripts/adapters/codex/validate-generated-plugin.py` does **not** exist.
   **RETIRED at the gap (Task 3, 4c):** an absence assertion inside the
   deleted tree is vacuous and has no port counterpart.
9. `scripts/core/validate-adapter-response.py` does **not** exist. The 4c
   deletion inverts the port into the shared absence set.

## Text-content assertions (`:47-124`)

10. `package.json` contains `"type": "module"`
11. `bin/superpowers-manager.js` does not contain `import.meta.main`
12. `config/upstream-ref` contains `latest-release`
13. `.agents/plugins/marketplace.json` contains `"name": "superpowers-manager"`
14. `.agents/plugins/marketplace.json` contains `"products": ["CODEX"]`
15. `.gitignore` contains `plugins/superpowers/.codex-plugin/plugin.json`
16. `.gitignore` contains `plugins/.superpowers.prepare.*/`
17. `.gitignore` does not contain `plugins/.superpowers.tmp.*/`
18. `plugins/superpowers/.codex-plugin/plugin.template.json` contains `"name": "superpowers"`
19. `plugins/superpowers/.codex-plugin/plugin.template.json` contains `"skills": "./skills/"`
20. `AGENTS.md` contains `` Run `sh tests/container.sh` before declaring a change complete. ``
21. `AGENTS.md` contains "no mutation of the developer's or runner's real Codex state"
22. `AGENTS.md` contains "Adapter installation and refresh mutations require current, validated update-control evidence."
23. `AGENTS.md` contains `pnpm install --frozen-lockfile`
24. `AGENTS.md` contains `` `src/` ``
25. `AGENTS.md` contains `` `dist/` ``
26. `README.md` contains `sh tests/container.sh`
27. `README.md` contains "Layers 1-3 stay offline and hermetic"
28. `README.md` contains "Layer 4 is the Docker acceptance path"
29. `README.md` contains "sh tests/container.sh                    # Layers 1-4: blocking Docker acceptance command"
30. `README.md` contains `pnpm install --frozen-lockfile`
31. `README.md` contains `pnpm run build`
32. `README.md` contains "toolchain"
33. `README.md` contains "no public harness selector"
34. `README.md` contains "superpowers-manager pin v6.1.1"
35. `README.md` contains "superpowers-manager track-latest"
36. `README.md` contains "superpowers-manager unpin"
37. `README.md` contains "selection commands save intent only"
38. `README.md` contains `` `SUPERPOWERS_REF` is an invocation-only override ``
39. `README.md` contains "SUPERPOWERS_REF=feature/foo npx superpowers-manager probe"
40. `tests/expected_tarball_contents.txt` contains `dist/selection-state-cli.js`
41. `tests/expected_tarball_contents.txt` does not contain `scripts/core/selection-state.py`.
    **RETIRED at the gap (Task 3, 4c):** vacuous once the whole tree leaves the
    manifest; no port counterpart.
42. `tests/expected_tarball_contents.txt` does not contain `dist/adapter-cli.js`.
    Slice 5 unshipped the artifact — `src/adapter-cli.ts` existed solely to
    serialize envelopes for the retired protocol drivers — which inverts the
    port.
43. `tests/expected_tarball_contents.txt` contains `dist/adapter-result.js`.
    Slice 5 renamed `src/adapter-protocol.ts` to `src/adapter-result.ts`; the
    artifact changed name, not membership.
44. `tests/expected_tarball_contents.txt` contains `dist/adapter.js`
45. `tests/expected_tarball_contents.txt` contains `dist/generated-plugin.js`
46. `tests/expected_tarball_contents.txt` contains `dist/python-text.js`
47. `tests/expected_tarball_contents.txt` contains `dist/validate-generated-plugin-cli.js`
48. `tests/expected_tarball_contents.txt` does not contain `scripts/adapters/codex/validate-generated-plugin.py`.
    **RETIRED at the gap (Task 3, 4c):** same vacuity class as item 41; no
    port counterpart.
49. `tests/expected_tarball_contents.txt` contains `dist/codex-json.js`
50. `tests/expected_tarball_contents.txt` contains `dist/codex-state.js`
51. `tests/expected_tarball_contents.txt` does not contain `dist/hooks-cli.js`
52. `tests/expected_tarball_contents.txt` does not contain `scripts/adapters/codex/lib.sh`.
    **RETIRED at the gap (Task 3, 4c):** same vacuity class as item 41; no
    port counterpart.
53. `tests/expected_tarball_contents.txt` contains `dist/hooks.js`
54. `tests/expected_tarball_contents.txt` does not contain `scripts/adapters/codex/materialize-hooks.py`.
    **RETIRED at the gap (Task 3, 4c):** same vacuity class as item 41; no
    port counterpart.
55. `tests/expected_tarball_contents.txt` does not contain `scripts/core/selection.sh`.
    The 4c deletion inverts the port.
56. `tests/expected_tarball_contents.txt` does not contain `scripts/pin`.
    **RETIRED at the gap (Task 3, 4c):** this already-deleted path becomes a
    vacuous member of a wholly deleted tree; no port counterpart.
57. `tests/expected_tarball_contents.txt` does not contain `scripts/track-latest`.
    **RETIRED at the gap (Task 3, 4c):** same vacuity class as item 56; no
    port counterpart.
58. `tests/expected_tarball_contents.txt` does not contain `scripts/unpin`.
    **RETIRED at the gap (Task 3, 4c):** same vacuity class as item 56; no
    port counterpart.
59. `RELEASING.md` contains `` Ensure `main` is green (`sh tests/container.sh`) ``
60. `RELEASING.md` contains `sh tests/container.sh`
61. `RELEASING.md` contains `pnpm install --frozen-lockfile`
62. `RELEASING.md` contains `pnpm run build`
63. `RELEASING.md` contains `` `prepack` ``
64. `RELEASING.md` contains "`v0.1.2` and `v0.1.3` were failed and unpublished maintenance attempts."
65. `RELEASING.md` contains "`v0.1.4` was the recovered maintenance publication."
66. `RELEASING.md` contains "`v0.1.5` failed before publication and must never be moved, reused, rerun, or published."
67. `RELEASING.md` contains "`v0.1.6` published successfully through OIDC and is immutable."
68. `RELEASING.md` contains "No npm token belongs in this path."
69. `RELEASING.md` contains "No prerelease path is authorized."
70. `RELEASING.md` contains "Persistent upstream-version pinning is required before production `0.2.0`."
71. `RELEASING.md` contains "protected `release` environment"
72. `RELEASING.md` contains "protected `npm` environment"
73. `RELEASING.md` contains "Never run or rerun a release workflow for `v0.1.5`, and never publish `superpowers-manager@0.1.5` by any path."
74. `RELEASING.md` contains "j7an/superpowers-manager"
75. `RELEASING.md` contains "workflow `release.yml`"
76. `RELEASING.md` contains "environment `npm`"
77. `RELEASING.md` does not contain "Published Manager baseline for version monotonicity"
78. `RELEASING.md` does not contain "Advance this marker after successful publication"
79. `RELEASING.md` does not contain "one-time `0.1.6` recovery"
80. `RELEASING.md` does not contain "0.1.6 recovery"
81. `RELEASING.md` does not contain "npm-bootstrap"
82. `RELEASING.md` does not contain "NPM_BOOTSTRAP_TOKEN"
83. `RELEASING.md` does not contain "j7an/superpowers-wrapper"
84. `tests/manual/codex-behavior-probe.sh` contains "Optional native-only Codex compatibility probe"
85. `README.md` does not contain "The automated suite is fully hermetic: it uses a fake local upstream repo and a"

## Structural release-section assertions (`:126-223`, embedded Python)

The shell driver embeds a `python3` heredoc that defines
`extract_section`/`assert_release_verification_sections` and runs it three
times: once against the real `RELEASING.md`, and twice against inline
fixture strings that must be *rejected*. The port re-implements the same
section-extraction logic in JavaScript (no Python invocation) against the
same real file and the same two fixture strings.

86. Exactly one `### Pre-publication approval` heading exists in `RELEASING.md`
    (`extract_section` raises if `len(matches) != 1`).
87. Exactly one `### Post-publication verification` heading exists in
    `RELEASING.md`.
88. The `Pre-publication approval` section starts before the
    `Post-publication verification` section.
89. Pre-publication body contains "frozen tag and source SHA"
90. Pre-publication body contains "package name and version"
91. Pre-publication body contains "tarball digest"
92. Pre-publication body contains "zero npm secrets"
93. Pre-publication body contains "before approving publication"
94. Post-publication body contains "npm provenance"
95. Post-publication body contains "clean-cache `npx` execution"
96. Post-publication body contains "published version and source SHA"
97. Post-publication body contains "after publication"
98. Negative fixture "swapped sections" (Post-publication heading appears
    before Pre-publication heading, each carrying the other's expected body
    text) is rejected by the same validation logic — i.e. running the
    validator against it raises/throws.
99. Negative fixture "misplaced evidence" (headings in the correct order, but
    each section's body carries the *other* section's required phrases) is
    rejected by the same validation logic.

<!-- inventory:mapped:end -->

## Port-only assertions (outside the 1:1 mapping)

<!-- inventory:port-only:start -->

1. An unreadable path passed to `read()` (e.g. a renamed or deleted file) is
   reported as `bootstrap inventory file could not be read: <path>`, never as
   a raw `ENOENT` with a stack. Port-only — no shell counterpart;
   `tests/test_bootstrap.sh`'s `assert_file` had no such guard.

<!-- inventory:port-only:end -->

## Cardinality

```json inventory
{
  "shellOriginal": 99,
  "portOnly": 1,
  "ports": { "tests/bin/bootstrap.test.js": 11 }
}
```

- Shell original: **99** assertions (85 flat `assert_*` calls at
  `tests/test_bootstrap.sh:34-124`, plus 14 assertions in the embedded Python
  release-section validator at `tests/test_bootstrap.sh:126-223`: 2
  exactly-one-section checks, 1 ordering check, 5 pre-publication phrase
  checks, 4 post-publication phrase checks, and 2 negative-fixture rejection
  checks).
- Port (`tests/bin/bootstrap.test.js`): 91 assertions retain counterparts,
  one `node:test` case per numbered item above (items 1-85 grouped into
  `node:test` subtests by source file for readability; each retains its own
  `assert.*` call so a single dropped check still fails independently),
  **plus** 1 port-only assertion (the unreadable-path guard added in Task 4)
  that has no shell counterpart and is outside the 1:1 mapping.
- Reconciliation: **91 of 99** original items retain a port counterpart. Eight
  absence assertions retire at their numbered gaps: items 8, 41, 48, 52, 54,
  and 56-58. Items 5 and 9 invert into the repository absence set; items 42 and 55
  invert in the tarball manifest. The one additional port-only assertion is
  strictly additive coverage, not a reconciliation of a shell assertion.
