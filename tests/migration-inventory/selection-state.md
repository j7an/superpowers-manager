# Migration inventory: tests/test_selection_state.sh

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
   `tests/baseline/selection-location.test.js:351`.
2. Unless running as root, the builder's `TARGET=` output names a file that
   is not readable (`:34-37`, `if [ -r ... ]; then ... exit 1; fi`). Port:
   `:354-362` (root-skip branch at `:354`, the negative check itself at
   `:362`).

### Selection location chain and fail-closed bases (`:41-70`)

3. `SUPERPOWERS_CONFIG_DIR`, explicit, wins over every other base (`:42`).
   Port: `tests/baseline/selection-location.test.js:369-376`.
4. `XDG_CONFIG_HOME`, with `SUPERPOWERS_CONFIG_DIR` absent, wins over `HOME`
   (`:43`). Port: `:378-381`.
5. An empty `XDG_CONFIG_HOME` is treated as absent, falling through to `HOME`
   (`:44`). Port: `:383-386`.
6. `HOME` alone is the last base (`:45`). Port: `:388-391`.
7. A relative `SUPERPOWERS_CONFIG_DIR` unexpectedly succeeding is itself the
   failure (`:47-50`, `if (...) ...; then ... exit 1; fi`). **Merged** into
   the port's `assert.throws` at `:395-401`, which is strictly stronger (a
   thrown error is not a success) and therefore subsumes this guard — same
   precedent as `bin-dispatch.md` item 15.
8. The relative-`SUPERPOWERS_CONFIG_DIR` diagnostic is
   `SUPERPOWERS_CONFIG_DIR must be absolute` (`:51`). Port: `:395-401`.
9. A relative `XDG_CONFIG_HOME` unexpectedly succeeding is itself the failure
   (`:52-55`). **Merged**, same rationale as item 7. Port: `:403-406`.
10. The relative-`XDG_CONFIG_HOME` diagnostic is `XDG_CONFIG_HOME must be
    absolute` (`:56`). Port: `:403-406`.
11. Every base absent unexpectedly succeeding is itself the failure
    (`:57-60`, the `env -u HOME -u XDG_CONFIG_HOME -u SUPERPOWERS_CONFIG_DIR`
    subshell). **Merged**, same rationale as item 7. Port: `:409-412`.
12. The all-absent diagnostic is `HOME is required to locate selection state`
    (`:61`). Port: `:409-412`.
