import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { TestContext } from "node:test";
import type { EffectiveSelection } from "../../../../src/effective-selection.ts";

export function nativeFixture(t: TestContext): string {
  const root = mkdtempSync(join(tmpdir(), "spw-native-package-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const [fixture, target] of [
    ["bootstrap.ts.txt", ".pi/extensions/superpowers.ts"],
    ["package.json.txt", "package.json"],
    ["SKILL.md.txt", "skills/using-superpowers/SKILL.md"],
    ["LICENSE.txt", "LICENSE"],
  ]) {
    const destination = join(root, target!);
    mkdirSync(dirname(destination), { recursive: true });
    copyFileSync(
      new URL(`../../../fixtures/pi-native/${fixture}`, import.meta.url),
      destination,
    );
  }
  return root;
}

export function fixtureGit(root: string, ...args: string[]): string {
  return execFileSync(
    "git",
    [
      "-c",
      "user.name=fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "-c",
      "core.hooksPath=/dev/null",
      "-c",
      "init.templateDir=",
      ...args,
    ],
    {
      cwd: root,
      encoding: "utf8",
      env: {
        ...process.env,
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_NOSYSTEM: "1",
      },
    },
  ).trim();
}

export function commitFixture(root: string): string {
  fixtureGit(root, "init", "-q");
  fixtureGit(root, "add", ".");
  fixtureGit(root, "commit", "-qm", "fixture");
  return fixtureGit(root, "rev-parse", "HEAD");
}

export function nativeSelection(
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

export function changePackage(root: string, value: unknown): void {
  writeFileSync(join(root, "package.json"), JSON.stringify(value));
}
