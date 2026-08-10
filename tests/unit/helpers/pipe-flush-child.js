#!/usr/bin/env node
// @ts-check
// Two-mode child proving that the idiom carried row :2041 prescribes is
// load-bearing rather than cosmetic. Spawned through execFile, so stdout is a
// pipe — the same channel src/adapter.ts:112-121 gives the fake `codex`.
//
// argv[2] is "exit" (the old idiom) or "exitCode" (the new one). The payload
// deliberately exceeds the 64 KiB POSIX pipe buffer, because a payload that
// fits is delivered under both idioms and would prove nothing.

const BYTES = 1024 * 1024;
const payload = "x".repeat(BYTES);

process.stdout.write(payload);
if (process.argv[2] === "exit") {
  process.exit(0);
} else {
  process.exitCode = 0;
}
