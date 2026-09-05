#!/usr/bin/env node

// Spawned by REF-CLEANUP-01 in tests/baseline/ref-resolution.test.ts. Calls
// fetchExactCommit against a real upstream repository while a fake `git` on
// this process's PATH hangs the inner proof-workspace fetch (see
// FAKE_GIT_SIGNAL_BODY in the test file), so the parent can interrupt this
// process — and, via its own process group, the hung fetch descendant too —
// with a real POSIX signal. Ports the child half of
// `git show 349fe2ed405b371ec2de1347bb3fc50c6bc15dc4:tests/test_ref_resolution.sh:144-188::start_new_session=True`'s Python fixture.

import { fetchExactCommit } from "../../src/upstream.ts";

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
