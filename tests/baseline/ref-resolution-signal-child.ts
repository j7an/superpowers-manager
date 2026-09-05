#!/usr/bin/env node

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
