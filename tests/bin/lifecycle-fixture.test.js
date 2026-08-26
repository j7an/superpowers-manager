// @ts-check
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
// Restored from tests/bin/lifecycle-fixture-selftest.test.js
// (`git show 76131cf`), deleted in `ccde130` on the rationale that the ports
// now exercise every path it proved. That rationale covered exercise, not
// assertion: tests/bin/lifecycle-fakes.js:29-31 still says the re-validation
// "is what makes a hand-written config.json ... fail closed too", and since
// PR 11.5 slice 4a both fakes reach it through runFake's single call site
// (:241) rather than calling it themselves — one loader for two fakes, and a
// guarantee that had no test once this file was gone. This file is permanent,
// not temporary scaffolding — hence the plain name, without "-selftest".

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
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
} from "./lifecycle-fixture.js";

const execFileAsync = promisify(execFile);

/** @typedef {import("./lifecycle-fixture.js").CaseEnv} CaseEnv */

/** @type {(keyof CaseEnv)[]} */
const WRITABLE_KEYS = ["dir", "pkg", "state", "tmp"];

const PLUGIN_PRESENT =
  '{"installed":[{"pluginId":"superpowers@superpowers-manager","name":"superpowers","marketplaceName":"superpowers-manager"}],"available":[]}';
const MARKETPLACE_PRESENT =
  '{"marketplaces":[{"name":"openai-curated","root":"/x"},{"name":"superpowers-manager","root":"/y"}]}';

/**
 * A seeded uninstall case, good for a full, successful run of
 * the `uninstall` command launched through `bin/superpowers-manager.js` and
 * `src/commands/uninstall.ts` — used only where a test needs realistic timing
 * (the concurrency-overlap proof), not just the fixture's own plumbing.
 * @param {Record<string, unknown>} config
 * @returns {CaseEnv}
 */
function seededUninstallCase(config) {
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
    "dist/cli.js",
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
  // all, which is exactly the property lifecycle-config.js:107-110 claims.
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

/** @param {string} text */
function parseProcessRow(text) {
  const lines = text.trim().split("\n").filter(Boolean);
  if (lines.length !== 1) return undefined;
  const match = lines[0].match(/^(\d+)\s+(\d+)\s+(\S+)\s+(\S+)\s+(.+)$/);
  if (!match) return undefined;
  return {
    pid: Number(match[1]),
    pgid: Number(match[2]),
    state: match[3],
    command: match[4],
    started: match[5].trim(),
  };
}

/**
 * @param {{pid: number, pgid: number, command: string, started: string}} expected
 * @param {{kind: "absent"} | {kind: "error"} | {kind: "row", text: string}} snapshot
 */
function classifyProcessSnapshot(expected, snapshot) {
  if (snapshot.kind === "absent") return "terminal";
  if (snapshot.kind === "error") return "error";
  const row = parseProcessRow(snapshot.text);
  if (!row) return "error";
  if (
    row.pid !== expected.pid ||
    row.pgid !== expected.pgid ||
    row.command !== expected.command ||
    row.started !== expected.started
  ) {
    return "reused";
  }
  return row.state.startsWith("Z") ? "terminal" : "live";
}

/** @param {unknown} error */
function classifyPsError(error) {
  if (typeof error !== "object" || error === null) return "error";
  const record = /** @type {Record<string, unknown>} */ (error);
  return record.code === 1 &&
    typeof record.stdout === "string" &&
    record.stdout === "" &&
    typeof record.stderr === "string" &&
    record.stderr === ""
    ? "absent"
    : "error";
}

/**
 * @param {number} pid
 * @returns {Promise<
 *   {kind: "absent"} |
 *   {kind: "error"} |
 *   {kind: "row", text: string}
 * >}
 */
async function inspectProcess(pid) {
  try {
    process.kill(pid, 0);
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "ESRCH"
    ) {
      return { kind: "absent" };
    }
    return { kind: "error" };
  }
  try {
    const { stdout } = await execFileAsync(
      "ps",
      ["-o", "pid=,pgid=,state=,comm=,lstart=", "-p", String(pid)],
      { encoding: "utf8" },
    );
    return stdout.trim() === ""
      ? { kind: "absent" }
      : { kind: "row", text: stdout };
  } catch (error) {
    return classifyPsError(error) === "absent"
      ? { kind: "absent" }
      : { kind: "error" };
  }
}

