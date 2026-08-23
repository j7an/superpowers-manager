# Migration inventory: tests/test_selection_state.sh
<!-- FROZEN: historical migration record. Declared historical against ad56569a4c161e7b122967442e2b026eeb6395f6. -->
<!-- Port pointers are NOT maintained. An item's identity is its quoted assertion text, not its number. -->
<!-- Resolve shell-original citations with: git show 349fe2ed405b371ec2de1347bb3fc50c6bc15dc4:tests/test_selection_state.sh -->

Source read in full (335 lines). Ported to
`tests/baseline/selection-location.test.js`.

## Counting rules applied

- Each `test "..." = "..."` / `test ! -s ...` / `test -d ...` line, and each
  `grep -Fq`/`grep -Fxq` (including bare ones relied on by `set -e`), is one
  assertion — same rule as `bin-dispatch.md`.
- Each `assert_effective ...` call site is one assertion: the shell's own
  choice was to bundle eight field comparisons behind one named helper call,
  and the port preserves that same granularity with one `assertEffective(...)`
  call per site (see the divergence note below for why the helper's
  *definition* is not itself counted).
- Extending `bin-dispatch.md`'s "bare `[ ... ]` relied on by `set -e`" rule to
  its `if <command>; then echo …; exit 1; [else …] fi` cousin: a negative
  guard with no `||` handler, where succeeding is itself the failure, is one
  assertion, exactly as if it had been written `<command> && { echo …; exit
  1; }`. `bin-dispatch.md` already applies this rule to that exact shape;
  this file just has eight instances of it that the mechanical grep — which
  only matches lines starting with `test `/`[ `/`assert_[a-z_]+ `/`grep -q` —
  cannot see, because every one of these guards starts with `if`.

## Divergences from the derived 51

The mechanical count
(`grep -cE '^[[:space:]]*(test |\[ |assert_[a-z_]+ |grep -[A-Za-z]*q)|\| *grep -[A-Za-z]*q' tests/test_selection_state.sh`)
returns **51**. Two divergences apply, and they happen to offset exactly:

1. **+8, undercounted.** Eight `if (...); then echo …; exit 1; [else …] fi`
   negative guards start with `if`, not `test`/`[`/`assert_.../`grep -q`, so
   the mechanical regex misses all of them: `:34` (permission-denied target
   unexpectedly readable), `:47` (relative `SUPERPOWERS_CONFIG_DIR`
   unexpectedly succeeds), `:52` (relative `XDG_CONFIG_HOME`), `:57` (missing
   `HOME`), `:63` (`spw_usage_error` unexpectedly succeeds), `:292` (malformed
   saved state unexpectedly succeeds), `:305` (credential-bearing source
   unexpectedly succeeds), `:327` (missing selection-state helper
   unexpectedly succeeds). Applying the counting rule above, uniformly,
   credits each as one assertion: +8.
2. **-8, double-counted.** `assert_effective`'s eight-line *definition*
   (`:123-130`, one `test "$VAR" = "$expected"` per `EffectiveSelection`
   field) is itself matched by the mechanical `test ` pattern, as if it were
   eight independent top-level assertions. It is not: those eight lines never
   execute except as the body of one of the fourteen `assert_effective(...)`
   *call sites* (`:141,153,162,171,180,190,199,209,218,231,241,252,263,277`),
   each of which the mechanical grep also matches — correctly, once per call.
   Crediting both the definition and the fourteen calls double-bills the same
   eight field checks fourteen times over. Subtracting the definition's eight
   lines leaves the fourteen call-site hits standing on their own, each
   already representing its own bundled eight-field comparison (ported as one
   `assertEffective(...)` call — see "Counting rules applied" above): -8.

   The shell's `assert_effective` also calls a second helper,
   `assert_exported_selection` (`:103-112`), once per invocation. That helper
   is a single bundled `: "$VAR1" "$VAR2" ...` compound command checking that
   fourteen `SPW_*` environment exports are all set under `set -u`. It has no
   line matching the mechanical grep at all (a bare `:` command matches
   none of `test `/`[ `/`assert_.../`grep -q`), so it was never in the 51 to
   begin with, is not being added as a new item here, and is not itemized on
   its own below — it is the same conceptual assertion as the
   `assert_effective` call that invokes it (the call is the item). Thirteen of
   the fourteen exports are covered structurally rather than by a runtime
   check: eight map onto `EffectiveSelection`'s fields
   (`src/effective-selection.ts:54-62`) and five onto
   `NormalizedSavedSelection`'s fields (`src/selection.ts:24-30`), and both
   interfaces declare every field `readonly` and non-optional, so "these
   thirteen are populated" is a compile-time guarantee. The fourteenth,
   `SPW_SELECTION_STATE_PATH`, is not a field of either interface — it comes
   from a separate function, `selectionStatePath` — so it has no structural
   counterpart and is not covered by this argument; nothing in the port
   asserts it either, since `computeEffectiveSelection`'s return value never
   carries the state path.

