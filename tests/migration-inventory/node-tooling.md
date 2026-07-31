# Migration inventory: tests/test_node_tooling.sh

Source read in full (23 lines). Ported to `tests/bin/node-tooling.test.js`.

No behavior ID in `docs/baseline/traceability.md` references
`test_node_tooling` (confirmed by grep on 2026-07-31 — zero matches). This
inventory, not the 121-ID count, is the evidence that no assertion was
dropped.

## Test cases and assertions

1. **Missing compiler binary fails closed.** When
   `${SPW_TSC:-$root/node_modules/.bin/tsc}` is not an executable file, the
   driver prints an error to stderr and exits non-zero, without ever
   invoking `tsc`. (`tests/test_node_tooling.sh:11-14`) The port asserts
   only the fail-closed outcome (`outcome.ok === false`), not the literal
   error text: the exact string lived solely in the deleted shell script,
   so comparing it against a same-file constant that this port's own
   implementation also returns would be a tautology — that assertion could
   only fail if someone edited this test file, never for a reason rooted in
   repository behavior. (A 2026-07-31 review correctly flagged an earlier
   draft of this port for doing exactly that — asserting message equality
   against a shared module constant — and that comparison was dropped.)
2. **Successful typecheck run.** When the compiler binary exists, the driver
   runs `"$tsc_bin" -p "$root/tests/tsconfig.json"` and requires exit 0 (via
   `set -e`), then prints `test_js_types: OK`. (`tests/test_node_tooling.sh:16-17`)
3. **`SPW_TSC` override seam.** The binary path is read from `SPW_TSC` when
   set, falling back to `$root/node_modules/.bin/tsc` otherwise. The port's
   `resolveTscBin()` reads `process.env.SPW_TSC` directly (mirroring the
   shell's `${SPW_TSC:-...}` parameter expansion), not a function argument.
   Both cases 1 and 2 are exercised through this live seam: case 2's test
   unsets `SPW_TSC` (proving the default-path fallback resolves and runs the
   real compiler), and case 1's test sets `SPW_TSC` to a path that does not
   exist while the real default compiler is still present and valid — the
   only way that test can observe failure is if the environment variable
   was actually read and preferred over the valid default. That is positive
   proof the override is live, not merely mentioned in a comment or test
   title.

## Cardinality

- Shell original: 2 behavioral assertions (missing-binary failure path,
  successful-typecheck path), each parameterized by the `SPW_TSC` seam (item
  3 is a property of both, not a third independent assertion).
- Port (`tests/bin/node-tooling.test.js`): 2 `node:test` cases, one per item
  above, each driving the binary through the live `SPW_TSC` seam.
- Reconciliation: 1:1, no merges, no drops. The frozen-message literal from
  the shell driver was deliberately not ported as a string-equality
  assertion (see item 1) because doing so would add a check that cannot
  fail for any reason tied to actual repository behavior; the fail-closed
  *behavior* it existed to protect (item 1's `ok === false`) is still
  asserted.
