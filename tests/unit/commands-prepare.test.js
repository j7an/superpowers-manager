// @ts-check
// Unit coverage for src/commands/prepare.ts's local helpers and diagnostic
// shapes. End-to-end coverage lives in tests/baseline/prepare.test.js.
import assert from "node:assert/strict";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { capture, notCalledAdapter } from "./helpers/command-harness.js";

/** @type {typeof import("../../src/commands/prepare.js")} */
const { runPrepare, readUpstreamManifestVersion } = await import(
  new URL("../../dist/commands/prepare.js", import.meta.url).href
);

const SCRATCH = mkdtempSync(join(tmpdir(), "spw-commands-prepare-"));
process.on("exit", () => rmSync(SCRATCH, { recursive: true, force: true }));

/**
 * @param {string} name
 * @param {string | Uint8Array} body
 * @returns {string}
 */
function manifestFile(name, body) {
  const path = join(SCRATCH, `${name}.json`);
  writeFileSync(path, body);
  return path;
}

void test("readUpstreamManifestVersion mirrors spw_json_get for the three shapes", async () => {
  assert.equal(
    await readUpstreamManifestVersion(
      manifestFile("present", '{"name":"superpowers","version":"6.0.3"}'),
    ),
    "6.0.3",
  );
  // scripts/core/provenance.sh:59 — a missing key yields the empty string.
  assert.equal(
    await readUpstreamManifestVersion(
      manifestFile("absent", '{"name":"superpowers"}'),
    ),
    "",
  );
  // scripts/core/provenance.sh:62 — an explicit null yields the empty string.
  assert.equal(
    await readUpstreamManifestVersion(manifestFile("null", '{"version":null}')),
    "",
  );
});

void test("readUpstreamManifestVersion fails closed on a non-string version", async () => {
  const path = manifestFile("numeric", '{"version":6}');
  await assert.rejects(readUpstreamManifestVersion(path), (error) => {
    assert.ok(error instanceof Error);
    assert.equal(
      error.message,
      `upstream manifest version is not a string: ${path}`,
    );
    return true;
  });
});

void test("readUpstreamManifestVersion delegates every read and parse failure to readManifest", async () => {
  const array = manifestFile("array", "[1,2,3]");
  await assert.rejects(readUpstreamManifestVersion(array), (error) => {
    assert.ok(error instanceof Error);
    assert.equal(error.message, `manifest must be a JSON object: ${array}`);
    return true;
  });

  const malformed = manifestFile("malformed", "{");
  await assert.rejects(readUpstreamManifestVersion(malformed), (error) => {
    assert.ok(error instanceof Error);
    assert.equal(error.message, `invalid manifest JSON in ${malformed}`);
    return true;
  });

  // Invalid UTF-8. readManifest reads bytes, so the strict parser rejects this
  // rather than the reader silently substituting U+FFFD.
  const invalidUtf8 = manifestFile(
    "invalid-utf8",
    Uint8Array.from([0x7b, 0x22, 0x76, 0x22, 0x3a, 0x22, 0xff, 0x22, 0x7d]),
  );
  await assert.rejects(readUpstreamManifestVersion(invalidUtf8), (error) => {
    assert.ok(error instanceof Error);
    assert.equal(error.message, `invalid manifest JSON in ${invalidUtf8}`);
    return true;
  });

  const unreadable = manifestFile("unreadable", '{"version":"1.0.0"}');
  chmodSync(unreadable, 0o000);
  await assert.rejects(readUpstreamManifestVersion(unreadable), (error) => {
    assert.ok(error instanceof Error);
    assert.equal(error.message, `cannot read manifest JSON in ${unreadable}`);
    // No errno vocabulary reaches the message. The apostrophe in Node's
    // `open '<path>'` prose is written as \x27, not literally: this file is an
    // inventoried port file, and tests/bin/migration-inventory.test.js's
    // stripInert does not track regex-literal context, so an unpaired quote
    // here starts a phantom string that swallows the next two `void test(`
    // call sites and silently undercounts the suite (measured: 4 instead of
    // 6). Identical pattern, no unpaired quote.
    assert.doesNotMatch(error.message, /EACCES|EPERM|errno|open \x27/);
    return true;
  });
  chmodSync(unreadable, 0o600);
});

/**
 * A ctx whose selection resolves without touching git: a 40-hex SUPERPOWERS_REF
 * is a raw-commit resolution (src/upstream.ts:160-162).
 *
 * `adapter: notCalledAdapter` is safe for every case below: each fails
 * closed (a missing manifest template, a failed clone) before gatherPrepare
 * ever reaches the `ctx.adapter` build call. End-to-end coverage of that
 * call lives in tests/baseline/prepare.test.js.
 * @param {string} dir
 * @param {Record<string, string>} [extra]
 */
