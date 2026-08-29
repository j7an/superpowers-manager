#!/usr/bin/env node
// @ts-check

import assert from "node:assert/strict";
import { chmodSync, writeFileSync, symlinkSync, existsSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import {
  capture,
  notCalledAdapter,
  withPackage,
} from "./helpers/command-harness.js";

// A static import from `dist/` fails the `typecheck:js` gate: dist output has
// no accompanying .d.ts, so checkJs treats every parameter along the chain as
// implicit `any`. Load the built module dynamically while typing it against
// its `src/` source instead. Convention documented at
// `tests/unit/manifest-overlay.test.js:5-7::typecheck`.
/** @type {typeof import("../../src/commands/unpin.js")} */
const { runUnpin } = await import(
  new URL("../../dist/commands/unpin.js", import.meta.url).href
);

void test("unpin removes an existing selection and names the packaged fallback", async () => {
  await withPackage(async (root) => {
    const state = join(root, "config", "selection.json");
    writeFileSync(state, "{}", "utf8");
    const out = capture();
    const status = await runUnpin([], {
      root: join(root, "pkg"),
      env: { SUPERPOWERS_CONFIG_DIR: join(root, "config") },
      stdout: out.stream,
      stderr: capture().stream,
      adapter: notCalledAdapter,
    });
    assert.equal(status, 0);
    assert.equal(existsSync(state), false);
    assert.equal(
      out.text(),
      "removed saved upstream selection; packaged fallback is v6.1.1\n",
    );
  });
});

void test("unpin reports the fallback when no selection was saved", async () => {
  await withPackage(async (root) => {
    const out = capture();
    const status = await runUnpin([], {
      root: join(root, "pkg"),
      env: { SUPERPOWERS_CONFIG_DIR: join(root, "config") },
      stdout: out.stream,
      stderr: capture().stream,
      adapter: notCalledAdapter,
    });
    assert.equal(status, 0);
    assert.equal(
      out.text(),
      "no saved upstream selection; packaged fallback is v6.1.1\n",
    );
  });
});

void test("unpin refuses a symlinked state path instead of following it", async () => {
  await withPackage(async (root) => {
    const target = join(root, "elsewhere.json");
    writeFileSync(target, "{}", "utf8");
    const state = join(root, "config", "selection.json");
    symlinkSync(target, state);
    const err = capture();
    const status = await runUnpin([], {
      root: join(root, "pkg"),
      env: { SUPERPOWERS_CONFIG_DIR: join(root, "config") },
      stdout: capture().stream,
      stderr: err.stream,
      adapter: notCalledAdapter,
    });
    assert.equal(status, 1);
    assert.match(err.text(), /selection state path is not a regular file/);
    // The symlink target must survive: refusing means refusing, not unlinking.
    assert.equal(existsSync(target), true);
  });
});

void test("unpin reports active overrides after removal", async () => {
  await withPackage(async (root) => {
    const out = capture();
    await runUnpin([], {
      root: join(root, "pkg"),
      env: {
        SUPERPOWERS_CONFIG_DIR: join(root, "config"),
        SUPERPOWERS_REF: "v9.9.9",
        SUPERPOWERS_UPSTREAM_URL: "https://example.invalid/u",
      },
      stdout: out.stream,
      stderr: capture().stream,
      adapter: notCalledAdapter,
    });
    // The fallback is the packaged ref, not the override.
    assert.match(out.text(), /packaged fallback is v6\.1\.1\n/);
    assert.match(
      out.text(),
      /^note: active SUPERPOWERS_REF override remains effective$/m,
    );
    assert.match(
      out.text(),
      /^note: active SUPERPOWERS_UPSTREAM_URL override remains effective$/m,
    );
  });
});

void test("unpin fails closed when the state path cannot be inspected", async () => {
  if (process.getuid?.() === 0) return; // permission checks do not apply to root
  await withPackage(async (root) => {
    const dir = join(root, "config");
    chmodSync(dir, 0o000);
    try {
      const err = capture();
      const status = await runUnpin([], {
        root: join(root, "pkg"),
        env: { SUPERPOWERS_CONFIG_DIR: dir },
        stdout: capture().stream,
        stderr: err.stream,
        adapter: notCalledAdapter,
      });
      // Not "no saved upstream selection" and not exit 0: unverifiable state is
      // never reported as success.
      assert.equal(status, 1);
      assert.match(err.text(), /cannot inspect selection state: /);
    } finally {
      chmodSync(dir, 0o700);
    }
  });
});
