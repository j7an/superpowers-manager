# Migration inventory: tests/test_marketplace_reconcile.sh

Source read in full (319 lines). Migrated to
`tests/baseline/marketplace-reconcile.test.js`; the three behavior-ID cases
remain named there so `docs/baseline/traceability.md` can resolve them.

The shell-original anchor is the last commit in which the driver existed:
`ccd1884007a6e7b77218d7ff41c75e69d84d5a5b`. Before deletion,
`git show ccd1884007a6e7b77218d7ff41c75e69d84d5a5b:tests/test_marketplace_reconcile.sh`
resolved and `git merge-base --is-ancestor
ccd1884007a6e7b77218d7ff41c75e69d84d5a5b origin/main` confirmed reachability.
The deleting commit cannot cite itself: its tree no longer contains the shell
path. Historical shell pointers below are therefore intentionally resolved
through this anchor, not at `HEAD`.

## Counting rules applied

- The mechanical shell count is the 31 lines matching the repository's
  `test`/predicate/`grep -q` inventory rule.
- A helper definition is counted once at its matching call-site shape, not in
  addition to the definition; the loop call is one inventory item, as in the
  existing migration inventories.
- The port consolidates repeated fixture rows into three behavior-level
  `node:test` cases while retaining every distinct fail-closed branch in the
  test bodies.

## Assertion inventory

<!-- inventory:mapped:start -->

1. Uninstall invokes only the manager plugin and marketplace removal commands
   (`tests/test_marketplace_reconcile.sh:73-79`). Port:
   `UNINSTALL-TARGETS-01 adapter removes only manager resources`.
2. Reconciliation records the exact marketplace command sequence
   (`:81-88`). **Merged** into item 1's exact command assertion.
3. A marketplace-list command failure fails without mutation (`:107-120`).
   Port: `a marketplace-list command failure fails without mutation`.
4. Malformed marketplace JSON fails without mutation (`:123-125`). **Retired
   at the gap**: the strict parser branch is already covered by
   `tests/unit/adapter.test.js`.
5. Invalid UTF-8 marketplace JSON fails without mutation (`:126-128`).
   **Retired at the gap**: the strict byte reader is already covered by
   `tests/unit/adapter.test.js`.
6. An unexpected marketplace-list schema fails without mutation (`:130-131`).
   **Retired at the gap**: parser schema coverage already lives in the unit
   adapter suite.
7. An empty manager root fails without mutation (`:132-133`). **Retired at
   the gap**: the adapter parser's missing/empty-root branch is existing unit
   coverage.
8. A missing manager root fails without mutation (`:134-135`). **Retired at
   the gap**: existing adapter parser coverage.
9. A non-string manager root fails without mutation (`:136-137`). **Retired at
   the gap**: existing adapter parser coverage.
10. Each malformed marketplace item fails closed (`:138-149`). **Merged** into
    the adapter parser's invalid-item coverage; no manager mutation is allowed.
11. An unrelated marketplace with no root does not block manager registration
    (`:151-160`). Port: `unrelated marketplace roots do not block manager
    registration`.
12. An unrelated marketplace with an invalid root does not block registration
    (`:151-160`). **Merged** with item 11's table-driven baseline case.
13. An unrelated marketplace is never mutated (`:162-167`). **Retired at the
    gap**: item 1's exact manager-only command list is the surviving contract.
14. A symlink-equivalent registered manager root is treated as the same path
    (`:169-177`). **Retired at the gap**: `pathsEqual` is covered by the
    existing path and adapter tests.
15. A different registered manager root is removed before re-add (`:179-188`).
    **Retired at the gap**: adapter reconciliation coverage already asserts
    the remove/add order.
16. An add failure returns non-zero after the old root was removed (`:190-204`).
    **Retired at the gap**: existing lifecycle adapter failure coverage.
17. Add-failure diagnostics name both roots (`:202-204`). **Merged** into item
    16's failure-envelope coverage.
18. A remove failure returns non-zero (`:206-216`). **Retired at the gap**:
    existing adapter failure coverage.
19. A failed remove never proceeds to add (`:217-220`). **Merged** into item
    18's command-order coverage.
20. Malformed ownership verification fails closed (`:222-228`). Port:
    `UNINSTALL-VERIFY-01 both manager resources must be absent`.
21. A surviving plugin is rejected after uninstall (`:230-250`). Port:
    `UNINSTALL-VERIFY-01 both manager resources must be absent`.
22. A surviving marketplace is rejected after uninstall (`:230-250`). Port:
    `UNINSTALL-VERIFY-01 both manager resources must be absent`.
23. Both manager resources absent is accepted (`:252-255`). Port:
    `UNINSTALL-VERIFY-01 both manager resources must be absent`.
24. An exact installed commit is accepted (`:257-277`). Port:
    `INSTALL-VERIFY-01 installed fingerprint proof and hints`.
25. A seven-character installed commit is accepted (`:279-285`). **Merged**
    into the same baseline install-verification case.
26. A mismatched installed commit fails (`:287-291`). Port: the install
    verification case asserts the mismatch diagnostic.
27. A mismatch hint is replayed (`:290-291`). **Merged** into item 26's exact
    stderr assertion.
28. An undetectable installed commit fails (`:293-302`). Port: the install
    verification case asserts the missing-fingerprint diagnostic and hint.
29. An undetectable result never reports success (`:300-302`). **Merged** into
    item 28's failure assertion.
30. A malformed fingerprint inspection fails as a parse error (`:304-312`).
    Port: the install verification case asserts the parse diagnostic.
31. A malformed fingerprint result is not reported as absent or successful
    (`:313-317`). **Merged** into item 30's exact stderr assertion.

<!-- inventory:mapped:end -->

## Cardinality

```json inventory
{
  "shellOriginal": 31,
  "portOnly": 0,
  "ports": { "tests/baseline/marketplace-reconcile.test.js": 5 }
}
```

- Shell original: **31** assertions (the mechanical predicate count used by
  the migration inventories; helper call-site and loop conventions are stated
  above). The anchor commit preserves all shell-original citations.
- Port (`tests/baseline/marketplace-reconcile.test.js`): 5 static `node:test`
  cases: the three retained behavior IDs plus focused list-failure and
  unrelated-root reconciliation cases. Repeated fixture rows are merged within
  those cases only where the expected command or diagnostic is the same.
- Reconciliation: all 31 shell items are accounted for by a port, an explicit
  merge note, or an explicit retirement note at the numbered gap. No number is
  reused.
