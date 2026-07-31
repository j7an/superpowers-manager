# Migration inventory: tests/test_node_tooling.sh

Source read in full (23 lines). Ported to `tests/bin/node-tooling.test.js`.

No behavior ID in `docs/baseline/traceability.md` references
`test_node_tooling` (confirmed by grep on 2026-07-31 — zero matches). This
inventory, not the 121-ID count, is the evidence that no assertion was
dropped.

## Test cases and assertions

1. **Missing compiler binary fails closed.** When
   `${SPW_TSC:-$root/node_modules/.bin/tsc}` is not an executable file, the
   driver prints `error: repo TypeScript compiler missing — run pnpm install
   --frozen-lockfile` to stderr and exits non-zero, without ever invoking
   `tsc`. (`tests/test_node_tooling.sh:11-14`)
2. **Successful typecheck run.** When the compiler binary exists, the driver
   runs `"$tsc_bin" -p "$root/tests/tsconfig.json"` and requires exit 0 (via
   `set -e`), then prints `test_js_types: OK`. (`tests/test_node_tooling.sh:16-17`)
3. **`SPW_TSC` override seam.** The binary path is read from `SPW_TSC` when
   set, falling back to `$root/node_modules/.bin/tsc` otherwise. Both cases 1
   and 2 must be exercised through this override so the container harness
   seam is preserved. (`tests/test_node_tooling.sh:9`)

## Cardinality

- Shell original: 2 behavioral assertions (missing-binary failure path,
  successful-typecheck path), each parameterized by the `SPW_TSC` seam (item
  3 is a property of both, not a third independent assertion).
- Port (`tests/bin/node-tooling.test.js`): 2 `node:test` cases, one per item
  above, each driving the binary through `SPW_TSC` so the seam is exercised
  by both.
- Reconciliation: 1:1, no merges, no drops.
