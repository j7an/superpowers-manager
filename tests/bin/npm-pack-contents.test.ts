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

function runSh(
  scriptPath: string,
  args: readonly string[],
  options: { cwd?: string } = {},
) {
  const result = spawnSync("sh", [scriptPath, ...args], {
    encoding: "utf8",
    cwd: options.cwd,
  });
  return {
    status: result.status,
    output: `${result.stdout ?? ""}${result.stderr ?? ""}`,
  };
}

function writeJson(jsonPath: string, value: unknown) {
  writeFileSync(jsonPath, JSON.stringify(value), "utf8");
}

/**
 * Produces the explicit native packer's real npm report for this repo, plus
 * the same report's single packed entry pulled out of npm's one-element
 * array shape — mirrors the shell driver's `pack-raw.json` step and the
 * Python reshape step at `git show 0b6d50e1e9c688397285c6fa274dc8c9437d8ba3:tests/test_npm_pack_contents.sh:15-34::python3 - "$tmpdir/pack-`.
 */
function packRealReport(scratchDir: string): {
  rawPath: string;
  packed: Record<string, unknown>;
} {
  const rawPath = join(scratchDir, "pack-raw.json");
  const pack = join(scratchDir, "pack");
  const home = join(scratchDir, "home");
  const cache = join(scratchDir, "npm-cache");
  for (const directory of [pack, home, cache]) mkdirSync(directory);
  const result = spawnSync(
    process.execPath,
    [join(ROOT, "tests", "tools", "pack.ts"), "--out-dir", pack],
    {
      cwd: ROOT,
      env: { ...process.env, HOME: home, NPM_CONFIG_CACHE: cache },
      encoding: "utf8",
    },
  );
  // Mirrors the shell driver's `command -v npm` precondition
  // (`git show 0b6d50e1e9c688397285c6fa274dc8c9437d8ba3:tests/test_npm_pack_contents.sh:9::required`): name what broke without letting
  // the raw spawn error (which carries an ENOENT-shaped message) reach the
  // assertion output.
  if (result.error) {
    assert.fail(
      "explicit package command could not be run — is Node installed and on PATH?",
    );
  }
  assert.equal(
    result.status,
    0,
    `explicit package command failed: ${result.stderr ?? ""}`,
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
  // Compare the delivered tarball itself as well as the npm report: the shared
  // validator below continues to own report-shape and identity diagnostics.
  const listed = spawnSync("tar", ["-tzf", join(pack, packed.filename)], {
    encoding: "utf8",
  });
  assert.equal(listed.status, 0, `tarball listing failed: ${listed.stderr}`);
  const actualFiles = listed.stdout
    .trim()
    .split("\n")
    .map((path) => path.replace(/^package\//, ""))
    .sort();
  const expectedFiles = readFileSync(
    join(ROOT, "tests", "expected_tarball_contents.txt"),
    "utf8",
  )
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"))
    .sort();
  assert.deepEqual(
    actualFiles,
    expectedFiles,
    "delivered tarball contents must match the maintained allowlist",
  );
  return { rawPath, packed };
}

void test("npm-pack-contents", async (t) => {
  const scratch = mkdtempSync(join(tmpdir(), "spw-pack-"));
  t.after(() => rmSync(scratch, { recursive: true, force: true }));

  const { rawPath, packed } = packRealReport(scratch);

  // --- inventory item 1: the real report validates end-to-end ---------

  await t.test(
    "the real explicit pack report is accepted (name, version, id, and tarball contents all match)",
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

  const malformedShapes: Record<string, unknown> = {
    "shape-empty-array.json": [],
    "shape-two-element-array.json": [packed, packed],
    "shape-empty-object.json": {},
    "shape-two-entry-object.json": { first: packed, second: packed },
    "shape-non-object-entry.json": [null],
  };
  assert.equal(
    Object.keys(malformedShapes).length,
    5,
    "malformedShapes lost or gained a case — update tests/migration-inventory/npm-pack-contents.md",
  );

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
    const paths = (packed.files as { path: string }[]).map((file) => file.path);
    for (const path of paths) {
      assert.equal(
        forbiddenPathCategory(path),
        null,
        `forbidden path (${forbiddenPathCategory(path)}): ${path}`,
      );
    }
  });

  // The real pack currently contains zero matches in any of the six
  // categories above, so that check alone can never go RED for a
  // mistranslated predicate (e.g. `includes` where the shell used
  // `startsWith`, or a missing `parts` split). This synthetic fixture is
  // not present in the original shell driver — it exists solely to make
  // each category's predicate independently falsifiable. See
  // tests/migration-inventory/npm-pack-contents.md for the discriminating
  // rationale.
  const FORBIDDEN_PATH_FIXTURES = [
    ["selection.json", "some/dir/selection.json"],
    ["pin-file", "some/dir/superpowers-manager.pin.deadbeef"],
    [".git", "some/.git/config"],
    [".cache", "some/.cache/thing"],
    ["plugins/superpowers/*", "plugins/superpowers/skills/foo.md"],
    ["docs/superpowers", "docs/superpowers/notes.md"],
  ] as const;
  assert.equal(
    FORBIDDEN_PATH_FIXTURES.length,
    6,
    "FORBIDDEN_PATH_FIXTURES lost or gained a case — update tests/migration-inventory/npm-pack-contents.md",
  );

  for (const [category, path] of FORBIDDEN_PATH_FIXTURES) {
    await t.test(
      `forbidden-path category "${category}" rejects a synthetic matching path (${path})`,
      () => {
        assert.equal(forbiddenPathCategory(path), category);
      },
    );
  }

  // The allowed carve-out must not be misclassified as forbidden by the
  // plugins/superpowers/* predicate's boundary.
  await t.test(
    "the plugins/superpowers/* exception path is not itself forbidden",
    () => {
      assert.equal(
        forbiddenPathCategory(
          "plugins/superpowers/.codex-plugin/plugin.template.json",
        ),
        null,
      );
    },
  );

  // --- inventory items 20-25: identity tampering is rejected -------------

  /**
   * Mirrors assert_rejected_identity() at
   * `git show 0b6d50e1e9c688397285c6fa274dc8c9437d8ba3:tests/test_npm_pack_contents.sh:97-126::assert_rejected_identity(`.
   */
  async function assertRejectedIdentity(
    field: string,
    value: string,
    diagnostic: string,
  ) {
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

  // --- inventory items 26-27: unconditional source prepack guard --------

  await t.test(
    "source packing with absent or stale dist/ fails closed with the explicit-command diagnostic",
    () => {
      for (const stale of [false, true]) {
        const checkout = join(scratch, stale ? "stale-dist" : "absent-dist");
        mkdirSync(checkout);
        copyFileSync(
          join(ROOT, "package.json"),
          join(checkout, "package.json"),
        );
        if (stale) {
          mkdirSync(join(checkout, "dist"));
          writeFileSync(join(checkout, "dist", "cli.js"), "// stale output\n");
        }
        const result = spawnSync("npm", ["pack", "--dry-run", "--json"], {
          cwd: checkout,
          env: {
            ...process.env,
            HOME: join(scratch, "home"),
            NPM_CONFIG_CACHE: join(scratch, "npm-cache"),
          },
          encoding: "utf8",
        });
        if (result.error) {
          assert.fail(
            "source npm pack --dry-run --json could not be run — is npm installed and on PATH?",
          );
        }
        assert.notEqual(result.status, 0, "source npm pack must fail");
        assert.match(
          result.stderr ?? "",
          /error: use node tests\/tools\/pack\.ts --out-dir <directory> to package this checkout/,
        );
      }
    },
  );
});

// --- port-only assertion (outside the 1:1 shell mapping) ----------------
// The published package declares zero runtime dependencies. Asserted as a
// count so that both an absent `dependencies` key and an empty object pass,
// and any added entry fails. This is about the ROOT manifest;
// tests/container/package.json has its own, different dependency contract
// asserted in container-contract.test.ts. See
// docs/superpowers/specs/2026-08-02-pr11.1-workflow-driver-migration-design.md
// section 3.7 — PR 11.1 added the first devDependency that is a library
// rather than a tool, and this is the guard that keeps it dev-only.
void test("package.json declares zero runtime dependencies", () => {
  const manifest = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
  const runtimeDependencies = Object.keys(manifest.dependencies ?? {});
  assert.deepEqual(
    runtimeDependencies,
    [],
    "package.json gained a runtime dependency — the manager ships with none by design",
  );
});

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Mirrors the six forbidden-path checks in the embedded Python at
 * `git show 0b6d50e1e9c688397285c6fa274dc8c9437d8ba3:tests/test_npm_pack_contents.sh:78-94::tuple`. Returns the name of the first
 * forbidden category a path matches, or `null` if it matches none.
 * Extracted as its own function (rather than inlined per-path assertions)
 * so both the real-pack check and the synthetic discriminating fixture
 * below exercise the exact same predicate.
 */
function forbiddenPathCategory(path: string): string | null {
  const parts = path.split("/");
  if (parts.includes("selection.json")) return "selection.json";
  if (parts.some((part) => part.startsWith("superpowers-manager.pin.")))
    return "pin-file";
  if (parts.includes(".git")) return ".git";
  if (parts.includes(".cache")) return ".cache";
  if (
    path.startsWith("plugins/superpowers/") &&
    path !== "plugins/superpowers/.codex-plugin/plugin.template.json"
  )
    return "plugins/superpowers/*";
  if (path === "docs/superpowers" || path.startsWith("docs/superpowers/"))
    return "docs/superpowers";
  return null;
}
