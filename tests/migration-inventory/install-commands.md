# Migration inventory: tests/test_install_commands.sh

Source read in full (782 lines). Ported to
`tests/bin/install-commands.test.js`.

No behavior ID in `docs/baseline/traceability.md` references
`test_install_commands` (confirmed by
`grep -c test_install_commands docs/baseline/traceability.md` returning 0).
This inventory is the evidence that no assertion was dropped.

Shell line references below are `:N` against the deleted
`tests/test_install_commands.sh`; port line references are `:N` against
`tests/bin/install-commands.test.js`.

## Counting rules applied

The first six rules are reproduced from `bin-dispatch.md:10-25`, unchanged:

- Each `[ ... ] || { echo …; exit 1; }` guard is one assertion.
- Each `grep -Fq` / `grep -Fqx` is one assertion, including bare ones relied
  on by `set -e`.
- Each `if <command>; then echo …; exit 1; fi` negative guard is one
  assertion.
- A `for` loop over N commands performing one assertion each contributes N.
- The `command -v node` precondition at `bin-dispatch:9` is one assertion.
- A bare `[ ... ]` test with no `|| { ... }` handler, relied on by `set -e`
  exactly like a bare `grep`, is counted the same way — one assertion each.
  Three such bare tests exist here: `:388`, `:399`, and `:415`.

Rules 7 and 8 are reproduced from `uninstall-commands.md:33-49`, unchanged:

- **Rule 7 — assertion helpers count at the call site, not at the
  definition.** This driver factors three assertion helpers out of its
  scenarios: `expect_fail` (`:289-295`), `assert_install_tmp_empty`
  (`:297-303`), and `assert_no_codex_mutation` (`:313-319`). Each body is one
  rule-1 or rule-3 guard, so this is that rule applied at the point of use.
  `line_of` (`:305-307`) and `adapter_line_of` (`:309-311`) are value
  extractors, not assertions, and are not counted. Neither are `reset`
  (`:226-235`), `set_update_control` (`:237-239`), `seed_installed_current`
  (`:241-251`), or the three `run_*` wrappers (`:253-287`).
- **Rule 8 — a negative guard whose condition is a `||` chain of N
  independent `grep` tests counts N, not 1.** Three occurrences here:
  `:561-563`, `:696-700`, and `:712-716`. The two greps in each are
  independent claims sharing only a diagnostic block, and the port makes each
  a separate assertion, so counting them separately keeps the mapping 1:1.

Two further rules are needed for this driver, stated explicitly rather than
folded silently into the eight above:

- **Rule 9 — a guard whose condition is an `&&` chain of N independent
  `[ ... ]` tests counts N, not 1.** This is rule 8 applied to the other
  operator, and it governs the five ordering guards at `:500`, `:527`, `:546`,
  `:578`, and `:729`. `{ [ "$a" -lt "$b" ] && [ "$b" -lt "$c" ]; } || { echo
  …; exit 1; }` makes two independent ordering claims about three separately
  extracted line numbers; the shell shares one diagnostic block between them
  purely for brevity. The port expresses each guard as a single `assertOrder`
  call, so N shell items map onto one port line — recorded per item below
  rather than merged away.
- **Rule 10 — an embedded `python3` heredoc counts one assertion per
  independent claim it can fail on, expanding a loop over a fixed literal
  tuple per literal.** That is rule 4 applied inside Python. Two heredocs
  carry assertions: `:11-42` (one unreadable-file guard, four forbidden
  literals, one `app-server` line guard = **6**) and `:759-768` (one
  40-hex-commit guard = **1**). The heredocs at `:118-127`, `:131-139`,
  `:150-158`, and `:458-467` mutate fixtures and assert nothing; they
  contribute 0.

**A bare `run_*` with no status test is not counted.** `:325`, `:398`, `:495`,
`:522`, `:541`, `:560`, `:574`, `:593`, `:724`, `:755`, and `:777` all take
the form `run_install >"$state/out"`, leaving the exit status to `set -e`.
`bin-dispatch.md` and `uninstall-commands.md` both treat that as implicit and
record the port's explicit `assert.equal(result.status, 0, …)` as port-only.
Same treatment here.

