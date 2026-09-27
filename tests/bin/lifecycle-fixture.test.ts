// Permanent coverage for tests/bin/lifecycle-config.js and
// tests/bin/lifecycle-fixture.js — the two modules the install and uninstall
// lifecycle ports share, but that no port ever asserts against directly.
// Every port case calls createCase, so the eager config validator and the
// scratch-tree containment check both run on every one of the 50 port cases,
// but no port case feeds a bad config key or value or an out-of-tree package
// root, so nothing in the port suites checks that those guards actually
// reject anything. This file exists to assert exactly the properties that
// exercise-without-assertion left silent:
//
//   1. createCase rejects an unknown config key eagerly, at case creation.
//   2. createCase rejects an invalid value for a known key eagerly.
//   3. a fake re-validates its own config as defence in depth, so a
//      hand-written config.json that bypasses createCase still fails closed.
//   4. runScript's scratch-tree containment check refuses a package root
//      outside the fixture scratch tree — including a sibling directory
//      whose name merely extends the scratch path, which a lexical
//      startsWith() would wrongly accept.
//   5. HOME is case-local, so production cannot read the developer's real
//      selection state.
//   6. runScript bodies actually overlap under concurrency — not merely that
//      the { concurrency: true } option is set, which reads as set whether
//      or not anything actually overlaps.
//
// These checks exercise fixture guards directly because normal cases only
// exercise their successful paths.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile, spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import {
  SCRATCH,
  UPSTREAM,
  assertOrder,
  createCase,
  firstIndex,
  lastIndex,
  readLog,
  runScript,
} from "./lifecycle-fixture.ts";

const execFileAsync = promisify(execFile);

type CaseEnv = import("./lifecycle-fixture.ts").CaseEnv;

const WRITABLE_KEYS: (keyof CaseEnv)[] = ["dir", "pkg", "state", "tmp"];

const PLUGIN_PRESENT =
  '{"installed":[{"pluginId":"superpowers@superpowers-manager","name":"superpowers","marketplaceName":"superpowers-manager","installed":true,"enabled":true,"version":"1.0.0"}],"available":[]}';
const MARKETPLACE_PRESENT =
  '{"marketplaces":[{"name":"openai-curated","root":"/x"},{"name":"superpowers-manager","root":"/y"}]}';

/**
 * A seeded uninstall case, good for a full, successful run of
 * the `uninstall` command launched through `src/cli.ts` and
 * `src/commands/uninstall.ts` — used only where a test needs realistic timing
 * (the concurrency-overlap proof), not just the fixture's own plumbing.
 */
function seededUninstallCase(config: Record<string, unknown>): CaseEnv {
  const c = createCase({ fakes: "uninstall", config });
  writeFileSync(join(c.state, "plugin_list.json"), `${PLUGIN_PRESENT}\n`);
  writeFileSync(
    join(c.state, "marketplace_list.json"),
    `${MARKETPLACE_PRESENT}\n`,
  );
  return c;
}

void test("each case gets distinct writable paths", () => {
  const a = createCase({ fakes: "uninstall" });
  const b = createCase({ fakes: "uninstall" });
  for (const key of WRITABLE_KEYS) {
    assert.notEqual(a[key], b[key], `cases share ${key}`);
  }
});

void test("the package root carries everything a lifecycle script needs", () => {
  const c = createCase({ fakes: "uninstall" });
  for (const rel of [
    "src/cli.ts",
    "package.json",
    "plugins/superpowers/.codex-plugin/plugin.template.json",
  ]) {
    assert.ok(existsSync(join(c.pkg, rel)), `package root is missing ${rel}`);
  }
});

void test("the fake upstream exposes one annotated release tag", () => {
  assert.ok(existsSync(join(UPSTREAM, ".git")), "upstream is not a git repo");
  assert.ok(
    existsSync(join(UPSTREAM, "skills/brainstorming/SKILL.md")),
    "upstream is missing its fixture skill",
  );
});

void test("the fake config is written where the fakes will read it", () => {
  const c = createCase({
    fakes: "uninstall",
    config: { pluginRemove: "missing-installed" },
  });
  const written = JSON.parse(
    readFileSync(join(c.state, "config.json"), "utf8"),
  );
  assert.equal(written.pluginRemove, "missing-installed");
});

void test("firstIndex and lastIndex are distinct, not aliases", () => {
  const log = ["alpha", "beta", "alpha"];
  assert.equal(firstIndex(log, "alpha"), 0);
  assert.equal(lastIndex(log, "alpha"), 2);
  assert.equal(firstIndex(log, "absent"), -1);
  assert.equal(lastIndex(log, "absent"), -1);
});

void test("assertOrder rejects a missing needle rather than passing vacuously", () => {
  assert.throws(
    () => assertOrder(["a", "b"], ["a", "missing"], "ordering"),
    /never appears/,
  );
});

void test("assertOrder rejects an out-of-order sequence", () => {
  assert.throws(
    () => assertOrder(["b", "a"], ["a", "b"], "ordering"),
    /out of order/,
  );
});