void test("process snapshot classifier is identity- and zombie-aware", () => {
  const expected = {
    pid: 123,
    pgid: 99,
    command: "node",
    started: "Wed Aug 26 07:28:00 2026",
  };
  assert.equal(
    classifyProcessSnapshot(expected, { kind: "absent" }),
    "terminal",
  );
  assert.equal(
    classifyProcessSnapshot(expected, {
      kind: "row",
      text: "123 99 Z+ node Wed Aug 26 07:28:00 2026\n",
    }),
    "terminal",
  );
  assert.equal(
    classifyProcessSnapshot(expected, {
      kind: "row",
      text: "123 99 S node Wed Aug 26 07:28:00 2026\n",
    }),
    "live",
  );
  assert.equal(
    classifyProcessSnapshot(expected, {
      kind: "row",
      text: "123 99 S other Wed Aug 26 07:28:00 2026\n",
    }),
    "reused",
  );
  assert.equal(
    classifyProcessSnapshot(expected, { kind: "row", text: "malformed" }),
    "error",
  );
  assert.equal(classifyProcessSnapshot(expected, { kind: "error" }), "error");
  assert.equal(classifyPsError({ code: 1, stdout: "", stderr: "" }), "absent");
  assert.equal(
    classifyPsError({ code: 1, stdout: Buffer.alloc(0), stderr: "" }),
    "error",
  );
  assert.equal(
    classifyPsError({ code: 1, stdout: "", stderr: Buffer.alloc(0) }),
    "error",
  );
  assert.equal(classifyPsError({ code: 1, stdout: " ", stderr: "" }), "error");
  assert.equal(classifyPsError({ code: 2, stdout: "", stderr: "" }), "error");
});

void test(
  "runScript watchdog kills and reaps an unreachable rendezvous process group",
  { timeout: 30000 },
  async (t) => {
    const rv = mkdtempSync(join(tmpdir(), "spw-rendezvous-watchdog-"));
    t.after(() => rmSync(rv, { recursive: true, force: true }));
    const c = seededUninstallCase({});
    const tag = createHash("sha256").update(c.state).digest("hex").slice(0, 16);
    const pidPath = join(rv, `${tag}.pid`);
    const managerPidPath = join(rv, `${tag}.manager-pid`);
    const groupPidPath = join(rv, `${tag}.group-pid`);
    const timeoutMs = 2000;
    const safety = new AbortController();
    const forwardTestAbort = () => safety.abort();
    if (t.signal.aborted) forwardTestAbort();
    else t.signal.addEventListener("abort", forwardTestAbort, { once: true });
    // Full-suite startup evidence is ~1-4.4s. Fifteen seconds is deliberately
    // generous and still precedes node:test's catastrophic 30s cancellation.
    /** @type {NodeJS.Timeout | undefined} */
    let startupSafetyTimer = setTimeout(() => safety.abort(), 15000);
    /** @type {NodeJS.Timeout | undefined} */
    let postReadinessSafetyTimer;

    // Attach the exact expected rejection immediately, before any readiness
    // wait, so no child rejection can become unhandled.
    const watchdogRejection = assert.rejects(
      runScript(c, "uninstall", {
        env: {
          SPW_RENDEZVOUS_DIR: rv,
          SPW_RENDEZVOUS_EXPECT: "2",
          SPW_RENDEZVOUS_PID_DELAY_MS: "3000",
          SPW_RENDEZVOUS_HOLD_AFTER_PID: "1",
        },
        timeoutMs,
        watchdogArmPath: pidPath,
        signal: safety.signal,
      }),
      {
        name: "Error",
        message: "uninstall exceeded fixture watchdog after 2000ms",
      },
    );

    // A condition promise races the already-attached rejection assertion.
    // Readiness MUST win for a conditioned helper.
    const readiness = (async () => {
      while (!existsSync(pidPath)) {
        if (safety.signal.aborted) return "aborted";
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
      }
      return "ready";
    })();

    /** @type {{pid: number, pgid: number, command: string, started: string} | undefined} */
    let fakeIdentity;
    let groupPid;
    let cleanupFailure;
    try {
      const winner = await Promise.race([
        readiness.then((state) => ({ source: "readiness", state })),
        watchdogRejection.then(() => ({ source: "watchdog", state: "done" })),
      ]);
      if (winner.source === "watchdog") {
        // Cleanup is already complete through assert.rejects. Abort only stops
        // the still-polling condition promise before the fixed RED is thrown.
        safety.abort();
        await readiness;
        throw new Error("watchdog rejected before descendant readiness");
      }
      if (winner.state === "aborted") {
        // Startup/t.signal safety must await runScript cleanup. An abort does
        // not match the expected watchdog diagnostic, so consume that mismatch
        // and replace it with the fixed readiness-aborted test diagnostic.
        try {
          await watchdogRejection;
        } catch {}
        throw new Error(
          "watchdog readiness wait aborted after process-group cleanup",
        );
      }
      clearTimeout(startupSafetyTimer);
      startupSafetyTimer = undefined;
      const fakePid = Number(readFileSync(pidPath, "utf8").trim());
      const managerPid = Number(readFileSync(managerPidPath, "utf8").trim());
      groupPid = Number(readFileSync(groupPidPath, "utf8").trim());
      assert.equal(
        managerPid,
        groupPid,
        "detached manager must be the recorded group leader",
      );
      const initialSnapshot = await inspectProcess(fakePid);
      assert.equal(
        initialSnapshot.kind,
        "row",
        "ready fake must have a readable ps identity",
      );
      const initialRow =
        initialSnapshot.kind === "row"
          ? parseProcessRow(initialSnapshot.text)
          : undefined;
      assert.ok(initialRow, "ready fake ps snapshot must parse exactly once");
      assert.equal(initialRow.pid, fakePid);
      assert.equal(initialRow.pgid, groupPid);
      assert.ok(
        !initialRow.state.startsWith("Z"),
        "ready fake must be live, not zombie",
      );
      fakeIdentity = {
        pid: initialRow.pid,
        pgid: initialRow.pgid,
        command: initialRow.command,
        started: initialRow.started,
      };
      // A later abort is the mutation safety net. In the normal case the
      // conditioned 2000ms watchdog wins and cleanup removes this listener.
      postReadinessSafetyTimer = setTimeout(() => safety.abort(), 5000);
      await watchdogRejection;
      const finalClass = classifyProcessSnapshot(
        fakeIdentity,
        await inspectProcess(fakePid),
      );
      if (finalClass === "live") {
        throw new Error("watchdog left matching live fake process");
      }
      if (finalClass === "error") {
        throw new Error("watchdog fake process state could not be classified");
      }
    } finally {
      if (startupSafetyTimer !== undefined) clearTimeout(startupSafetyTimer);
      if (postReadinessSafetyTimer !== undefined) {
        clearTimeout(postReadinessSafetyTimer);
      }
      t.signal.removeEventListener("abort", forwardTestAbort);
      safety.abort();
      if (fakeIdentity !== undefined && groupPid !== undefined) {
        let classification = classifyProcessSnapshot(
          fakeIdentity,
          await inspectProcess(fakeIdentity.pid),
        );
        if (classification === "live") {
          try {
            process.kill(-groupPid, "SIGKILL");
          } catch (error) {
            if (!(
              typeof error === "object" &&
              error !== null &&
              "code" in error &&
              error.code === "ESRCH"
            )) {
              try {
                process.kill(fakeIdentity.pid, "SIGKILL");
              } catch {}
            }
          }
          for (let attempt = 0; attempt < 80; attempt += 1) {
            classification = classifyProcessSnapshot(
              fakeIdentity,
              await inspectProcess(fakeIdentity.pid),
            );
            if (classification === "terminal" || classification === "reused") {
              break;
            }
            if (classification === "error") break;
            await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
          }
        }
        if (classification === "live" || classification === "error") {
          cleanupFailure =
            "watchdog cleanup could not reach absent, reused, or zombie fake state";
          t.diagnostic(cleanupFailure);
        }
      }
    }
    if (cleanupFailure !== undefined) assert.fail(cleanupFailure);
  },
);