**`:600-602` is one assertion, not two.** The construct is
`[ ! -s "$log" ] || { assert_no_codex_mutation; }`. The `[ ]` is a condition
selecting whether to check, not a claim about the subject; the helper call is
the assertion (rule 7).

**Alternative reading, for the record.** Rules 9 and 10 are the two places a
reasonable reader could count differently. Collapsing every `&&`/`||` chain to
one assertion and counting only `raise SystemExit` sites inside `:11-42`
yields **112** rather than 124. Decision: **124**, following the rule-8
precedent already set by `uninstall-commands.md` — the port makes each claim
separately, and a 1:1 mapping is the property this file exists to certify.

## Assertion inventory

<!-- inventory:mapped:start -->

### Source guards: no hook-trust mutation surface in production scripts (`:11-42`)

These read the repository's own `scripts/`, not a fixture snapshot, so the
port reads `ROOT`.

1. An unreadable production script is a hard failure, never a skip
   (`:26-29`). Port: `:417`.
2. No production script contains `requirements.toml` (`:30-35`, literal 1 of
   4). Port: `:423`.
3. No production script contains `hooks.state` (literal 2 of 4). Port:
   `:423`.
4. No production script contains `trusted_hash` (literal 3 of 4). Port:
   `:423`.
5. No production script contains `--dangerously-bypass-hook-trust` (literal 4
   of 4). Port: `:423`.
6. No production script names `app-server` outside a comment (`:36-41`).
   Port: `:431`.

### Packaged root preconditions (`:77-82`)

7. `scripts/install` is executable in the packaged root (`:77`). Port:
   `:449`.
8. `scripts/adapters/codex/adapter` is executable (`:78`). Port: `:449`.
9. `dist/validate-generated-plugin-cli.js` is packaged (`:79`). Port: `:461`.
10. `dist/generated-plugin.js` is packaged (`:80`). Port: `:461`.
11. `dist/python-text.js` is packaged (`:81`). Port: `:461`.
12. `scripts/adapters/codex/validate-generated-plugin.py` is **not** packaged
    (`:82`). Port: `:467`.

### Prepare is capability-independent (`:321-336`)

13. The adapter log holds no `inspect --view update-control` (`:326-330`).
    Port: `:485`.
14. The adapter log holds no `install --package-root` (`:331-335`). Port:
    `:490`.
15. No Codex mutation (`:336`, `assert_no_codex_mutation`). Port: `:497`,
    which asserts the strictly stronger property that the Codex log is
    **empty** — prepare makes no Codex call at all, and unlike the helper's
    form that claim is non-vacuous on its own.

### Unsupported update control blocks the update fast path (`:338-347`)

16. Update fails (`:344`). Port: `:516`.
17. Output contains `adapter cannot guarantee manager-controlled updates`
    (`:345`). Port: `:521`.
18. Output does **not** contain `manager is current` (`:346`). Port: `:528`.
    Non-vacuous: item 17 proves the output carries the subject's diagnostics.
19. No Codex mutation (`:347`). Port: `:533`.

### Unsupported update control blocks a direct install (`:349-352`)

20. Install fails (`:351`). Port: `:544`.
21. No Codex mutation (`:352`). Port: `:548`.

### Malformed update-control output exits exactly 1 (`:354-364`)

22. Install does not succeed (`:357-362`). Port: `:556`.
23. The exit status is exactly 1 (`:363`). Port: `:556`. **Merged:** one
    `assert.equal(result.status, 1, …)` carries items 22 and 23 together,
    because `status === 1` implies `status !== 0`.
24. No Codex mutation (`:364`). Port: `:562`.

### Failed update-control inspection exits exactly 1 (`:366-375`)

25. Update does not succeed (`:368-373`). Port: `:569`.
26. The exit status is exactly 1 (`:374`). Port: `:569`. Merged with item 25,
    as items 22-23 were.
27. No Codex mutation (`:375`). Port: `:575`.

### A needs-prepare install reinspects after prepare (`:377-392`)

28. Install rejects capability drift after prepare (`:383-386`). Port:
    `:590`.
