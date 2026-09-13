import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { compareByCodePoint, pythonStrip } from "../../src/python-text.ts";

const DECODER = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const SHAPE_DIAGNOSTIC =
  "unexpected npm pack --json shape: expected a one-element array or a keyed object with exactly one value";

class ValidationFailure extends Error {}

function fail(message: string): never {
  throw new ValidationFailure(message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function readJson(path: string, input: string): unknown {
  let text: string;
  try {
    text = DECODER.decode(readFileSync(path));
  } catch {
    fail(`cannot read ${input}: ${path}`);
  }
  try {
    return JSON.parse(text);
  } catch {
    fail(`invalid JSON in ${input}: ${path}`);
  }
}

function reshapeReport(value: unknown, path: string): Record<string, unknown> {
  let packed: unknown;
  if (Array.isArray(value) && value.length === 1) {
    packed = value[0];
  } else if (isRecord(value) && Object.keys(value).length === 1) {
    packed = Object.values(value)[0];
  } else {
    fail(`${SHAPE_DIAGNOSTIC}: ${path}`);
  }
  try {
    assert.ok(isRecord(packed));
  } catch {
    fail(`${SHAPE_DIAGNOSTIC}: ${path}`);
  }
  return packed;
}

function display(value: unknown): string {
  return typeof value === "string" ? `'${value}'` : String(value);
}

function packedPaths(packed: Record<string, unknown>, path: string): string[] {
  if (!Array.isArray(packed.files)) {
    fail(
      `pack report files must be an array of objects with string paths: ${path}`,
    );
  }
  const paths: string[] = [];
  for (const entry of packed.files) {
    if (!isRecord(entry) || typeof entry.path !== "string") {
      fail(
        `pack report files must be an array of objects with string paths: ${path}`,
      );
    }
    paths.push(entry.path);
  }
  return paths.sort(compareByCodePoint);
}

function expectedPaths(path: string): string[] {
  let text: string;
  try {
    text = DECODER.decode(readFileSync(path));
  } catch {
    fail(`cannot read expected tarball contents: ${path}`);
  }
  return text
    .split(/\r\n|\r|\n/)
    .filter((line) => !line.startsWith("#"))
    .map(pythonStrip)
    .filter((line) => line !== "")
    .sort(compareByCodePoint);
}

function validate(
  reportPath: string,
  packagePath: string,
  expectedPath: string,
): void {
  const packed = reshapeReport(
    readJson(reportPath, "npm pack report"),
    reportPath,
  );
  const packageValue = readJson(packagePath, "root package manifest");
  if (!isRecord(packageValue))
    fail(`root package manifest must be an object: ${packagePath}`);

  if (packageValue.name !== "superpowers-manager") {
    fail(
      `root package name mismatch: expected 'superpowers-manager', got ${display(packageValue.name)}`,
    );
  }
  const version = packageValue.version;
  if (typeof version !== "string" || version === "") {
    fail(`root package version is missing or invalid: ${display(version)}`);
  }
  if (packed.name !== packageValue.name) {
    fail(
      `pack report name mismatch: expected ${display(packageValue.name)}, got ${display(packed.name)}`,
    );
  }
  if (packed.version !== version) {
    fail(
      `pack report version mismatch: expected ${display(version)}, got ${display(packed.version)}`,
    );
  }
  const expectedId = `superpowers-manager@${version}`;
  if (packed.id !== expectedId) {
    fail(
      `pack report id mismatch: expected ${display(expectedId)}, got ${display(packed.id)}`,
    );
  }

  const actual = packedPaths(packed, reportPath);
  const expected = expectedPaths(expectedPath);
  const missing = expected.filter((entry) => !actual.includes(entry));
  const extra = actual.filter((entry) => !expected.includes(entry));
  const matches =
    actual.length === expected.length &&
    actual.every((entry, index) => entry === expected[index]);
  if (!matches) {
    if (missing.length)
      console.log(`missing from tarball:\n  ${missing.join("\n  ")}`);
    if (extra.length)
      console.log(`unexpected in tarball:\n  ${extra.join("\n  ")}`);
    process.exitCode = 1;
    return;
  }
  console.log(`tarball contents OK (${actual.length} files)`);
}

const [reportPath, packagePath, expectedPath] = process.argv.slice(2);
if (!reportPath || !packagePath || !expectedPath) {
  console.error(
    "usage: assert-pack-contents <report-path> <package-json> <expected-files>",
  );
  process.exitCode = 1;
} else {
  try {
    validate(reportPath, packagePath, expectedPath);
  } catch (error) {
    console.error(
      error instanceof ValidationFailure
        ? error.message
        : "cannot validate npm pack contents",
    );
    process.exitCode = 1;
  }
}
