import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import type { TestContext } from "node:test";
import type { EffectiveSelection } from "../../../../src/effective-selection.ts";

export function nativeOpenCodeFixture(t: TestContext): string {
  const root = mkdtempSync(join(tmpdir(), "spw-opencode-package-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const [fixture, target] of [
    ["bootstrap.js.txt", ".opencode/plugins/superpowers.js"],
    ["package.json.txt", "package.json"],
    ["SKILL.md.txt", "skills/using-superpowers/SKILL.md"],
    ["LICENSE.txt", "LICENSE"],
  ]) {
    const destination = join(root, target);
    mkdirSync(dirname(destination), { recursive: true });
    copyFileSync(
      new URL(`../../../fixtures/opencode-native/${fixture}`, import.meta.url),
      destination,
    );
  }
  return root;
}

export function openCodeSelection(
  commit = "1".repeat(40),
  source = "https://github.com/obra/superpowers",
): EffectiveSelection {
  return {
    selectionOrigin: "package-default",
    selectionMode: "default",
    upstreamSourceOrigin: "package-default",
    effectiveSource: source,
    requestedRef: "future-ref",
    resolvedRef: "future-ref",
    desiredCommit: commit,
    resolutionKind: "ref",
    saved: {
      saved_mode: "none",
      saved_source: "",
      saved_requested_ref: "",
      saved_resolved_ref: "",
      saved_commit: "",
    },
  };
}