Net: 51 + 8 - 8 = **51**. The reconciled figure equals the derived figure,
but for reasons that require both adjustments named above, not because no
divergence exists.

## Assertion inventory

<!-- inventory:mapped:start -->

### The permission-denied builder's own guarantee (`:22-40`)

Not a registered behavior ID: `BUILDER-PERMISSION-01` matches no pattern in
`docs/baseline/traceability.md`'s `ID_PATTERN`
(`tests/baseline/traceability.test.js:15`), and the shell's own
`permission_root`/`permission_target`/`permission_parent` variables are never
referenced again after this block. It exercises
`tests/builders/baseline-scenario.sh`'s `permission-denied` scenario, not
`scripts/core/selection.sh`.

1. The builder's `ROOT=` output names a directory that exists (`:30`). Port:
   `tests/baseline/selection-location.test.js:298`.
2. Unless running as root, the builder's `TARGET=` output names a file that
   is not readable (`:34-37`, `if [ -r ... ]; then ... exit 1; fi`). Port:
   `:301-309` (root-skip branch at `:301`, the negative check itself at
   `:309`).

### Selection location chain and fail-closed bases (`:41-70`)

3. `SUPERPOWERS_CONFIG_DIR`, explicit, wins over every other base (`:42`).
   Port: `tests/baseline/selection-location.test.js:316-323`.
4. `XDG_CONFIG_HOME`, with `SUPERPOWERS_CONFIG_DIR` absent, wins over `HOME`
   (`:43`). Port: `:325-328`.
5. An empty `XDG_CONFIG_HOME` is treated as absent, falling through to `HOME`
   (`:44`). Port: `:330-333`.
6. `HOME` alone is the last base (`:45`). Port: `:335-338`.
7. A relative `SUPERPOWERS_CONFIG_DIR` unexpectedly succeeding is itself the
   failure (`:47-50`, `if (...) ...; then ... exit 1; fi`). **Merged** into
   the port's `assert.throws` at `:342-348`, which is strictly stronger (a
   thrown error is not a success) and therefore subsumes this guard — same
   precedent as `bin-dispatch.md` item 15.
8. The relative-`SUPERPOWERS_CONFIG_DIR` diagnostic is
   `SUPERPOWERS_CONFIG_DIR must be absolute` (`:51`). Port: `:342-348`.
9. A relative `XDG_CONFIG_HOME` unexpectedly succeeding is itself the failure
   (`:52-55`). **Merged**, same rationale as item 7. Port: `:350-353`.
10. The relative-`XDG_CONFIG_HOME` diagnostic is `XDG_CONFIG_HOME must be
   absolute` (`:56`). Port: `:350-353`.
11. Every base absent unexpectedly succeeding is itself the failure
    (`:57-60`, the `env -u HOME -u XDG_CONFIG_HOME -u SUPERPOWERS_CONFIG_DIR`
   subshell). **Merged**, same rationale as item 7. Port: `:356-359`.
12. The all-absent diagnostic is `HOME is required to locate selection state`
   (`:61`). Port: `:356-359`.
