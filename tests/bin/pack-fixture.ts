import { spawn, spawnSync, type SpawnSyncReturns } from "node:child_process";
import {
  copyFileSync,
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createServer, type Socket } from "node:net";
import type { TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { registerScratch } from "./fixture-scratch.ts";

const REPO = fileURLToPath(new URL("../..", import.meta.url));

export interface PackFixture {
  root: string;
  out: string;
  temp: string;
  bin: string;
  events: string;
}

export function makePackFixture(t: TestContext): PackFixture {
  const outer = mkdtempSync(join(tmpdir(), "spw-pack-contract-"));
  registerScratch(outer);
  const f = {
    root: join(outer, "repo"),
    out: join(outer, "out"),
    temp: join(outer, "temp"),
    bin: join(outer, "bin"),
    events: join(outer, "events"),
  };
  t.after(() => {
    chmodSync(f.temp, 0o700);
    chmodSync(f.out, 0o700);
    rmSync(outer, { recursive: true, force: true });
  });
  for (const path of [
    f.root,
    f.out,
    f.temp,
    f.bin,
    f.events,
    join(outer, "home"),
    join(outer, "cache"),
    join(outer, "node-cache"),
    join(f.root, "src"),
    join(f.root, "tests"),
    join(f.root, "node_modules", ".bin"),
  ]) {
    mkdirSync(path, { recursive: true });
  }
  const assets: Record<string, string> = {
    "config/upstream-ref": "v1.0.0\n",
    ".agents/plugins/marketplace.json": "{}\n",
    "plugins/superpowers/.codex-plugin/plugin.template.json": "{}\n",
    "README.md": "fixture package\n",
    LICENSE: "fixture license\n",
  };
  for (const [name, body] of Object.entries(assets)) {
    const path = join(f.root, name);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, body);
  }
  writeFileSync(
    join(f.root, "package.json"),
    JSON.stringify({
      name: "superpowers-manager",
      version: "0.0.0-fixture",
      type: "module",
      bin: { "superpowers-manager": "dist/cli.js" },
      files: ["dist/", ...Object.keys(assets)],
      scripts: { prepack: 'node -e "process.exit(9)"' },
    }),
  );
  writeFileSync(
    join(f.root, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: { noEmit: true, rootDir: "src" },
      include: ["src/**/*.ts"],
    }),
  );
  writeFileSync(join(f.root, "src", "cli.ts"), "export {};\n");
  copyFileSync(
    join(REPO, "tests", "assert_pack_contents.sh"),
    join(f.root, "tests", "assert_pack_contents.sh"),
  );
  writeFileSync(
    join(f.root, "tests", "expected_tarball_contents.txt"),
    [...Object.keys(assets), "dist/cli.js", "package.json"].sort().join("\n") +
      "\n",
  );
  writeFileSync(
    join(f.root, "node_modules", ".bin", "tsc"),
    [
      "#!/bin/sh",
      "set -eu",
      "spw_emit=",
      'while [ "$#" -gt 0 ]; do',
      '  case "$1" in --outDir) spw_emit="$2"; shift 2 ;; *) shift ;; esac',
      "done",
      ': "${spw_emit:?missing output directory}"',
      'mkdir -p "$spw_emit"',
      "cat > \"$spw_emit/cli.js\" <<'JS'",
      "#!/usr/bin/env node",
      'console.log(process.argv.includes("--version") ? "0.0.0-fixture" : "usage: fixture");',
      "JS",
      'chmod +x "$spw_emit/cli.js"',
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
  return f;
}

export function packDriverEnv(f: PackFixture): NodeJS.ProcessEnv {
  const outer = dirname(f.root);
  return {
    ...process.env,
    HOME: join(outer, "home"),
    NPM_CONFIG_CACHE: join(outer, "cache"),
    NPM_CONFIG_OFFLINE: "true",
    NODE_COMPILE_CACHE: join(outer, "node-cache"),
    TMPDIR: f.temp,
    TMP: f.temp,
    TEMP: f.temp,
    PACK_EVENTS: f.events,
    PACK_FIXTURE_DRIVER: join(
      REPO,
      "tests",
      "bin",
      "helpers",
      "pack-driver.ts",
    ),
    PATH: `${f.bin}:${dirname(process.execPath)}:${process.env.PATH ?? ""}`,
  };
}

export function runPackDriver(f: PackFixture): SpawnSyncReturns<string> {
  return spawnSync(
    process.execPath,
    [join(REPO, "tests", "bin", "helpers", "pack-driver.ts"), f.root, f.out],
    {
      cwd: f.root,
      encoding: "utf8",
      env: packDriverEnv(f),
    },
  );
}

export function startPackDriver(f: PackFixture) {
  const child = spawn(
    process.execPath,
    [join(REPO, "tests", "bin", "helpers", "pack-driver.ts"), f.root, f.out],
    { cwd: f.root, env: packDriverEnv(f), stdio: ["ignore", "pipe", "pipe"] },
  );
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
    stderr += chunk;
  });
  const closed = new Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
    stdout: string;
    stderr: string;
  }>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) =>
      resolve({ code, signal, stdout, stderr }),
    );
  });
  return { child, closed };
}

export function stopPackProcess(pid: number): void {
  try {
    process.kill(pid, "SIGKILL");
  } catch (error) {
    if (!(
      error &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "ESRCH"
    ))
      throw error;
  }
}

export interface PackEvent {
  event: string;
  pid: number;
  writerPid?: number;
  staging?: string;
}

export async function listenPackEvents(f: PackFixture) {
  const sockets = new Set<Socket>();
  const queued: PackEvent[] = [];
  let waiting: ((event: PackEvent) => void) | undefined;
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    let data = "";
    socket.setEncoding("utf8").on("data", (chunk: string) => {
      data += chunk;
      let end;
      while ((end = data.indexOf("\n")) !== -1) {
        const event = JSON.parse(data.slice(0, end)) as PackEvent;
        data = data.slice(end + 1);
        if (waiting) {
          const resolve = waiting;
          waiting = undefined;
          resolve(event);
        } else queued.push(event);
      }
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(join(f.events, "pipe"), resolve);
  });
  return {
    next(): Promise<PackEvent> {
      const event = queued.shift();
      if (event) return Promise.resolve(event);
      return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          waiting = undefined;
          reject(new Error("package fixture event timed out"));
        }, 10000);
        waiting = (event) => {
          clearTimeout(timeout);
          resolve(event);
        };
      });
    },
    release(): void {
      for (const socket of sockets) socket.end("go\n");
    },
    close(): Promise<void> {
      for (const socket of sockets) socket.destroy();
      return new Promise((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}

export function packValidatorMode(f: PackFixture, mode: string): void {
  const validator = join(f.root, "tests", "assert_pack_contents.sh");
  writeFileSync(
    validator,
    `#!/bin/sh\nexec node "$PACK_FIXTURE_DRIVER" ${mode} "$1"\n`,
  );
}