29. Stdout contains `prepared v1.0.0` (`:387`). Port: `:596`.
30. Update control was inspected exactly twice (`:388`, bare `[ ... ]` per
    rule 6). Port: `:598`.
31. The build line precedes the second update-control inspection (`:391`).
    Port: `:608`. `head -n1` for the build line, `tail -n1` for the second
    inspection, as the shell did.
32. No Codex mutation (`:392`). Port: `:613`.

### The needs-install path inspects freshly, then installs (`:394-404`)

33. Update control was inspected exactly twice (`:399`, bare `[ ... ]`).
    Port: `:625`.
34. The last ownership inspection precedes the last update-control gate
    (`:403`). Port: `:632`.
35. The last update-control gate precedes the adapter install (`:404`). Port:
    `:636`.

### The fresh gate, not the probe, controls mutation authority (`:406-416`)

36. Install rejects capability drift before adapter install (`:411-414`).
    Port: `:651`.
37. Update control was inspected exactly twice (`:415`, bare `[ ... ]`).
    Port: `:660`.
38. No Codex mutation (`:416`). Port: `:662`.

### Legacy and mixed identity state stop before mutation (`:425-451`)

The `for legacy_state in legacy both` loop contributes 6 assertions per
iteration (rule 4). Items 39-44 are the `legacy` iteration, items 45-50 the
`both` iteration. Both port to the shared helper at `:361-394`; the call sites
are `:671` and `:680`.

39. Install rejects the `legacy` identity state (`:438-441`). Port: `:365`.
40. Output holds the exact line `Legacy superpowers-wrapper Codex state is
    installed.` (`:442`). Port: `:374`.
41. Output holds the exact line `Run: npx superpowers-wrapper@0.1.1
    uninstall` (`:443`). Port: `:378`. This literal is user-facing guidance
    owned by `scripts/core/lifecycle.sh:52`, not a dependency version that
    moves on someone else's schedule — the exact text is the contract.
42. Output holds the exact line `Then run: npx superpowers-manager install`
    (`:444`). Port: `:379`.
43. The adapter log holds no `^build ` or `^install ` line (`:445-449`).
    Port: `:387`.
44. No Codex mutation (`:450`). Port: `:393`.
45. Install rejects the `both` identity state (`:438-441`, iteration 2).
    Port: `:365` via `:680`.
46. The same exact `Legacy superpowers-wrapper …` line (`:442`, iteration 2).
    Port: `:374` via `:680`.
47. The same exact `Run: npx superpowers-wrapper@0.1.1 uninstall` line
    (`:443`, iteration 2). Port: `:378` via `:680`.
48. The same exact `Then run: npx superpowers-manager install` line (`:444`,
    iteration 2). Port: `:379` via `:680`.
49. No `^build ` or `^install ` adapter line (`:445-449`, iteration 2). Port:
    `:387` via `:680`.
50. No Codex mutation (`:450`, iteration 2). Port: `:393` via `:680`.

### Built-in validation failure leaves Codex untouched (`:453-476`)

51. Install fails on built-in validation (`:468-472`). Port: `:700`.
52. Output contains ``field `name` must equal `superpowers` `` (`:473`).
    Port: `:706`.
53. No Codex mutation (`:474`). Port: `:708`.

### Additional-validator failure leaves Codex untouched (`:478-487`)

54. Install fails on additional validation (`:481-485`). Port: `:722`.
55. Output contains `additional plugin validation failed` (`:486`). Port:
    `:728`.
56. No Codex mutation (`:487`). Port: `:730`.

### Scenario 1 — fresh install (`:489-512`)

57. Prepare generated the tree: the package root carries
    `.superpowers-upstream.json` (`:496`). Port: `:760`.
58. `plugin marketplace list` precedes `plugin marketplace add <pkg>`
    (`:500`, first `[ ]` of the rule-9 chain). Port: `:767`, via
    `assertOrder`.
59. `plugin marketplace add <pkg>` precedes `plugin add
    superpowers@superpowers-manager` (`:500`, second `[ ]`). Port: `:767`,
    same call.
