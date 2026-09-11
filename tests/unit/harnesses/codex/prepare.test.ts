import assert from "node:assert/strict";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import {
  codexPreparationLocation,
  inspectCodexPrepared,
  prepareCodexCandidate,
  readCodexPrepared,
  validateCodexPreparationBeforeFetch,
} from "../../../../src/harnesses/codex/prepare.ts";
import { codexPaths } from "../../../../src/harnesses/codex/paths.ts";
import type { EffectiveSelection } from "../../../../src/effective-selection.ts";

const COMMIT = "1".repeat(40);

function effectiveSelection(): EffectiveSelection {
  return {
    selectionOrigin: "package-default",
    selectionMode: "default",
    upstreamSourceOrigin: "package-default",
    effectiveSource: "https://example.invalid/superpowers.git",
    requestedRef: "v1.0.0",
    resolvedRef: "v1.0.0",
    desiredCommit: COMMIT,
    resolutionKind: "tag",
    saved: {
      saved_mode: "none",
      saved_source: "",
      saved_requested_ref: "",
      saved_resolved_ref: "",
      saved_commit: "",
    },
  };
}

function candidateFixture(t: test.TestContext, manifest: string) {
  const root = mkdtempSync(join(tmpdir(), "spw-codex-prepare-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const upstreamRoot = join(root, "upstream");
  const candidateRoot = join(root, "workspace", "superpowers");
  mkdirSync(join(upstreamRoot, "skills"), { recursive: true });
  for (const name of ["LICENSE", "README.md", "CODE_OF_CONDUCT.md"]) {
    writeFileSync(join(upstreamRoot, name), `${name}\n`);
  }
  mkdirSync(join(upstreamRoot, ".codex-plugin"), { recursive: true });
  writeFileSync(join(upstreamRoot, ".codex-plugin", "plugin.json"), manifest);
  return { root, upstreamRoot, candidateRoot };
}

void test("preparation location resolves a relative override from the invocation cwd", () => {
  const location = codexPreparationLocation({
    root: "/package-root",
    env: { SUPERPOWERS_PLUGIN_ROOT: "relative/plugin-root" },
  });
  assert.deepEqual(location, {
    destinationRoot: resolve(process.cwd(), "relative/plugin-root"),
    stagingLeaf: "superpowers",
  });
});

void test("preparation defaults to the durable Codex prepared root", () => {
  const env = { CODEX_HOME: "/fixture/codex-home" };
  assert.deepEqual(codexPreparationLocation({ root: "/package-root", env }), {
    destinationRoot: codexPaths(env, process.cwd()).preparedRoot,
    stagingLeaf: "superpowers",
  });
});

void test("prefetch validation blocks malformed unresolved recovery before external access", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "spw-codex-prepare-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const codexHome = join(root, "codex-home");
  const paths = codexPaths({ CODEX_HOME: codexHome }, process.cwd());
  const template = join(root, "template.json");
  writeFileSync(template, "{}\n");
  mkdirSync(paths.recoveryRoot, { recursive: true });
  writeFileSync(join(paths.recoveryRoot, "transaction.json"), "{\n");
  const result = await validateCodexPreparationBeforeFetch({
    root,
    env: {
      CODEX_HOME: codexHome,
      SUPERPOWERS_MANIFEST_TEMPLATE: template,
    },
  });
  assert.equal(result.outcome.ok, false);
  if (result.outcome.ok) assert.fail("expected recovery refusal");
  assert.equal(result.outcome.error.code, "recovery-required");
  assert.equal(
    result.outcome.error.message,
    `cannot inspect Codex recovery state at ${paths.recoveryRoot}`,
  );
});

void test("prefetch validation distinguishes unsafe protected storage from preparation overlap", async (t) => {
  const cases = [
    {
      name: "recovery symlink",
      root: "recovery" as const,
      kind: "symlink" as const,
      code: "recovery-required",
    },
    {
      name: "recovery regular file",
      root: "recovery" as const,
      kind: "regular-file" as const,
      code: "recovery-required",
    },
    {
      name: "marketplace symlink",
      root: "marketplace" as const,
      kind: "symlink" as const,
      code: "prepare-failed",
    },
    {
      name: "marketplace regular file",
      root: "marketplace" as const,
      kind: "regular-file" as const,
      code: "prepare-failed",
    },
  ];

  for (const item of cases) {
    await t.test(item.name, async (t) => {
      const root = mkdtempSync(join(tmpdir(), "spw-codex-prepare-"));
      t.after(() => rmSync(root, { recursive: true, force: true }));
      const codexHome = join(root, "codex-home");
      const paths = codexPaths({ CODEX_HOME: codexHome }, process.cwd());
      const unsafeRoot =
        item.root === "recovery" ? paths.recoveryRoot : paths.marketplaceRoot;
      const template = join(root, "template.json");
      mkdirSync(paths.managerRoot, { recursive: true });
      writeFileSync(template, "{}\n");
      if (item.kind === "symlink") {
        symlinkSync(paths.preparedRoot, unsafeRoot);
      } else {
        writeFileSync(unsafeRoot, "preserve\n");
      }

      const result = await validateCodexPreparationBeforeFetch({
        root,
        env: {
          CODEX_HOME: codexHome,
          SUPERPOWERS_MANIFEST_TEMPLATE: template,
        },
      });

      assert.equal(result.outcome.ok, false);
      if (result.outcome.ok) assert.fail("expected unsafe storage refusal");
      assert.equal(result.outcome.error.code, item.code);
      assert.equal(
        result.outcome.error.message,
        item.root === "recovery"
          ? `cannot inspect Codex recovery state at ${paths.recoveryRoot}`
          : `cannot inspect Codex marketplace storage at ${paths.marketplaceRoot}`,
      );
      assert.equal(
        item.kind === "symlink"
          ? lstatSync(unsafeRoot).isSymbolicLink()
          : lstatSync(unsafeRoot).isFile(),
        true,
      );
      if (item.kind === "symlink") {
        assert.equal(existsSync(paths.preparedRoot), false);
      }
      if (item.root === "marketplace") {
        assert.equal(existsSync(paths.recoveryRoot), false);
      }
    });
  }
});

void test("prefetch validation rejects a directory template", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "spw-codex-prepare-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const template = join(root, "template");
  mkdirSync(template);
  const result = await validateCodexPreparationBeforeFetch({
    root,
    env: {
      HOME: root,
      SUPERPOWERS_MANIFEST_TEMPLATE: template,
      SUPERPOWERS_PLUGIN_ROOT: join(root, "plugins", "superpowers"),
    },
  });
  assert.equal(result.outcome.ok, false);
  if (result.outcome.ok) assert.fail("expected template rejection");
  assert.equal(
    result.outcome.error.message,
    `missing fallback manifest template: ${template}`,
  );
});

