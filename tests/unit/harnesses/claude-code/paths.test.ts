import { scratch } from "../../../lib/scratch.ts";
import assert from "node:assert/strict";
import { mkdirSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import {
  assertClaudeCodeStorageSafe,
  claudeCodePaths,
} from "../../../../src/harnesses/claude-code/paths.ts";

void test("CLAUDE_CONFIG_DIR wins over HOME and owns the manager tree", () => {
  const paths = claudeCodePaths(
    { HOME: "/home/user", CLAUDE_CONFIG_DIR: "relative-config" },
    "/work",
  );
  assert.equal(paths.configRoot, "/work/relative-config");
  assert.equal(
    paths.pluginRoot,
    "/work/relative-config/superpowers-manager/marketplace/plugins/superpowers",
  );
  assert.equal(
    paths.marketplaceManifest,
    "/work/relative-config/superpowers-manager/marketplace/.claude-plugin/marketplace.json",
  );
  assert.equal(
    claudeCodePaths({ HOME: "/home/user" }, "/work").configRoot,
    "/home/user/.claude",
  );
});

void test("storage safety refuses a symlinked manager root", async (t) => {
  const root = scratch(t, "spw-claude-code-paths-");
  const paths = claudeCodePaths(
    { CLAUDE_CONFIG_DIR: join(root, "claude") },
    root,
  );
  mkdirSync(paths.configRoot, { recursive: true });
  mkdirSync(join(root, "elsewhere"));
  symlinkSync(join(root, "elsewhere"), paths.managerRoot);
  await assert.rejects(
    assertClaudeCodeStorageSafe(paths),
    /disallowed type symlink/,
  );
});
