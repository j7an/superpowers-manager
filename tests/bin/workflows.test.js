// @ts-check
// Ported from tests/test_workflows.sh (see
// tests/migration-inventory/workflows.md for the numbered assertion
// inventory this file maps to 1:1).
//
// YAML is parsed by the `yaml` devDependency rather than by a hand-written
// subset parser. See
// docs/superpowers/specs/2026-08-02-pr11.1-workflow-driver-migration-design.md
// section 3.1 for that decision and its evidence.

import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { loadWorkflow } from "./workflow-support.js";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const WORKFLOW_DIR = join(ROOT, ".github", "workflows");

// --- port-only: the YAML version this project parses under --------------
void test("workflow documents parse under YAML 1.2, keeping `on` a string key", () => {
  const ci = loadWorkflow(join(WORKFLOW_DIR, "ci.yml"));

  assert.ok(
    Object.hasOwn(ci, "on"),
    "expected the string key `on` — YAML 1.2 does not coerce it",
  );
  assert.ok(
    !Object.hasOwn(ci, "true"),
    "found a boolean `true` key: the parser is applying YAML 1.1 `on` coercion",
  );
  assert.equal(typeof ci.on, "object");
});
