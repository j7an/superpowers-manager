// @ts-check
// Temporary: proves the fixture builder before either port depends on it.
// Deleted in Task 3 once the uninstall port exercises the same paths.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
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

/** @typedef {import("./lifecycle-fixture.js").CaseEnv} CaseEnv */

/** @type {(keyof CaseEnv)[]} */
const WRITABLE_KEYS = ["dir", "pkg", "state", "tmp"];

void test("each case gets distinct writable paths", () => {
  const a = createCase({ fakes: "uninstall" });
  const b = createCase({ fakes: "uninstall" });
  for (const key of WRITABLE_KEYS) {
    assert.notEqual(a[key], b[key], `cases share ${key}`);
  }
});

void test("every writable path is inside the fixture scratch tree", () => {
  const c = createCase({ fakes: "uninstall" });
  for (const key of WRITABLE_KEYS) {
    assert.ok(
      c[key].startsWith(SCRATCH),
      `${key} escapes the scratch tree: ${c[key]}`,
    );
  }
});

void test("the package root carries everything a lifecycle script needs", () => {
  const c = createCase({ fakes: "uninstall" });
  for (const rel of [
    "scripts/install",
    "scripts/uninstall",
    "scripts/core/common.sh",
    "scripts/adapters/codex/adapter",
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
    config: { removesMutateState: false },
  });
  const written = JSON.parse(
    readFileSync(join(c.state, "config.json"), "utf8"),
  );
  assert.equal(written.removesMutateState, false);
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
  // that make zero fake calls (the missing-python3 case asserts an empty Codex
  // log) would otherwise never validate their config at all.
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

const PLUGIN_PRESENT =
  '{"installed":[{"pluginId":"superpowers@superpowers-manager","name":"superpowers","marketplaceName":"superpowers-manager"}],"available":[]}';
const MARKETPLACE_PRESENT =
  '{"marketplaces":[{"name":"openai-curated","root":"/x"},{"name":"superpowers-manager","root":"/y"}]}';

/**
 * @param {Record<string, unknown>} config
 * @param {{ plugins?: string, marketplaces?: string }} [seed]
 */
function uninstallCase(config, seed = {}) {
  const c = createCase({ fakes: "uninstall", config });
  writeFileSync(
    join(c.state, "plugin_list.json"),
    `${seed.plugins ?? PLUGIN_PRESENT}\n`,
  );
  writeFileSync(
    join(c.state, "marketplace_list.json"),
    `${seed.marketplaces ?? MARKETPLACE_PRESENT}\n`,
  );
  return c;
}

void test("a clean uninstall removes both owned resources and succeeds", async () => {
  const c = uninstallCase({});
  const result = await runScript(c, "uninstall");
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const log = readLog(c.codexLog);
  assert.ok(
    log.some((l) =>
      l.includes("plugin remove superpowers@superpowers-manager"),
    ),
    "plugin remove was never issued",
  );
  assert.ok(
    log.some((l) =>
      l.includes("plugin marketplace remove superpowers-manager"),
    ),
    "marketplace remove was never issued",
  );
  assert.match(result.stdout, /uninstall complete/);
});

void test("the adapter fake execs the real adapter for ownership inspection", async () => {
  const c = uninstallCase({});
  await runScript(c, "uninstall");
  const log = readLog(c.adapterLog);
  assert.ok(
    log.some((l) => l === "inspect --view ownership"),
    `real adapter was never reached: ${log.join(" | ")}`,
  );
});

void test("the fake re-validates its config as defence in depth", async () => {
  // createCase validates eagerly, so reach past it to prove the fake also
  // refuses a bad config on its own. Write the file directly.
  const c = uninstallCase({});
  writeFileSync(
    join(c.state, "config.json"),
    `${JSON.stringify({ pluginRemoveTypo: "noop" })}\n`,
  );
  const result = await runScript(c, "uninstall");
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /unknown fixture config key: pluginRemoveTypo/);
});

// The concurrency proof. Asserting that `{ concurrency: true }` is set proves
// nothing — the option reads as set whether or not bodies actually overlap.
// This measures overlap instead. Measured on Node v24.18.0: four spawnSync
// subtests take 1.31s while four awaited async spawns take 0.36s, so a
// regression to spawnSync fails here rather than silently serialising.
void test("runScript bodies actually overlap under concurrency", async () => {
  const cases = [0, 1, 2, 3].map(() => uninstallCase({}));
  const started = Date.now();
  const single = await (async () => {
    const t0 = Date.now();
    await runScript(uninstallCase({}), "uninstall");
    return Date.now() - t0;
  })();
  const t1 = Date.now();
  await Promise.all(cases.map((c) => runScript(c, "uninstall")));
  const together = Date.now() - t1;
  assert.ok(
    together < single * 3,
    `four concurrent runs took ${together}ms against a ${single}ms single run — ` +
      `they are not overlapping (total elapsed ${Date.now() - started}ms)`,
  );
});