13. The CLI usage-error path unexpectedly succeeding is itself the
    failure (`:63-68`). **Merged** into the port's `assert.equal(usage.status,
    2)` at `tests/baseline/selection-location.test.js:372`, which is strictly
    stronger and subsumes this guard, same precedent as `bin-dispatch.md`
    item 15. No TypeScript counterpart exists for `spw_usage_error` itself:
    it was reachable in production only from `scripts/pin`, `scripts/unpin`,
    and `scripts/track-latest`, before those three flipped to in-process
    TypeScript by earlier tasks in this slice, after which none of them
    reached `spw_usage_error` through `src/cli.ts`'s `DISPATCH` any more
    (their own usage-error diagnostics now come from `src/cli.ts`'s
    `parseArgs`, already covered by `bin-dispatch.md` items 35-37; Task 10b
    then deleted all three shell files outright — see the note below).
    Slice 4c re-expresses the case through `src/cli.ts:314-316`, the live
    usage-error implementation, rather than the deleted shell helper.
14. The CLI usage-error path exits `2` (`:69`). Port:
    `tests/baseline/selection-location.test.js`.
15. Its stderr is `error: <msg>` followed by the complete usage block, while
    stdout is empty (`:70`). Port: `tests/baseline/selection-location.test.js`.

### Complete ref precedence — absent state (`:134-172`)

16. Absent state resolves the packaged default ref, tag kind, one resolver
    call (`:137-142`, `assert_effective package-default default
    package-default ...`). Port: `tests/baseline/selection-location.test.js:387-401`.
17. `SPW_SAVED_MODE` is `none` for absent state (`:143`). Port: `:403`.
18. Exactly one resolver call for the packaged-default path (`:144`). Ported
    as "exactly one `--tags` probe logged" — see the file header's note on
    why a raw git-invocation count would not be equivalent. Port: `:404`.
19. Both `SUPERPOWERS_REF` and `SUPERPOWERS_UPSTREAM_URL` override
    independently over absent state (`:146-154`). Port: `:407-423`.
20. `SUPERPOWERS_REF` alone overrides the ref while the source stays
    package-default (`:156-163`). Port: `:427-442`.
21. `SUPERPOWERS_UPSTREAM_URL` alone overrides the source while the ref stays
    package-default (`:165-172`). Port: `:446-461`.

### Complete ref precedence — track-latest state (`:174-210`)

22. Track-latest state resolves `latest-release` to a distinct tag and commit
    (`:176-181`). This is the non-short-circuit path with distinct
    `resolvedRef`/`desiredCommit` values the file header's swap-detection note
    describes. Port: `tests/baseline/selection-location.test.js:467-479`.
23. `SPW_SAVED_MODE` is `track-latest` (`:182`). Port: `:481`.
24. `SUPERPOWERS_REF` overrides track-latest's ref while the source stays
    saved (`:184-191`). Port: `:484-499`.
25. `SUPERPOWERS_UPSTREAM_URL` overrides track-latest's source while the ref
    stays `latest-release` — again with distinct resolved-ref/commit values
    (`:193-200`). Port: `:503-518`.
26. Both override together (`:202-210`). Port: `:522-538`.

### Complete ref precedence — pinned state (`:212-254`)

27. Pinned state reuses its verified identity without querying the resolver
    (`:213-219`). Port: `tests/baseline/selection-location.test.js:544-558`.
28. The resolver log is empty for the pinned short-circuit (`:220`). Port:
    `:560`.
29. `SPW_SAVED_REQUESTED_REF` equals the saved pin's requested ref (`:221`).
    Port: `:561`.
30. `SPW_SAVED_RESOLVED_REF` equals the saved pin's resolved ref (`:222`).
    Port: `:562`.
31. `SPW_SAVED_COMMIT` equals the saved pin's commit (`:223`). Port: `:563`.
32. `SUPERPOWERS_REF` overrides a pin's ref, falling through to resolution
    (`:225-232`). Port: `:566-581`.
33. Exactly one resolver call when overriding a pin's ref (`:233`). Port:
    `:583`.
34. `SUPERPOWERS_UPSTREAM_URL` overrides a pin's source while its ref/commit
    stay saved (`:235-242`). Port: `:586-601`.
35. The resolver log is empty when only the pin's source is overridden
    (`:243`). Port: `:603`.
36. Both override together over a pin (`:245-252`). Port: `:606-622`.

### Arbitrary ref and raw-commit resolution (`:255-280`)

Not a registered behavior ID: `SEL-REF-GENERIC-01` matches no pattern in
`tests/baseline/traceability.test.js:15`'s `ID_PATTERN` either.

37. An environment ref containing a shell glob character resolves as data,
    not as a pattern (`:256-264`). Port:
    `tests/baseline/selection-location.test.js:636-651`.
38. A raw-commit saved pin derives `raw-commit` resolution kind without
    resolver access (`:266-278`). Port: `:667-679`.
39. The resolver log is empty for the raw-commit short-circuit (`:279`).
    Port: `:681`.

### Invalid saved state and safe display (`:281-333`)

40. Malformed saved state (`schema_version: 2`) unexpectedly succeeding is
    itself the failure (`:283-295`). **Merged** into the port's
    `assert.rejects` at `tests/baseline/selection-location.test.js:696-708`,
    same rationale as item 7.
41. The malformed-state diagnostic includes `schema_version must equal
    integer 1` (`:296`). Port: `:696-708`.
42. The resolver log stays empty when saved-state validation fails first
    (`:297`). Port: `:709`.
43. An effective HTTP(S) source with userinfo unexpectedly succeeding is
    itself the failure (`:300-308`). **Merged**, same rationale as item 7.
    Port: `:717-728`.
44. The userinfo diagnostic is `HTTP(S) source must not include userinfo`
    (`:309`). Port: `:717-728`.
45. The resolver log stays empty when source validation fails first (`:310`).
    Port: `:729`.
46. Displaying a credential-bearing source redacts it (`:311`). Port: `:730`.
47. Displaying the official source shows it verbatim (`:312`). Port: `:731`.
48. `spw_selection_state` ignores ambient `NODE_OPTIONS` (`:314-322`).
    **Retired structurally in slice 4c:** selection state is read in-process
    by `src/selection-store.ts`, so there is no child Node process for
    `NODE_OPTIONS` to reach and no helper file left to be missing.
49. A missing `dist/selection-state-cli.js` unexpectedly succeeding is itself
    the failure (`:325-330`). **Retired structurally in slice 4c**, for the
    same in-process/no-helper reason as item 48.
50. The missing-helper stderr is exactly one line (`:332`). **Retired
    structurally in slice 4c**, same reason as item 48.
51. That line is exactly `error: selection state helper missing` (`:333`).
    **Retired structurally in slice 4c**, same reason as item 48.

<!-- inventory:mapped:end -->

## Cardinality

```json inventory
{
  "shellOriginal": 51,
  "portOnly": 0,
  "ports": { "tests/baseline/selection-location.test.js": 5 }
}
```

- Shell original: **51** assertions (2 permission-denied builder, 13
  selection-location chain and fail-closed bases including `spw_usage_error`,
  6 absent-state ref precedence, 5 track-latest-state ref precedence, 10
  pinned-state ref precedence, 3 arbitrary-ref/raw-commit resolution, 12
  invalid-saved-state/safe-display/spw_selection_state; sum:
  2+13+6+5+10+3+12 = 51). See "Divergences from the derived 51" above for why
  this equals, but is not simply copied from, the mechanical grep's 51.
- Port (`tests/baseline/selection-location.test.js`): 5 static `test(` call
  sites — one ordinary case for the permission-denied builder, the three
  behavior-ID cases (`SEL-LOCATION-01`, `SEL-PRECEDENCE-REF-01`,
  `SEL-PRECEDENCE-VALIDATE-01`), and one ordinary case for the
  non-behavior-ID `SEL-REF-GENERIC-01` cluster — carrying all 51 shell items
  mapped or structurally retired (six recorded merges, at items 7, 9, 11, 13, 40, and 43, each a
  negative if-guard subsumed by the stronger check that follows it, same
  precedent as `bin-dispatch.md` item 15). 47 mapped + 4 retired = 51. No
  port-only assertions were added: `computeEffectiveSelection`'s TypeScript
  return type already makes `assert_exported_selection`'s property
  structural (see the divergence note), and this port otherwise stays at the
  shell's own assertion granularity rather than adding new coverage.
- Reconciliation: 47 shell items remain mapped and items 48-51 retire
  structurally because selection state is read in-process by
  `src/selection-store.ts`; no child Node process or helper path survives.
  47 + 4 = 51.
