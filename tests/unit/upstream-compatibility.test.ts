import assert from "node:assert/strict";
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { digestArtifactTree } from "../../src/artifact-tree.ts";
import { assessPiCompatibility } from "../../src/harnesses/pi/compatibility.ts";
import { assessCodexCompatibility } from "../../src/harnesses/codex/compatibility.ts";
import { activationBlock } from "../../src/harness-compatibility.ts";
import {
  prepareCodexCandidate,
  inspectCodexPrepared,
  readCodexPrepared,
} from "../../src/harnesses/codex/prepare.ts";
import {
  changePackage,
  nativeFixture,
  nativeSelection,
} from "../lib/pi-package-fixture.ts";

void test("qualified Pi bytes admit exactly the official aliases and require opt-in for custom sources", async (t) => {
  const root = nativeFixture(t);
  for (const source of [
    "https://github.com/obra/superpowers",
    "https://github.com/obra/superpowers.git",
    "ssh://git@github.com/obra/superpowers.git",
    "git@github.com:obra/superpowers.git",
  ]) {
    assert.equal(
      (await assessPiCompatibility(root, nativeSelection(undefined, source)))
        .kind,
      "supported",
    );
  }
  for (const source of [
    "github.com/obra/superpowers",
    "/local/superpowers",
    "https://github.com/Obra/superpowers",
    "https://example.invalid/upstream",
  ]) {
    const result = await assessPiCompatibility(
      root,
      nativeSelection(undefined, source),
    );
    assert.equal(result.kind, "experimental");
    assert.match(
      activationBlock(result, false)!,
      /requires --allow-experimental/,
    );
    assert.equal(activationBlock(result, true), null);
  }
});

void test("Pi rejects unknown mechanics even when version and ref look official", async (t) => {
  const cases: Record<string, (root: string) => void> = {
    "missing package": (root) => rmSync(join(root, "package.json")),
    "malformed package": (root) =>
      writeFileSync(join(root, "package.json"), "{"),
    "one byte bootstrap drift": (root) => {
      const path = join(root, ".pi/extensions/superpowers.ts");
      const bytes = readFileSync(path);
      bytes[0] = 88;
      writeFileSync(path, bytes);
    },
    "executable bootstrap": (root) =>
      chmodSync(join(root, ".pi/extensions/superpowers.ts"), 0o755),
    "missing skill": (root) =>
      rmSync(join(root, "skills/using-superpowers/SKILL.md")),
    "escaping resource chain": (root) => {
      const path = join(root, "skills/using-superpowers/SKILL.md");
      rmSync(path);
      symlinkSync("/etc/hosts", path);
    },
  };
  for (const [name, mutate] of Object.entries(cases))
    await t.test(name, async (t) => {
      const root = nativeFixture(t);
      mutate(root);
      const selection = {
        ...nativeSelection(),
        requestedRef: "v6.3.0",
      };
      const result = await assessPiCompatibility(root, selection);
      assert.equal(result.kind, "unsupported");
      assert.notEqual(activationBlock(result, true), null);
    });
  const metadataCases: [string, unknown][] = [
    ["name", "other"],
    ["type", "commonjs"],
    ["version", "01.2.3"],
    [
      "pi",
      {
        extensions: ["./.pi/extensions/superpowers.ts", "./evil.ts"],
        skills: ["./skills"],
      },
    ],
    [
      "pi",
      {
        extensions: ["./.pi/extensions/superpowers.ts"],
        skills: ["./skills"],
        prompts: [],
      },
    ],
    ...[
      "dependencies",
      "optionalDependencies",
      "peerDependencies",
      "bundleDependencies",
      "bundledDependencies",
    ].map((key): [string, unknown] => [key, { evil: "*" }]),
  ];
  for (const [field, value] of metadataCases)
    await t.test(field, async (t) => {
      const root = nativeFixture(t);
      const valueBefore = JSON.parse(
        readFileSync(join(root, "package.json"), "utf8"),
      );
      changePackage(root, { ...valueBefore, [field]: value });
      assert.equal(
        (await assessPiCompatibility(root, nativeSelection())).kind,
        "unsupported",
      );
    });
});

