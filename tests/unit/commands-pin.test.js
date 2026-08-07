#!/usr/bin/env node
// @ts-check

import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { capture, withGitUpstream } from "./helpers/command-harness.js";

// A static import from `dist/` fails the `typecheck:js` gate: dist output has
// no accompanying .d.ts, so checkJs treats every parameter along the chain as
// implicit `any`. Load the built module dynamically while typing it against
// its `src/` source instead. Convention documented at
// tests/unit/manifest-overlay.test.js:5-7.
/** @type {typeof import("../../src/commands/pin.js")} */
const { runPin } = await import(
  new URL("../../dist/commands/pin.js", import.meta.url).href
);

void test("a tag pin writes the resolved record and prints the confirmation", async () => {
  await withGitUpstream(async ({ pkgRoot, configDir, upstream, tagCommit }) => {
    const out = capture();
    const status = await runPin(["v1.0.0"], {
      root: pkgRoot,
      env: {
        SUPERPOWERS_CONFIG_DIR: configDir,
        SUPERPOWERS_UPSTREAM_URL: upstream,
      },
      stdout: out.stream,
      stderr: capture().stream,
    });
    assert.equal(status, 0);
    assert.equal(
      out.text(),
      `pinned upstream selection to v1.0.0 at ${tagCommit}\n`,
    );
    const written = JSON.parse(
      readFileSync(join(configDir, "selection.json"), "utf8"),
    );
    assert.equal(written.mode, "pinned");
    assert.equal(written.requested_ref, "v1.0.0");
    assert.equal(written.commit, tagCommit);
  });
});

void test("a mixed-case 40-hex ref is lowercased in the written record", async () => {
  await withGitUpstream(async ({ pkgRoot, configDir, upstream, tagCommit }) => {
    // Guards against this test silently becoming a tautology on a
    // (vanishingly unlikely, but not impossible) all-digit commit SHA, where
    // .toUpperCase() would be a no-op and every assertion below would pass
    // whether or not runPin actually lowercased anything.
    assert.notEqual(tagCommit.toUpperCase(), tagCommit);
    const status = await runPin([tagCommit.toUpperCase()], {
      root: pkgRoot,
      env: {
        SUPERPOWERS_CONFIG_DIR: configDir,
        SUPERPOWERS_UPSTREAM_URL: upstream,
      },
      stdout: capture().stream,
      stderr: capture().stream,
    });
    assert.equal(status, 0);
    const written = JSON.parse(
      readFileSync(join(configDir, "selection.json"), "utf8"),
    );
    assert.equal(written.requested_ref, tagCommit); // already lowercase
    assert.equal(written.commit, tagCommit);
  });
});

void test("an invalid saved record rejects before any resolution", async () => {
  await withGitUpstream(async ({ pkgRoot, configDir, upstream }) => {
    const state = join(configDir, "selection.json");
    writeFileSync(state, "{ not json", "utf8");
    const err = capture();
    const status = await runPin(["v1.0.0"], {
      root: pkgRoot,
      env: {
        SUPERPOWERS_CONFIG_DIR: configDir,
        SUPERPOWERS_UPSTREAM_URL: upstream,
      },
      stdout: capture().stream,
      stderr: err.stream,
    });
    assert.equal(status, 1);
    // src/selection-store.ts's JSON-parse-failure translation is one of
    // AGENTS.md's frozen reader wordings; pin it rather than leaving `err`
    // captured but unchecked.
    assert.equal(
      err.text(),
      `error: invalid JSON in ${state}: line 1 column 3: Expecting property name enclosed in double quotes\n`,
    );
    assert.equal(readFileSync(state, "utf8"), "{ not json");
  });
});

void test("a source that cannot supply the commit fails and writes nothing", async () => {
  await withGitUpstream(async ({ pkgRoot, configDir, upstream }) => {
    const absent = "c".repeat(40);
    const err = capture();
    const status = await runPin([absent], {
      root: pkgRoot,
      env: {
        SUPERPOWERS_CONFIG_DIR: configDir,
        SUPERPOWERS_UPSTREAM_URL: upstream,
      },
      stdout: capture().stream,
      stderr: err.stream,
    });
    assert.equal(status, 1);
    assert.match(err.text(), /source cannot supply requested commit/);
    assert.equal(existsSync(join(configDir, "selection.json")), false);
  });
});