60. Stdout contains `manager updated` (`:502`). Port: `:777`.
61. The invocation TMPDIR is left empty (`:503`,
    `assert_install_tmp_empty`). Port: `:779`, helper at `:293`. **Scope
    narrowed — see the note below.**
62. The Codex log holds no `marketplace remove` (`:504-506`). Port: `:782`.
63. The Codex log holds no `plugin remove superpowers@superpowers-manager`
    (`:507-509`). Port: `:786`.
64. The Codex log never names `openai-curated` (`:510-512`). Port: `:790`.
    Items 62-64 are non-vacuous because items 58-59 prove all three expected
    commands reached the log.

**TMPDIR scope narrowing (items 61 and 94).** The shell created
`$install_tmp` once at `:96-97` and `reset` (`:226-235`) never cleared it, so
by `:503` the check proved that *every* run since the top of the file had left
no residue. `assertTmpEmpty(c)` inspects one case's own TMPDIR, because
`createCase` gives every case a private one. The claim is therefore narrower
at both call sites: it still catches a leak in the scenario that makes it, but
no longer sweeps up the scenarios that ran before it. This is an unavoidable
consequence of per-case isolation, not an oversight; it mirrors the identical
narrowing recorded at `uninstall-commands.md:157-170`.

### Scenario 1b — a current manager is reconciled, not skipped (`:514-532`)

65. The adapter log holds `install --package-root <pkg>` (`:523`). Port:
    `:812`.
66. `plugin marketplace list` precedes `plugin marketplace add <pkg>`
    (`:527`, first `[ ]`). Port: `:817`.
67. `plugin marketplace add <pkg>` precedes `plugin add
    superpowers@superpowers-manager` (`:527`, second `[ ]`). Port: `:817`.

### Scenario 1c — a matching fingerprint at a different root (`:534-551`)

68. The adapter log holds `install --package-root <pkg>` (`:542`). Port:
    `:844`.
69. `plugin marketplace remove superpowers-manager` precedes `plugin
    marketplace add <pkg>` (`:546`, first `[ ]`). Port: `:849`.
70. `plugin marketplace add <pkg>` precedes `plugin add
    superpowers@superpowers-manager` (`:546`, second `[ ]`). Port: `:849`.

### Scenario 2 — the same physical root via a symlink (`:553-567`)

71. The Codex log holds no `marketplace add` (`:561`, first grep of the
    rule-8 `||` chain). Port: `:882`.
72. The Codex log holds no `marketplace remove` (`:561`, second grep of the
    same chain). Port: `:886`.
73. The Codex log holds `plugin add superpowers@superpowers-manager`
    (`:564`). Port: `:877` — hoisted **above** items 71-72 in the port so
    neither negative can pass on an empty log.
74. The Codex log holds no `plugin remove superpowers@superpowers-manager`
    (`:565-567`). Port: `:891`.

### Scenario 3 — a different registered root (`:569-585`)

75. `plugin marketplace remove superpowers-manager` precedes `plugin
    marketplace add <pkg>` (`:578`, first `[ ]`). Port: `:912`.
76. `plugin marketplace add <pkg>` precedes `plugin add
    superpowers@superpowers-manager` (`:578`, second `[ ]`). Port: `:912`.
77. The Codex log holds no `marketplace remove openai-curated` (`:580-582`).
    Port: `:922`.
78. The Codex log holds no `plugin remove superpowers@superpowers-manager`
    (`:583-585`). Port: `:926`.

### Scenario 3b — update stays read-only when probe reports current (`:587-602`)

79. Stdout contains `manager is current` (`:594`). Port: `:944`.
80. The adapter log holds no `install --package-root` (`:595-599`). Port:
    `:947`.
81. No Codex mutation (`:600-602`). Port: `:955`. **Divergence:** the shell
    wrapped the helper in `[ ! -s "$log" ] ||`, so an empty Codex log
    satisfied the scenario. The port drops that escape hatch —
    `assertNoCodexMutation`'s emptiness guard reports an empty log as the
    fixture fault it would be, since probe always reaches
    `codex plugin list`. Strictly stronger, and recorded so the difference is
    not mistaken for an oversight.

