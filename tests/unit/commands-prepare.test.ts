// Unit coverage for src/commands/prepare.ts's local helpers and diagnostic
// shapes. End-to-end coverage lives in tests/baseline/prepare.test.js.
import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  capture,
  notCalledAdapter,
  observingCoordinator,
} from "./helpers/command-harness.ts";
import { scratch } from "../lib/scratch.ts";

import type { CommandContext } from "../../src/commands/context.ts";
import { runInstall } from "../../src/commands/install.ts";
import { runPrepare } from "../../src/commands/prepare.ts";
import { runUpdate } from "../../src/commands/update.ts";
import type { CodexRemovalInput } from "../../src/harnesses/codex/adapter.ts";
import { readUpstreamManifestVersion } from "../../src/harnesses/codex/prepare.ts";
import { codexHarness } from "../../src/harnesses/codex/harness.ts";
import { openCodeHarness } from "../../src/harnesses/opencode/harness.ts";
import { openCodePaths } from "../../src/harnesses/opencode/paths.ts";
import { createResourceCoordinator } from "../../src/resource-lock.ts";
import { nativeSelection } from "../lib/harnesses/pi/package-fixture.ts";

void test("OpenCode prepare rejects symlinked storage parents before locks, workspaces, or fetch", async (t) => {
  for (const parent of ["config", "manager"] as const)
    await t.test(parent, async (t) => {
      const root = scratch(t, "spw-opencode-command-prepare-");
      const env = {
        HOME: join(root, "home"),
        XDG_CONFIG_HOME: join(root, "xdg"),
        SUPERPOWERS_CACHE_DIR: join(root, "cache"),
      };
      const paths = openCodePaths(env, root);
      const target = join(root, "outside");
      mkdirSync(target);
      writeFileSync(join(target, "preserve"), "unchanged\n");
      if (parent === "config") {
        mkdirSync(join(paths.configRoot, ".."), { recursive: true });
        symlinkSync(target, paths.configRoot, "dir");
      } else {
        mkdirSync(paths.configRoot, { recursive: true });
        symlinkSync(target, paths.managerRoot, "dir");
      }
      const stdout = capture();
      const stderr = capture();
      const real = createResourceCoordinator();
      let coordinated = false;
      const status = await runPrepare([], {
        root,
        env,
        stdout: stdout.stream,
        stderr: stderr.stream,
        options: { harness: "opencode", allowExperimental: false },
        selection: {
          ...nativeSelection(),
          selectionMode: "pinned",
          resolutionKind: "commit",
          effectiveSource: join(root, "upstream-must-not-fetch"),
        },
        adapter: openCodeHarness,
        coordination: {
          observeResources: (resources) => real.observeResources(resources),
          withResources: async (resources, action) =>
            await real.withResources(resources, async () => {
              coordinated = true;
              return await action();
            }),
        },
      });
      assert.equal(status, 1);
      assert.equal(coordinated, false);
      assert.deepEqual(readdirSync(target), ["preserve"]);
      assert.equal(existsSync(join(root, "cache")), false);
      assert.match(
        stderr.text(),
        /cannot determine harness mutation resources/,
      );
      assert.equal(stdout.text(), "");
    });
});

void test("retired validator rejects direct handlers before selection or adapter access", async () => {
  for (const run of [runPrepare, runInstall, runUpdate]) {
    const stdout = capture();
    const stderr = capture();
    const locks: string[][] = [];
    let selectionReads = 0;
    const ctx: CommandContext<CodexRemovalInput> = {
      root: "/retired-validator-must-not-read",
      env: { SUPERPOWERS_VALIDATOR: "/retired" },
      stdout: stdout.stream,
      stderr: stderr.stream,
      options: { harness: "codex", allowExperimental: false },
      adapter: notCalledAdapter,
      coordination: observingCoordinator(locks),
      get selection(): never {
        selectionReads += 1;
        throw new Error("selection must not be read");
      },
    };
    assert.equal(await run([], ctx), 1);
    assert.equal(selectionReads, 0);
    assert.deepEqual(locks, []);
    assert.equal(
      stdout.text(),
      run === runInstall ? `${codexHarness.presentation.installNotice}\n` : "",
    );
    assert.equal(
      stderr.text(),
      "error: SUPERPOWERS_VALIDATOR has been removed; unset it and configure " +
        "SUPERPOWERS_VALIDATOR_EXECUTABLE with an executable validator.\n",
    );
  }
});

