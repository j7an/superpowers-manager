// Shared harness for src/commands/*.ts unit tests. Extracted from
// tests/unit/commands-unpin.test.js (PR 11.5 Task 6) so later command tests
// (e.g. track-latest, pin) do not redefine copies that could quietly drift
// from one another.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createSandbox,
  destroySandbox,
  runScenario,
} from "../../baseline/support.ts";

export {
  capture,
  notCalledAdapter,
  observingCoordinator,
} from "../../lib/command-doubles.ts";

// Await the callback before finally removes the fixture; returning its
// pending promise directly would delete the fixture while it is still in use.
/**
 * A package root with a packaged `config/upstream-ref` (for readConfigRef)
 * and an empty `config/` directory (for SUPERPOWERS_CONFIG_DIR) under a
 * shared scratch root.
 */
export async function withPackage<T>(
  fn: (root: string) => Promise<T>,
): Promise<T> {
  const root = mkdtempSync(join(tmpdir(), "spw-cmd-"));
  try {
    mkdirSync(join(root, "pkg", "config"), { recursive: true });
    writeFileSync(
      join(root, "pkg", "config", "upstream-ref"),
      "v6.1.1\n",
      "utf8",
    );
    mkdirSync(join(root, "config"), { recursive: true });
    return await fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// Await the callback before destroySandbox runs, just as withPackage waits
// before removing its fixture.
//
// `pin` (unlike unpin/track-latest) shells out to a real `git` to resolve its
// requested ref (src/upstream.ts's resolveExactTag/verifyRawCommit), so its
// tests need a real, reachable source rather than a stubbed one. Building it
// via tests/baseline/support.js's createSandbox/runScenario — the same
// machinery the baseline CLI-parity suite already uses for this exact
// scenario (tests/baseline/cli-parity.test.js's createReleaseRepo) — keeps
// this hermetic: the "upstream" is a local filesystem path, never a network
// URL, and the sandbox's own real `git` (linked from the host once, at
// sandbox-creation time) is what builds it.
/**
 * A real local git repository (tests/builders/baseline-scenario.sh's
 * `git-release-repo` scenario, which tags `v1.0.0`) plus a package root and
 * config dir suitable for a `runPin` call, all under one disposable sandbox.
 */
export async function withGitUpstream<T>(
  fn: (fixture: {
    pkgRoot: string;
    configDir: string;
    upstream: string;
    tagCommit: string;
  }) => Promise<T>,
): Promise<T> {
  const sandbox = createSandbox();
  try {
    const upstream = join(sandbox.root, "upstream");
    const built = runScenario(sandbox, "git-release-repo", upstream);
    assert.equal(
      built.status,
      0,
      `git-release-repo scenario failed: ${built.stderr}`,
    );
    const revList = spawnSync(
      join(sandbox.bin, "git"),
      ["-C", upstream, "rev-list", "-n", "1", "v1.0.0"],
      { encoding: "utf8", env: { PATH: sandbox.bin } },
    );
    assert.equal(
      revList.status,
      0,
      `cannot read back the v1.0.0 tag commit: ${revList.stderr}`,
    );
    const tagCommit = revList.stdout.trim();
    return await fn({
      pkgRoot: sandbox.pkg,
      configDir: sandbox.config,
      upstream,
      tagCommit,
    });
  } finally {
    destroySandbox(sandbox);
  }
}