### Scenario 3c — update rejects mixed legacy state while current (`:604-620`)

82. Update fails (`:610-613`). Port: `:972`.
83. Output holds the exact line `Then run: npx superpowers-manager install`
    (`:614`, `grep -Fxq`). Port: `:978`.
84. The adapter log holds no `^build ` or `^install ` line (`:615-619`).
    Port: `:986`.
85. No Codex mutation (`:620`). Port: `:992`.

### Scenario 4 — remove succeeds, add fails (`:622-634`)

86. Install fails (`:629`, `expect_fail`). Port: `:1006`.
87. Output names the root it failed to add: `plugin marketplace add <pkg>`
    (`:630`). Port: `:1013`.
88. Output names the previous root it had already removed (`:631`). Port:
    `:1014`.
89. The Codex log holds no `plugin add superpowers@superpowers-manager` — the
    plugin add was never attempted (`:632-634`). Port: `:1017`.

### Scenario 5 — malformed marketplace listing (`:636-646`)

90. Install fails (`:641`). Port: `:1032`.
91. The Codex log holds no `marketplace (add|remove)` and no `^plugin
    (add|remove)` (`:642-646`). Port: `:1039`. The ERE here is wider than
    `assert_no_codex_mutation`'s — `marketplace (add|remove)` is unanchored —
    so the port carries it as its own pattern rather than reusing
    `CODEX_MUTATION`.

### Scenario 6 — plugin add refreshes nothing (`:648-659`)

92. Install fails (`:654`). Port: `:1053`.
93. Output contains `fingerprint is not detectable` (`:655`). Port: `:1059`.
94. The invocation TMPDIR is left empty (`:656`). Port: `:1061`. Same scope
    narrowing as item 61.
95. Output does **not** contain `manager updated` (`:657-659`). Port:
    `:1064`. Non-vacuous: item 93 proves the output carries the subject's
    verification diagnostics.

### Scenario 7 — the installed fingerprint stays stale (`:661-674`)

96. Install fails (`:669`). Port: `:1077`.
97. Output contains `does not match the prepared plugin` (`:670`). Port:
    `:1083`.
98. Output contains `SUPERPOWERS_INSTALL_REFRESH_MODE=remove-add` (`:671`).
    Port: `:1087`. The hint text is owned by `src/adapter.ts:641-643` and
    replayed from the adapter result by `scripts/core/lifecycle.sh:109,121`;
    core holds no copy of it.
99. Output does **not** contain `manager updated` (`:672-674`). Port:
    `:1089`.

### Scenario 8 — the missing-fingerprint replay hint (`:676-685`)

100. Install fails (`:683`). Port: `:1102`.
101. Output contains `fingerprint is not detectable` (`:684`). Port: `:1108`.
102. Output contains `verify with 'codex plugin list --json'` (`:685`,
     `src/adapter.ts:645`). Port: `:1110`.

### Scenario 8a — fingerprint inspection command failure (`:687-700`)

103. Install fails (`:694`). Port: `:1120`.
104. Output contains `fingerprint inspection` (`:695`). Port: `:1126`.
105. Output does **not** contain `fingerprint is not detectable` (`:696`,
     first grep of the rule-8 `||` chain). Port: `:1129`.
106. Output does **not** contain `manager updated` (`:697`, second grep of
     the same chain). Port: `:1133`. Items 105-106 are non-vacuous because
     item 104 proves the output carries the subject's diagnostics.

### Scenario 8b — malformed fingerprint inspection output (`:702-716`)

107. Install fails (`:709`). Port: `:1146`.
108. Output contains `invalid adapter response` (`:710`). Port: `:1152`.
109. Output contains `fingerprint inspection` (`:711`). Port: `:1154`.
110. Output does **not** contain `fingerprint is not detectable` (`:712`,
     first grep of the rule-8 chain). Port: `:1156`.
111. Output does **not** contain `manager updated` (`:713`, second grep).
     Port: `:1160`.

### Scenario 9 — remove-add refresh mode (`:718-736`)

112. `plugin marketplace list` precedes `plugin marketplace add <pkg>`
     (`:729`, first `[ ]` of the rule-9 chain). Port: `:1177`.
