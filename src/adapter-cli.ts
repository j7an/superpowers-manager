import { realpathSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { serializeEnvelope } from "./adapter-protocol.js";
import { runAdapter } from "./adapter.js";
import { oneLine } from "./cli-arguments.js";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export async function runAdapterCli(argv: readonly string[]): Promise<number> {
  try {
    const result = await runAdapter(argv, { root: packageRoot });
    process.stdout.write(serializeEnvelope(result.envelope));
    return result.status;
  } catch (cause) {
    process.stderr.write(`${oneLine(cause)}\n`);
    return 1;
  }
}

const entry = process.argv[1];
if (entry !== undefined && import.meta.filename === realpathSync(entry)) {
  process.exitCode = await runAdapterCli(process.argv.slice(2));
}
