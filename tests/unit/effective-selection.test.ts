#!/usr/bin/env node

import assert from "node:assert/strict";
import test from "node:test";

import { selectionStatePath } from "../../src/effective-selection.ts";

void test("the state path appends selection.json to the config dir", () => {
  assert.equal(
    selectionStatePath({ SUPERPOWERS_CONFIG_DIR: "/explicit" }),
    "/explicit/selection.json",
  );
});
