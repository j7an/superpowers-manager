// The README's per-command requirements table is derived from production.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));

import { requirementsFor } from "../../src/cli.ts";
import { codexHarness } from "../../src/harnesses/codex/harness.ts";
import { piHarness } from "../../src/harnesses/pi/harness.ts";
import { openCodeHarness } from "../../src/harnesses/opencode/harness.ts";
import type { HarnessCommand } from "../../src/harness.ts";

const BEGIN = "<!-- requirements:begin -->";
const END = "<!-- requirements:end -->";
type HarnessName = "codex" | "pi" | "opencode";

const COMMANDS = {
  pin: true,
  "track-latest": true,
  unpin: true,
  prepare: true,
  probe: true,
  install: true,
  update: true,
  uninstall: true,
} satisfies Record<HarnessCommand, true>;

// Column heading -> selected harness and production requirement token.
const TOOL_COLUMNS = [
  ["git", "codex", "git"],
  ["Codex CLI (default)", "codex", "codex"],
  ["Pi CLI (`--harness pi`)", "pi", "pi"],
  ["OpenCode CLI (`--harness opencode`)", "opencode", "opencode"],
] as const satisfies readonly (readonly [string, HarnessName, string])[];
const COLUMNS = TOOL_COLUMNS.map(([column]) => column);

function derive(): Record<string, string>[] {
  return (Object.keys(COMMANDS) as HarnessCommand[]).map((command) => {
    const names = {
      codex: requirementsFor(command, {}, codexHarness).map(
        (requirement) => requirement.name,
      ),
      pi: requirementsFor(command, {}, piHarness).map(
        (requirement) => requirement.name,
      ),
      opencode: requirementsFor(command, {}, openCodeHarness).map(
        (requirement) => requirement.name,
      ),
    };
    const row: Record<string, string> = { Command: command };
    for (const [column, harness, tool] of TOOL_COLUMNS) {
      row[column] = names[harness].includes(tool) ? "yes" : "no";
    }
    return row;
  });
}

function parseRegion(): Record<string, string>[] {
  const text = readFileSync(join(ROOT, "README.md"), "utf8");
  const start = text.indexOf(BEGIN);
  const end = text.indexOf(END);
  assert.notEqual(start, -1, `README.md is missing ${BEGIN}`);
  assert.notEqual(end, -1, `README.md is missing ${END}`);
  assert.ok(end > start, "README.md requirements markers are out of order");
  const rows = text
    .slice(start + BEGIN.length, end)
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("|"))
    .map((line) =>
      line
        .slice(1, -1)
        .split("|")
        .map((cell) => cell.trim()),
    );
  assert.ok(rows.length >= 3, "the requirements region has no table rows");
  assert.deepEqual(rows[0], ["Command", ...COLUMNS]);
  assert.ok(
    rows[1].every((cell) => /^-+$/.test(cell)),
    "the second table row must be the markdown separator",
  );
  return rows.slice(2).map((row) => {
    assert.equal(
      row.length,
      COLUMNS.length + 1,
      `row has ${row.length} cells, expected ${COLUMNS.length + 1}: ${row.join(" | ")}`,
    );

    const parsed: Record<string, string> = {
      Command: row[0].replaceAll("`", ""),
    };
    COLUMNS.forEach((column, index) => {
      parsed[column] = row[index + 1];
    });
    return parsed;
  });
}

void test("README requirements table matches production preflight", () => {
  assert.deepEqual(parseRegion(), derive());
});
