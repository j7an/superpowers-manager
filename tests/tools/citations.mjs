#!/usr/bin/env node
// @ts-check
// A TOOL, not a registered test suite -- the same status float-differential
// declares for itself. The suite is the gate; this exists so a contributor can
// see the buckets in under a second, and so PR 12.3 has a mechanically safe
// way to rewrite a line number.
import { writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CORPUS_DIRS,
  applyFixEdits,
  buildLedger,
  displayPath,
  fixEdits,
  listSources,
  scan,
  validate,
} from "../lib/citations.js";

// The suite drives this TOOL against isolated fixture roots, exactly as
// tests/run-node-suites.js is driven by SPW_RUNNER_ROOT. Production callers
// never set this. Without it the CLI's own dispatch could only be exercised
// against the repository, which the design forbids for --fix. The override
// belongs HERE, on the tool: the suite keeps its ordinary repository root,
// because CITATION-01 through CITATION-03 must read the real corpus.
const ROOT = process.env.SPW_CITATIONS_ROOT
  ? resolve(process.env.SPW_CITATIONS_ROOT)
  : fileURLToPath(new URL("../..", import.meta.url));
const LEDGER_PATH = join(ROOT, "tests", "citation-ledger.json");

/**
 * @param {Record<string, Record<string, number>>} bucket
 * @returns {number}
 */
function total(bucket) {
  return Object.values(bucket).reduce(
    (sum, tokens) => sum + Object.values(tokens).reduce((a, b) => a + b, 0),
    0,
  );
}

/** @returns {void} */
function writeLedger() {
  const ledger = buildLedger(scan(listSources(CORPUS_DIRS, ROOT)), ROOT);
  writeFileSync(LEDGER_PATH, `${JSON.stringify(ledger, null, 2)}\n`);
  process.stdout.write(
    `wrote ledger: unanchored=${total(ledger.unanchored)} ` +
      `deadReferent=${total(ledger.deadReferent)}\n`,
  );
}

/** @returns {void} */
function report() {
  const citations = scan(listSources(CORPUS_DIRS, ROOT));
  const ledger = buildLedger(citations, ROOT);
  /** @type {string[]} */
  const failures = [];
  for (const citation of citations) {
    if (citation.kind === "legacy") continue;
    const verdict = validate(citation, ROOT);
    if (!verdict.ok) {
      failures.push(
        `${displayPath(citation.file, ROOT)}:${citation.lineNumber}: ${verdict.message}`,
      );
    }
  }
  process.stdout.write(
    `citations=${citations.length} unanchored=${total(ledger.unanchored)} ` +
      `deadReferent=${total(ledger.deadReferent)} failing=${failures.length}\n`,
  );
  for (const line of failures) process.stdout.write(`  ${line}\n`);
  if (failures.length > 0) process.exitCode = 1;
}

/** @returns {void} */
function fix() {
  const edits = fixEdits(scan(listSources(CORPUS_DIRS, ROOT)), ROOT);
  const files = applyFixEdits(edits);
  process.stdout.write(`rewrote ${edits.length} citations in ${files} files\n`);
}

const mode = process.argv[2] ?? "--report";
if (mode === "--report") report();
else if (mode === "--fix") fix();
else if (mode === "--write-ledger") writeLedger();
else {
  process.stderr.write(`error: unknown mode ${mode ?? "(none)"}\n`);
  process.exitCode = 1;
}
