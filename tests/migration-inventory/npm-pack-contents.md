# Migration inventory: tests/test_npm_pack_contents.sh
<!-- FROZEN: historical migration record. Declared historical against ad56569a4c161e7b122967442e2b026eeb6395f6. -->
<!-- Port pointers are NOT maintained. An item's identity is its quoted assertion text, not its number. -->
<!-- Resolve shell-original citations with: git show 0b6d50e1e9c688397285c6fa274dc8c9437d8ba3:tests/test_npm_pack_contents.sh -->

Source read in full (148 lines). Ported to `tests/bin/npm-pack-contents.test.js`.

`grep -n 'test_npm_pack_contents' docs/baseline/traceability.md` on
2026-07-31 returns zero matches: no behavior ID in
`docs/baseline/traceability.md` references this driver, so the 121-ID count
cannot detect a dropped assertion here. This inventory, not that count, is
the evidence that no assertion was dropped.

The driver never inspects `npm pack`'s JSON report itself. It always
delegates to `tests/assert_pack_contents.sh` (a shared script also used by
the publish workflow, out of scope for this migration and left untouched)
via `sh`, and treats that script's exit code and stderr/stdout text as the
oracle. The port reproduces this exactly: it `spawnSync`s the same shared
script against the same fixtures, rather than reimplementing the shared
script's Python comparison logic in JavaScript.

Setup lines 1-9 (shebang, harness sourcing, `spw_test_root`/`spw_test_tmpdir`,
and the `command -v npm` environment guard) are preconditions, not behavioral
assertions about repository code, and are not numbered below. `set -eu`
means any unconditional invocation of `assert_pack_contents.sh` (i.e. one not
guarded by `if output=$(...); then ... fi`) aborts the whole driver
non-zero on failure — that abort-on-nonzero-exit is itself the assertion for
those lines.

## Shape-acceptance assertions (`:11-36`)

<!-- inventory:mapped:start -->

1. `npm pack --dry-run --json` output for the real package, fed to
   `assert_pack_contents.sh` unmodified, exits 0 (`:11-13`) — this is the
   only case that validates the *actual* current tarball contents against
   `tests/expected_tarball_contents.txt` end-to-end; every fixture below is
   a copy or mutation of this report's single packed entry.
2. The same report reshaped into a one-element JSON array
   (`pack-array.json`) is still accepted (exit 0) by
   `assert_pack_contents.sh` (`:28,35`).
3. The same report reshaped into a single-key JSON object
   (`pack-keyed.json`, key `"packed"`) is still accepted (exit 0) by
   `assert_pack_contents.sh` (`:32-33,36`).

## Malformed-shape rejection assertions (`:38-69`)

Five fixtures are generated from the accepted one-element-array report:
`shape-empty-array.json` (`[]`), `shape-two-element-array.json`
(two-element array), `shape-empty-object.json` (`{}`),
`shape-two-entry-object.json` (two-entry object), and
`shape-non-object-entry.json` (`[None]`, i.e. a JSON `null` as the sole
array element). For each fixture, two assertions hold:

4. `shape-empty-array.json`: `assert_pack_contents.sh` exits non-zero.
5. `shape-empty-array.json`: the combined stdout+stderr contains the literal
   diagnostic `unexpected npm pack --json shape: expected a one-element
   array or a keyed object with exactly one value`.
6. `shape-two-element-array.json`: exits non-zero.
7. `shape-two-element-array.json`: output contains the shape diagnostic.
8. `shape-empty-object.json`: exits non-zero.
9. `shape-empty-object.json`: output contains the shape diagnostic.
10. `shape-two-entry-object.json`: exits non-zero.
11. `shape-two-entry-object.json`: output contains the shape diagnostic.
12. `shape-non-object-entry.json`: exits non-zero.
13. `shape-non-object-entry.json`: output contains the shape diagnostic.

## Forbidden-path assertions (`:71-95`)

A single embedded Python check walks every `path` in the real report's
`files` list and raises (causing the driver to abort, since it is
unconditional under `set -eu`) if any path matches one of six forbidden
categories. Each category is an independently droppable rule, so each is
inventoried separately:

14. No packed path has `"selection.json"` as a `/`-split path segment.
15. No packed path has any `/`-split segment starting with
    `"superpowers-manager.pin."`.
16. No packed path has `".git"` as a `/`-split path segment.
17. No packed path has `".cache"` as a `/`-split path segment.
18. No packed path starts with `"plugins/superpowers/"` *except* the single
    allowed exception
    `"plugins/superpowers/.codex-plugin/plugin.template.json"`.
19. No packed path equals `"docs/superpowers"` or starts with
    `"docs/superpowers/"`.

**Review addendum (2026-07-31, Finding 1):** the real pack currently
contains zero matches in any of these six categories, so items 14-19 alone
can never go RED for a mistranslated predicate — a substring check where the
shell used a segment check, a dropped `parts.split("/")`, or a wrong
prefix/equality boundary would pass silently forever. The port therefore
extracts the six checks into one `forbiddenPathCategory(path)` function,
used both by the real-pack check (items 14-19, unchanged) and by a new
synthetic discriminating fixture — one deliberately forbidden path per
category, asserted to be classified into that category, plus one assertion
that the `plugins/superpowers/*` exception path itself is *not* classified
as forbidden. This synthetic fixture has **no counterpart in the original
shell driver** (the shell never runs `assert_pack_contents.sh`'s Python
against anything but the real pack for this check), so it does not change
the 1:1 cardinality count in the "Cardinality" section below; it is
additional port-only coverage that makes the six real-pack predicates
independently falsifiable. Mutation-tested 2026-07-31: mutating the
`pin-file` predicate from a per-segment `startsWith` check to a whole-path
`startsWith` check drove the `"pin-file"` synthetic assertion RED (and only
that one); mutating the `.git` predicate from `parts.includes(".git")` to
`path === ".git"` (i.e. dropping the `parts` split) drove the `".git"`
synthetic assertion RED (and only that one). Both were restored and
reconfirmed GREEN.

