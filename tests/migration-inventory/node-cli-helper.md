# Migration inventory: tests/test_node_cli_helper.sh

Source read in full (76 lines). Retired in Task 2 of slice 4c. The surviving
property is the child-environment scrub and is covered by
`tests/unit/adapter.test.js`.

The shell-original anchor is the last commit in which the driver existed:
`b3f926f3a5428d21e1fdfe35f9714a639d8209c5`. Before deletion,
`git show b3f926f3a5428d21e1fdfe35f9714a639d8209c5:tests/test_node_cli_helper.sh`
resolved and `git merge-base --is-ancestor
b3f926f3a5428d21e1fdfe35f9714a639d8209c5 origin/main` confirmed reachability.

## Counting rules applied

- Each explicit `test` or `grep -Fq`/`grep -Fqx` assertion is counted.
- Each `if <command>; then ... exit 1; fi` negative guard is counted once,
  including the three preload guards.
- The two direct consecutive scrub calls are separate shell assertions; the
  port's single child-environment test covers the scrub contract without
  reproducing the shell's temporary-environment leak mechanism.

## Assertion inventory

<!-- inventory:mapped:start -->

1. A missing selection helper fails (`tests/test_node_cli_helper.sh:13-17`).
   **Retired at the gap**: the `spw_node_cli` shell helper and its `dist/`
   script callers are retired; no live product path remains to exercise this
   shell-only failure.
2. The missing selection helper emits its frozen diagnostic (`:18`). **Retired
   at the gap** for the same shell-helper retirement.
3. A missing upstream helper fails (`:20-24`). **Retired at the gap** for the
   same shell-helper retirement.
4. The missing upstream helper emits its frozen diagnostic (`:25`). **Retired
   at the gap** for the same shell-helper retirement.
5. The first child invocation receives neither `NODE_OPTIONS` nor `NODE_PATH`
   (`:36-42`). Port: `tests/unit/adapter.test.js`'s
   `runCommand strips NODE_OPTIONS and NODE_PATH from the child env`.
6. The first child invocation does not execute the preload (`:43-46`). **Retired
   at the gap**: the port tests the child boundary directly, and the shell's
   inherited-export failure mode does not exist in the TypeScript dispatcher.
7. The priming invocation is clean (`:55-59`). **Retired at the gap**: repeated
   shell calls are not a TypeScript contract.
8. The priming invocation does not execute the preload (`:60-63`). **Retired at
   the gap** with item 7; the same child boundary is covered once.
9. The second consecutive invocation is clean (`:65-69`). **Retired at the
   gap** for the same shell-export reason.
10. The second consecutive invocation does not execute the preload (`:70-73`).
    **Retired at the gap** for the same reason.

<!-- inventory:mapped:end -->

## Cardinality

```json inventory
{
  "shellOriginal": 10,
  "portOnly": 0,
  "ports": { "tests/unit/adapter.test.js": 13 }
}
```

- Shell original: **10** assertions (four missing-helper branch assertions,
  six scrub/preload assertions across the first and two consecutive calls).
- Port (`tests/unit/adapter.test.js`): 13 static `node:test` cases are present
  in the shared adapter unit file; the final case carries the surviving
  child-environment contract and preservation of an unrelated variable.
- Reconciliation: the surviving child-environment property is represented by
  the port; all shell-only helper and repeated-call assertions are **retired
  items**, each marked at its numbered gap above. No assertion number is
  reused.
