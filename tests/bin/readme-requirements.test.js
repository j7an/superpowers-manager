// @ts-check
// The README's per-command requirements table is derived from production, not
// restated. PR 11.5 slice 2 flipped `probe` in-process and left README.md
// claiming `probe` needs Python 3 and a POSIX sh, a regression that shipped
// and survived four slices because nothing checked it (carried row 12).
//
// CLI-PREFLIGHT-01 already derives its own map from these same two exports, so
// this adds no new source of truth -- it stops one document from restating one.
//
// This whole file dies in slice 6 with the table it guards.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
/** @type {typeof import("../../src/cli.js")} */
const cli = await import(new URL("../../dist/cli.js", import.meta.url).href);

const BEGIN = "<!-- requirements:begin -->";
const END = "<!-- requirements:end -->";
// Column heading -> the COMMAND_REQUIREMENTS token it reports on. The POSIX sh
// column has no token: preflight derives it from DISPATCH (src/cli.ts:267-278),
// which is exactly the second encoding of dispatch that slice 2 removed from
// CLI-PREFLIGHT-01's hand-written map.
const TOOL_COLUMNS = [
  ["git", "git"],
  ["Python 3", "python3"],
  ["Codex CLI", "codex"],
];
const COLUMNS = ["git", "Python 3", "POSIX `sh`", "Codex CLI"];

/** @returns {Record<string, string>[]} */
function derive() {
  const declared = cli.commandRequirements();
  return Object.keys(declared).map((command) => {
    const key = /** @type {keyof typeof declared} */ (command);
    /** @type {Record<string, string>} */
    const row = { Command: command };
    for (const [column, tool] of TOOL_COLUMNS) {
      row[column] = declared[key].includes(tool) ? "yes" : "no";
    }
    row["POSIX `sh`"] = cli.DISPATCH[key] === "spawn" ? "yes" : "no";
    return row;
  });
}

/** @returns {Record<string, string>[]} */
function parseRegion() {
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
    /** @type {Record<string, string>} */
    const parsed = { Command: row[0].replaceAll("`", "") };
    COLUMNS.forEach((column, index) => {
      parsed[column] = row[index + 1];
    });
    return parsed;
  });
}

void test("README requirements table matches production preflight", () => {
  assert.deepEqual(parseRegion(), derive());
});
