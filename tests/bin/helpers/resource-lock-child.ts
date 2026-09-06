#!/usr/bin/env node

import { mkdir, writeFile } from "node:fs/promises";

import { createResourceCoordinator } from "../../../src/resource-lock.ts";

const mode = process.argv[2];
const resource = process.argv[3];
const marker = process.argv[4];

if (
  (mode !== "hold" && mode !== "hold-create" && mode !== "write") ||
  resource === undefined ||
  typeof process.send !== "function"
) {
  process.exit(2);
}

const coordinator = createResourceCoordinator();

try {
  await coordinator.withResources([resource], async () => {
    if (mode === "write") {
      if (marker === undefined) throw new Error("missing marker path");
      await writeFile(marker, "changed\n", "utf8");
      return;
    }
    if (mode === "hold-create") {
      await mkdir(resource, { recursive: true });
    }
    process.send!({ kind: "ready" });
    await new Promise<void>((resolve) => {
      process.once("message", (message) => {
        if (message === "release") resolve();
      });
    });
  });
  process.send!({ kind: "complete" }, () => process.disconnect());
} catch (cause) {
  process.send!(
    {
      kind: "error",
      name: cause instanceof Error ? cause.name : "unknown",
      message: cause instanceof Error ? cause.message : "unknown failure",
    },
    () => process.disconnect(),
  );
}