const SCRATCH = mkdtempSync(join(tmpdir(), "spw-commands-prepare-"));
process.on("exit", () => rmSync(SCRATCH, { recursive: true, force: true }));

function manifestFile(name: string, body: string | Uint8Array): string {
  const path = join(SCRATCH, `${name}.json`);
  writeFileSync(path, body);
  return path;
}

void test("readUpstreamManifestVersion mirrors spw_json_get for the three shapes", async () => {
  assert.equal(
    await readUpstreamManifestVersion(
      manifestFile("present", '{"name":"superpowers","version":"6.0.3"}'),
    ),
    "6.0.3",
  );
  // `git show ad56569a4c161e7b122967442e2b026eeb6395f6:scripts/core/provenance.sh:59::break` — a missing key yields the empty string.
  assert.equal(
    await readUpstreamManifestVersion(
      manifestFile("absent", '{"name":"superpowers"}'),
    ),
    "",
  );
  // `git show ad56569a4c161e7b122967442e2b026eeb6395f6:scripts/core/provenance.sh:62::print(value` — an explicit null yields the empty string.
  assert.equal(
    await readUpstreamManifestVersion(manifestFile("null", '{"version":null}')),
    "",
  );
});

void test("readUpstreamManifestVersion fails closed on a non-string version", async () => {
  const path = manifestFile("numeric", '{"version":6}');
  await assert.rejects(readUpstreamManifestVersion(path), (error) => {
    assert.ok(error instanceof Error);
    assert.equal(
      error.message,
      `upstream manifest version is not a string: ${path}`,
    );
    return true;
  });
});

void test("readUpstreamManifestVersion delegates every read and parse failure to readManifest", async () => {
  const array = manifestFile("array", "[1,2,3]");
  await assert.rejects(readUpstreamManifestVersion(array), (error) => {
    assert.ok(error instanceof Error);
    assert.equal(error.message, `manifest must be a JSON object: ${array}`);
    return true;
  });

  const malformed = manifestFile("malformed", "{");
  await assert.rejects(readUpstreamManifestVersion(malformed), (error) => {
    assert.ok(error instanceof Error);
    assert.equal(error.message, `invalid manifest JSON in ${malformed}`);
    return true;
  });

  // Invalid UTF-8. readManifest reads bytes, so the strict parser rejects this
  // rather than the reader silently substituting U+FFFD.
  const invalidUtf8 = manifestFile(
    "invalid-utf8",
    Uint8Array.from([0x7b, 0x22, 0x76, 0x22, 0x3a, 0x22, 0xff, 0x22, 0x7d]),
  );
  await assert.rejects(readUpstreamManifestVersion(invalidUtf8), (error) => {
    assert.ok(error instanceof Error);
    assert.equal(error.message, `invalid manifest JSON in ${invalidUtf8}`);
    return true;
  });

  const unreadable = manifestFile("unreadable", '{"version":"1.0.0"}');
  chmodSync(unreadable, 0o000);
  await assert.rejects(readUpstreamManifestVersion(unreadable), (error) => {
    assert.ok(error instanceof Error);
    assert.equal(error.message, `cannot read manifest JSON in ${unreadable}`);
    // No errno vocabulary reaches the message.
    assert.doesNotMatch(error.message, /EACCES|EPERM|errno|open \x27/);
    return true;
  });
  chmodSync(unreadable, 0o600);
});

/**
 * A ctx whose selection resolves without touching git: a 40-hex SUPERPOWERS_REF
 * is a raw-commit resolution (`src/upstream.ts:162-164::return { kind: "raw-commit"`).
 *
 * `adapter: notCalledAdapter` is safe for every case below: each fails
 * closed (a missing manifest template, a failed clone) before gatherPrepare
 * ever reaches the `ctx.adapter` build call. End-to-end coverage of that
 * call lives in tests/baseline/prepare.test.js.
 */
