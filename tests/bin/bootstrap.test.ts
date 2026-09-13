// Bootstrap configuration contract tests.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));

void test("bootstrap configuration preserves manager discovery", () => {
  const marketplace = JSON.parse(
    readFileSync(join(ROOT, ".agents/plugins/marketplace.json"), "utf8"),
  );
  assert.equal(marketplace.name, "superpowers-manager");
  const plugin = marketplace.plugins.find(
    (entry: { name: string }) => entry.name === "superpowers",
  );
  assert.ok(plugin);
  assert.deepEqual(plugin.policy.products, ["CODEX"]);

  const template = JSON.parse(
    readFileSync(
      join(ROOT, "plugins/superpowers/.codex-plugin/plugin.template.json"),
      "utf8",
    ),
  );
  assert.equal(template.name, "superpowers");
  assert.equal(template.skills, "./skills/");
  assert.equal(
    JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).type,
    "module",
  );
  assert.equal(
    readFileSync(join(ROOT, "config/upstream-ref"), "utf8").trim(),
    "latest-release",
  );
});
