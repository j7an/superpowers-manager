#!/usr/bin/env node
// @ts-check

// Spawned by REF-CLEANUP-01 in tests/baseline/ref-resolution.test.js. Calls
// fetchExactCommit against a real upstream repository while a fake `git` on
// this process's PATH hangs the inner proof-workspace fetch (see
// FAKE_GIT_SIGNAL_BODY in the test file), so the parent can interrupt this
// process — and, via its own process group, the hung fetch descendant too —
// with a real POSIX signal. Ports the child half of
// tests/test_ref_resolution.sh:144-188's Python fixture.

/** @type {typeof import("../../src/upstream.js")} */
const { fetchExactCommit } = await import(
  new URL("../../dist/upstream.js", import.meta.url).href
);

const [source, commit, repository, workspaceParent] = process.argv.slice(2);
if (
  source === undefined ||
  commit === undefined ||
  repository === undefined ||
  workspaceParent === undefined
) {
  process.stderr.write(
    "error: signal child requires source, commit, repository, workspace-parent\n",
  );
  process.exit(2);
}

await fetchExactCommit(source, commit, repository, workspaceParent);