## Identity-tampering rejection assertions (`:97-130`)

`assert_rejected_identity` copies the real one-element-array report,
overwrites one top-level field with a tampered value, writes it to a new
fixture, and asserts `assert_pack_contents.sh` rejects it with a specific
diagnostic substring. Called three times:

20. Tampering `name` to `tampered-package`: `assert_pack_contents.sh` exits
    non-zero.
21. Tampering `name`: output contains `pack report name mismatch`.
22. Tampering `version` to `0.0.0-tampered`: exits non-zero.
23. Tampering `version`: output contains `pack report version mismatch`.
24. Tampering `id` to `tampered-package@0.0.0`: exits non-zero.
25. Tampering `id`: output contains `pack report id mismatch`.

## Dist-less prepack assertions (`:132-146`)

A scratch directory receives only a copy of the real `package.json` (no
`dist/`, no other packed sources).

26. Running `npm pack --dry-run --json` inside that directory exits
    non-zero (`rc -ne 0`).
27. That failing run's stderr contains the literal text
    `dist/cli.js is missing`.

<!-- inventory:mapped:end -->

Line 148 (`echo "test_npm_pack_contents: OK"`) is driver-completion output,
not an assertion.

**Review addendum (2026-07-31, Finding 2):** the shell driver's `command -v
npm` precondition (`:9`) fails closed with `error: npm is required for this
test` before anything else runs. The port's two `spawnSync("npm", ...)`
call sites (in `packRealReport`, and in the dist-less prepack test) now
check `result.error` and `assert.fail` with a clear diagnostic
(`"... could not be run — is npm installed and on PATH?"`) before touching
`result.status`/`result.stderr`, instead of letting a `null !== 0`
comparison with an empty message reach the test report. Confirmed by
running the same `spawnSync` call with `PATH` pointed at a directory
containing no `npm`: `result.error.code` is `"ENOENT"` and `result.status`
is `null` — exactly the case the new guard intercepts before any raw
ENOENT-shaped text can reach stdout/stderr.

## Port-only assertions (outside the 1:1 mapping)

<!-- inventory:port-only:start -->

1. Synthetic fixture `some/dir/selection.json` is classified into the
   `"selection.json"` forbidden-path category by `forbiddenPathCategory()`.
   Port-only — no shell counterpart; added 2026-07-31 (Finding 1) to make
   the category's predicate independently falsifiable (see the addendum
   under item 19 above).
2. Synthetic fixture `some/dir/superpowers-manager.pin.deadbeef` is
   classified into the `"pin-file"` forbidden-path category. Port-only —
   same rationale as item 1.
3. Synthetic fixture `some/.git/config` is classified into the `".git"`
   forbidden-path category. Port-only — same rationale as item 1.
4. Synthetic fixture `some/.cache/thing` is classified into the `".cache"`
   forbidden-path category. Port-only — same rationale as item 1.
5. Synthetic fixture `plugins/superpowers/skills/foo.md` is classified into
   the `"plugins/superpowers/*"` forbidden-path category. Port-only — same
   rationale as item 1.
6. Synthetic fixture `docs/superpowers/notes.md` is classified into the
   `"docs/superpowers"` forbidden-path category. Port-only — same rationale
   as item 1.
7. The allowed exception path
   `plugins/superpowers/.codex-plugin/plugin.template.json` is asserted
   **not** classified as forbidden by `forbiddenPathCategory()` — the
   boundary check for the `plugins/superpowers/*` carve-out. Port-only —
   added 2026-07-31 (Finding 1) alongside items 1-6 above.
8. **The published package declares zero runtime dependencies.** Asserted as
   `Object.keys(manifest.dependencies ?? {})` deep-equal to `[]`, so an absent
   key and an empty object both pass and any added entry fails. Added by
   PR 11.1 (2026-08-02) alongside the `yaml` devDependency: that dependency's
   justification is that it is dev-only, and before this assertion no test
   constrained the **root** manifest's runtime dependency set.
   `container-contract.test.js:950` constrains `tests/container/package.json`,
   which is a different file with a different contract.
   Port-only — it has no shell counterpart and is outside the 1:1 mapping.

<!-- inventory:port-only:end -->

## Cardinality

```json inventory
{
  "shellOriginal": 27,
  "portOnly": 8,
  "ports": { "tests/bin/npm-pack-contents.test.js": 2 }
}
```

- Shell original: **27** assertions (3 shape-acceptance, 10
  malformed-shape-rejection, 6 forbidden-path-category, 6
  identity-tampering-rejection, 2 dist-less-prepack).
- Port (`tests/bin/npm-pack-contents.test.js`): 27 assertions 1:1-mapped to
  the shell, one `node:test` `assert.*` call per numbered item above,
  grouped into `node:test` subtests by fixture/scenario for readability,
  **plus** 8 port-only assertions (6 synthetic per-category discriminating
  checks + 1 exception-boundary check added 2026-07-31 in response to review
  Finding 1, + 1 zero-runtime-dependency check added 2026-08-02 by PR 11.1)
  that have no shell counterpart and are outside the 1:1 mapping.
- Reconciliation: 1:1 for all 27 original items, no merges, no drops. The 8
  additional port-only assertions are strictly additive test coverage, not
  a reconciliation of any shell assertion.
