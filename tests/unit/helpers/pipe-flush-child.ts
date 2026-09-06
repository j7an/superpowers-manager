#!/usr/bin/env node
// Two-mode child proving that the idiom carried row :2041 prescribes is
// load-bearing rather than cosmetic. Stdout is a real child-process pipe — the
// same channel `src/adapter.ts:142::execFile(` gives the fake `codex`.
//
// argv[2] is "exit" (the old idiom) or "exitCode" (the new one). The parent
// pauses its reader, then uses IPC to control the write and exit separately.
// Corking makes the pending byte count observable without assuming any OS pipe
// capacity: both arms schedule the same uncork before selecting their exit
// idiom, and only process.exit() prevents that scheduled flush from running.

const BYTES = 1024 * 1024;
const payload = "x".repeat(BYTES);
const mode = process.argv[2];

if (
  (mode !== "exit" && mode !== "exitCode") ||
  typeof process.send !== "function"
) {
  process.exit(2);
}

let attemptedBytes = 0;
let ready = false;
process.on("message", (message) => {
  if (message === "write" && !ready) {
    process.stdout.cork();
    attemptedBytes = Buffer.byteLength(payload);
    process.stdout.write(payload);
    ready = true;
    process.send!({
      phase: "queued",
      attemptedBytes,
      queuedBytes: process.stdout.writableLength,
    });
    return;
  }

  if (message !== "finish" || !ready) return;
  const queuedBytes = process.stdout.writableLength;
  process.send!(
    { phase: "finishing", attemptedBytes, queuedBytes },
    (error) => {
      if (error || process.stdout.writableLength !== queuedBytes) {
        process.exit(2);
      }
      process.nextTick(() => {
        process.stdout.uncork();
        process.disconnect();
      });
      if (mode === "exit") process.exit(0);
      process.exitCode = 0;
    },
  );
});