113. `plugin marketplace add <pkg>` precedes `plugin remove
     superpowers@superpowers-manager` (`:729`, second `[ ]`). Port: `:1177`.
114. `plugin remove superpowers@superpowers-manager` precedes `plugin add
     superpowers@superpowers-manager` (`:729`, third `[ ]`). Port: `:1177`.
115. The Codex log never names `openai-curated` (`:734-736`). Port: `:1188`.
     Non-vacuous via items 112-114.

### Scenario 10 — invalid refresh mode (`:738-745`)

116. Install fails (`:744`, `expect_fail`). Port: `:1203`.
117. No Codex mutation (`:745`). Port: `:1209`.

### Scenario 11 — install remediates malformed generated provenance (`:747-768`)

118. Stdout contains `prepared v1.0.0` (`:756`). Port: `:1230`. `v1.0.0` is
     the tag the fixture creates for itself (`lifecycle-fixture.js:118-127`),
     an input this test owns — not a version whose source of truth lives
     elsewhere.
119. Stdout contains `manager updated` (`:757`). Port: `:1232`.
120. The adapter log holds `install --package-root <pkg>` (`:758`). Port:
     `:1235`.
121. The regenerated provenance carries a `commit` that is a string of
     exactly 40 hex digits (`:759-768`, rule 10). Port: `:1240`, helper at
     `:340`.

### Scenario 12 — update takes the same remediation path (`:770-780`)

122. Stdout contains `prepared v1.0.0` (`:778`). Port: `:1256`.
123. Stdout contains `manager updated` (`:779`). Port: `:1258`.
124. The adapter log holds `install --package-root <pkg>` (`:780`). Port:
     `:1261`.

<!-- inventory:mapped:end -->

## Preconditions the shell established by scenario ordering

The shell driver established several preconditions implicitly, through the
state one scenario left behind for the next. Per-case isolation destroys that
inheritance silently, so each is reconstructed explicitly. Recorded here
because a case that passes for a different reason than the original is exactly
the defect this migration exists to eliminate.

- **A valid generated tree in `$pkg`.** The teardown at `:420-423` stripped
  the package root back to a bare `plugin.template.json`; the fresh install at
  `:495` put a valid generated tree back, and nothing removed it again. Every
  scenario from `:519` to `:745` therefore reached the subject with that tree
  present. The port rebuilds it with `prepareGeneratedTree(c)` (`:210`).
  Measured on this fixture: a fresh case probes `needs prepare`, after
  `prepareGeneratedTree` it probes `needs install`, and after
  `seedInstalledCurrent` as well it probes `current`.
- **The `current` branch.** Scenarios 1b (`:519`), 1c (`:538`), 3b (`:591`),
  and 3c (`:607`) add `seed_installed_current` on top of that tree. Ports at
  `:799`, `:831`, `:935`, and `:961`. In the port, 1b and 1c pin the branch
  with `assertNoPrepareRan` (`:809`, `:841`); 3b is pinned by ported item 79,
  since `manager is current` is printed only by `scripts/update:20`. 3c cannot
  be pinned from its output — `scripts/update:11` rejects the mixed identity
  state before the status `case` is reached — so its `current` precondition
  rests on the same construction 3b proves live.
- **Empty logs.** `reset` (`:233-234`) truncated `codex.log` and `adapter.log`
  before each scenario, so a scenario's logs held only its own subject's
  calls. `prepareGeneratedTree` runs *inside* the case here, so `clearLogs(c)`
  (`:276`) restores that. Not cosmetic: without it, prepare's own
  `build --upstream-root` adapter line sits in the log item 84 reads, and item
  84 fails. Verified by removing the call and observing exactly that failure.
- **No generated tree.** Scenario 1 (`:493`) is the one case in this range
  that must *not* have the tree, because item 57 is a claim about the subject
  generating it. Its port omits `prepareGeneratedTree` deliberately.
- **A tree to corrupt.** Scenarios 11 and 12 overwrite the provenance with `{`
  in a package root that already carried a full generated tree, so the
  remediation exercises `spw_replace_generated_tree`'s replace-an-existing-
  tree path (`scripts/core/lifecycle.sh:7-26`). The ports call
  `prepareGeneratedTree(c)` before corrupting, preserving that.

