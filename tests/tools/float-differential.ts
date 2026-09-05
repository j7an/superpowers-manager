#!/usr/bin/env node
// Seeded random IEEE-754 differential between `formatPythonNumber` and the
// live CPython oracle (`json.dumps`). This is a TOOL, not a registered test
// suite: it shells out to `python3`, which Task 6 deletes from this repo. It
// stays committed so a future oracle (or a reviewer re-deriving trust) can
// re-run it, and so the seed and case count recorded in the roadmap are
// reproducible rather than merely asserted.
//
// Why random bit patterns rather than hand-picked values: a hand-assembled
// corpus that probes remembered notation thresholds (1e15, 1e16, ...) has
// missed a re-rounding defect twice during this component's design, because
// every hand-picked value happened to have few significant digits. Filling a
// BigUint64Array from a seeded generator and reinterpreting it as a double
// produces digit strings with no such bias.
//
// Usage:
//   node tests/tools/float-differential.ts --seed 0x9e3779b97f4a7c15 --cases 200000

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { formatPythonNumber } from "../../src/python-json-format.ts";

const DEFAULT_SEED = 0x9e3779b97f4a7c15n;
const DEFAULT_CASES = 200_000;

function parseArgs(argv: string[]): { seed: bigint; cases: number } {
  let seed = DEFAULT_SEED;
  let cases = DEFAULT_CASES;
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--seed") seed = BigInt(argv[(i += 1)]);
    else if (argv[i] === "--cases") cases = Number(argv[(i += 1)]);
    else throw new Error(`unrecognized argument: ${argv[i]}`);
  }
  return { seed, cases };
}

const MASK64 = (1n << 64n) - 1n;

/**
 * splitmix64 — used only to derive two well-mixed 64-bit words for
 * xorshift128+ from a single seed. Not itself the generator.
 */
function makeSplitMix64(seed: bigint) {
  let state = seed & MASK64;
  return function next() {
    state = (state + 0x9e3779b97f4a7c15n) & MASK64;
    let z = state;
    z = ((z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n) & MASK64;
    z = ((z ^ (z >> 27n)) * 0x94d049bb133111ebn) & MASK64;
    z = (z ^ (z >> 31n)) & MASK64;
    return z;
  };
}

/**
 * Seeded xorshift128+. `Math.random()` cannot be seeded, and this run must
 * be reproducible from the seed recorded in the roadmap.
 */
function makeXorshift128Plus(seed: bigint) {
  const seedNext = makeSplitMix64(seed);
  let s0 = seedNext();
  let s1 = seedNext();
  if (s0 === 0n && s1 === 0n) s1 = 1n; // an all-zero state never advances.
  return function next() {
    let x = s0;
    const y = s1;
    s0 = y;
    x = (x ^ ((x << 23n) & MASK64)) & MASK64;
    x = x ^ (x >> 17n);
    x = (x ^ y ^ (y >> 26n)) & MASK64;
    s1 = x;
    return (s0 + s1) & MASK64;
  };
}

const { seed, cases } = parseArgs(process.argv.slice(2));
const next = makeXorshift128Plus(seed);

const bits = new BigUint64Array(1);
const asFloat = new Float64Array(bits.buffer);

const inputs: string[] = [];
let skipped = 0;
while (inputs.length < cases) {
  bits[0] = next() & MASK64;
  const value = asFloat[0];
  if (!Number.isFinite(value)) {
    skipped += 1;
    continue;
  }
  // toExponential() with no argument is the shortest exponential digit
  // string that round-trips to this exact double, and JSON's grammar
  // accepts exponential notation directly — so the text IS the input, with
  // no intermediate re-parse that could shift which double is under test.
  inputs.push(value.toExponential());
}

const workDir = mkdtempSync(join(tmpdir(), "float-differential-"));
const workFile = join(workDir, "cases.json");
try {
  // NOT JSON.stringify(inputs): each entry is already valid JSON *number*
  // text produced by toExponential(). Stringifying the array would quote
  // every entry as a JSON string, and the oracle would dutifully echo those
  // quotes back — comparing string reprs instead of number reprs and
  // manufacturing mismatches that have nothing to do with formatPythonNumber.
  writeFileSync(workFile, `[${inputs.join(",")}]`, "utf8");

  const oracleScript = `
import json, sys
with open(sys.argv[1], "r", encoding="utf-8") as f:
    cases = json.load(f)
for value in cases:
    sys.stdout.write(json.dumps(value))
    sys.stdout.write("\\n")
`;
  const oracleOutput = execFileSync(
    "python3",
    ["-S", "-c", oracleScript, workFile],
    { encoding: "utf8", maxBuffer: 1024 * 1024 * 1024 },
  );
  const expectedLines = oracleOutput.split("\n");
  // json.dumps ends each line with "\n" via our explicit write, so the split
  // leaves one trailing empty string — drop it rather than assume a count.
  if (expectedLines.at(-1) === "") expectedLines.pop();

  if (expectedLines.length !== inputs.length) {
    console.error(
      `oracle produced ${expectedLines.length} lines for ${inputs.length} inputs`,
    );
    process.exit(2);
  }

  let mismatches = 0;
  for (let i = 0; i < inputs.length; i += 1) {
    const raw = inputs[i];
    const expected = expectedLines[i];
    let actual;
    try {
      actual = formatPythonNumber(raw);
    } catch (cause) {
      actual = `<threw: ${cause instanceof Error ? cause.message : String(cause)}>`;
    }
    if (actual !== expected) {
      mismatches += 1;
      const bitsHex = (() => {
        asFloat[0] = Number(raw);
        return bits[0].toString(16).padStart(16, "0");
      })();
      console.error(
        `MISMATCH bits=0x${bitsHex} input=${raw} expected=${expected} actual=${actual}`,
      );
    }
  }

  console.log(
    `seed=0x${seed.toString(16)} cases=${inputs.length} skipped-non-finite=${skipped} ${mismatches} mismatches`,
  );
  process.exit(mismatches === 0 ? 0 : 1);
} finally {
  rmSync(workDir, { recursive: true, force: true });
}
