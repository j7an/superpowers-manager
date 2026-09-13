import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";

const [namesJson, outputPath] = process.argv.slice(2);
assert.ok(
  namesJson !== undefined && outputPath !== undefined,
  "witness arguments",
);
const names: unknown = JSON.parse(namesJson);
assert.ok(
  Array.isArray(names) && names.every((name) => typeof name === "string"),
  "witness names must be strings",
);
const entries = Object.entries(process.env);
writeFileSync(
  outputPath,
  JSON.stringify({
    passthrough: Object.fromEntries(
      names.map((name) => [name, process.env[name] ?? null]),
    ),
    superpowers_env: Object.fromEntries(
      entries.filter(([name]) => name.startsWith("SUPERPOWERS_")),
    ),
    xdg_env: Object.fromEntries(
      entries.filter(([name]) => name.startsWith("XDG_")),
    ),
    npm_env: Object.fromEntries(
      entries.filter(([name]) => name.toUpperCase().startsWith("NPM_CONFIG_")),
    ),
    codex_env: Object.fromEntries(
      entries.filter(([name]) => name.startsWith("CODEX_")),
    ),
    node_env: Object.fromEntries(
      entries.filter(
        ([name]) => name === "NODE_OPTIONS" || name === "NODE_PATH",
      ),
    ),
  }),
);