void test("readLog returns an empty array for an absent log", () => {
  assert.deepEqual(readLog(join(SCRATCH, "does-not-exist.log")), []);
});

void test("createCase rejects an unknown config key eagerly", () => {
  // Eagerly, at case creation — NOT when a fake is eventually invoked. Cases
  // that make zero fake calls would otherwise never validate their config at
  // all, which is exactly the property `tests/bin/lifecycle-config.ts:99-102::Throws on an unknown key or an invalid value` claims.
  assert.throws(
    () => createCase({ fakes: "uninstall", config: { pluginRemoove: "noop" } }),
    /unknown fixture config key: pluginRemoove/,
  );
});

void test("createCase rejects an invalid value for a known key eagerly", () => {
  assert.throws(
    () =>
      createCase({ fakes: "uninstall", config: { pluginRemove: "sometimes" } }),
    /invalid value for pluginRemove: sometimes/,
  );
});

void test("HOME is case-local, so production cannot read real selection state", () => {
  const c = createCase({ fakes: "uninstall" });
  assert.ok(
    c.home.startsWith(SCRATCH),
    `home escapes the scratch tree: ${c.home}`,
  );
  assert.notEqual(c.home, process.env.HOME);
});

void test("runScript refuses a package root outside the fixture scratch tree", async () => {
  const c = createCase({ fakes: "uninstall" });
  const outside = mkdtempSync(join(tmpdir(), "spw-lifecycle-outside-"));
  try {
    await assert.rejects(
      () => runScript({ ...c, pkg: outside }, "uninstall"),
      /outside the fixture scratch tree/,
    );
  } finally {
    rmSync(outside, { recursive: true, force: true });
  }
});

void test("runScript refuses a sibling directory whose name merely extends the scratch path", async () => {
  const c = createCase({ fakes: "uninstall" });
  // A lexical `startsWith(SCRATCH)` would wrongly accept this path: it
  // literally begins with the SCRATCH string. runScript's containment
  // check is resolved and segment-aware, so it must still refuse it.
  const sibling = `${SCRATCH}-sibling`;
  assert.ok(
    sibling.startsWith(SCRATCH),
    "test setup: sibling must lexically extend SCRATCH to exercise the segment-aware check",
  );
  mkdirSync(sibling, { recursive: true });
  try {
    await assert.rejects(
      () => runScript({ ...c, pkg: sibling }, "uninstall"),
      /outside the fixture scratch tree/,
    );
  } finally {
    rmSync(sibling, { recursive: true, force: true });
  }
});

void test("the fake re-validates its config as defence in depth", async () => {
  // createCase validates eagerly, so reach past it to prove the fake also
  // refuses a bad config on its own. Write the file directly, bypassing
  // createCase's validateConfig call entirely.
  const c = createCase({ fakes: "uninstall" });
  writeFileSync(
    join(c.state, "config.json"),
    `${JSON.stringify({ pluginRemoveTypo: "noop" })}\n`,
  );
  const result = await runScript(c, "uninstall");
  assert.notEqual(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stderr, /unknown fixture config key: pluginRemoveTypo/);
});

void test(
  "runScript bodies actually overlap under concurrency",
  { timeout: 30000 },
  async () => {
    // Overlap is a property, not a duration. The previous oracle compared wall
    // clocks -- `together < single * 3` -- and failed at 3894ms against a 3795ms
    // budget during PR 11.6, i.e. it was sampling machine load at 3.08x, not
    // detecting serialisation. The regression it must catch is named in its own
    // history: a return to spawnSync, or a dropped `await`. Both make the four
    // runs DISJOINT, so measure disjointness.
    const rv = mkdtempSync(join(tmpdir(), "spw-fixture-barrier-"));
    const release = join(rv, "release");
    const cases = [0, 1, 2, 3].map(() => seededUninstallCase({}));
    const tags = cases.map((c) =>
      createHash("sha256").update(c.state).digest("hex").slice(0, 16),
    );
    const settled = cases.map(() => false);
    const runs = cases.map((c, index) => {
      const run = runScript(c, "uninstall", {
        env: { SPW_FIXTURE_BARRIER_DIR: rv },
      });
      run.then(
        () => {
          settled[index] = true;
        },
        () => {
          settled[index] = true;
        },
      );
      return run;
    });
    try {
      // A stuck participant still ends: the fake's own barrier bound (pinned
      // below) exits it, so this wait needs only its own deadline.
      const deadline = Date.now() + 15000;
      while (!tags.every((tag) => existsSync(join(rv, `${tag}.ready`)))) {
        if (settled.some(Boolean)) {
          throw new Error(
            "runScript settled before all participants were ready",
          );
        }
        if (Date.now() >= deadline) {
          throw new Error("fixture barrier readiness wait timed out");
        }
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
      }
      assert.deepEqual(
        settled,
        [false, false, false, false],
        "all four runs must remain blocked before release",
      );
      writeFileSync(release, "released\n");
      const results = await Promise.all(runs);
      assert.deepEqual(
        results.map(({ status }) => status),
        [0, 0, 0, 0],
      );
    } finally {
      // Release any participant still waiting, so none sits out its bound.
      if (!existsSync(release)) writeFileSync(release, "released\n");
      await Promise.allSettled(runs);
      rmSync(rv, { recursive: true, force: true });
    }
  },
);

