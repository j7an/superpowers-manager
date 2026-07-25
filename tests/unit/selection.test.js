// @ts-check
import assert from "node:assert/strict";
import test from "node:test";

/** @type {typeof import("../../src/safety-error.js")} */
const { SafetyError } = await import(
  new URL("../../dist/safety-error.js", import.meta.url).href
);
/** @type {typeof import("../../src/selection.js")} */
const {
  normalizePinnedArguments,
  normalizeSaved,
  serializeRecord,
  validateRecord,
  validateSource,
} = await import(new URL("../../dist/selection.js", import.meta.url).href);

const commit = "0123456789abcdef0123456789abcdef01234567";

void test("selection validation and normalization preserve the frozen record shapes", () => {
  const pinned = validateRecord({
    schema_version: 1,
    mode: "pinned",
    source: "https://example.invalid/repo",
    requested_ref: "v1.2.3",
    resolved_ref: "v1.2.3",
    commit,
  });
  assert.deepEqual(normalizeSaved(pinned), {
    saved_mode: "pinned",
    saved_source: "https://example.invalid/repo",
    saved_requested_ref: "v1.2.3",
    saved_resolved_ref: "v1.2.3",
    saved_commit: commit,
  });
  assert.deepEqual(normalizeSaved(null), {
    saved_mode: "none",
    saved_source: "",
    saved_requested_ref: "",
    saved_resolved_ref: "",
    saved_commit: "",
  });
  assert.deepEqual(
    normalizePinnedArguments({
      source: "https://example.invalid/repo",
      requestedRef: commit.toUpperCase(),
      resolvedRef: commit.toUpperCase(),
      commit: commit.toUpperCase(),
    }),
    {
      schema_version: 1,
      mode: "pinned",
      source: "https://example.invalid/repo",
      requested_ref: commit,
      resolved_ref: commit,
      commit,
    },
  );
  assert.throws(
    () =>
      validateRecord({
        schema_version: 1,
        mode: "pinned",
        source: "https://example.invalid/repo",
        requested_ref: commit,
        resolved_ref: commit,
        commit: "89abcdef0123456789abcdef0123456789abcdef",
      }),
    /raw commit requested_ref, resolved_ref, and commit must be equal/,
  );
});

void test("validateSource matches the bounded CPython urlsplit verdict corpus", () => {
  const accepted = [
    "https://github.com/obra/superpowers",
    "http://example.invalid/repo",
    "ssh://git@github.com/obra/superpowers.git",
    "git@github.com:obra/superpowers.git",
    "/tmp/local upstream",
    "https://example.invalid/@repo",
    "ssh://[::1]/repo",
    "git://[v1.future]/repo",
    "git://[vabc.future]/repo",
    "ssh://[::1]:22[/repo",
  ];
  for (const source of accepted) {
    assert.equal(validateSource(source), source, source);
  }

  /** @type {Array<[string, RegExp]>} */
  const rejected = [
    ["https://user:password@example.invalid/repo", /must not include userinfo/],
    ["https://token@example.invalid/repo", /must not include userinfo/],
    ["http://@example.invalid/repo", /must not include userinfo/],
    ["ht\ttp://user@x", /must not include userinfo/],
    ["\u0001http://user@x", /must not include userinfo/],
    [" http://user@x", /must not include userinfo/],
    ["https://[invalid/repo", /source URL is malformed/],
    ["ssh://a[b]c/repo", /source URL is malformed/],
    ["git://user[x]@host/repo", /source URL is malformed/],
    ["git://[V1.future]/repo", /source URL is malformed/],
    ["https://exa／mple.invalid/repo", /source URL is malformed/],
    ["https://ex＠ample/repo", /source URL is malformed/],
  ];
  for (const [source, message] of rejected) {
    assert.throws(() => validateSource(source), message, source);
  }
  for (const source of ["", "line\nbreak", "nul\0byte"]) {
    assert.throws(() => validateSource(source), SafetyError, source);
  }
});

void test("selection serializer preserves Python-compatible bytes", () => {
  assert.equal(
    serializeRecord({
      schema_version: 1,
      mode: "track-latest",
      source: "https://example.invalid/café",
    }),
    '{\n  "schema_version": 1,\n  "mode": "track-latest",\n  "source": "https://example.invalid/caf\\u00e9"\n}\n',
  );
  assert.equal(
    serializeRecord({
      schema_version: 1,
      mode: "pinned",
      source: "https://example.invalid/repo",
      requested_ref: "v1.2.3",
      resolved_ref: "v1.2.3",
      commit,
    }),
    '{\n  "schema_version": 1,\n  "mode": "pinned",\n  "source": "https://example.invalid/repo",\n  "requested_ref": "v1.2.3",\n  "resolved_ref": "v1.2.3",\n  "commit": "0123456789abcdef0123456789abcdef01234567"\n}\n',
  );
});