void test("Codex native fallback requires a valid bootstrap skill and rejects custom bootstrap CLI remnants", async (t) => {
  const root = nativeFixture(t);
  assert.equal(
    (await assessCodexCompatibility(root, nativeSelection())).kind,
    "supported",
  );
  mkdirSync(join(root, ".codex"));
  copyFileSync(
    new URL("../fixtures/pi-native/codex-legacy-cli.txt", import.meta.url),
    join(root, ".codex/superpowers-codex"),
  );
  assert.equal(
    (await assessCodexCompatibility(root, nativeSelection())).kind,
    "unsupported",
  );
  rmSync(join(root, ".codex"), { recursive: true });
  writeFileSync(join(root, "skills/using-superpowers/SKILL.md"), "invalid");
  assert.equal(
    (await assessCodexCompatibility(root, nativeSelection())).kind,
    "unsupported",
  );
});

void test("historical native Codex manifest modes retain qualified hook packaging", async (t) => {
  for (const mode of ["default", "active", "empty"])
    await t.test(mode, async (t) => {
      const root = nativeFixture(t);
      copyFileSync(
        new URL(
          "../fixtures/pi-native/codex-native-skill.txt",
          import.meta.url,
        ),
        join(root, "skills/using-superpowers/SKILL.md"),
      );
      mkdirSync(join(root, ".codex-plugin"));
      copyFileSync(
        new URL(
          `../fixtures/pi-native/codex-${mode}-manifest.json.txt`,
          import.meta.url,
        ),
        join(root, ".codex-plugin/plugin.json"),
      );
      mkdirSync(join(root, "hooks"));
      writeFileSync(
        join(
          root,
          "hooks",
          mode === "active" ? "hooks-codex.json" : "hooks.json",
        ),
        JSON.stringify({ hooks: {} }),
      );
      assert.equal(
        (await assessCodexCompatibility(root, nativeSelection())).kind,
        "supported",
      );
      const manifestPath = join(root, ".codex-plugin/plugin.json");
      const upstreamManifest = JSON.parse(readFileSync(manifestPath, "utf8"));
      writeFileSync(
        manifestPath,
        JSON.stringify({ ...upstreamManifest, skills: "./wrong-skills/" }),
      );
      assert.equal(
        (await assessCodexCompatibility(root, nativeSelection())).kind,
        "supported",
      );
      if (mode === "active") {
        rmSync(join(root, "hooks/hooks-codex.json"));
        assert.equal(
          (await assessCodexCompatibility(root, nativeSelection())).kind,
          "unsupported",
        );
      }
    });
});

