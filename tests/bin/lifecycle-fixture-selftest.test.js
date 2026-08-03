// @ts-check
// Temporary: proves the fixture builder before either port depends on it.
// Deleted in Task 2 once the uninstall port exercises the same paths.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  SCRATCH,
  UPSTREAM,
  assertOrder,
  createCase,
  firstIndex,
  lastIndex,
  readLog,
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
    config: { pluginRemove: "noop" },
  });
  const written = JSON.parse(
    readFileSync(join(c.state, "config.json"), "utf8"),
  );
  assert.equal(written.pluginRemove, "noop");
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
