# Migration inventory: tests/test_node_tooling.sh
<!-- FROZEN: historical migration record. Declared historical against ad56569a4c161e7b122967442e2b026eeb6395f6. -->
<!-- Port pointers are NOT maintained. An item's identity is its quoted assertion text, not its number. -->
<!-- Resolve shell-original citations with: git show 0b6d50e1e9c688397285c6fa274dc8c9437d8ba3:tests/test_node_tooling.sh -->

Source read in full (22 lines). Current native port: `tests/bin/node-tooling.test.ts`.

No behavior ID in `docs/baseline/traceability.md` references
`test_node_tooling` (confirmed by grep on 2026-07-31 — zero matches). This
inventory, not the 121-ID count, is the evidence that no assertion was
dropped.

## Test cases and assertions

<!-- inventory:mapped:start -->

1. **Missing compiler binary fails closed and reports the remedy.** When
   `${SPW_TSC:-$root/node_modules/.bin/tsc}` is not an executable file, the
   driver prints `error: repo TypeScript compiler missing — run pnpm install
--frozen-lockfile` to stderr (em dash, U+2014) and exits non-zero,
   without ever invoking `tsc`. (`tests/test_node_tooling.sh:11-14`) The
   port asserts both the fail-closed outcome (`outcome.ok === false`) and
   the exact diagnostic text. An earlier draft of this port asserted only
   the fail-closed outcome, on the grounds that comparing the message
   against a same-file constant the implementation also returns would be a
   tautology (that comparison could only fail if someone edited this test
   file, never for a reason rooted in repository behavior). A 2026-08-01
   review restored the message check as its own independently-typed
   literal (`MISSING_COMPILER_DIAGNOSTIC` in
   `tests/bin/node-tooling.test.ts`, not imported by or into
   `runTsTypecheck`), verified byte-for-byte against the deleted shell
   script (`git show d41fb88^:tests/test_node_tooling.sh | od -An -tx1`
   confirms bytes `e2 80 94` at the dash, i.e. U+2014, not a hyphen). That
   is not the tautology the earlier draft avoided: the test's literal and
   the implementation's literal are two independently-typed occurrences of
   the same ground-truth string, so the assertion fails if either one
   drifts from the deleted script's original text. The diagnostic is also
   passed as the assertion message on the successful-typecheck test's
   `outcome.ok` check (item 2 below), so an operator who has not run `pnpm
install --frozen-lockfile` sees the remedy instead of a bare `expected
false to equal true`.
2. **Successful typecheck run.** When the compiler binary exists, the driver
   runs `"$tsc_bin" -p "$root/tests/tsconfig.json"` and requires exit 0 (via
   `set -e`), then prints `test_js_types: OK`. (`tests/test_node_tooling.sh:16-17`)
3. **`SPW_TSC` override seam.** The binary path is read from `SPW_TSC` when
   set, falling back to `$root/node_modules/.bin/tsc` otherwise. The port's
   `resolveTscBin()` reads `process.env.SPW_TSC` directly (mirroring the
   shell's `${SPW_TSC:-...}` parameter expansion), not a function argument.
   The deleted shell driver supported this override; the port preserves the
   seam, but no in-repo caller sets `SPW_TSC` today — only this test file's
   own save/restore helper does, to drive both branches below. Both cases 1
   and 2 are exercised through this live seam: case 2's test
   unsets `SPW_TSC` (proving the default-path fallback resolves and runs the
   real compiler), and case 1's test sets `SPW_TSC` to a path that does not
   exist while the real default compiler is still present and valid — the
   only way that test can observe failure is if the environment variable
   was actually read and preferred over the valid default. That is positive
   proof the override is live, not merely mentioned in a comment or test
   title.

<!-- inventory:mapped:end -->

## Cardinality

```json inventory
{
  "shellOriginal": 3,
  "portOnly": 0,
  "ports": { "tests/bin/node-tooling.test.ts": 2 }
}
```

- Shell original: **3** assertions (3 behavioral assertions (missing-binary
  diagnostic text, missing-binary fail-closed exit, successful-typecheck
  path), each parameterized by the `SPW_TSC` seam (item 3 above is a
  property of both test cases, not a fourth independent assertion)). The
  diagnostic text and the fail-closed exit are two separate assertions of
  item 1's single shell
  branch (`tests/test_node_tooling.sh:11-14` both prints and exits), raised
  from 2 to 3 on 2026-08-01 when the message check was restored (see item
  1's history above).
- Port (`tests/bin/node-tooling.test.ts`): 2 `node:test` cases, one per
  shell branch, together carrying all 3 assertions — the missing-binary
  case (`:88-105`) asserts both `outcome.ok === false` and
  `outcome.diagnostic === MISSING_COMPILER_DIAGNOSTIC`; the
  successful-typecheck case (`:79-86`) asserts `outcome.ok === true` (using
  the same diagnostic as its failure message) and `outcome.status === 0`.
- Reconciliation: 3:3, no merges, no drops. No test-case count changed —
  the message assertion joined the existing missing-binary case rather than
  adding a third `node:test` case.

## Native TypeScript reconciliation (issue #113)

Current ports: `tests/bin/node-tooling.test.ts` (2 static `test(` call sites).
The `.ts` paths identify the current native counterparts; the quoted shell
assertions, original counts, historical dispositions, freeze header, and Git
resolution anchors remain historical. Imports, child entry points, preloads, and
maintained helper references follow the renamed native source paths.

Both compiler-selection cases and the complete missing-compiler diagnostic are
unchanged. The local helper is named `runTsTypecheck`; the actual compiler still
checks `tests/tsconfig.json`, now owning all maintained native test/tool sources.