void test("candidate preparation returns controlled reader failures as typed outcomes", async (t) => {
  const fixture = candidateFixture(t, "{");
  const manifest = join(fixture.upstreamRoot, ".codex-plugin", "plugin.json");

  const result = await prepareCodexCandidate(
    {
      upstreamRoot: fixture.upstreamRoot,
      workspaceRoot: join(fixture.root, "workspace"),
      candidateRoot: fixture.candidateRoot,
      selection: effectiveSelection(),
    },
    { root: fixture.root },
  );

  assert.equal(result.status, 1);
  assert.equal(result.outcome.ok, false);
  if (result.outcome.ok) assert.fail("expected candidate preparation failure");
  assert.deepEqual(result.outcome.error, {
    code: "prepare-failed",
    message: `invalid manifest JSON in ${manifest}`,
    hints: [],
  });
  assert.deepEqual(result.outcome.messages, []);
});

void test("status inspection treats malformed generated provenance as needing prepare", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "spw-codex-prepare-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const pluginRoot = join(root, "plugins", "superpowers");
  mkdirSync(pluginRoot, { recursive: true });
  writeFileSync(join(pluginRoot, ".superpowers-upstream.json"), "{");

  const result = await inspectCodexPrepared(effectiveSelection(), {
    root,
    env: { SUPERPOWERS_PLUGIN_ROOT: pluginRoot },
  });

  assert.equal(result.status, 0);
  assert.equal(result.outcome.ok, true);
  if (!result.outcome.ok) assert.fail("expected status inspection success");
  assert.deepEqual(result.outcome.result, {
    kind: "needs-prepare",
    observedIdentity: "",
    compatibility: {
      kind: "unknown",
      reason: "Codex compatibility assessment is not available",
    },
  });
});

void test("strict prepared read rejects malformed generated provenance", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "spw-codex-prepare-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const pluginRoot = join(root, "plugins", "superpowers");
  mkdirSync(pluginRoot, { recursive: true });
  writeFileSync(join(pluginRoot, ".superpowers-upstream.json"), "{");

  const result = await readCodexPrepared({
    root,
    env: { SUPERPOWERS_PLUGIN_ROOT: pluginRoot },
  });

  assert.equal(result.outcome.ok, false);
  if (result.outcome.ok) assert.fail("expected strict provenance rejection");
  assert.equal(
    result.outcome.error.message,
    "generated metadata missing desired commit after prepare",
  );
});

console.log("codex-prepare.test.js: OK");
