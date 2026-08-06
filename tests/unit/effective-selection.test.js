#!/usr/bin/env node
// @ts-check

import assert from "node:assert/strict";
import test from "node:test";

// A static import from `dist/` fails the `typecheck:js` gate: dist output has
// no accompanying .d.ts, so checkJs treats every parameter along the chain as
// implicit `any`. Load the built module dynamically while typing it against
// its `src/` source instead.
/** @type {typeof import("../../src/effective-selection.js")} */
const { selectionConfigDir, selectionStatePath } = await import(
  new URL("../../dist/effective-selection.js", import.meta.url).href
);

void test("selection config dir honours SUPERPOWERS_CONFIG_DIR first", () => {
  assert.equal(
    selectionConfigDir({
      SUPERPOWERS_CONFIG_DIR: "/explicit",
      XDG_CONFIG_HOME: "/xdg",
      HOME: "/home/user",
    }),
    "/explicit",
  );
});

void test("selection config dir falls back to XDG then HOME", () => {
  assert.equal(
    selectionConfigDir({ XDG_CONFIG_HOME: "/xdg", HOME: "/home/user" }),
    "/xdg/superpowers-manager",
  );
  assert.equal(
    selectionConfigDir({ HOME: "/home/user" }),
    "/home/user/.config/superpowers-manager",
  );
});

void test("an empty SUPERPOWERS_CONFIG_DIR is present and therefore rejected", () => {
  // The shell tested presence with ${SUPERPOWERS_CONFIG_DIR+x}, so an empty
  // value selects this branch and then fails the absolute-path check. An
  // emptiness test here would silently fall through to XDG instead.
  assert.throws(
    () =>
      selectionConfigDir({ SUPERPOWERS_CONFIG_DIR: "", HOME: "/home/user" }),
    { module: "selection", message: "SUPERPOWERS_CONFIG_DIR must be absolute" },
  );
});

void test("each base rejects a relative path with its own diagnostic", () => {
  assert.throws(
    () => selectionConfigDir({ SUPERPOWERS_CONFIG_DIR: "relative" }),
    { module: "selection", message: "SUPERPOWERS_CONFIG_DIR must be absolute" },
  );
  assert.throws(
    () => selectionConfigDir({ XDG_CONFIG_HOME: "relative", HOME: "/home/u" }),
    { module: "selection", message: "XDG_CONFIG_HOME must be absolute" },
  );
  assert.throws(() => selectionConfigDir({ HOME: "relative" }), {
    module: "selection",
    message: "HOME must be absolute",
  });
  assert.throws(() => selectionConfigDir({}), {
    module: "selection",
    message: "HOME is required to locate selection state",
  });
});

void test("the state path appends selection.json to the config dir", () => {
  assert.equal(
    selectionStatePath({ SUPERPOWERS_CONFIG_DIR: "/explicit" }),
    "/explicit/selection.json",
  );
});
