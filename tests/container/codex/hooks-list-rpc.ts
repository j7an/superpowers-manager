import { spawn } from "node:child_process";
import {
  closeSync,
  openSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";

const args = process.argv.slice(2);
if (args.length !== 3 && args.length !== 4) {
  throw new Error("expected cwd response stderr [hooks/list|skills/list]");
}
const [requestedCwd, responseName, stderrName] = args;
const method = args[3] ?? "hooks/list";
if (method !== "hooks/list" && method !== "skills/list") {
  throw new Error("expected cwd response stderr [hooks/list|skills/list]");
}

const deadline = performance.now() + 25_000;
const idSources = new WeakMap<object, string>();
const responseTemporary = `${responseName}.${process.pid}.tmp`;

class ProtocolFailure extends Error {}

function fail(message: string): never {
  throw new ProtocolFailure(message);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseRecord(raw: Uint8Array): {
  message: Record<string, unknown>;
  hasNonFiniteDecimal: boolean;
} {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
      raw,
    );
  } catch {
    fail("malformed JSONL response");
  }

  let hasNonFiniteDecimal = false;
  let parsed: unknown;
  try {
    parsed = JSON.parse(
      text,
      function (
        this: object,
        key: string,
        value: unknown,
        context?: { source?: string },
      ) {
        if (key === "id") {
          if (
            typeof value === "number" &&
            typeof context?.source === "string"
          ) {
            idSources.set(this, context.source);
          } else {
            idSources.delete(this);
          }
        }
        if (
          typeof value === "number" &&
          !Number.isFinite(value) &&
          typeof context?.source === "string" &&
          /[.eE]/.test(context.source)
        ) {
          hasNonFiniteDecimal = true;
        }
        return value;
      },
    );
  } catch {
    fail("malformed JSONL response");
  }
  if (!isObject(parsed)) fail("JSONL response must be an object");
  return { message: parsed, hasNonFiniteDecimal };
}

const stderrFd = openSync(stderrName, "w");
const child = spawn("codex", ["app-server"], {
  stdio: ["pipe", "pipe", stderrFd] as const,
});
closeSync(stderrFd);
const childStdin = child.stdin!;
const childStdout = child.stdout!;

let buffered = Buffer.alloc(0);
let stdoutClosed = false;
let childClosed = false;
let streamFailure: string | undefined;
let wake: (() => void) | undefined;

function signalActivity(): void {
  const resolve = wake;
  wake = undefined;
  resolve?.();
}

function onData(chunk: Buffer): void {
  buffered = Buffer.concat([buffered, chunk]);
  signalActivity();
}
function onStdoutClose(): void {
  stdoutClosed = true;
  signalActivity();
}
function onStdoutError(): void {
  streamFailure = "app-server stdout failed";
  signalActivity();
}
function onStdinError(): void {
  streamFailure = "could not send request";
  signalActivity();
}
function onChildError(): void {
  streamFailure = "could not start app-server";
  signalActivity();
}
function onChildClose(): void {
  childClosed = true;
  signalActivity();
}

childStdout.on("data", onData);
childStdout.on("close", onStdoutClose);
childStdout.on("error", onStdoutError);
childStdin.on("error", onStdinError);
child.on("error", onChildError);
child.on("close", onChildClose);

async function waitForActivity(): Promise<void> {
  const remaining = deadline - performance.now();
  if (remaining <= 0) fail("timed out waiting for app-server output");
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      if (wake === awaken) wake = undefined;
      resolve();
    }, remaining);
    const awaken = () => {
      clearTimeout(timer);
      resolve();
    };
    wake = awaken;
  });
}

async function nextMessage(): Promise<{
  message: Record<string, unknown>;
  raw: Buffer;
  hasNonFiniteDecimal: boolean;
}> {
  while (true) {
    if (performance.now() >= deadline) {
      fail("timed out waiting for app-server output");
    }
    const newline = buffered.indexOf(0x0a);
    if (newline >= 0) {
      const raw = buffered.subarray(0, newline);
      buffered = buffered.subarray(newline + 1);
      if (raw.length === 0) continue;
      const parsed = parseRecord(raw);
      if (performance.now() >= deadline) {
        fail("timed out waiting for app-server output");
      }
      return { ...parsed, raw };
    }
    if (streamFailure !== undefined) fail(streamFailure);
    if (stdoutClosed || childClosed) fail("EOF before the required response");
    await waitForActivity();
  }
}

async function receive(expectedId: number): Promise<Buffer> {
  while (true) {
    const { message, raw, hasNonFiniteDecimal } = await nextMessage();
    const idSource = idSources.get(message);
    if (
      typeof idSource !== "string" ||
      !/^-?(?:0|[1-9][0-9]*)$/.test(idSource) ||
      message.id !== expectedId
    ) {
      continue;
    }
    if (Object.hasOwn(message, "error")) {
      fail(`RPC error for id ${expectedId}`);
    }
    if (!Object.hasOwn(message, "result")) {
      fail(`response id ${expectedId} has no result`);
    }
    if (hasNonFiniteDecimal) fail("malformed JSONL response");
    return raw;
  }
}

async function send(message: Record<string, unknown>): Promise<void> {
  if (childClosed || streamFailure !== undefined) {
    fail("app-server exited before request");
  }
  const payload = `${JSON.stringify(message)}\n`;
  await new Promise<void>((resolve, reject) => {
    childStdin.write(payload, (error) => {
      if (error) reject(new ProtocolFailure("could not send request"));
      else resolve();
    });
  });
}

async function waitForExit(milliseconds: number): Promise<boolean> {
  if (childClosed) return true;
  return await new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => {
      child.off("close", closed);
      resolve(false);
    }, milliseconds);
    const closed = () => {
      clearTimeout(timer);
      resolve(true);
    };
    child.once("close", closed);
  });
}

async function cleanup(): Promise<void> {
  childStdin.end();
  if (await waitForExit(2_000)) return;
  child.kill("SIGTERM");
  if (await waitForExit(2_000)) return;
  child.kill("SIGKILL");
  if (!childClosed) {
    await new Promise<void>((resolve) => child.once("close", () => resolve()));
  }
}

async function main(): Promise<void> {
  try {
    await send({
      id: 0,
      method: "initialize",
      params: {
        clientInfo: {
          name: "superpowers-manager-container-probe",
          version: "1",
        },
      },
    });
    await receive(0);
    await send({ method: "initialized" });
    const params: Record<string, unknown> = { cwds: [requestedCwd] };
    if (method === "skills/list") params.forceReload = true;
    await send({ id: 1, method, params });
    const response = await receive(1);
    writeFileSync(
      responseTemporary,
      Buffer.concat([response, Buffer.from("\n")]),
    );
    renameSync(responseTemporary, responseName);
  } finally {
    await cleanup();
    childStdout.off("data", onData);
    childStdout.off("close", onStdoutClose);
    childStdout.off("error", onStdoutError);
    childStdin.off("error", onStdinError);
    child.off("error", onChildError);
    child.off("close", onChildClose);
    rmSync(responseTemporary, { force: true });
  }
}

try {
  await main();
} catch (error) {
  const message =
    error instanceof ProtocolFailure ? error.message : "unexpected failure";
  process.stderr.write(`Codex hooks/list protocol failed: ${message}\n`);
  process.exitCode = 1;
}
