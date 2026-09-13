import { readFileSync } from "node:fs";

const [, , input] = process.argv;

if (!input || process.argv.length !== 3) {
  console.error("error: metadata input path is required");
  process.exitCode = 1;
} else {
  try {
    const text = new TextDecoder("utf-8", {
      fatal: true,
      ignoreBOM: true,
    }).decode(readFileSync(input));
    if (text.startsWith("\uFEFF")) throw new Error("metadata has a BOM");
    const metadata: unknown = JSON.parse(text);
    if (
      metadata === null ||
      typeof metadata !== "object" ||
      Array.isArray(metadata)
    ) {
      throw new Error("metadata has an invalid commit");
    }
    const record = metadata as Record<string, unknown>;
    if ("commit" in record && typeof record.commit !== "string") {
      throw new Error("metadata has an invalid commit");
    }
    console.log(record.commit ?? "");
  } catch {
    console.error(`error: could not read metadata input ${input}`);
    process.exitCode = 1;
  }
}
