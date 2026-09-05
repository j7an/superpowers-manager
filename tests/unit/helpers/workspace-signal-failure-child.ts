import { chmodSync } from "node:fs";
import { dirname } from "node:path";

import { withWorkspace } from "../../../src/workspace.ts";

const parent = process.argv[2];
if (!parent) throw new Error("missing parent");
setInterval(() => {}, 2 ** 31 - 1);

await withWorkspace(
  parent,
  "failing-",
  async (workspace) => {
    // Make removal fail: a read-only parent blocks unlinking its children.
    chmodSync(dirname(workspace), 0o500);
    process.stdout.write(`${workspace}\n`);
    await new Promise(() => {});
  },
  { onCleanupFailure: (path) => process.stdout.write(`reported:${path}\n`) },
);
