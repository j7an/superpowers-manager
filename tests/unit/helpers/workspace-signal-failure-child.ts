import { chmodSync } from "node:fs";
import { dirname } from "node:path";

import { withWorkspaceReporting } from "../../../src/workspace.ts";

const parent = process.argv[2];
if (!parent) throw new Error("missing parent");
setInterval(() => {}, 2 ** 31 - 1);

await withWorkspaceReporting(parent, "failing-", async (workspace) => {
  // Make removal fail: a read-only parent blocks unlinking its children.
  chmodSync(dirname(workspace), 0o500);
  process.stdout.write(`${workspace}\n`);
  await new Promise(() => {});
});
