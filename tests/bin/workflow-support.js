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
 * Parse a GitHub Actions workflow document from its YAML source text.
 *
 * This is the only function in the repository that calls `yaml`'s `parse`
 * directly. Callers that need to construct a document from a string (rather
 * than reading it from a file) go through this wrapper instead of importing
 * `yaml` themselves, so `yaml` stays imported in exactly one file.
 *
 * @param {string} source YAML document text
 * @returns {any} the parsed document
 */
export function parseWorkflow(source) {
  return parse(source);
}

/**
 * Parse a GitHub Actions workflow file.
 *
 * @param {string} path absolute path to a .yml/.yaml file
 * @returns {any} the parsed document
 */
export function loadWorkflow(path) {
  return parseWorkflow(readFileSync(path, "utf8"));
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

const PIN_CANDIDATE = /[A-Za-z0-9_.-]+\/[A-Za-z0-9_./-]+@[0-9A-Fa-f]+/;
// POSIX [[:space:]] plus [[:punct:]] — ASCII 33-47, 58-64, 91-96, 123-126.
const PIN_BOUNDARY = /[\s\x21-\x2f\x3a-\x40\x5b-\x60\x7b-\x7e]/;

/**
 * Report every line containing a literal 40-hex action pin.
 *
 * Ported 1:1 from `find_literal_action_pin_snapshots` in
 * tests/lib/action-pin-assertions.sh. At most one finding per line, matching
 * awk's `next`.
 *
 * @param {string[]} paths files to scan
 * @returns {string[]} entries shaped `${path}:${lineNumber}:${line}`
 */
export function findLiteralActionPinSnapshots(paths) {
  /** @type {string[]} */
  const findings = [];

  for (const path of paths) {
    const lines = readFileSync(path, "utf8").split("\n");
    if (lines.at(-1) === "") {
      lines.pop();
    }

    lines.forEach((line, index) => {
      let remaining = line;
      for (;;) {
        const match = PIN_CANDIDATE.exec(remaining);
        if (match === null) {
          return;
        }
        const candidate = match[0];
        const suffix = remaining.slice(match.index + candidate.length);
        const sha = candidate.slice(candidate.indexOf("@") + 1);
        const delimiter = suffix.slice(0, 1);
        if (
          sha.length === 40 &&
          (delimiter === "" || PIN_BOUNDARY.test(delimiter))
        ) {
          findings.push(`${path}:${index + 1}:${line}`);
          return;
        }
        remaining = suffix;
      }
    });
  }

  return findings;
}

/**
 * Extract the action target from a `uses:` value, dropping any `@ref`.
 *
 * @param {unknown} value
 * @param {string} path diagnostic path for the error message
 * @returns {string}
 */
export function usesTarget(value, path) {
  if (typeof value !== "string") {
    throw new TypeError(`expected string at ${path}, got ${typeof value}`);
  }
  return value.split("@")[0];
}

/**
 * Collect every external (non `./`) action target in a parsed document.
 *
 * Ported 1:1 from `collect_external_targets` in the shell driver's Ruby
 * checker (tests/test_workflows.sh:212-230).
 *
 * @param {unknown} value parsed workflow or subtree
 * @param {string} path diagnostic path
 * @returns {string[]}
 */
export function collectExternalTargets(value, path) {
  /** @type {string[]} */
  const targets = [];

  if (Array.isArray(value)) {
    value.forEach((child, index) => {
      targets.push(...collectExternalTargets(child, `${path}[${index}]`));
    });
    return targets;
  }

  if (value !== null && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      if (key === "uses") {
        const target = usesTarget(child, `${path}.uses`);
        if (!String(child).startsWith("./")) {
          targets.push(target);
        }
      }
      targets.push(...collectExternalTargets(child, `${path}.${key}`));
    }
  }

  return targets;
}

/**
 * Index of the single step whose `uses:` names `target`.
 *
 * Ported 1:1 from `unique_step_target_index` (tests/test_workflows.sh:32-43).
 *
 * @param {unknown[]} steps
 * @param {string} target
 * @returns {number}
 */
export function uniqueStepTargetIndex(steps, target) {
  /** @type {number[]} */
  const matches = [];
  steps.forEach((step, index) => {
    if (step === null || typeof step !== "object") return;
    const uses = /** @type {Record<string, unknown>} */ (step).uses;
    if (typeof uses !== "string") return;
    if (usesTarget(uses, `steps[${index}].uses`) === target) {
      matches.push(index);
    }
  });
  if (matches.length !== 1) {
    throw new Error(
      `expected exactly one step using ${JSON.stringify(target)}, found ${matches.length}`,
    );
  }
  return matches[0];
}

/**
 * Index of the single step whose `run:` equals `command` exactly.
 *
 * Ported 1:1 from `unique_run_step_index` (tests/test_workflows.sh:45-54).
 *
 * @param {unknown[]} steps
 * @param {string} command
 * @returns {number}
 */
export function uniqueRunStepIndex(steps, command) {
  /** @type {number[]} */
  const matches = [];
  steps.forEach((step, index) => {
    if (step === null || typeof step !== "object") return;
    if (/** @type {Record<string, unknown>} */ (step).run === command) {
      matches.push(index);
    }
  });
  if (matches.length !== 1) {
    throw new Error(
      `expected exactly one run step ${JSON.stringify(command)}, found ${matches.length}`,
    );
  }
  return matches[0];
}

const FORBIDDEN_PUBLISH_CONFIG =
  /--provenance|npm_config_provenance|npm(?:[_ -]?token)|node_auth_token|npm-bootstrap|superpowers-wrapper|npm publish|--tag next/i;

/**
 * Throw if any key or string value carries forbidden publish configuration.
 *
 * Ported 1:1 from `assert_no_forbidden` (tests/test_workflows.sh:197-210),
 * including its recursion over mapping keys as well as values.
 *
 * @param {unknown} value
 * @param {string} [path]
 * @returns {void}
 */
export function assertNoForbidden(value, path = "workflow") {
  if (Array.isArray(value)) {
    value.forEach((child, index) =>
      assertNoForbidden(child, `${path}[${index}]`),
    );
    return;
  }

  if (value !== null && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      assertNoForbidden(key, `${path}.<key>`);
      assertNoForbidden(child, `${path}.${key}`);
    }
    return;
  }

  if (typeof value === "string" && FORBIDDEN_PUBLISH_CONFIG.test(value)) {
    throw new Error(
      `forbidden publish configuration at ${path}: ${JSON.stringify(value)}`,
    );
  }
}
