#!/usr/bin/env node
// A TOOL, not a registered test suite. The suite is the gate; this exists so a
// contributor can see citation validation in under a second.
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CORPUS_DIRS,
  classify,
  displayPath,
  listSources,
  scan,
  validate,
} from "../lib/citations.ts";

// The suite drives this TOOL against isolated fixture roots, exactly as
// tests can exercise CLI dispatch against isolated roots. Production callers
// never set this; the corpus-validation gate reads the real repository.
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

const mode = process.argv[2] ?? "--report";
if (mode === "--report") report();
else {
  process.stderr.write(`error: unknown mode ${mode}\n`);
  process.exitCode = 1;
}
