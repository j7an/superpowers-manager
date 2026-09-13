// The README's per-command requirements table is derived from production.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));

import * as cli from "../../src/cli.ts";
import { piHarness } from "../../src/harnesses/pi/harness.ts";

const BEGIN = "<!-- requirements:begin -->";
const END = "<!-- requirements:end -->";
type HarnessName = "codex" | "pi";
type Subcommand = keyof ReturnType<typeof cli.commandRequirements>;

// Column heading -> selected harness and production requirement token.
const TOOL_COLUMNS = [
  ["git", "codex", "git"],
  ["Python 3", "codex", "python3"],
  ["Codex CLI (default)", "codex", "codex"],
  ["Pi CLI (`--harness pi`)", "pi", "pi"],
] as const satisfies readonly (readonly [string, HarnessName, string])[];
const COLUMNS = TOOL_COLUMNS.map(([column]) => column);

function requirements(
  env: NodeJS.ProcessEnv,
): Record<HarnessName, Record<Subcommand, string[]>> {
  const pi = Object.fromEntries(
    Object.entries(cli.commandRequirementsFor(env, piHarness)).map(
      ([command, tools]) => [
        command,
        tools.map((requirement) => requirement.name),
      ],
    ),
  ) as Record<Subcommand, string[]>;
  return { codex: cli.commandRequirements(env), pi };
}

function derive(): Record<string, string>[] {
  const unset = requirements({});
  return Object.keys(unset.codex).map((command) => {
    const key = command as Subcommand;

    const row: Record<string, string> = { Command: command };
    for (const [column, harness, tool] of TOOL_COLUMNS) {
      row[column] = unset[harness][key].includes(tool) ? "yes" : "no";
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
