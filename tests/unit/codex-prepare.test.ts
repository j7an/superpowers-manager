import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import {
  codexPreparationLocation,
  inspectCodexPrepared,
  readCodexPrepared,
  validateCodexPreparationBeforeFetch,
} from "../../src/codex-prepare.ts";
import type { EffectiveSelection } from "../../src/effective-selection.ts";

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

void test("prefetch validation rejects a directory template", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "spw-codex-prepare-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const template = join(root, "template");
  mkdirSync(template);
  const result = await validateCodexPreparationBeforeFetch({
    root,
    env: { SUPERPOWERS_MANIFEST_TEMPLATE: template },
  });
  assert.equal(result.outcome.ok, false);
  if (result.outcome.ok) assert.fail("expected template rejection");
  assert.equal(
    result.outcome.error.message,
    `missing fallback manifest template: ${template}`,
  );
});

void test("status inspection treats malformed generated provenance as needing prepare", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "spw-codex-prepare-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const pluginRoot = join(root, "plugins", "superpowers");
  mkdirSync(pluginRoot, { recursive: true });
  writeFileSync(join(pluginRoot, ".superpowers-upstream.json"), "{");

  const result = await inspectCodexPrepared(effectiveSelection(), { root });

  assert.equal(result.status, 0);
  assert.equal(result.outcome.ok, true);
  if (!result.outcome.ok) assert.fail("expected status inspection success");
  assert.deepEqual(result.outcome.result, {
    kind: "needs-prepare",
    observedIdentity: "",
  });
});

void test("strict prepared read rejects malformed generated provenance", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "spw-codex-prepare-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const pluginRoot = join(root, "plugins", "superpowers");
  mkdirSync(pluginRoot, { recursive: true });
  writeFileSync(join(pluginRoot, ".superpowers-upstream.json"), "{");

  const result = await readCodexPrepared({ root });

  assert.equal(result.outcome.ok, false);
  if (result.outcome.ok) assert.fail("expected strict provenance rejection");
  assert.equal(
    result.outcome.error.message,
    "generated metadata missing desired commit after prepare",
  );
});

console.log("codex-prepare.test.js: OK");
