#!/usr/bin/env node
// Child for the fixture termination-contract test. Creates a scratch tree,
// registers it, prints its path, then blocks forever so the parent controls
// when the signal arrives.

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerScratch } from "../fixture-scratch.ts";

const scratch = mkdtempSync(join(tmpdir(), "spw-scratch-signal-"));
writeFileSync(join(scratch, "marker"), "present\n", "utf8");
registerScratch(scratch);
process.stdout.write(`${scratch}\n`);
setInterval(() => {}, 1 << 30);
