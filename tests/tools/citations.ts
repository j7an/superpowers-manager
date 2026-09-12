#!/usr/bin/env node
// A TOOL, not a registered test suite -- the same status float-differential
// declares for itself. The suite is the gate; this exists so a contributor can
// see the buckets in under a second, and so PR 12.3 has a mechanically safe
// way to rewrite a line number.
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CORPUS_DIRS,
  applyFixEdits,
  classify,
  displayPath,
  fixEdits,
  listSources,
  scan,
  validate,
} from "../lib/citations.ts";

// The suite drives this TOOL against isolated fixture roots, exactly as
// tests/run-node-suites.js is driven by SPW_RUNNER_ROOT. Production callers
// never set this. Without it the CLI's own dispatch could only be exercised
// against the repository, which the design forbids for --fix. The override
// belongs HERE, on the tool: the suite keeps its ordinary repository root,
// because CITATION-01 through CITATION-03 must read the real corpus.
const ROOT = process.env.SPW_CITATIONS_ROOT
  ? resolve(process.env.SPW_CITATIONS_ROOT)
  : fileURLToPath(new URL("../..", import.meta.url));
function report(): void {
  const citations = scan(listSources(CORPUS_DIRS, ROOT));

  const failures: string[] = [];
  let unverified = 0;
  let unanchored = 0;
  let deadReferent = 0;
  for (const citation of citations) {
    const category = classify(citation, ROOT);
    if (category === "unanchored") unanchored += 1;
    if (category === "dead") deadReferent += 1;
    const verdict = validate(citation, ROOT);
    if (!verdict.ok) {
      failures.push(
        `${displayPath(citation.file, ROOT)}:${citation.lineNumber}: ${verdict.message}`,
      );
      continue;
    }
    if (verdict.unverified !== undefined) unverified += 1;
  }
  process.stdout.write(
    `citations=${citations.length} unanchored=${unanchored} ` +
      `deadReferent=${deadReferent} unverified=${unverified} ` +
      `failing=${failures.length}\n`,
  );
  for (const line of failures) process.stdout.write(`  ${line}\n`);
  if (failures.length > 0) process.exitCode = 1;
}

function fix(): void {
  const edits = fixEdits(scan(listSources(CORPUS_DIRS, ROOT)), ROOT);
  const files = applyFixEdits(edits);
  process.stdout.write(`rewrote ${edits.length} citations in ${files} files\n`);
}

const mode = process.argv[2] ?? "--report";
if (mode === "--report") report();
else if (mode === "--fix") fix();
else {
  process.stderr.write(`error: unknown mode ${mode ?? "(none)"}\n`);
  process.exitCode = 1;
}
