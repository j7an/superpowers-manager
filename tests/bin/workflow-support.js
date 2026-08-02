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

const PIN_SHA = /^[0-9a-f]{40}$/;
const PIN_VERSION_COMMENT = /^v[0-9]+\.[0-9]+\.[0-9]+$/;
// `[^\S\n]` is horizontal whitespace: POSIX [[:space:]] minus the newline
// the caller has already split on.
const LEADING_SEQUENCE_USES = /^[^\S\n]*-[^\S\n]+uses:[^\S\n]*/;
const LEADING_USES = /^[^\S\n]*uses:[^\S\n]*/;

/**
 * Extract the agreeing SHA pin and version comment for one action target.
 *
 * Ported 1:1 from `action_pin_pair` in tests/lib/action-pin-assertions.sh.
 * Throws unless every reference to `target` in `block` is a 40-hex lowercase
 * SHA followed by ` # vMAJOR.MINOR.PATCH`, and all of them agree.
 *
 * @param {string} block one or more lines of workflow YAML
 * @param {string} target action target without the `@ref`
 * @returns {{ sha: string, version: string }}
 */
export function actionPinPair(block, target) {
  let referenceCount = 0;
  let validCount = 0;
  let disagreed = false;
  /** @type {{ sha: string, version: string } | null} */
  let pair = null;

  for (const rawLine of block.split("\n")) {
    let line = rawLine.replace(LEADING_SEQUENCE_USES, "");
    line = line.replace(LEADING_USES, "");

    let quote = line.slice(0, 1);
    if (quote === '"' || quote === "'") {
      line = line.slice(1);
    } else {
      quote = "";
    }

    // Anchored: a target that merely *contains* the sought target, but not
    // at the start, must not match. (Note: the near-miss OSV fixture in
    // action-pins.test.js does NOT exercise this — it tests exact-target
    // matching, since target is not a substring of the near-miss line at
    // any offset. The discriminating fixture for this property is the
    // port-only "anchored prefix match" case; see
    // tests/migration-inventory/workflows.md.)
    if (line.indexOf(`${target}@`) !== 0) {
      continue;
    }
    referenceCount += 1;

    const separator = line.indexOf(" # ");
    if (separator === -1) {
      continue;
    }

    let ref = line.slice(0, separator);
    const comment = line.slice(separator + 3);

    if (quote !== "") {
      if (ref.slice(-1) !== quote) {
        continue;
      }
      ref = ref.slice(0, -1);
    }

    const sha = ref.slice(target.length + 1);
    if (!PIN_SHA.test(sha) || !PIN_VERSION_COMMENT.test(comment)) {
      continue;
    }

    if (pair === null) {
      pair = { sha, version: comment };
    } else if (sha !== pair.sha || comment !== pair.version) {
      disagreed = true;
    }
    validCount += 1;
  }

  if (
    referenceCount === 0 ||
    validCount !== referenceCount ||
    disagreed ||
    pair === null
  ) {
    throw new Error(
      `expected agreeing semantic action pins for ${target}; found ` +
        `${referenceCount} references and ${validCount} valid pins`,
    );
  }
  return pair;
}
