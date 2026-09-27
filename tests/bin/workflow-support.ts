// Support module for the workflow-contract suites. Ported from
// tests/test_workflows.sh's embedded Ruby checker and from
// tests/lib/action-pin-assertions.sh.

import { readFileSync } from "node:fs";

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
 */
export function findLiteralActionPinSnapshots(paths: string[]): string[] {
  const findings: string[] = [];

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
 */
export function usesTarget(value: unknown, path: string): string {
  if (typeof value !== "string") {
    throw new TypeError(`expected string at ${path}, got ${typeof value}`);
  }
  return value.split("@")[0];
}

/**
 * Collect every external (non `./`) action target in a parsed document.
 *
 * Ported 1:1 from `collect_external_targets` in the shell driver's Ruby
 * checker (`git show 6c9f042a3e0b9b88bf9619cddef6e9b810a82189:tests/test_workflows.sh:212-230::def collect_external_targets`).
 *
 */
export function collectExternalTargets(value: unknown, path: string): string[] {
  const targets: string[] = [];

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
 * Ported 1:1 from `unique_step_target_index` (`git show 6c9f042a3e0b9b88bf9619cddef6e9b810a82189:tests/test_workflows.sh:32-43::def unique_step_target_index`).
 *
 */
export function uniqueStepTargetIndex(
  steps: unknown[],
  target: string,
): number {
  const matches: number[] = [];
  steps.forEach((step, index) => {
    if (step === null || typeof step !== "object") return;
    const uses = (step as Record<string, unknown>).uses;
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

const FORBIDDEN_PUBLISH_CONFIG =
  /--provenance|npm_config_provenance|npm(?:[_ -]?token)|node_auth_token|npm-bootstrap|superpowers-wrapper|npm publish|--tag next/i;

/**
 * Throw if any key or string value carries forbidden publish configuration.
 *
 * Ported 1:1 from `assert_no_forbidden` (`git show 6c9f042a3e0b9b88bf9619cddef6e9b810a82189:tests/test_workflows.sh:197-210::def assert_no_forbidden`),
 * including its recursion over mapping keys as well as values.
 *
 */
export function assertNoForbidden(
  value: unknown,
  path: string = "workflow",
): void {
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
