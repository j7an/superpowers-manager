// @ts-check
// Temporary: proves the install fakes before the port depends on them.
// Deleted in Task 7.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createCase, readLog, runScript } from "./lifecycle-fixture.js";

const MARKETPLACE_ABSENT =
  '{"marketplaces":[{"name":"openai-curated","root":"/x"}]}';

/** @param {Record<string, unknown>} config */
function installCase(config) {
  const c = createCase({ fakes: "install", config });
  writeFileSync(
    join(c.state, "plugin_list.json"),
    '{"installed":[],"available":[]}\n',
  );
  writeFileSync(
    join(c.state, "marketplace_list.json"),
    `${MARKETPLACE_ABSENT}\n`,
  );
  return c;
}

void test("a fresh install prepares, registers, and reports success", async () => {
  const c = installCase({});
  const result = await runScript(c, "install");
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /manager updated/);
});

void test("an unknown config key is rejected eagerly by createCase", () => {
  assert.throws(
    () => installCase({ pluginAdd: "ok", plugonAdd: "fail" }),
    /unknown fixture config key: plugonAdd/,
  );
});

void test("managed-then-unsupported answers differently on the second call", async () => {
  const c = installCase({ updateControl: "managed-then-unsupported" });
  const result = await runScript(c, "install");
  assert.notEqual(result.status, 0, "capability drift must be rejected");
  assert.equal(
    Number(readFileSync(join(c.state, "update-control-count"), "utf8").trim()),
    2,
    "update control must be inspected exactly twice",
  );
});

void test("the adapter fake execs the real adapter for build and install", async () => {
  const c = installCase({});
  await runScript(c, "install");
  const log = readLog(c.adapterLog);
  assert.ok(
    log.some((l) => l.includes("install --package-root")),
    `real adapter install was never reached: ${log.join(" | ")}`,
  );
});
