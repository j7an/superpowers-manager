// @ts-check
// Support module for the workflow-contract suites. Ported from
// tests/test_workflows.sh's embedded Ruby checker and from
// tests/lib/action-pin-assertions.sh (see
// tests/migration-inventory/workflows.md for the numbered assertion
// inventory those suites map to 1:1).
//
// This is the only file in the repository that imports `yaml`.

import { readFileSync } from "node:fs";
import { parse } from "yaml";

/**
 * Parse a GitHub Actions workflow file.
 *
 * @param {string} path absolute path to a .yml/.yaml file
 * @returns {any} the parsed document
 */
export function loadWorkflow(path) {
  return parse(readFileSync(path, "utf8"));
}