13. `spw_usage_error 'bad arguments'` unexpectedly succeeding is itself the
    failure (`:63-68`). **Merged** into the port's `assert.equal(usage.status,
    2)` at `tests/baseline/selection-location.test.js:427`, which is strictly
    stronger and subsumes this guard, same precedent as `bin-dispatch.md`
    item 15. No TypeScript counterpart exists for `spw_usage_error` itself:
    it is reachable in production only from `scripts/pin`, `scripts/unpin`,
    and `scripts/track-latest`, none of which `src/cli.ts`'s `DISPATCH`
    reaches any more (all three flipped to in-process TypeScript by earlier
    tasks in this slice — their own usage-error diagnostics now come from
    `src/cli.ts`'s `parseArgs`, already covered by `bin-dispatch.md` items
    35-37). The shell file itself is unchanged and still live source for
    other shell tests, so the port runs it directly via a generated script
    (`tests/baseline/selection-location.test.js`'s `runShellScript`).
    Note for slice 4 (not this slice's work): Task 10b deleted
    `scripts/pin`, `scripts/unpin`, and `scripts/track-latest` outright, so
    `spw_usage_error` (`scripts/core/common.sh:9`) now has zero callers
    anywhere in `scripts/`. `scripts/core/common.sh` still ships
    (`tests/expected_tarball_contents.txt:47`), and removing the now-dead
    helper is slice 4's call, not this task's.
14. `spw_usage_error` exits `2` (`:69`). Port: `:427`.
15. `spw_usage_error`'s stderr is exactly `error: bad arguments` (`:70`).
    Port: `:428-429` (the port asserts the full stdout/stderr shape in one
    step: empty stdout, one exact stderr line).

### Complete ref precedence — absent state (`:134-172`)

16. Absent state resolves the packaged default ref, tag kind, one resolver
    call (`:137-142`, `assert_effective package-default default
    package-default ...`). Port: `tests/baseline/selection-location.test.js:440-454`.
17. `SPW_SAVED_MODE` is `none` for absent state (`:143`). Port: `:455`.
18. Exactly one resolver call for the packaged-default path (`:144`). Ported
    as "exactly one `--tags` probe logged" — see the file header's note on
    why a raw git-invocation count would not be equivalent. Port: `:456`.
19. Both `SUPERPOWERS_REF` and `SUPERPOWERS_UPSTREAM_URL` override
    independently over absent state (`:146-154`). Port: `:460-476`.
20. `SUPERPOWERS_REF` alone overrides the ref while the source stays
    package-default (`:156-163`). Port: `:480-495`.
21. `SUPERPOWERS_UPSTREAM_URL` alone overrides the source while the ref stays
    package-default (`:165-172`). Port: `:499-514`.

### Complete ref precedence — track-latest state (`:174-210`)

22. Track-latest state resolves `latest-release` to a distinct tag and commit
    (`:176-181`). This is the non-short-circuit path with distinct
    `resolvedRef`/`desiredCommit` values the file header's swap-detection note
    describes. Port: `tests/baseline/selection-location.test.js:520-532`.
23. `SPW_SAVED_MODE` is `track-latest` (`:182`). Port: `:533`.
24. `SUPERPOWERS_REF` overrides track-latest's ref while the source stays
    saved (`:184-191`). Port: `:537-552`.
25. `SUPERPOWERS_UPSTREAM_URL` overrides track-latest's source while the ref
    stays `latest-release` — again with distinct resolved-ref/commit values
    (`:193-200`). Port: `:556-571`.
26. Both override together (`:202-210`). Port: `:575-591`.

### Complete ref precedence — pinned state (`:212-254`)

27. Pinned state reuses its verified identity without querying the resolver
    (`:213-219`). Port: `tests/baseline/selection-location.test.js:597-611`.
28. The resolver log is empty for the pinned short-circuit (`:220`). Port:
    `:612`.
29. `SPW_SAVED_REQUESTED_REF` equals the saved pin's requested ref (`:221`).
    Port: `:613`.
30. `SPW_SAVED_RESOLVED_REF` equals the saved pin's resolved ref (`:222`).
    Port: `:614`.
31. `SPW_SAVED_COMMIT` equals the saved pin's commit (`:223`). Port: `:615`.
32. `SUPERPOWERS_REF` overrides a pin's ref, falling through to resolution
    (`:225-232`). Port: `:619-634`.
33. Exactly one resolver call when overriding a pin's ref (`:233`). Port:
    `:635`.
34. `SUPERPOWERS_UPSTREAM_URL` overrides a pin's source while its ref/commit
    stay saved (`:235-242`). Port: `:639-654`.
35. The resolver log is empty when only the pin's source is overridden
    (`:243`). Port: `:655`.
36. Both override together over a pin (`:245-252`). Port: `:659-675`.

### Arbitrary ref and raw-commit resolution (`:255-280`)

Not a registered behavior ID: `SEL-REF-GENERIC-01` matches no pattern in
`docs/baseline/traceability.test.js:15`'s `ID_PATTERN` either.

37. An environment ref containing a shell glob character resolves as data,
    not as a pattern (`:256-264`). Port:
    `tests/baseline/selection-location.test.js:689-704`.
38. A raw-commit saved pin derives `raw-commit` resolution kind without
    resolver access (`:266-278`). Port: `:720-732`.
39. The resolver log is empty for the raw-commit short-circuit (`:279`).
    Port: `:733`.

### Invalid saved state and safe display (`:281-333`)

40. Malformed saved state (`schema_version: 2`) unexpectedly succeeding is
    itself the failure (`:283-295`). **Merged** into the port's
    `assert.rejects` at `tests/baseline/selection-location.test.js:748-759`,
    same rationale as item 7.
41. The malformed-state diagnostic includes `schema_version must equal
    integer 1` (`:296`). Port: `:748-759`.
42. The resolver log stays empty when saved-state validation fails first
    (`:297`). Port: `:761`.
43. An effective HTTP(S) source with userinfo unexpectedly succeeding is
    itself the failure (`:300-308`). **Merged**, same rationale as item 7.
    Port: `:769-779`.
44. The userinfo diagnostic is `HTTP(S) source must not include userinfo`
    (`:309`). Port: `:769-779`.
45. The resolver log stays empty when source validation fails first (`:310`).
    Port: `:781`.
46. Displaying a credential-bearing source redacts it (`:311`). Port: `:782`.
47. Displaying the official source shows it verbatim (`:312`). Port: `:783`.
48. `spw_selection_state` ignores ambient `NODE_OPTIONS` (`:314-322`). No
    TypeScript counterpart: `scripts/core/selection.sh`'s
    `spw_selection_state` remains live production code for
    `scripts/prepare` and `scripts/probe`, untouched by this slice. Ported by
    running a small generated script against the still-live shell source.
    Port: `tests/baseline/selection-location.test.js:797-809`.
49. A missing `dist/selection-state-cli.js` unexpectedly succeeding is itself
    the failure (`:325-330`). Unlike items 7/9/11/13/40/43 above, nothing
    stronger follows this guard in the shell either — the original only ever
    checks non-zero here, never an exact status code — so this is ported as
    its own assertion rather than merged. Port: `:817-823` (`:823`
    specifically).
50. The missing-helper stderr is exactly one line (`:332`). Port: `:825`.
51. That line is exactly `error: selection state helper missing` (`:333`).
    Port: `:826`.

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
  mapped (six recorded merges, at items 7, 9, 11, 13, 40, and 43, each a
  negative if-guard subsumed by the stronger check that follows it, same
  precedent as `bin-dispatch.md` item 15). 51 mapped + 0 retired = 51. No
  port-only assertions were added: `computeEffectiveSelection`'s TypeScript
  return type already makes `assert_exported_selection`'s property
  structural (see the divergence note), and this port otherwise stays at the
  shell's own assertion granularity rather than adding new coverage.
- Reconciliation: all 51 shell items are mapped, none retired — every shell
  behavior this driver checked still has a live subject (either the
  TypeScript `computeEffectiveSelection`/`selectionConfigDir`/`validateSource`/
  `displaySource` path, or the still-live shell library, unlike
  `bin-dispatch.md`'s `pin`/`unpin`/`track-latest` routing items, whose
  underlying shell path was physically removed from dispatch). 51 + 0 = 51.