void test(
  "an unreleased fake Codex invocation expires at its own bound",
  { timeout: 20000 },
  (t) => {
    const rv = mkdtempSync(join(tmpdir(), "spw-fixture-barrier-bound-"));
    t.after(() => rmSync(rv, { recursive: true, force: true }));
    const c = seededUninstallCase({});
    const result = spawnSync(c.codexBin, ["plugin", "list", "--json"], {
      env: {
        ...process.env,
        HOME: c.home,
        SPW_FIXTURE_STATE: c.state,
        SPW_FIXTURE_BARRIER_DIR: rv,
      },
      encoding: "utf8",
      timeout: 15000,
    });
    assert.equal(result.signal, null);
    assert.equal(result.status, 90);
    assert.equal(result.stderr, "fixture: release barrier timed out\n");
  },
);

void test("the fake codex delivers an oversized plugin listing intact", async () => {
  // The read side already used process.exitCode, so this is a
  // regression guard on the whole spawn path rather than a mutation proof:
  // it is what fails if a future edit reintroduces process.exit() into
  // respondToListing or the role dispatch around it.
  const c = createCase({ fakes: "install" });
  const filler = "y".repeat(1024 * 1024);
  writeFileSync(
    join(c.state, "plugin_list.json"),
    JSON.stringify({ installed: [], available: [], filler }),
    "utf8",
  );
  const result = await execFileAsync(c.codexBin, ["plugin", "list", "--json"], {
    env: { ...process.env, SPW_FIXTURE_STATE: c.state },
    maxBuffer: 8 << 20,
  });
  assert.equal(JSON.parse(result.stdout).filler.length, filler.length);
});

/**
 * Bounds a promise that would otherwise hang forever if the termination
 * contract regresses — e.g. deregistration dropped or reordered so the
 * re-raise re-enters cleanupForSignal, whose own `if (exiting) return;`
 * guard then swallows the signal and the child's `setInterval` keeps it
 * alive. node:test's own `{ timeout }` marks a test failed once it fires,
 * but never resolves the promise it was waiting on, so an unbounded await
 * here would never reach `finally` and the child would survive the whole
 * suite. Racing against an explicit, shorter bound instead turns that hang
 * into a rejection this test's own try/finally can act on.
 */
function withBound<T>(promise: Promise<T>, message: string): Promise<T> {
  return new Promise((resolvePromise, rejectPromise) => {
    const timer = setTimeout(() => {
      rejectPromise(new Error(message));
    }, 10_000);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolvePromise(value);
      },
      (error) => {
        clearTimeout(timer);
        rejectPromise(error);
      },
    );
  });
}

void test(
  "a scratch tree is removed and the signal is re-raised on SIGTERM",
  { timeout: 15_000 },
  async () => {
    // A CHILD-PROCESS signal test, per D4: an assertion about the code would
    // not show that the process dies BY the signal. The child prints its
    // scratch path, then waits; the parent signals it and checks both
    // halves.
    const child = fileURLToPath(
      new URL("./helpers/scratch-signal-child.ts", import.meta.url),
    );
    const proc = spawn(process.execPath, [child], {
      stdio: ["ignore", "pipe", "inherit"],
    });
    try {
      const scratch = await withBound(
        new Promise<string>((resolvePath) => {
          let buffer = "";
          proc.stdout.setEncoding("utf8");
          proc.stdout.on("data", (chunk) => {
            buffer += chunk;
            const newline = buffer.indexOf("\n");
            if (newline !== -1) resolvePath(buffer.slice(0, newline));
          });
        }),
        "child did not print its scratch path before the bound elapsed",
      );
      assert.equal(
        existsSync(scratch),
        true,
        "child did not create its scratch",
      );

      const ended = new Promise<{
        code: number | null;
        signal: NodeJS.Signals | null;
      }>((resolveEnd) => {
        proc.on("close", (code, signal) => resolveEnd({ code, signal }));
      });
      proc.kill("SIGTERM");
      const outcome = await withBound(
        ended,
        "child did not exit after SIGTERM before the bound elapsed -- " +
          "deregistration or the re-raise is likely broken",
      );

      // Asserting the SIGNAL, not 143. `128+N` is a shell convention, not a
      // POSIX guarantee, and asserting the signal is both stronger and
      // immune to it.
      assert.equal(outcome.signal, "SIGTERM");
      assert.equal(existsSync(scratch), false, "scratch survived the signal");
    } finally {
      // Runs whether the test passed, failed an assertion, or the bound
      // above rejected -- so a failed run never leaves the child (and its
      // scratch tree) still holding the suite hostage.
      proc.kill("SIGKILL");
    }
  },
);
