// The README's per-command requirements table is derived from production, not
// restated. PR 11.5 slice 2 flipped `probe` in-process and left README.md
// claiming `probe` needs Python 3 and a POSIX sh, a regression that shipped
// and survived four slices because nothing checked it (carried row 12).
//
// CLI-PREFLIGHT-01 already derives its own map from the same production
// requirement accessors, so this adds no new source of truth -- it stops one
// document from restating one.
//
// This file is RETAINED (slice 6, D2). Its earlier note said it "dies in slice
// 6 with the table it guards"; that was wrong on its own terms. Three of its
// maintained columns derive from commandRequirements() or
// commandRequirementsFor() and never touched DISPATCH. The retired POSIX `sh`
// column was the exception. The regression this file was built for was slice 2
// flipping `probe` in-process and leaving README claiming `probe` needs Python
// 3, which is a requirement fact, not a dispatch fact. PR 11.6 retargets
// SUPERPOWERS_VALIDATOR_EXECUTABLE, which moves the exact `prepare` cell this
// table carries.
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
  const withValidator = requirements({
    SUPERPOWERS_VALIDATOR: "/validator.py",
  });
  return Object.keys(unset.codex).map((command) => {
    const key = command as Subcommand;

    const row: Record<string, string> = { Command: command };
    for (const [column, harness, tool] of TOOL_COLUMNS) {
      // Required with no validator configured -> plainly required. Required
      // only once one is -> conditional. The README must say which; a boolean
      // cell would be a lie in one direction or the other.
      row[column] = unset[harness][key].includes(tool)
        ? "yes"
        : withValidator[harness][key].includes(tool)
          ? "only with SUPERPOWERS_VALIDATOR"
          : "no";
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

void test("Pi reference separates runtime qualification from admission", () => {
  const text = readFileSync(join(ROOT, "docs/pi.md"), "utf8").replace(
    /\s+/g,
    " ",
  );
  assert.match(
    text,
    /For both Codex and Pi, native test versions are qualification evidence, not runtime allowlists\./,
  );
  assert.match(
    text,
    /Untested runtime versions are not automatically certified as compatible\./,
  );
  assert.doesNotMatch(
    text,
    /Every other Pi version is unsupported until separately qualified/,
  );
  assert.doesNotMatch(
    text,
    /the flag cannot admit it or an unqualified Pi runtime/,
  );
});
