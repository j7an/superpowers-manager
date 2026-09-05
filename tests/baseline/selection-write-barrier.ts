#!/usr/bin/env node

// Deterministic write barrier for FS-SELECTION-CONCURRENT-01.
//
// The child pauses inside the atomic write's already-public rename seam
// (`SelectionWriteOptions.hooks.rename`), signals the parent by creating the
// paused marker, and resumes only once the parent creates the release marker.
// The parent therefore reads the state back at a known in-flight moment, with
// no scheduling luck involved: a raised iteration count only shifts
// probability, whereas this barrier discriminates atomic from non-atomic on
// every run.
import { existsSync, writeFileSync } from "node:fs";
import { rename } from "node:fs/promises";

import { writeSelectionState } from "../../src/selection-store.ts";

const RELEASE_TIMEOUT_MS = 30_000;
const POLL_INTERVAL_MS = 5;

const [statePath, pausedMarker, releaseMarker, source] = process.argv.slice(2);
if (
  statePath === undefined ||
  pausedMarker === undefined ||
  releaseMarker === undefined ||
  source === undefined
) {
  process.stderr.write(
    "error: barrier requires a state path, two markers, and a source\n",
  );
  process.exit(2);
}

async function waitForMarker(path: string) {
  const deadline = Date.now() + RELEASE_TIMEOUT_MS;
  while (!existsSync(path)) {
    if (Date.now() > deadline) {
      throw new Error("barrier release marker never appeared");
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
}

await writeSelectionState(
  statePath,
  { schema_version: 1, mode: "track-latest", source },
  {
    hooks: {
      rename: async (from, to) => {
        writeFileSync(pausedMarker, "paused", "utf8");
        await waitForMarker(releaseMarker);
        await rename(from, to);
      },
    },
  },
);