function unitContext(dir, extra = {}) {
  mkdirSync(join(dir, "config"), { recursive: true });
  writeFileSync(join(dir, "config", "upstream-ref"), "v1.0.0\n");
  const out = capture();
  const err = capture();
  return {
    out,
    err,
    ctx: {
      root: dir,
      env: {
        HOME: join(dir, "home"),
        PATH: process.env.PATH ?? "",
        SUPERPOWERS_CONFIG_DIR: join(dir, "config-dir"),
        SUPERPOWERS_CACHE_DIR: join(dir, "cache"),
        SUPERPOWERS_PLUGIN_ROOT: join(dir, "plugins", "superpowers"),
        SUPERPOWERS_UPSTREAM_URL: join(dir, "no-such-upstream"),
        SUPERPOWERS_REF: "0".repeat(40),
        ...extra,
      },
      stdout: out.stream,
      stderr: err.stream,
      adapter: notCalledAdapter,
    },
  };
}

void test("runPrepare rejects a directory as the fallback manifest template", async () => {
  const dir = mkdtempSync(join(SCRATCH, "case-"));
  const template = join(dir, "template-directory");
  mkdirSync(template, { recursive: true });
  // scripts/prepare:42 is `[ -f ]`, not `[ -e ]`. A stat-only predicate would
  // accept this directory and hand it to the adapter as --fallback-manifest;
  // tests/baseline/cli-parity.test.js's "CLI-ENV-MANIFEST-TEMPLATE-01 fallback
  // template bytes and non-file rejection" test already forbids that.
  const { out, err, ctx } = unitContext(dir, {
    SUPERPOWERS_MANIFEST_TEMPLATE: template,
  });
  const status = await runPrepare([], ctx);
  assert.equal(status, 1);
  assert.equal(out.text(), "");
  assert.equal(
    err.text(),
    `error: missing fallback manifest template: ${template}\n`,
  );
});

void test("runPrepare emits no errno or multi-line git text when the clone fails before reaching the additional validator", async () => {
  const dir = mkdtempSync(join(SCRATCH, "case-"));
  const template = join(dir, "template.json");
  writeFileSync(template, '{"name":"superpowers"}\n');
  const validator = join(dir, "validator-directory");
  mkdirSync(validator, { recursive: true });
  const { err, ctx } = unitContext(dir, {
    SUPERPOWERS_MANIFEST_TEMPLATE: template,
    SUPERPOWERS_VALIDATOR: validator,
  });
  const status = await runPrepare([], ctx);
  assert.equal(status, 1);
  // The clone of a nonexistent upstream fails first, so the validator's own
  // -f branch (a directory at SUPERPOWERS_VALIDATOR) is never reached here --
  // that predicate is exercised end-to-end in tests/baseline/prepare.test.js.
  //
  // Exact equality, not just doesNotMatch(/ENOENT|errno|Error:|\n.*\n.*\n/):
  // notCalledAdapter's throw is caught by gatherPrepare's own `catch`
  // following the adapter build argv construction and turned into a
  // *different*, still-single-line, still-errno-free diagnostic ("cannot
  // build the generated plugin candidate"). A loose doesNotMatch
  // cannot tell that diagnostic apart from this one, so it would stay green
  // even if a future change made this case wrongly reach the adapter. Pinning
  // the exact clone-failure text is what makes reaching ctx.adapter here
  // observable.
  assert.doesNotMatch(err.text(), /ENOENT|errno|Error:|\n.*\n.*\n/);
  assert.equal(
    err.text(),
    `error: cannot clone upstream repo: ${join(dir, "no-such-upstream")}\n`,
  );
});

void test("runPrepare takes the clone branch, not fetch, when the cache's .git is a regular file", async () => {
  const dir = mkdtempSync(join(SCRATCH, "case-"));
  const template = join(dir, "template.json");
  writeFileSync(template, '{"name":"superpowers"}\n');
  const source = join(dir, "no-such-upstream");
  // scripts/prepare:50 is `[ -d "$cache/.git" ]`. A regular file named
  // `.git` -- what a git worktree or `clone --separate-git-dir` leaves
  // behind -- must NOT be treated as a directory: an `-e` predicate would
  // take the fetch branch and let git follow the file's `gitdir:` pointer,
  // where the shell (and the `-d` port) take the clone branch instead. The
  // two branches are discriminated here by their diagnostics, which differ.
  const cache = join(dir, "cache", "superpowers");
  mkdirSync(cache, { recursive: true });
  writeFileSync(join(cache, ".git"), "gitdir: /nonexistent\n");
  const { err, ctx } = unitContext(dir, {
    SUPERPOWERS_MANIFEST_TEMPLATE: template,
    SUPERPOWERS_UPSTREAM_URL: source,
  });
  const status = await runPrepare([], ctx);
  assert.equal(status, 1);
  assert.equal(err.text(), `error: cannot clone upstream repo: ${source}\n`);
});

console.log("commands-prepare.test.js: OK");
