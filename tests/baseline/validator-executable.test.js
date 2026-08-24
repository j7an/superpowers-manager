// @ts-check
// End-to-end coverage for SUPERPOWERS_VALIDATOR_EXECUTABLE across prepare, install
// and update. A NEW suite, deliberately: tests/baseline/prepare.test.js is frozen at
// 31 call sites by tests/migration-inventory/prepare.md.
import assert from "node:assert/strict";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { createCase, runScript } from "../bin/lifecycle-fixture.js";
import { prepare } from "./prepare-fixture.js";

/** @typedef {import("../bin/lifecycle-fixture.js").CaseEnv} CaseEnv */

// `createCase` builds the fake executables and the state directory and NOTHING
// else; the listings are the case's own precondition. `prepare` never contacts
// Codex, so a prepare case needs none — but `install` and `update` probe first,
// and the INSTALL fake reads a FLAT plugin_list.json (only tests/bin/probe-fakes.js
// passes `sequencePluginList` and reads the numbered plugin_list.N.json form).
// Using the probe fakes for a lifecycle command fails at the probe, before the
// validator is ever reached.
const PLUGIN_LIST_EMPTY = '{"installed":[],"available":[]}';
const MARKETPLACE_ABSENT =
  '{"marketplaces":[{"name":"openai-curated","root":"/x"}]}';

/**
 * A case that can run `install` or `update`: install fakes plus seeded listings,
 * mirroring `installCase` in tests/bin/install-commands.test.js.
 * @returns {CaseEnv}
 */
function lifecycleCase() {
  const c = createCase({ fakes: "install", config: {} });
  writeFileSync(join(c.state, "plugin_list.json"), `${PLUGIN_LIST_EMPTY}\n`);
  writeFileSync(
    join(c.state, "marketplace_list.json"),
    `${MARKETPLACE_ABSENT}\n`,
  );
  return c;
}

/**
 * Writes an executable POSIX sh validator into the case's scratch directory.
 * @param {{ dir: string }} c
 * @param {string} name
 * @param {string} body
 * @returns {string}
 */
function writeValidator(c, name, body) {
  const p = join(c.dir, name);
  writeFileSync(p, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  return p;
}

void test("prepare accepts a tree when the executable validator exits 0", async () => {
  const c = createCase({ fakes: "probe" });
  const validator = writeValidator(c, "accept.sh", "exit 0");
  const result = await prepare(c, {
    SUPERPOWERS_VALIDATOR_EXECUTABLE: validator,
  });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /running external validator/);
});

void test("prepare rejects a tree when the executable validator exits nonzero", async () => {
  const c = createCase({ fakes: "probe" });
  const validator = writeValidator(c, "reject.sh", "echo no >&2; exit 1");
  const result = await prepare(c, {
    SUPERPOWERS_VALIDATOR_EXECUTABLE: validator,
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /external plugin validation failed/);
});

void test("a missing executable validator names itself, and still discloses", async () => {
  const c = createCase({ fakes: "probe" });
  const result = await prepare(c, {
    SUPERPOWERS_VALIDATOR_EXECUTABLE: join(c.dir, "absent"),
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /external plugin validator not found/);
  // The disclosure must survive the launch-failure path.
  assert.match(result.stdout, /running external validator/);
});

void test("install rejects a contradictory validator configuration before any network access", async () => {
  const c = lifecycleCase();
  const result = await runScript(c, "install", {
    env: {
      SUPERPOWERS_VALIDATOR: writeValidator(c, "legacy.py", "exit 0"),
      SUPERPOWERS_VALIDATOR_EXECUTABLE: writeValidator(c, "exe.sh", "exit 0"),
    },
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /both set/);
});

void test("update rejects a contradictory validator configuration before any network access", async () => {
  const c = lifecycleCase();
  const result = await runScript(c, "update", {
    env: {
      SUPERPOWERS_VALIDATOR: writeValidator(c, "legacy2.py", "exit 0"),
      SUPERPOWERS_VALIDATOR_EXECUTABLE: writeValidator(c, "exe2.sh", "exit 0"),
    },
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /both set/);
});

void test("install runs the executable validator and rejects on its nonzero exit", async () => {
  const c = lifecycleCase();
  const validator = writeValidator(
    c,
    "install-reject.sh",
    "echo no >&2; exit 1",
  );
  const result = await runScript(c, "install", {
    env: { SUPERPOWERS_VALIDATOR_EXECUTABLE: validator },
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /external plugin validation failed/);
  assert.match(result.stdout, /running external validator/);
});

void test("update runs the executable validator and rejects on its nonzero exit", async () => {
  const c = lifecycleCase();
  const validator = writeValidator(
    c,
    "update-reject.sh",
    "echo no >&2; exit 1",
  );
  const result = await runScript(c, "update", {
    env: { SUPERPOWERS_VALIDATOR_EXECUTABLE: validator },
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /external plugin validation failed/);
  assert.match(result.stdout, /running external validator/);
});

void test("a both-set rejection touches no integration state", async () => {
  // The rejection is at preflight, before any network or Codex access, so the
  // fixture's logs must be untouched. Asserting only the exit status would pass
  // even if the rejection happened after a probe.
  const c = lifecycleCase();
  const result = await runScript(c, "install", {
    env: {
      SUPERPOWERS_VALIDATOR: writeValidator(c, "l3.py", "exit 0"),
      SUPERPOWERS_VALIDATOR_EXECUTABLE: writeValidator(c, "e3.sh", "exit 0"),
    },
  });
  assert.notEqual(result.status, 0);
  assert.equal(
    existsSync(c.codexLog),
    false,
    "Codex was contacted before the rejection",
  );
});

void test("PARITY: the legacy validator is not bounded by the new timeout", async () => {
  // Sleeps well past BOUNDED_EXECUTABLE.timeoutMs. Under the unbounded policy it
  // must still succeed. If this fails, the legacy path acquired a timeout — a
  // behaviour change to CLI-ENV-VALIDATOR-01, which this PR is NOT authorized to
  // make. Stop and escalate; do not shorten the sleep.
  const c = createCase({ fakes: "probe" });
  const validator = join(c.dir, "slow.py");
  writeFileSync(validator, "import time\ntime.sleep(31)\n");
  const result = await prepare(c, { SUPERPOWERS_VALIDATOR: validator });
  assert.equal(result.status, 0);
});
