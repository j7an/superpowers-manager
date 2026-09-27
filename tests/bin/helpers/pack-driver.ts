import { runPack } from "../../tools/pack.ts";
import { chmodSync } from "node:fs";
import { dirname, join } from "node:path";
import { createConnection } from "node:net";

const mode = process.argv[2];
if (
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