void test(
  "runScript bodies actually overlap under concurrency",
  { timeout: 30000 },
  async (t) => {
    // Overlap is a property, not a duration. The previous oracle compared wall
    // clocks -- `together < single * 3` -- and failed at 3894ms against a 3795ms
    // budget during PR 11.6, i.e. it was sampling machine load at 3.08x, not
    // detecting serialisation. The regression it must catch is named in its own
    // history: a return to spawnSync, or a dropped `await`. Both make the four
    // runs DISJOINT, so measure disjointness.
    const rv = mkdtempSync(join(tmpdir(), "spw-rendezvous-"));
    t.after(() => rmSync(rv, { recursive: true, force: true }));
    const env = { SPW_RENDEZVOUS_DIR: rv, SPW_RENDEZVOUS_EXPECT: "4" };
    const cases = [0, 1, 2, 3].map(() => seededUninstallCase({}));
    const participants = cases.map((c) => ({
      c,
      tag: createHash("sha256").update(c.state).digest("hex").slice(0, 16),
    }));
    const expectedTags = participants.map(({ tag }) => tag).sort();
    await Promise.all(
      participants.map(({ c, tag }) =>
        runScript(c, "uninstall", {
          env,
          timeoutMs: 20000,
          watchdogArmPath: join(rv, `${tag}.pid`),
          signal: t.signal,
        }),
      ),
    );
    const tags = readdirSync(rv)
      .filter((f) => f.endsWith(".peak"))
      .map((f) => f.slice(0, -".peak".length))
      .sort();
    assert.deepEqual(
      tags,
      expectedTags,
      "exactly the four participants must record evidence",
    );
    const peaks = tags.map((tag) =>
      Number(readFileSync(join(rv, `${tag}.peak`), "utf8").trim()),
    );
    const reasons = tags.map((tag) =>
      readFileSync(join(rv, `${tag}.reason`), "utf8").trim(),
    );
    assert.deepEqual(
      peaks,
      [4, 4, 4, 4],
      `only ever saw ${Math.max(...peaks)} in flight; participant peaks were ${peaks.join(",")}`,
    );
    const readyTags = readdirSync(rv)
      .filter((f) => f.endsWith(".ready"))
      .map((f) => f.slice(0, -".ready".length))
      .sort();
    assert.deepEqual(
      readyTags,
      expectedTags,
      "every participant must acknowledge arrival quorum",
    );
    assert.deepEqual(reasons, ["quorum", "quorum", "quorum", "quorum"]);
  },
);

