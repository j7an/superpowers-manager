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

export { capture, notCalledAdapter } from "../../lib/command-doubles.ts";

// async + `return await` for the same reason as withConfigDir below: a bare
// `return fn(root)` hands back a pending promise, and the `finally` block's
// rmSync then deletes the fixture before the callback has actually read it.
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

// MUST be async with `return await`. A synchronous `return fn(...)` hands back
// a pending promise and `finally` then runs rmSync immediately, deleting the
// fixture before the callback has read it. Matches
// tests/unit/effective-selection.test.js's withConfigDir.
/**
 * A bare SUPERPOWERS_CONFIG_DIR, optionally pre-seeded with a
 * `selection.json`, with no packaged root alongside it.
 */
export async function withConfigDir<T>(
  contents: string | null,
  fn: (env: NodeJS.ProcessEnv) => Promise<T>,
): Promise<T> {
  const root = mkdtempSync(join(tmpdir(), "spw-cmd-cfg-"));
  try {
    const dir = join(root, "config");
    mkdirSync(dir, { recursive: true });
    if (contents !== null) {
      writeFileSync(join(dir, "selection.json"), contents, "utf8");
    }
    return await fn({ SUPERPOWERS_CONFIG_DIR: dir });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// MUST be async with `return await`, for the same reason as withPackage and
// withConfigDir above: a synchronous `return fn(...)` would let destroySandbox
// run before the callback has actually read the sandbox.
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
