import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { shQuote } from "../lib/git-egress.ts";
import { resolvePackageNode } from "../lib/package-runtime.ts";

const engine = JSON.parse(
  readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
).engines.node;
const floor = `${/^>=(\d+)$/.exec(engine)![1]}.0.0`;

function shellDouble(t: import("node:test").TestContext, body: string): string {
  const root = mkdtempSync(join(tmpdir(), "spw-package-runtime-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const binary = join(root, "node");
  writeFileSync(binary, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  return binary;
}

void test("optional package runtime may be absent", () => {
  assert.equal(resolvePackageNode({}, false, engine), undefined);
});

void test("required package runtime rejects absent evidence", () => {
  assert.throws(
    () => resolvePackageNode({}, true, engine),
    /SPW_PACKAGE_NODE and SPW_PACKAGE_NODE_VERSION are required together/,
  );
});

void test("package runtime evidence rejects partial environment pairs", () => {
  for (const env of [
    { SPW_PACKAGE_NODE: "/absolute/node" },
    { SPW_PACKAGE_NODE_VERSION: floor },
    { SPW_PACKAGE_NODE: "", SPW_PACKAGE_NODE_VERSION: floor },
    { SPW_PACKAGE_NODE: "/absolute/node", SPW_PACKAGE_NODE_VERSION: "" },
  ]) {
    assert.throws(
      () => resolvePackageNode(env, false, engine),
      /SPW_PACKAGE_NODE and SPW_PACKAGE_NODE_VERSION are required together/,
    );
  }
});

void test("package runtime evidence requires an absolute executable path", () => {
  assert.throws(
    () =>
      resolvePackageNode(
        { SPW_PACKAGE_NODE: "relative/node", SPW_PACKAGE_NODE_VERSION: floor },
        false,
        engine,
      ),
    /SPW_PACKAGE_NODE must be an absolute executable path/,
  );
});

void test("package runtime rejects unavailable and invalid executable paths", (t) => {
  const root = mkdtempSync(join(tmpdir(), "spw-package-runtime-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const binary of [
    join(root, "missing-node"),
    `${join(root, "node")}\0bad`,
  ]) {
    assert.throws(
      () =>
        resolvePackageNode(
          { SPW_PACKAGE_NODE: binary, SPW_PACKAGE_NODE_VERSION: floor },
          false,
          engine,
        ),
      /SPW_PACKAGE_NODE could not be verified/,
    );
  }
});

void test("package runtime rejects a nonzero version probe without leaking output", (t) => {
  const binary = shellDouble(
    t,
    `printf '%s\\n' ${shQuote("private stdout")}\nprintf '%s\\n' ${shQuote("private stderr")} >&2\nexit 7`,
  );
  assert.throws(
    () =>
      resolvePackageNode(
        { SPW_PACKAGE_NODE: binary, SPW_PACKAGE_NODE_VERSION: floor },
        false,
        engine,
      ),
    (error: unknown) => {
      assert.match(String(error), /SPW_PACKAGE_NODE could not be verified/);
      assert.doesNotMatch(
        String(error),
        /private stdout|private stderr|exit 7/,
      );
      return true;
    },
  );
});

void test("package runtime rejects an advertised version above the package minimum", (t) => {
  const binary = shellDouble(t, `printf '%s\\n' ${shQuote(`v${floor}`)}`);
  assert.throws(
    () =>
      resolvePackageNode(
        { SPW_PACKAGE_NODE: binary, SPW_PACKAGE_NODE_VERSION: "24.1.0" },
        false,
        engine,
      ),
    /SPW_PACKAGE_NODE_VERSION must match the declared package minimum/,
  );
});

void test("package runtime rejects unsupported package engine declarations", (t) => {
  const binary = shellDouble(t, `printf '%s\\n' ${shQuote(`v${floor}`)}`);
  for (const packageEngine of [undefined, 24, "^24", ">=24.0.0"]) {
    assert.throws(
      () =>
        resolvePackageNode(
          { SPW_PACKAGE_NODE: binary, SPW_PACKAGE_NODE_VERSION: floor },
          false,
          packageEngine,
        ),
      /package.json engines.node does not declare a supported package minimum/,
    );
  }
});

void test("package runtime rejects a different observed version", (t) => {
  const binary = shellDouble(t, `printf '%s\\n' ${shQuote("v24.0.1")}`);
  assert.throws(
    () =>
      resolvePackageNode(
        { SPW_PACKAGE_NODE: binary, SPW_PACKAGE_NODE_VERSION: floor },
        false,
        engine,
      ),
    /SPW_PACKAGE_NODE does not report the declared package minimum/,
  );
});

void test("package runtime rejects extra version probe output", (t) => {
  const binary = shellDouble(
    t,
    `printf '%s\\n' ${shQuote(`v${floor}`)} ${shQuote("unexpected")}`,
  );
  assert.throws(
    () =>
      resolvePackageNode(
        { SPW_PACKAGE_NODE: binary, SPW_PACKAGE_NODE_VERSION: floor },
        false,
        engine,
      ),
    /SPW_PACKAGE_NODE does not report the declared package minimum/,
  );
});

void test("package runtime rejects version probe stderr without leaking it", (t) => {
  const binary = shellDouble(
    t,
    `printf '%s\\n' ${shQuote(`v${floor}`)}\nprintf '%s\\n' ${shQuote("private stderr")} >&2`,
  );
  assert.throws(
    () =>
      resolvePackageNode(
        { SPW_PACKAGE_NODE: binary, SPW_PACKAGE_NODE_VERSION: floor },
        false,
        engine,
      ),
    (error: unknown) => {
      assert.match(
        String(error),
        /SPW_PACKAGE_NODE does not report the declared package minimum/,
      );
      assert.doesNotMatch(String(error), /private stderr/);
      return true;
    },
  );
});

void test("package runtime accepts matching executable evidence", (t) => {
  const binary = shellDouble(t, `printf '%s\\n' ${shQuote(`v${floor}`)}`);
  assert.equal(
    resolvePackageNode(
      { SPW_PACKAGE_NODE: binary, SPW_PACKAGE_NODE_VERSION: floor },
      true,
      engine,
    ),
    binary,
  );
});