void test("Codex prepared qualification binds provenance, resources and current assessment rules", async (t) => {
  const root = nativeFixture(t);
  for (const name of ["README.md", "CODE_OF_CONDUCT.md"])
    writeFileSync(join(root, name), name);
  const candidateRoot = join(root, "plugins/superpowers");
  mkdirSync(join(root, ".codex-plugin"));
  writeFileSync(
    join(root, ".codex-plugin/plugin.json"),
    JSON.stringify({
      name: "superpowers",
      description: "fixture",
      version: "6.3.0",
      skills: "./skills/",
      hooks: {},
    }),
  );
  const selection = nativeSelection();
  const template = join(root, "template.json");
  writeFileSync(
    template,
    JSON.stringify({
      name: "superpowers",
      version: "1.0.0",
      skills: "./skills/",
    }),
  );
  const built = await prepareCodexCandidate(
    { upstreamRoot: root, workspaceRoot: root, candidateRoot, selection },
    { root, env: { SUPERPOWERS_MANIFEST_TEMPLATE: template } },
  );
  assert.equal(
    built.outcome.ok && built.outcome.result.compatibility.kind,
    "supported",
    JSON.stringify(built),
  );
  const state = await inspectCodexPrepared(selection, { root });
  assert.equal(state.outcome.ok && state.outcome.result.kind, "current");
  const overrideCtx = {
    root: join(root, "different-manager-root"),
    env: { SUPERPOWERS_PLUGIN_ROOT: candidateRoot },
  };
  assert.equal((await readCodexPrepared(overrideCtx)).outcome.ok, true);
  const overridden = await inspectCodexPrepared(selection, overrideCtx);
  assert.equal(
    overridden.outcome.ok && overridden.outcome.result.observedIdentity,
    selection.desiredCommit,
  );
  const receiptPath = join(candidateRoot, ".superpowers-manager.json");
  const receipt = readFileSync(receiptPath, "utf8");
  writeFileSync(
    receiptPath,
    JSON.stringify({ ...JSON.parse(receipt), generation: "invented" }),
  );
  assert.equal((await readCodexPrepared({ root })).outcome.ok, false);
  const invalidReceipt = await inspectCodexPrepared(selection, { root });
  assert.equal(invalidReceipt.outcome.ok, false);
  if (invalidReceipt.outcome.ok)
    assert.fail("expected invalid receipt failure");
  assert.deepEqual(invalidReceipt.outcome.error, {
    code: "invalid-assessment",
    message: `cannot inspect Codex prepared artifact: ${candidateRoot}`,
    hints: [],
  });
  writeFileSync(receiptPath, receipt);
  const metadataPath = join(candidateRoot, ".superpowers-upstream.json"),
    metadata = readFileSync(metadataPath, "utf8");
  for (const key of ["source", "commit"]) {
    writeFileSync(
      metadataPath,
      JSON.stringify({
        ...JSON.parse(metadata),
        [key]: key === "commit" ? "2".repeat(40) : "https://other.invalid/repo",
      }),
    );
    assert.equal((await readCodexPrepared({ root })).outcome.ok, false);
    assert.equal(
      (await inspectCodexPrepared(selection, { root })).outcome.ok,
      false,
    );
  }
  writeFileSync(metadataPath, metadata);
  const skillPath = join(candidateRoot, "skills/using-superpowers/SKILL.md"),
    skill = readFileSync(skillPath);
  writeFileSync(skillPath, "invalid");
  assert.equal((await readCodexPrepared({ root })).outcome.ok, false);
  assert.equal(
    (await inspectCodexPrepared(selection, { root })).outcome.ok,
    false,
  );

  writeFileSync(skillPath, skill);
  mkdirSync(join(candidateRoot, ".codex"));
  writeFileSync(join(candidateRoot, ".codex/superpowers-codex"), "legacy");
  const unsupportedReceipt = {
    ...JSON.parse(receipt),
    digest: await digestArtifactTree(candidateRoot),
  };
  writeFileSync(receiptPath, JSON.stringify(unsupportedReceipt));
  const unsupported = await inspectCodexPrepared(selection, { root });
  assert.equal(unsupported.status, 0);
  assert.equal(unsupported.outcome.ok, true);
  if (!unsupported.outcome.ok) assert.fail("expected unsupported inspection");
  assert.deepEqual(unsupported.outcome.result, {
    kind: "needs-prepare",
    observedIdentity: selection.desiredCommit,
    compatibility: {
      kind: "unsupported",
      reason: `Codex package does not provide compatible native skill discovery: ${candidateRoot}`,
    },
  });
  const mismatch = await inspectCodexPrepared(
    {
      ...selection,
      effectiveSource: "https://other.invalid/superpowers",
      desiredCommit: "3".repeat(40),
    },
    { root },
  );
  assert.equal(mismatch.outcome.ok, true);
  if (!mismatch.outcome.ok) assert.fail("expected mismatched inspection");
  assert.equal(mismatch.outcome.result.kind, "needs-prepare");
  assert.equal(mismatch.outcome.result.compatibility.kind, "unknown");
  assert.equal((await readCodexPrepared({ root })).outcome.ok, false);
});