**Fixture-precondition assertions are excluded from both counts.** The
`assert` calls inside `prepareGeneratedTree` (`:212`, `:219`, `:223`) and
`seedInstalledCurrent` (`:123`) verify that the fixture reached the state the
shell inherited. They are claims about the harness, not about the subject,
and follow `uninstall-commands.md:51-61`'s treatment of `command -v`
resolution.

## Port-only assertions (outside the 1:1 mapping)

Items 6, 16, 23, 24, 26, 28, 29, 30, 37, 39, and 40 are the additive pattern
`bin-dispatch.md` records: the shell left the exit status implicit under
`set -e`, and the port asserts it explicitly.

Items 1-5, 7, 9, 11-15, 18, 20-22, 31-36, and 38 are non-vacuity guards with
no shell analogue. The shell's `$log` and `$state/adapter.log` were files the
fakes appended to before doing anything else, so `grep` over them could not
silently degrade; `readLog` returns `[]` for a missing file, so a negative
over an empty log would pass whether or not the property holds.

Items 8, 10, 17, 19, 25, and 27 are `assertNoPrepareRan` precondition guards,
described in the section above.

Item 41 extends the shell's install-path provenance check to the update path.

<!-- inventory:port-only:start -->

1. `assertLegacyIdentityStops` adapter-log non-vacuity guard (`:383`) at the
   `legacy` call site (`:671`).
2. The same guard at the `both` call site (`:680`).
3. `assertNoCodexMutation` emptiness guard (`:169`), reached through the
   helper at `:393`, at the `legacy` call site (`:671`).
4. The same guard at the `both` call site (`:680`).
5. `scripts/` held at least one file, so the source scan proved something
   (`:437`).
6. Prepare exits 0 (`:478`; shell `:325` left it implicit).
7. The adapter log holds `build --upstream-root`, hoisting items 13-14 above
   an empty log (`:483`).
