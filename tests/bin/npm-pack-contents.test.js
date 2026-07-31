// @ts-check
// Ported from tests/test_npm_pack_contents.sh (see
// tests/migration-inventory/npm-pack-contents.md for the numbered
// assertion inventory this file maps to 1:1).
//
// The shell driver never inspects `npm pack`'s JSON report itself — it
// always delegates to the shared `tests/assert_pack_contents.sh` (also used
// by the publish workflow; out of scope here and left untouched) and
// treats that script's exit code and combined stdout+stderr as the oracle.
// This port reproduces that exactly via spawnSync, rather than
// reimplementing the shared script's Python comparison logic in JS.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const ASSERT_SCRIPT = join(ROOT, "tests", "assert_pack_contents.sh");

/**
 * @param {string} scriptPath
 * @param {readonly string[]} args
 * @param {{ cwd?: string }} [options]
 */
function runSh(scriptPath, args, options = {}) {
  const result = spawnSync("sh", [scriptPath, ...args], {
    encoding: "utf8",
    cwd: options.cwd,
  });
  return {
    status: result.status,
    output: `${result.stdout ?? ""}${result.stderr ?? ""}`,
  };
}

/**
 * @param {string} jsonPath
 * @param {unknown} value
 */
function writeJson(jsonPath, value) {
  writeFileSync(jsonPath, JSON.stringify(value), "utf8");
}

/**
 * Produces the real `npm pack --dry-run --json` report for this repo, plus
 * the same report's single packed entry pulled out of npm's one-element
 * array shape — mirrors the shell driver's `pack-raw.json` step and the
 * Python reshape step at tests/test_npm_pack_contents.sh:15-34.
 * @param {string} scratchDir
 * @returns {{ rawPath: string, packed: Record<string, unknown> }}
 */
function packRealReport(scratchDir) {
  const rawPath = join(scratchDir, "pack-raw.json");
  const result = spawnSync("npm", ["pack", "--dry-run", "--json"], {
    cwd: ROOT,
    encoding: "utf8",
  });
  assert.equal(
    result.status,
    0,
    `npm pack --dry-run --json failed: ${result.stderr ?? ""}`,
  );
  writeFileSync(rawPath, result.stdout ?? "", "utf8");
  const report = JSON.parse(readFileSync(rawPath, "utf8"));
  // The installed npm's `pack --json` shape varies by version (a
  // one-element array on some, a single-key keyed object on others) — the
  // same variance assert_pack_contents.sh itself normalizes. Mirror that
  // normalization here rather than assuming one shape.
  let packed;
  if (Array.isArray(report) && report.length === 1) {
    packed = report[0];
  } else if (
    report !== null &&
    typeof report === "object" &&
    !Array.isArray(report) &&
    Object.keys(report).length === 1
  ) {
    packed = Object.values(report)[0];
  } else {
    assert.fail(
      `unexpected npm pack --json shape from the real npm invocation: ${JSON.stringify(report)}`,
    );
  }
  return { rawPath, packed };
}