function unitContext(dir: string, extra: Record<string, string> = {}) {
  mkdirSync(join(dir, "config"), { recursive: true });
  writeFileSync(join(dir, "config", "upstream-ref"), "v1.0.0\n");
  const out = capture();
  const err = capture();
  return {
    out,
    err,
    ctx: {
      root: dir,
      env: {
        HOME: join(dir, "home"),
        PATH: process.env.PATH ?? "",
        SUPERPOWERS_CONFIG_DIR: join(dir, "config-dir"),
        SUPERPOWERS_CACHE_DIR: join(dir, "cache"),
        SUPERPOWERS_PLUGIN_ROOT: join(dir, "plugins", "superpowers"),
        SUPERPOWERS_UPSTREAM_URL: join(dir, "no-such-upstream"),
        SUPERPOWERS_REF: "0".repeat(40),
        ...extra,
      },
      stdout: out.stream,
      stderr: err.stream,
      options: { harness: "codex" as const, allowExperimental: false },
      coordination: observingCoordinator(),
      adapter: codexHarness,
    },
  };
}

void test("runPrepare emits no errno or multi-line git text when the clone fails", async () => {
  const dir = mkdtempSync(join(SCRATCH, "case-"));
  const template = join(dir, "template.json");
  writeFileSync(template, '{"name":"superpowers"}\n');
  const { err, ctx } = unitContext(dir, {
    SUPERPOWERS_MANIFEST_TEMPLATE: template,
  });
  const status = await runPrepare([], ctx);
  assert.equal(status, 1);
  // Exact equality, not just doesNotMatch(/ENOENT|errno|Error:|\n.*\n.*\n/):
  // notCalledAdapter's throw is caught by gatherPrepare's own `catch`
  // following the adapter build argv construction and turned into a
  // *different*, still-single-line, still-errno-free diagnostic ("cannot
  // build the generated plugin candidate"). A loose doesNotMatch
  // cannot tell that diagnostic apart from this one, so it would stay green
  // even if a future change made this case wrongly reach the adapter. Pinning
  // the exact clone-failure text is what makes reaching ctx.adapter here
  // observable.
  assert.doesNotMatch(err.text(), /ENOENT|errno|Error:|\n.*\n.*\n/);
  assert.equal(
    err.text(),
    `error: cannot clone upstream repo: ${join(dir, "no-such-upstream")}\n`,
  );
});

void test("runPrepare takes the clone branch, not fetch, when the cache's .git is a regular file", async () => {
  const dir = mkdtempSync(join(SCRATCH, "case-"));
  const template = join(dir, "template.json");
  writeFileSync(template, '{"name":"superpowers"}\n');
  const source = join(dir, "no-such-upstream");
  // `git show ad56569a4c161e7b122967442e2b026eeb6395f6:scripts/prepare:50::if [ -d` is `[ -d "$cache/.git" ]`. A regular file named
  // `.git` -- what a git worktree or `clone --separate-git-dir` leaves
  // behind -- must NOT be treated as a directory: an `-e` predicate would
  // take the fetch branch and let git follow the file's `gitdir:` pointer,
  // where the shell (and the `-d` port) take the clone branch instead. The
  // two branches are discriminated here by their diagnostics, which differ.
  const cache = join(dir, "cache", "superpowers");
  mkdirSync(cache, { recursive: true });
  writeFileSync(join(cache, ".git"), "gitdir: /nonexistent\n");
  const { err, ctx } = unitContext(dir, {
    SUPERPOWERS_MANIFEST_TEMPLATE: template,
    SUPERPOWERS_UPSTREAM_URL: source,
  });
  const status = await runPrepare([], ctx);
  assert.equal(status, 1);
  assert.equal(err.text(), `error: cannot clone upstream repo: ${source}\n`);
});

console.log("commands-prepare.test.js: OK");