8. `assertNoPrepareRan` at the unsupported-update-fast-path case (`:519`).
9. `assertNoCodexMutation` emptiness guard at `:533`.
10. `assertNoPrepareRan` at the unsupported-direct-install case (`:546`).
11. `assertNoCodexMutation` emptiness guard at `:548`.
12. `assertNoCodexMutation` emptiness guard at `:562`.
13. `assertNoCodexMutation` emptiness guard at `:575`.
14. The build line exists at all (`:607`); the shell's `[ "$build_line" -lt
    … ]` would have errored on an empty extraction rather than said so.
15. `assertNoCodexMutation` emptiness guard at `:613`.
16. Install exits 0 on the needs-install path (`:621`; shell `:398`).
17. `assertNoPrepareRan` at the needs-install case (`:623`).
18. The adapter install line exists at all (`:631`).
19. `assertNoPrepareRan` at the fresh-gate case (`:658`).
20. `assertNoCodexMutation` emptiness guard at `:662`.
21. `assertNoCodexMutation` emptiness guard at `:708`.
22. `assertNoCodexMutation` emptiness guard at `:730`.
23. Install exits 0 in scenario 1 (`:758`; shell `:495`).
24. Install exits 0 in scenario 1b (`:803`; shell `:522`).
25. `assertNoPrepareRan` at scenario 1b (`:809`).
26. Install exits 0 in scenario 1c (`:839`; shell `:541`).
27. `assertNoPrepareRan` at scenario 1c (`:841`).
28. Install exits 0 in scenario 2 (`:873`; shell `:560`).
29. Install exits 0 in scenario 3 (`:909`; shell `:574`).
30. Update exits 0 in scenario 3b (`:939`; shell `:593`).
31. `nonEmpty` adapter-log guard in scenario 3b (`:946`), hoisting item 80.
32. `assertNoCodexMutation` emptiness guard at `:955`.
33. Adapter ownership non-vacuity guard in scenario 3c (`:982`), hoisting
    item 84.
34. `assertNoCodexMutation` emptiness guard at `:992`.
35. `nonEmpty` Codex-log guard in scenario 4 (`:1016`), hoisting item 89.
36. `nonEmpty` Codex-log guard in scenario 5 (`:1038`), hoisting item 91.
37. Install exits 0 in scenario 9 (`:1174`; shell `:724`).
38. `assertNoCodexMutation` emptiness guard at `:1209`.
39. Install exits 0 in scenario 11 (`:1227`; shell `:755`).
40. Update exits 0 in scenario 12 (`:1254`; shell `:777`).
41. The regenerated provenance carries a 40-hex `commit` after the **update**
    remediation path (`:1268`). The shell ran this check only for install
    (`:759-768`); update reaches the same remediation through
    `scripts/update:22-25`, so the same claim is asserted there.

<!-- inventory:port-only:end -->

## Mutation proof

Not yet performed. The formal Decision-5 sweep for this port — inject the
violation into the fixture, observe which assertions turn RED, and adjudicate
every guard that stays GREEN — is a separate task in this PR series, and its
injection matrix, divergences, adjudications, and coverage ledger will be
recorded in this section. The `uninstall-commands.md:403-614` sweep is the
model.

One targeted observation was made while writing the port, and is recorded here
because it justifies a structural choice rather than an assertion: removing
`clearLogs(c)` from the scenario-3c port turns item 84 RED with
`build --upstream-root …` as the sole offender, confirming that the log
truncation `reset` performed is load-bearing and not decorative.

## Cardinality

```json inventory
{
  "shellOriginal": 124,
  "portOnly": 41,
  "ports": { "tests/bin/install-commands.test.js": 32 }
}
```

- Shell original: **124** assertions (6 source guards, 6 packaged-root
  preconditions, 3 prepare, 4 unsupported-update-fast-path, 2
  unsupported-direct-install, 3 malformed-update-control, 3
  failed-update-control, 5 needs-prepare-drift, 3 needs-install, 3
  fresh-gate, 12 legacy/mixed identity, 3 built-in-validation, 3
  additional-validator, 8 scenario 1, 3 scenario 1b, 3 scenario 1c, 4
  scenario 2, 4 scenario 3, 3 scenario 3b, 4 scenario 3c, 4 scenario 4, 2
  scenario 5, 4 scenario 6, 4 scenario 7, 3 scenario 8, 4 scenario 8a, 5
  scenario 8b, 4 scenario 9, 2 scenario 10, 4 scenario 11, 3 scenario 12;
  sum: 6+6+3+4+2+3+3+5+3+3+12+3+3+8+3+3+4+4+3+4+4+2+4+4+3+4+5+4+2+4+3 = 124).
- Port (`tests/bin/install-commands.test.js`): 32 static `test(` call sites,
  counted with `migration-inventory.test.js`'s own `stripInert` +
  `/(?<![A-Za-z0-9_$.])test\(/g` method rather than a naive grep. No call site
  is data-driven, so the 32 static sites produce 32 runtime cases. The
  `for legacy_state in legacy both` loop at `:426` is expanded into two
  explicit call sites (`:665`, `:674`) sharing one helper.
- Reconciliation: all 124 shell items are accounted for and none is dropped,
  but the mapping is **not** 1:1 throughout. 109 items map onto a port
  assertion of their own; the remaining 15 share 7, across seven merges
  recorded inline. Two are status merges — items 22/23 and 25/26 each collapse
  onto one `assert.equal(status, 1)`, since `=== 1` implies `!== 0`. Five are
  rule-9 ordering guards — items 58-59, 66-67, 69-70, 75-76, and 112-114 —
  each collapsing onto one `assertOrder` call, which asserts every one of
  those ordering claims plus the presence of each needle. Two orderings
  differ from the shell: items 71-73 and items 62-64 assert the positive claim
  before the negatives that depend on it. Two fidelity notes are recorded
  inline rather than left implicit: items 61 and 94 carry a **narrowed TMPDIR
  scope** forced by per-case isolation, and item 81 **drops the shell's
  empty-log escape hatch**, making the claim strictly stronger. Neither
  changes the count. The 41 port-only assertions are strictly additive and are
  excluded from the 124-item accounting above.