void test("npm-pack-contents", async (t) => {
  const scratch = mkdtempSync(join(tmpdir(), "spw-pack-"));
  t.after(() => rmSync(scratch, { recursive: true, force: true }));

  const { rawPath, packed } = packRealReport(scratch);

  // --- inventory item 1: the real report validates end-to-end ---------

  await t.test(
    "the real dry-run pack report is accepted (name, version, id, and tarball contents all match)",
    () => {
      const { status, output } = runSh(ASSERT_SCRIPT, [rawPath]);
      assert.equal(status, 0, output);
    },
  );

  // --- inventory items 2-3: alternate accepted shapes ------------------

  const arrayPath = join(scratch, "pack-array.json");
  const keyedPath = join(scratch, "pack-keyed.json");
  writeJson(arrayPath, [packed]);
  writeJson(keyedPath, { packed });

  await t.test(
    "a one-element array reshape of the same report is still accepted",
    () => {
      const { status, output } = runSh(ASSERT_SCRIPT, [arrayPath]);
      assert.equal(status, 0, output);
    },
  );

  await t.test(
    "a single-key keyed-object reshape of the same report is still accepted",
    () => {
      const { status, output } = runSh(ASSERT_SCRIPT, [keyedPath]);
      assert.equal(status, 0, output);
    },
  );

  // --- inventory items 4-13: malformed shapes are rejected -------------

  const SHAPE_DIAGNOSTIC =
    "unexpected npm pack --json shape: expected a one-element array or a keyed object with exactly one value";

  /** @type {Record<string, unknown>} */
  const malformedShapes = {
    "shape-empty-array.json": [],
    "shape-two-element-array.json": [packed, packed],
    "shape-empty-object.json": {},
    "shape-two-entry-object.json": { first: packed, second: packed },
    "shape-non-object-entry.json": [null],
  };

  for (const [name, report] of Object.entries(malformedShapes)) {
    const fixturePath = join(scratch, name);
    writeJson(fixturePath, report);
    const { status, output } = runSh(ASSERT_SCRIPT, [fixturePath]);

    await t.test(`malformed shape ${name} is rejected (non-zero exit)`, () => {
      assert.notEqual(status, 0);
    });

    await t.test(`malformed shape ${name} reports the shape diagnostic`, () => {
      assert.match(output, new RegExp(escapeRegExp(SHAPE_DIAGNOSTIC)));
    });
  }

  // --- inventory items 14-19: forbidden packed paths --------------------

  await t.test("no packed path falls into a forbidden category", () => {
    const paths = /** @type {{ path: string }[]} */ (packed.files).map(
      (file) => file.path,
    );
    for (const path of paths) {
      const parts = path.split("/");
      assert.equal(
        parts.includes("selection.json"),
        false,
        `forbidden selection.json path: ${path}`,
      );
      assert.equal(
        parts.some((part) => part.startsWith("superpowers-manager.pin.")),
        false,
        `forbidden pin-file path: ${path}`,
      );
      assert.equal(
        parts.includes(".git"),
        false,
        `forbidden .git path: ${path}`,
      );
      assert.equal(
        parts.includes(".cache"),
        false,
        `forbidden .cache path: ${path}`,
      );
      const isForbiddenPluginsPath =
        path.startsWith("plugins/superpowers/") &&
        path !== "plugins/superpowers/.codex-plugin/plugin.template.json";
      assert.equal(
        isForbiddenPluginsPath,
        false,
        `forbidden plugins/superpowers/* path: ${path}`,
      );
      const isForbiddenDocsPath =
        path === "docs/superpowers" || path.startsWith("docs/superpowers/");
      assert.equal(
        isForbiddenDocsPath,
        false,
        `forbidden docs/superpowers path: ${path}`,
      );
    }
  });

  // --- inventory items 20-25: identity tampering is rejected -------------

  /**
   * Mirrors assert_rejected_identity() at
   * tests/test_npm_pack_contents.sh:97-126.
   * @param {string} field
   * @param {string} value
   * @param {string} diagnostic
   */
  async function assertRejectedIdentity(field, value, diagnostic) {
    const fixturePath = join(scratch, `pack-${field}.json`);
    const tampered = { ...packed, [field]: value };
    writeJson(fixturePath, [tampered]);
    const { status, output } = runSh(ASSERT_SCRIPT, [fixturePath]);

    await t.test(`tampered ${field} is rejected (non-zero exit)`, () => {
      assert.notEqual(status, 0);
    });

    await t.test(`tampered ${field} reports "${diagnostic}"`, () => {
      assert.match(output, new RegExp(escapeRegExp(diagnostic)));
    });
  }

  await assertRejectedIdentity(
    "name",
    "tampered-package",
    "pack report name mismatch",
  );
  await assertRejectedIdentity(
    "version",
    "0.0.0-tampered",
    "pack report version mismatch",
  );
  await assertRejectedIdentity(
    "id",
    "tampered-package@0.0.0",
    "pack report id mismatch",
  );

  // --- inventory items 26-27: dist-less prepack guard --------------------

  await t.test(
    "packing without a built dist/ fails closed with the prepack guard's diagnostic",
    () => {
      const distless = join(scratch, "distless");
      mkdirSync(distless, { recursive: true });
      copyFileSync(join(ROOT, "package.json"), join(distless, "package.json"));

      const result = spawnSync("npm", ["pack", "--dry-run", "--json"], {
        cwd: distless,
        encoding: "utf8",
      });

      assert.notEqual(result.status, 0, "distless npm pack must fail");
      assert.match(result.stderr ?? "", /dist\/cli\.js is missing/);
    },
  );
});

/** @param {string} value */
function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
