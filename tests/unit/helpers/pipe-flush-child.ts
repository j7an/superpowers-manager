#!/usr/bin/env node
// Two-mode child proving that the idiom carried row :2041 prescribes is
// load-bearing rather than cosmetic. Stdout is a real child-process pipe — the
// same channel `src/harnesses/codex/adapter.ts:169::execFile(` gives the fake `codex`.
//
// argv[2] is "exit" (the old idiom) or "exitCode" (the new one). The parent
// observes an uncorked seed write, pauses its reader, and then uses IPC to make
// the child fill the pipe adaptively. Pending write callbacks must survive the
// queued/finish/arm IPC handshake and are re-established before the synchronous
// exit decision; neither a fixed pipe capacity nor a momentary writableLength
// value is the witness.

const CHUNK_BYTES = 64 * 1024;
const MAX_ATTEMPTED_BYTES = 64 * 1024 * 1024;
const chunk = Buffer.alloc(CHUNK_BYTES, "x");
const mode = process.argv[2];

if (
  (mode !== "exit" && mode !== "exitCode") ||
  typeof process.send !== "function"
) {
  process.exit(2);
}

let attemptedBytes = 0;
let completedBytes = 0;
let pendingWrites = 0;
let ready = false;
let filling = false;
let queued = false;
let finishing = false;
let awaitingArm = false;

function writeChunk(bytes: Buffer, onComplete?: () => void): void {
  attemptedBytes += bytes.length;
  pendingWrites += 1;
  process.stdout.write(bytes, () => {
    completedBytes += bytes.length;
    pendingWrites -= 1;
    onComplete?.();
  });
}

function hasPendingOutput(): boolean {
  return (
    pendingWrites > 0 &&
    attemptedBytes > completedBytes &&
    process.stdout.writableLength > 0 &&
    process.stdout.writableCorked === 0
  );
}

function fillUntilPending(onPending: () => void): void {
  if (attemptedBytes + chunk.length > MAX_ATTEMPTED_BYTES) {
    process.exit(2);
  }
  writeChunk(chunk);
  setImmediate(() => {
    if (hasPendingOutput()) {
      onPending();
      return;
    }
    fillUntilPending(onPending);
  });
}

function state(phase: "seeded" | "queued" | "finishing" | "armed") {
  return {
    phase,
    attemptedBytes,
    queuedBytes: process.stdout.writableLength,
    pendingBytes: attemptedBytes - completedBytes,
    pendingWrites,
    corkedWrites: process.stdout.writableCorked,
  };
}

function reportFinishingWhenPending(): void {
  if (!hasPendingOutput()) {
    fillUntilPending(reportFinishingWhenPending);
    return;
  }
  awaitingArm = true;
  process.send!(state("finishing"), (error) => {
    if (error) process.exit(2);
  });
}

process.on("message", (message) => {
  if (message === "write" && !ready) {
    ready = true;
    writeChunk(Buffer.from("x"), () => {
      process.send!(state("seeded"));
    });
    return;
  }

  if (message === "fill" && ready && !filling) {
    filling = true;
    fillUntilPending(() => {
      queued = true;
      process.send!(state("queued"));
    });
    return;
  }

  if (message === "finish" && queued && !finishing) {
    finishing = true;
    reportFinishingWhenPending();
    return;
  }

  if (message === "arm" && finishing && awaitingArm) {
    awaitingArm = false;
    if (!hasPendingOutput()) {
      reportFinishingWhenPending();
      return;
    }
    if (mode === "exit") process.exit(0);
    process.exitCode = 0;
    process.send!(state("armed"), (error) => {
      if (error) process.exit(2);
      process.disconnect();
    });
  }
});