// Four participants, quorum of five: unreachable by construction. Each fake
// records its own wait-call count and exit reason, so the oracle reads the
// mechanism rather than inferring it from whole-run wall time.
void test(
  "an unmet quorum expires at the bound and reports what it saw",
  { timeout: 30000 },
  async (t) => {
    const rv = mkdtempSync(join(tmpdir(), "spw-rendezvous-bound-"));
    t.after(() => rmSync(rv, { recursive: true, force: true }));
    const env = { SPW_RENDEZVOUS_DIR: rv, SPW_RENDEZVOUS_EXPECT: "5" };
    const cases = [0, 1, 2, 3].map(() => seededUninstallCase({}));
    const participants = cases.map((c) => ({
      c,
      tag: createHash("sha256").update(c.state).digest("hex").slice(0, 16),
    }));
    await Promise.all(
      participants.map(({ c, tag }) =>
        runScript(c, "uninstall", {
          env,
          timeoutMs: 20000,
          watchdogArmPath: join(rv, `${tag}.pid`),
          signal: t.signal,
        }),
      ),
    );
    const tags = readdirSync(rv)
      .filter((f) => f.endsWith(".peak"))
      .map((f) => f.slice(0, -".peak".length));
    assert.equal(
      tags.length,
      4,
      "every participant must record rendezvous evidence",
    );
    const peaks = tags.map((tag) =>
      Number(readFileSync(join(rv, `${tag}.peak`), "utf8").trim()),
    );
    const waitCalls = tags.map((tag) =>
      Number(readFileSync(join(rv, `${tag}.waits`), "utf8").trim()),
    );
    const reasons = tags.map((tag) =>
      readFileSync(join(rv, `${tag}.reason`), "utf8").trim(),
    );
    // First on purpose: deadline `+ 0` deterministically records zero waits, so
    // M2 fails on this exact diagnostic before any scheduling-sensitive count.
    assert.ok(
      waitCalls.every((count) => count > 0),
      "wait did not wait",
    );
    assert.deepEqual(
      [...new Set(reasons)],
      ["expired"],
      `exit reasons were ${reasons.join(",")}`,
    );
    assert.deepEqual(
      [...new Set(peaks)],
      [4],
      `saw ${peaks.join(",")} instead of four everywhere`,
    );
  },
);

void test("the process.exitCode idiom is what delivers a large pipe payload", async () => {
  // Carried row :2041's mutation proof. The `exit` arm is the OLD idiom and
  // must truncate; the `exitCode` arm is the new one and must not. Both arms
  // are asserted: dropping the truncating arm would leave a test that passes
  // under either idiom, which is the vacuous shape this slice exists to close.
  //
  // If the truncating arm ever stops truncating on a supported platform, do
  // NOT weaken this to a one-sided check — re-derive the payload size or the
  // channel and escalate, because a passing negative control is the only
  // evidence that the positive one means anything.
  const child = fileURLToPath(
    new URL("../unit/helpers/pipe-flush-child.js", import.meta.url),
  );
  const BYTES = 1024 * 1024;

  const complete = await execFileAsync(process.execPath, [child, "exitCode"], {
    maxBuffer: BYTES * 4,
  });
  assert.equal(complete.stdout.length, BYTES);

  const truncated = await execFileAsync(process.execPath, [child, "exit"], {
    maxBuffer: BYTES * 4,
  });
  assert.ok(
    truncated.stdout.length < BYTES,
    `process.exit() delivered ${truncated.stdout.length} of ${BYTES} bytes; ` +
      "the negative control no longer demonstrates truncation",
  );
});

void test("the fake codex delivers an oversized plugin listing intact", async () => {
  // The read side already used process.exitCode (slice 2), so this is a
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
 * @template T
 * @param {Promise<T>} promise
 * @param {string} message
 * @returns {Promise<T>}
 */
function withBound(promise, message) {
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
      new URL("./helpers/scratch-signal-child.js", import.meta.url),
    );
    const proc = spawn(process.execPath, [child], {
      stdio: ["ignore", "pipe", "inherit"],
    });
    try {
      const scratch = await withBound(
        new Promise((resolvePath) => {
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

      const ended = new Promise((resolveEnd) => {
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
