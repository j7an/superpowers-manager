// Package-content contract tests.
//
// Most cases invoke the shell wrapper, which delegates to the TypeScript
// checker; direct checker cases exercise allowlist decoding and line handling.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { expectedTarballPaths } from "../lib/pack-contents.ts";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const ASSERT_SCRIPT = join(ROOT, "tests", "assert_pack_contents.sh");
const ASSERT_CHECKER = join(ROOT, "tests", "tools", "assert-pack-contents.ts");

function makeExpectedPathsFixture(t: import("node:test").TestContext): string {
  const root = mkdtempSync(join(tmpdir(), "spw-expected-tarball-paths-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "src", "nested"), { recursive: true });
  writeFileSync(join(root, "src", "cli.ts"), "export {};\n");
  writeFileSync(join(root, "src", "nested", "tool.ts"), "export {};\n");
  writeFileSync(join(root, "src", "types.d.ts"), "export {};\n");
  writeFileSync(join(root, "outside-src.txt"), "unrelated\n");
  return root;
}

void test("expected tarball paths derive static and emitted files", (t) => {
  const root = makeExpectedPathsFixture(t);
  assert.deepEqual(
    expectedTarballPaths(root, "# static\r\n README.md \r\npackage.json\n"),
    ["README.md", "dist/cli.js", "dist/nested/tool.js", "package.json"],
  );
});

void test("expected tarball paths preserve duplicate allowlist entries", (t) => {
  const root = makeExpectedPathsFixture(t);
  assert.deepEqual(expectedTarballPaths(root, "README.md\nREADME.md\n"), [
    "README.md",
    "README.md",
    "dist/cli.js",
    "dist/nested/tool.js",
  ]);
});

void test("expected tarball paths reject a missing source directory", (t) => {
  const root = mkdtempSync(join(tmpdir(), "spw-expected-tarball-missing-src-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  assert.throws(() => expectedTarballPaths(root, "README.md\n"), {
    code: "ENOENT",
    message: /ENOENT/,
  });
});

function runSh(
  scriptPath: string,
  args: readonly string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
) {
  const result = spawnSync("sh", [scriptPath, ...args], {
    encoding: "utf8",
    cwd: options.cwd,
    env: options.env,
  });
  return {
    status: result.status,
    output: `${result.stdout ?? ""}${result.stderr ?? ""}`,
  };
}

function writeJson(jsonPath: string, value: unknown) {
  writeFileSync(jsonPath, JSON.stringify(value), "utf8");
}

function runChecker(args: readonly string[]) {
  const result = spawnSync(process.execPath, [ASSERT_CHECKER, ...args], {
    encoding: "utf8",
  });
  return {
    status: result.status,
    output: `${result.stdout ?? ""}${result.stderr ?? ""}`,
  };
}

function checkerReport(paths: readonly string[]) {
  const manifest = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
  return [
    {
      name: manifest.name,
      version: manifest.version,
      id: `${manifest.name}@${manifest.version}`,
      files: paths.map((path) => ({ path })),
    },
  ];
}

function makeCheckerPackageRoot(
  scratch: string,
  name: string,
  options: { source?: Record<string, string> } = {},
): string {
  const packageRoot = join(scratch, `boundary-package-${name}`);
  mkdirSync(packageRoot, { recursive: true });
  if (options.source !== undefined) {
    mkdirSync(join(packageRoot, "src"), { recursive: true });
    for (const [path, contents] of Object.entries(options.source)) {
      writeFileSync(join(packageRoot, "src", path), contents);
    }
  }
  copyFileSync(join(ROOT, "package.json"), join(packageRoot, "package.json"));
  return packageRoot;
}

void test("package source missing is rejected", (t) => {
  const scratch = mkdtempSync(join(tmpdir(), "spw-pack-source-missing-"));
  t.after(() => rmSync(scratch, { recursive: true, force: true }));
  const packageRoot = makeCheckerPackageRoot(scratch, "missing");
  const reportPath = join(scratch, "report.json");
  const expectedPath = join(scratch, "expected.txt");
  writeJson(reportPath, checkerReport(["README.md"]));
  writeFileSync(expectedPath, "README.md\n");

  const result = runChecker([
    reportPath,
    join(packageRoot, "package.json"),
    expectedPath,
  ]);
  assert.notEqual(result.status, 0);
  assert.match(result.output, /cannot discover package source files/);
  assert.doesNotMatch(result.output, /ENOENT|Error:|at \S+ \(/);
});

void test("missing derived output is rejected", (t) => {
  const scratch = mkdtempSync(join(tmpdir(), "spw-pack-derived-missing-"));
  t.after(() => rmSync(scratch, { recursive: true, force: true }));
  const packageRoot = makeCheckerPackageRoot(scratch, "missing-derived", {
    source: { "cli.ts": "export {};\n" },
  });
  const reportPath = join(scratch, "report.json");
  const expectedPath = join(scratch, "expected.txt");
  writeJson(reportPath, checkerReport(["README.md"]));
  writeFileSync(expectedPath, "README.md\n");

  const result = runChecker([
    reportPath,
    join(packageRoot, "package.json"),
    expectedPath,
  ]);
  assert.notEqual(result.status, 0);
  assert.match(result.output, /missing from tarball:\s+dist\/cli\.js/);
});

void test("extra emitted file is rejected", (t) => {
  const scratch = mkdtempSync(join(tmpdir(), "spw-pack-derived-extra-"));
  t.after(() => rmSync(scratch, { recursive: true, force: true }));
  const packageRoot = makeCheckerPackageRoot(scratch, "extra-derived", {
    source: { "cli.ts": "export {};\n" },
  });
  const reportPath = join(scratch, "report.json");
  const expectedPath = join(scratch, "expected.txt");
  writeJson(
    reportPath,
    checkerReport(["README.md", "dist/cli.js", "dist/stale.js"]),
  );
  writeFileSync(expectedPath, "README.md\n");

  const result = runChecker([
    reportPath,
    join(packageRoot, "package.json"),
    expectedPath,
  ]);
  assert.notEqual(result.status, 0);
  assert.match(result.output, /unexpected in tarball:\s+dist\/stale\.js/);
});

/**
 * Produces the explicit native packer's real npm report for this repo, plus
 * the same report's single packed entry pulled out of npm's one-element
 * array shape.
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
  // Name what broke without letting
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
  assert.ok(Array.isArray(report), "manager pack output must be an array");
  assert.equal(
    report.length,
    1,
    "manager pack output must contain one artifact",
  );
  assert.ok(report[0] !== null && typeof report[0] === "object");
  const packed = report[0];
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
  const expectedFiles = expectedTarballPaths(
    ROOT,
    readFileSync(join(ROOT, "tests", "expected_tarball_contents.txt"), "utf8"),
  );
  assert.deepEqual(
    actualFiles,
    expectedFiles,
    "delivered tarball contents must match source-derived output and the maintained allowlist",
  );
  return { rawPath, packed };
}

void test("npm-pack-contents", async (t) => {
  const scratch = mkdtempSync(join(tmpdir(), "spw-pack-"));
  t.after(() => rmSync(scratch, { recursive: true, force: true }));

  const { rawPath, packed } = packRealReport(scratch);

  // --- the real report validates end-to-end ----------------------------

  await t.test(
    "the real explicit pack report is accepted (name, version, id, and tarball contents all match)",
    () => {
      const { status, output } = runSh(ASSERT_SCRIPT, [rawPath]);
      assert.equal(status, 0, output);
      const paths = new Set(
        (packed.files as { path: string }[]).map((entry) => entry.path),
      );
      assert.equal(paths.has("dist/harnesses/opencode/config.js"), true);
      assert.equal(
        paths.has("node_modules/jsonc-parser/lib/umd/main.js"),
        true,
      );
    },
  );

  // --- alternate accepted shapes ---------------------------------------

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

  await t.test(
    "the shell entry point succeeds without python3 and from an unrelated directory",
    () => {
      const noPythonBin = join(scratch, "no-python-bin");
      mkdirSync(noPythonBin);
      symlinkSync("/bin/sh", join(noPythonBin, "sh"));
      symlinkSync(process.execPath, join(noPythonBin, "node"));
      symlinkSync("/usr/bin/dirname", join(noPythonBin, "dirname"));
      const path = noPythonBin;
      const noPython = spawnSync("/bin/sh", ["-c", "command -v python3"], {
        encoding: "utf8",
        env: { ...process.env, PATH: path },
      });
      assert.notEqual(
        noPython.status,
        0,
        "fixture: python3 unexpectedly remains on the wrapper PATH",
      );
      const { status, output } = runSh(ASSERT_SCRIPT, [rawPath], {
        cwd: scratch,
        env: { ...process.env, PATH: path },
      });
      assert.equal(status, 0, output);
    },
  );

  // --- malformed shapes are rejected -----------------------------------

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
    "malformedShapes lost or gained a case; review the malformed shape contract",
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

  await t.test("a malformed files entry is rejected", () => {
    const fixturePath = join(scratch, "files-entry-not-a-path.json");
    writeJson(fixturePath, [{ ...packed, files: [{ path: 1 }] }]);
    const { status, output } = runSh(ASSERT_SCRIPT, [fixturePath]);
    assert.notEqual(status, 0);
    assert.match(
      output,
      /pack report files must be an array of objects with string paths/,
    );
  });

  await t.test("a duplicated packed path is rejected", () => {
    const fixturePath = join(scratch, "duplicate-path.json");
    const duplicated = structuredClone(packed) as {
      files: { path: string }[];
    };
    duplicated.files.push({ ...duplicated.files[0] });
    writeJson(fixturePath, [duplicated]);
    assert.notEqual(runSh(ASSERT_SCRIPT, [fixturePath]).status, 0);
  });

  await t.test("an invalid UTF-8 expected allowlist is rejected", () => {
    const reportPath = join(scratch, "replacement-character-report.json");
    const expectedPath = join(scratch, "invalid-expected-contents.txt");
    const packageRoot = makeCheckerPackageRoot(scratch, "invalid-utf8", {
      source: {},
    });
    writeJson(reportPath, [{ ...packed, files: [{ path: "\ufffd" }] }]);
    writeFileSync(expectedPath, Buffer.from([0xff]));
    const { status, output } = runChecker([
      reportPath,
      join(packageRoot, "package.json"),
      expectedPath,
    ]);
    assert.notEqual(status, 0);
    assert.match(output, new RegExp(escapeRegExp(expectedPath)));
  });

  for (const [name, expectedText, path] of [
    ["LF", "first\nsecond\n", ["first", "second"]],
    ["CRLF", "first\r\nsecond\r\n", ["first", "second"]],
    ["CR", "first\rsecond\r", ["first", "second"]],
    ["U+2028", "first\u2028second\n", ["first\u2028second"]],
    ["padded", "  first\t\n", ["first"]],
    ["BOM-at-edge", "\ufefffirst\n", ["first"]],
  ] as const) {
    await t.test(
      `expected allowlist preserves ${name} text-file boundaries`,
      () => {
        const reportPath = join(scratch, `expected-boundary-${name}.json`);
        const expectedPath = join(scratch, `expected-boundary-${name}.txt`);
        const packageRoot = makeCheckerPackageRoot(
          scratch,
          `boundary-${name}`,
          {
            source: {},
          },
        );
        writeJson(reportPath, [
          { ...packed, files: path.map((path) => ({ path })) },
        ]);
        writeFileSync(expectedPath, expectedText, "utf8");
        const { status, output } = runChecker([
          reportPath,
          join(packageRoot, "package.json"),
          expectedPath,
        ]);
        assert.equal(status, 0, output);
      },
    );
  }

  // --- forbidden packed paths -------------------------------------------

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
  // `startsWith`, or a missing `parts` split). This synthetic fixture makes
  // each category's predicate independently falsifiable.
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
    "FORBIDDEN_PATH_FIXTURES lost or gained a case; review the forbidden path contract",
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

  // --- identity tampering is rejected -----------------------------------

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

  // --- unconditional source prepack guard -------------------------------

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

// The published package declares only its two approved bundled parsers as
// runtime dependencies. This is about the ROOT manifest;
// tests/container/package.json has its own, different dependency contract
// asserted in container-contract.test.ts. This keeps unrelated libraries out
// of runtime.
void test("package.json declares exactly the approved bundled parsers at runtime", () => {
  const manifest = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
  const runtimeDependencies = Object.keys(manifest.dependencies ?? {});
  assert.deepEqual(
    runtimeDependencies,
    ["jsonc-parser", "smol-toml"],
    "package.json runtime dependencies must remain limited to the approved parsers",
  );
  assert.deepEqual(
    new Set(manifest.bundleDependencies ?? []),
    new Set(["jsonc-parser", "smol-toml"]),
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
