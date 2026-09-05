import { runPack } from "../../tools/pack.ts";
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  writeFileSync,
} from "node:fs";
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { createConnection } from "node:net";

const mode = process.argv[2];
if (
  mode === "compiler-writer" ||
  mode === "compiler-orphan" ||
  mode === "compiler-closed-orphan"
) {
  const args = process.argv.slice(3);
  const output = args[args.indexOf("--outDir") + 1]!;
  const staging = dirname(dirname(output));
  mkdirSync(output, { recursive: true });
  writeFileSync(join(output, "cli.js"), "#!/usr/bin/env node\n", {
    mode: 0o755,
  });
  const writer = spawn(
    process.execPath,
    [import.meta.filename, "writer", staging, mode],
    {
      stdio:
        mode === "compiler-closed-orphan"
          ? ["ignore", "ignore", "ignore", "ipc"]
          : ["ignore", "inherit", "inherit", "ipc"],
    },
  );
  let terminating = false;
  for (const signal of ["SIGHUP", "SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      terminating = true;
      if (mode !== "compiler-writer") process.exit(0);
    });
  }
  writer.once("message", () => {
    const pipe = createConnection(
      join(process.env.PACK_EVENTS!, "pipe"),
      () => {
        pipe.end(
          JSON.stringify({
            event: "writer-ready",
            pid: process.pid,
            writerPid: writer.pid,
            staging,
          }) + "\n",
        );
      },
    );
  });
  writer.once("close", () => {
    writeFileSync(
      join(process.env.PACK_EVENTS!, "writer-reaped"),
      JSON.stringify({ stagingExists: existsSync(staging) }),
    );
    process.exit(terminating ? 0 : 7);
  });
} else if (mode === "writer") {
  const staging = process.argv[3]!;
  const orphan = process.argv[4] !== "compiler-writer";
  const events = process.env.PACK_EVENTS!;
  const write = () => {
    try {
      appendFileSync(join(staging, "writer-bytes"), "x");
    } catch {
      writeFileSync(
        join(events, "writer-outlived-staging"),
        "writer is still active",
      );
    }
  };
  for (const signal of ["SIGHUP", "SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      writeFileSync(
        join(events, "writer-signalled"),
        JSON.stringify({ signal, stagingExists: existsSync(staging) }),
      );
      if (!orphan) process.exit(0);
    });
  }
  write();
  setInterval(write, 10);
  process.send!({ ready: true });
  process.disconnect();
} else if (
  mode === "barrier" ||
  mode === "cleanup-failure" ||
  mode === "dual-failure"
) {
  const events = process.env.PACK_EVENTS!;
  const metadata = process.argv[3]!;
  if (mode === "barrier") {
    await new Promise<void>((resolve, reject) => {
      const pipe = createConnection(join(events, "pipe"), () => {
        pipe.write(JSON.stringify({ event: "ready", pid: process.pid }) + "\n");
      });
      pipe.once("error", reject);
      pipe.once("data", () => {
        pipe.end();
        resolve();
      });
    });
  } else {
    chmodSync(dirname(dirname(metadata)), 0o500);
    if (mode === "dual-failure") process.exitCode = 7;
  }
} else {
  const root = process.argv[2];
  const out = process.argv[3];
  if (!root || !out) throw new Error("pack driver needs root and output");
  try {
    const report = await runPack(root, out);
    process.stdout.write(`${JSON.stringify(report)}\n`);
  } catch (error) {
    if (error instanceof Error) process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
