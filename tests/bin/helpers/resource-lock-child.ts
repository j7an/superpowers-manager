#!/usr/bin/env node

import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";

const mode = process.argv[2];
const resource = process.argv[3];
const marker = process.argv[4];

if (
  (mode !== "hold" &&
    mode !== "hold-before-lock" &&
    mode !== "hold-create" &&
    mode !== "write" &&
    mode !== "write-before-lock") ||
  resource === undefined ||
  typeof process.send !== "function"
) {
  process.exit(2);
}

const { mkdir, writeFile } = fs.promises;
if (mode === "hold-before-lock" || mode === "write-before-lock") {
  let intercepted = false;
  const promises = fs.promises as unknown as Record<string, unknown>;
  promises.mkdir = async (...args: Parameters<typeof mkdir>) => {
    const [path] = args;
    if (
      !intercepted &&
      typeof path === "string" &&
      path.endsWith(".resource-lock")
    ) {
      intercepted = true;
      process.send!({ kind: "before-lock" });
      await new Promise<void>((resolve) => {
        process.once("message", (message) => {
          if (message === "acquire") resolve();
        });
      });
    }
    return await mkdir(...args);
  };
  syncBuiltinESMExports();
}

const { createResourceCoordinator } =
  await import("../../../src/resource-lock.ts");
const coordinator = createResourceCoordinator();

try {
  await coordinator.withResources([resource], async () => {
    if (mode === "write" || mode === "write-before-lock") {
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
