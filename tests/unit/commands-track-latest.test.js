#!/usr/bin/env node
// @ts-check

import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
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
/** @type {typeof import("../../src/commands/track-latest.js")} */
const { runTrackLatest } = await import(
  new URL("../../dist/commands/track-latest.js", import.meta.url).href
);

void test("track-latest writes the record and prints one line", async () => {
  await withPackage(async (root) => {
    const out = capture();
    const status = await runTrackLatest([], {
      root: join(root, "pkg"),
      env: {
        SUPERPOWERS_CONFIG_DIR: join(root, "config"),
        SUPERPOWERS_UPSTREAM_URL: "https://example.invalid/upstream",
      },
      stdout: out.stream,
      stderr: capture().stream,
      adapter: notCalledAdapter,
    });
    assert.equal(status, 0);
    assert.equal(
      out.text(),
      "saved upstream selection: latest stable release\n",
    );
    const written = JSON.parse(
      readFileSync(join(root, "config", "selection.json"), "utf8"),
    );
    assert.deepEqual(written, {
      schema_version: 1,
      mode: "track-latest",
      source: "https://example.invalid/upstream",
    });
  });
});

void test("track-latest rejects a credential-bearing source before writing", async () => {
  await withPackage(async (root) => {
    const state = join(root, "config", "selection.json");
    const err = capture();
    const status = await runTrackLatest([], {
      root: join(root, "pkg"),
      env: {
        SUPERPOWERS_CONFIG_DIR: join(root, "config"),
        SUPERPOWERS_UPSTREAM_URL: "https://token@example.invalid/upstream",
      },
      stdout: capture().stream,
      stderr: err.stream,
      adapter: notCalledAdapter,
    });
    assert.equal(status, 1);
    assert.match(err.text(), /HTTP\(S\) source must not include userinfo/);
    assert.equal(existsSync(state), false);
  });
});

void test("track-latest refuses to overwrite a corrupt saved record", async () => {
  await withPackage(async (root) => {
    const state = join(root, "config", "selection.json");
    writeFileSync(state, "{ not json", "utf8");
    const err = capture();
    const status = await runTrackLatest([], {
      root: join(root, "pkg"),
      env: {
        SUPERPOWERS_CONFIG_DIR: join(root, "config"),
        SUPERPOWERS_UPSTREAM_URL: "https://example.invalid/upstream",
      },
      stdout: capture().stream,
      stderr: err.stream,
      adapter: notCalledAdapter,
    });
    assert.equal(status, 1);
    // src/selection-store.ts's JSON-parse-failure translation is one of
    // AGENTS.md's frozen reader wordings; pin it rather than leaving `err`
    // captured but unchecked.
    assert.equal(
      err.text(),
      `error: invalid JSON in ${state}: line 1 column 3: Expecting property name enclosed in double quotes\n`,
    );
    // The corrupt bytes survive: a fail-closed read must not have overwritten.
    assert.equal(readFileSync(state, "utf8"), "{ not json");
  });
});

void test("track-latest rejects extra arguments with exit 2", async () => {
  await withPackage(async (root) => {
    const err = capture();
    const status = await runTrackLatest(["extra"], {
      root: join(root, "pkg"),
      env: { SUPERPOWERS_CONFIG_DIR: join(root, "config") },
      stdout: capture().stream,
      stderr: err.stream,
      adapter: notCalledAdapter,
    });
    assert.equal(status, 2);
    assert.match(
      err.text(),
      /^error: usage: superpowers-manager track-latest$/m,
    );
  });
});
