import assert from "node:assert/strict";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import {
  assessOpenCodeCompatibility,
  readOpenCodeReceipt,
} from "../../../../src/harnesses/opencode/package.ts";
import { snapshotReceiptBinding } from "../../../../src/snapshot-package.ts";
import { nativeOpenCodeFixture } from "../../../lib/harnesses/opencode/package-fixture.ts";
import { nativeSelection } from "../../../lib/harnesses/pi/package-fixture.ts";

void test("an unknown bootstrap is unsupported even with valid metadata", async (t) => {
  const root = nativeOpenCodeFixture(t),
    selection = nativeSelection();
  assert.equal(
    (await assessOpenCodeCompatibility(root, selection)).kind,
    "supported",
  );
  appendFileSync(
    join(root, ".opencode/plugins/superpowers.js"),
    "\n// changed\n",
  );
  assert.equal(
    (await assessOpenCodeCompatibility(root, selection)).kind,
    "unsupported",
  );
});

void test("a custom source is experimental", async (t) => {
  assert.equal(
    (
      await assessOpenCodeCompatibility(
        nativeOpenCodeFixture(t),
        nativeSelection(undefined, "https://example.invalid/superpowers"),
      )
    ).kind,
    "experimental",
  );
});

void test("runtime dependencies are unsupported with an otherwise valid entrypoint", async (t) => {
  const root = nativeOpenCodeFixture(t);
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({
      name: "superpowers",
      version: "6.3.0",
      type: "module",
      main: ".opencode/plugins/superpowers.js",
      dependencies: { uninstalled: "1.0.0" },
    }),
  );
  assert.equal(
    (await assessOpenCodeCompatibility(root, nativeSelection())).kind,
    "unsupported",
  );
});

void test("an escaping entrypoint is unsupported without dependencies", async (t) => {
  const root = nativeOpenCodeFixture(t);
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({ ...pkg, main: "../outside.js" }),
  );
  assert.equal(
    (await assessOpenCodeCompatibility(root, nativeSelection())).kind,
    "unsupported",
  );
});

void test("an invalid native skill is unsupported", async (t) => {
  const root = nativeOpenCodeFixture(t);
  writeFileSync(
    join(root, "skills/using-superpowers/SKILL.md"),
    "not a skill\n",
  );
  assert.equal(
    (await assessOpenCodeCompatibility(root, nativeSelection())).kind,
    "unsupported",
  );
});

void test("rejects receipt compatibility without a valid discriminant shape", async (t) => {
  const root = nativeOpenCodeFixture(t);
  const identity = {
    schema: 1,
    manager: "superpowers-manager",
    harness: "opencode",
    source: "https://github.com/obra/superpowers",
    commit: "1".repeat(40),
    digest: "2".repeat(64),
  } as const;
  writeFileSync(
    join(root, ".superpowers-manager.json"),
    JSON.stringify({
      ...identity,
      binding: snapshotReceiptBinding(identity),
      compatibility: { kind: "supported", reason: "missing generation" },
    }),
  );
  await assert.rejects(
    readOpenCodeReceipt(root),
    /invalid OpenCode artifact receipt/,
  );
});
