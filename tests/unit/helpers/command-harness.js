// @ts-check
// Shared harness for src/commands/*.ts unit tests. Extracted from
// tests/unit/commands-unpin.test.js (PR 11.5 Task 6) so later command tests
// (e.g. track-latest, pin) do not redefine copies that could quietly drift
// from one another.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * A minimal writable-stream stand-in that records every chunk written to it,
 * for asserting exact CLI output without touching real stdout/stderr.
 * @returns {{ stream: any, text: () => string }}
 */
export function capture() {
  /** @type {string[]} */
  const chunks = [];
  return {
    stream: /** @type {any} */ ({
      write: (/** @type {string} */ s) => {
        chunks.push(s);
        return true;
      },
    }),
    text: () => chunks.join(""),
  };
}

// async + `return await` for the same reason as withConfigDir below: a bare
// `return fn(root)` hands back a pending promise, and the `finally` block's
// rmSync then deletes the fixture before the callback has actually read it.
/**
 * A package root with a packaged `config/upstream-ref` (for readConfigRef)
 * and an empty `config/` directory (for SUPERPOWERS_CONFIG_DIR) under a
 * shared scratch root.
 * @template T
 * @param {(root: string) => Promise<T>} fn
 * @returns {Promise<T>}
 */
export async function withPackage(fn) {
  const root = mkdtempSync(join(tmpdir(), "spw-cmd-"));
  try {
    mkdirSync(join(root, "pkg", "config"), { recursive: true });
    writeFileSync(
      join(root, "pkg", "config", "upstream-ref"),
      "v6.1.1\n",
      "utf8",
    );
    mkdirSync(join(root, "config"), { recursive: true });
    return await fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// MUST be async with `return await`. A synchronous `return fn(...)` hands back
// a pending promise and `finally` then runs rmSync immediately, deleting the
// fixture before the callback has read it. Matches
// tests/unit/effective-selection.test.js's withConfigDir.
/**
 * A bare SUPERPOWERS_CONFIG_DIR, optionally pre-seeded with a
 * `selection.json`, with no packaged root alongside it.
 * @template T
 * @param {string | null} contents
 * @param {(env: NodeJS.ProcessEnv) => Promise<T>} fn
 * @returns {Promise<T>}
 */
export async function withConfigDir(contents, fn) {
  const root = mkdtempSync(join(tmpdir(), "spw-cmd-cfg-"));
  try {
    const dir = join(root, "config");
    mkdirSync(dir, { recursive: true });
    if (contents !== null) {
      writeFileSync(join(dir, "selection.json"), contents, "utf8");
    }
    return await fn({ SUPERPOWERS_CONFIG_DIR: dir });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
