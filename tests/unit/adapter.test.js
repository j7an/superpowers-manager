// @ts-check
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

/** @type {typeof import("../../src/adapter.js")} */
const { runAdapter, mapCodexLaunchFailure, runCommandForTest } = await import(
  new URL("../../dist/adapter.js", import.meta.url).href
);

const PACKAGE_ROOT = resolve(fileURLToPath(new URL("../../", import.meta.url)));
const COMMIT = "d884ae04edebef577e82ff7c4e143debd0bbec99";
const SOURCE = "https://example.invalid/superpowers.git";
// Sibling of tests/assert-matcher-gate.js, from this file's own location —
// never a repo-root constant. The nested `--test` spawns below get `--import`
// on argv, not via NODE_OPTIONS, so it does not propagate from this parent
// process and must be passed explicitly.
const GATE_URL = new URL("../assert-matcher-gate.js", import.meta.url).href;

/**
 * Build the upstream root, candidate root, and fallback manifest `build`
 * requires, with a candidate that passes validation.
 * @param {import("node:test").TestContext} t
 */
async function buildWorkspace(t) {
  const base = await mkdtemp(join(tmpdir(), "spw-adapter-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const upstream = join(base, "upstream");
  await mkdir(upstream);
  const candidate = join(base, "candidate");
  await mkdir(join(candidate, ".codex-plugin"), { recursive: true });
  await mkdir(join(candidate, "skills", "brainstorming"), { recursive: true });
  for (const name of ["LICENSE", "README.md", "CODE_OF_CONDUCT.md"]) {
    await writeFile(join(candidate, name), `${name}\n`);
  }
  // Do NOT write `.codex-plugin/plugin.json` or `plugin.template.json` here:
  // `build` generates both from `--fallback-manifest` (`src/adapter.ts:362`,
  // `:449`), so anything written here is overwritten before validation runs.
  await writeFile(
    join(candidate, "skills", "brainstorming", "SKILL.md"),
    "---\nname: brainstorming\ndescription: Fake skill\n---\n# Body\n",
  );
  await writeFile(
    join(candidate, ".superpowers-upstream.json"),
    `${JSON.stringify({
      source: SOURCE,
      requested_ref: "latest-release",
      resolved_ref: "v6.1.1",
      commit: COMMIT,
      upstream_manifest_version: "6.1.1",
    })}\n`,
  );
  // The fallback IS the manifest under validation. The overlay adds only
  // `version` and `skills` (`src/manifest-overlay.ts:49-50`), so `name` and
  // `description` must be valid here or the "success" case cannot succeed.
  // `hooks` must be ABSENT: its absence is what forbids `hooks/` for a
  // fallback manifest. Declaring it — even as `{}` — is rejected by
  // `classifyHooks` before the validator is reached, and by `validate_hooks`
  // if it were.
  const fallback = join(base, "fallback.json");
  await writeFile(
    fallback,
    `${JSON.stringify({
      name: "superpowers",
      description: "Fake superpowers plugin",
    })}\n`,
  );
  return { base, upstream, candidate, fallback };
}

/**
 * @param {{upstream: string, candidate: string, fallback: string}} workspace
 * @param {Record<string, string>} overrides
 */
function buildArgv(workspace, overrides = {}) {
  /** @type {Record<string, string>} */
  const flags = {
    "--upstream-root": workspace.upstream,
    "--candidate-root": workspace.candidate,
    "--requested-ref": "latest-release",
    "--resolved-ref": "v6.1.1",
    "--commit": COMMIT,
    "--manager-version": "6.1.1+manager.d884ae0",
    "--upstream-manifest-version": "6.1.1",
    "--fallback-manifest": workspace.fallback,
    ...overrides,
  };
  return ["build", ...Object.entries(flags).flat()];
}

void test("the adapter replays the validator success line as one stdout record", async (t) => {
  const workspace = await buildWorkspace(t);
  const result = await runAdapter(buildArgv(workspace), { root: PACKAGE_ROOT });
  assert.equal(result.outcome.ok, true, JSON.stringify(result.outcome));
  assert.deepStrictEqual(result.outcome.messages, [
    {
      channel: "stdout",
      text: `generated plugin validation passed: ${workspace.candidate}`,
    },
  ]);
});

void test("the adapter replays a multi-error failure as one record per line", async (t) => {
  const workspace = await buildWorkspace(t);
  await rm(join(workspace.candidate, "LICENSE"));
  await rm(join(workspace.candidate, "README.md"));
  const result = await runAdapter(buildArgv(workspace), { root: PACKAGE_ROOT });
  assert.equal(result.outcome.ok, false);
  assert.deepStrictEqual(result.outcome.messages, [
    { channel: "stderr", text: "Generated plugin validation failed:" },
    { channel: "stderr", text: "- missing required file `LICENSE`" },
    { channel: "stderr", text: "- missing required file `README.md`" },
  ]);
  assert.equal(
    result.outcome.error?.code,
    "generated-plugin-validation-failed",
  );
  assert.equal(
    result.outcome.error?.message,
    "built-in generated plugin validation failed",
  );
});

// A read failure on the overlay's own `readFile(candidateManifest, "utf8")`
// call (src/adapter.ts:396) must surface exactly `cannot read manifest JSON
// in <path>`, with the underlying OSError dropped: no `errno`, no `ENOENT`,
// and no second line. The pre-existing hook-classification read of the same
// path (src/hooks.ts) must keep succeeding, so this exercises the read at
// the overlay boundary specifically, not the sibling one that already
// leaks `errno` by design (verified: `tests/unit/hooks.test.js`).
//
// Triggering that — succeed once, then fail on the *next* read of the same
// path — needs Node's experimental module-mocking API, which requires
// `--experimental-test-module-mocks` and is only reachable from a running
// `node:test` TestContext. The shared suite runner does not set that flag
// for the whole suite, so the mocked build runs in its own child process;
// see `tests/unit/helpers/overlay-read-failure-child.js` for why the
// substitution is deterministic rather than a timing race.
void test("a manifest overlay read failure surfaces the frozen message with no errno", () => {
  const child = fileURLToPath(
    new URL("helpers/overlay-read-failure-child.js", import.meta.url),
  );
  // This test itself runs under `node --test`, which sets
  // NODE_TEST_CONTEXT / NODE_TEST_WORKER_ID. Left in the child's env, its
  // own `node --test` invocation below misreads itself as a nested
  // recursive test run and silently skips executing — exit 0 having run
  // nothing. Verified by reproduction; see the same guard in
  // tests/run-node-suites.js. Strip both before spawning.
  const childEnv = { ...process.env };
  delete childEnv.NODE_TEST_CONTEXT;
  delete childEnv.NODE_TEST_WORKER_ID;
  const spawned = spawnSync(
    process.execPath,
    ["--import", GATE_URL, "--experimental-test-module-mocks", "--test", child],
    { encoding: "utf8", env: childEnv },
  );
  assert.equal(
    spawned.status,
    0,
    `child probe failed:\nstdout: ${spawned.stdout}\nstderr: ${spawned.stderr}`,
  );
  const resultLine = spawned.stdout
    .split("\n")
    .find((line) => line.startsWith("RESULT_JSON:"));
  assert.ok(
    resultLine,
    `no RESULT_JSON line in child stdout: ${spawned.stdout}`,
  );
  const outcome = JSON.parse(resultLine.slice("RESULT_JSON:".length));
  assert.equal(outcome.ok, false);
  assert.equal(outcome.messages.length, 1, "expected exactly one message");
  assert.equal(outcome.messages[0].channel, "stderr");
  assert.match(
    outcome.messages[0].text,
    /^cannot read manifest JSON in .+\/\.codex-plugin\/plugin\.json$/,
  );
  assert.equal(outcome.error?.code, "build-failed");
  assert.equal(
    outcome.error?.message,
    "failed to apply manager manifest overlay",
  );
  const serialized = JSON.stringify(outcome);
  assert.doesNotMatch(serialized, /errno/i);
  assert.doesNotMatch(serialized, /ENOENT/);
  assert.doesNotMatch(serialized, /Traceback/);
});

// The real TOCTOU: `readManifest` (src/hooks.ts:113) validates the candidate
// manifest fatally for hook classification; the overlay's own read
// (src/adapter.ts, ~:360) reads the same path again afterward. Between those
// two reads, `tests/unit/helpers/manifest-toctou-child.js` replaces the file
// on disk with genuinely invalid UTF-8 bytes, so the second read observes
// different bytes than the first one validated. Before the fix, the second
// read decoded leniently (U+FFFD replacement) and the corrupted manifest was
// written back with the run reporting success — see the finding in PR #52.
// This needs the same experimental-module-mocking child-process setup as the
// read-failure case above, for the same reason.
void test("a manifest overlay read fails closed when the file changes between the two reads", () => {
  const child = fileURLToPath(
    new URL("helpers/manifest-toctou-child.js", import.meta.url),
  );
  const childEnv = { ...process.env };
  delete childEnv.NODE_TEST_CONTEXT;
  delete childEnv.NODE_TEST_WORKER_ID;
  const spawned = spawnSync(
    process.execPath,
    ["--import", GATE_URL, "--experimental-test-module-mocks", "--test", child],
    { encoding: "utf8", env: childEnv },
  );
  assert.equal(
    spawned.status,
    0,
    `child probe failed:\nstdout: ${spawned.stdout}\nstderr: ${spawned.stderr}`,
  );
  const lines = spawned.stdout.split("\n");
  const resultLine = lines.find((line) => line.startsWith("RESULT_JSON:"));
  assert.ok(
    resultLine,
    `no RESULT_JSON line in child stdout: ${spawned.stdout}`,
  );
  const bytesLine = lines.find((line) =>
    line.startsWith("MANIFEST_BYTES_BASE64:"),
  );
  assert.ok(
    bytesLine,
    `no MANIFEST_BYTES_BASE64 line in child stdout: ${spawned.stdout}`,
  );

  const outcome = JSON.parse(resultLine.slice("RESULT_JSON:".length));
  assert.equal(outcome.ok, false);
  assert.equal(outcome.messages.length, 1, "expected exactly one message");
  assert.equal(outcome.messages[0].channel, "stderr");
  assert.match(
    outcome.messages[0].text,
    /^cannot read manifest JSON in .+\/\.codex-plugin\/plugin\.json$/,
  );
  assert.equal(outcome.error?.code, "build-failed");
  assert.equal(
    outcome.error?.message,
    "failed to apply manager manifest overlay",
  );
  const serialized = JSON.stringify(outcome);
  assert.doesNotMatch(serialized, /errno/i);
  assert.doesNotMatch(serialized, /ENOENT/);
  assert.doesNotMatch(serialized, /Traceback/);

  // The manifest on disk must still be exactly the corrupted bytes the child
  // wrote between the two reads: the run must not have decoded them
  // leniently, overlaid them, and written a "successful" replacement
  // (U+FFFD) manifest back. Note a lenient `.toString("utf8")` comparison
  // would not distinguish those two cases \u2014 decoding either one leniently
  // produces the U+FFFD character, since decoding is exactly the lossy step
  // under test. The byte-exact comparison below, and the fatal re-decode
  // after it, use the raw bytes instead.
  const finalBytes = Buffer.from(
    bytesLine.slice("MANIFEST_BYTES_BASE64:".length),
    "base64",
  );
  // Reconstructed independently of the child's fixture, matching its exact
  // construction (validText + single corrupted byte at the "zz" placeholder)
  // \u2014 see tests/unit/helpers/manifest-toctou-child.js.
  const expectedValidText = `${JSON.stringify({
    name: "superpowers",
    description: "zz",
  })}\n`;
  const expectedCorruptedBytes = Buffer.from(expectedValidText, "utf8");
  expectedCorruptedBytes[expectedValidText.indexOf("zz")] = 0xff;
  assert.deepEqual(
    finalBytes,
    expectedCorruptedBytes,
    "manifest on disk must be exactly the bytes corrupted between the two reads \u2014 unwritten, not repaired",
  );
  assert.throws(
    () => new TextDecoder("utf-8", { fatal: true }).decode(finalBytes),
    TypeError,
    "manifest on disk must still be invalid UTF-8 (unwritten, not repaired)",
  );
});

void test("a split dash-leading ref fails before the validator with a named-flag record", async (t) => {
  const workspace = await buildWorkspace(t);
  const result = await runAdapter(
    buildArgv(workspace, { "--requested-ref": "-foo" }),
    { root: PACKAGE_ROOT },
  );
  assert.equal(result.outcome.ok, false);
  assert.equal(
    result.outcome.error?.code,
    "generated-plugin-validation-failed",
  );
  // Declared exception: argparse wrote usage records here; the pre-call guard
  // writes a differently-worded record naming the rejected flag instead. The
  // failure code and message are unchanged.
  assert.deepStrictEqual(result.outcome.messages, [
    { channel: "stderr", text: "Generated plugin validation failed:" },
    {
      channel: "stderr",
      text: "- validator argument `--requested-ref` has a dash-leading value the argument parser rejects",
    },
  ]);
});

void test("a split dash-leading value on a different flag names that flag", async (t) => {
  const workspace = await buildWorkspace(t);
  const result = await runAdapter(
    buildArgv(workspace, { "--commit": "-deadbeef" }),
    { root: PACKAGE_ROOT },
  );
  assert.equal(result.outcome.ok, false);
  assert.equal(
    result.outcome.error?.code,
    "generated-plugin-validation-failed",
  );
  assert.deepStrictEqual(result.outcome.messages, [
    { channel: "stderr", text: "Generated plugin validation failed:" },
    {
      channel: "stderr",
      text: "- validator argument `--commit` has a dash-leading value the argument parser rejects",
    },
  ]);
});

// `-١` U+0661 ARABIC-INDIC ONE, `-१` U+0967 DEVANAGARI ONE, `-١.٥` a Unicode
// fractional exercising the matcher's second alternative. CPython `re` `\d`
// matches Unicode category Nd, so real `argparse` accepts all three as negative
// numbers; the guard must let them through to the validator rather than
// reporting them as rejected split flags.
void test("split Unicode-decimal values still reach the validator", async (t) => {
  for (const value of ["-١", "-१", "-١.٥"]) {
    await t.test(value, async (t) => {
      const workspace = await buildWorkspace(t);
      const result = await runAdapter(
        buildArgv(workspace, { "--requested-ref": value }),
        { root: PACKAGE_ROOT },
      );
      assert.equal(result.outcome.ok, false);
      assert.deepStrictEqual(result.outcome.messages, [
        { channel: "stderr", text: "Generated plugin validation failed:" },
        {
          channel: "stderr",
          text: "- provenance field `requested_ref` does not match expected value",
        },
      ]);
    });
  }
});

void test("split dash-leading exceptions still reach the validator", async (t) => {
  for (const value of ["-", "-1", "-1.5", "-.5"]) {
    await t.test(value, async (t) => {
      const workspace = await buildWorkspace(t);
      const result = await runAdapter(
        buildArgv(workspace, { "--requested-ref": value }),
        { root: PACKAGE_ROOT },
      );
      assert.equal(result.outcome.ok, false);
      assert.deepStrictEqual(result.outcome.messages, [
        { channel: "stderr", text: "Generated plugin validation failed:" },
        {
          channel: "stderr",
          text: "- provenance field `requested_ref` does not match expected value",
        },
      ]);
    });
  }
});

const FAKE_CODEX = fileURLToPath(
  new URL("helpers/fake-codex.sh", import.meta.url),
);

/**
 * A sandbox for the Codex-invoking adapter operations: a recorded fake Codex
 * plus an isolated installed-plugin search root, so nothing reads or writes the
 * developer's real `~/.codex`.
 * @param {import("node:test").TestContext} t
 */
async function codexSandbox(t) {
  const base = await mkdtemp(join(tmpdir(), "spw-adapter-codex-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const log = join(base, "commands.log");
  await writeFile(log, "");
  const searchRoot = join(base, "codex");
  await mkdir(searchRoot);
  const packageRoot = join(base, "package");
  await mkdir(packageRoot);
  return {
    base,
    log,
    packageRoot,
    /** @returns {Promise<string[]>} */
    async commands() {
      return (await readFile(log, "utf8")).split("\n").filter(Boolean);
    },
    /** @param {Record<string, string>} extra */
    env(extra) {
      return {
        SUPERPOWERS_CODEX: FAKE_CODEX,
        SUPERPOWERS_INSTALLED_SEARCH_ROOT: searchRoot,
        FAKE_CODEX_LOG: log,
        ...extra,
      };
    },
  };
}

// The adapter reads `codex plugin list --json` as raw bytes: `CommandResult`'s
// `stdout: Buffer` field, read by `activePluginVersionFromJson`. `@@BAD@@` is
// a raw 0xff byte inside an otherwise well-formed JSON string, so a lossy
// `.toString()` at the call site would parse successfully and yield a
// fabricated version instead of failing closed. Asserting the exact parse
// diagnostic is what distinguishes the two.
//
// This case's discriminating power rests on the exact message AND on the
// sandbox `searchRoot` being empty: under a lossy decode the outcome is still
// ok:false / inspect-failed, and differs only because the fabricated version
// resolves to no directory. Pre-populating `searchRoot` would defeat it.
void test("the fingerprint view rejects an invalid-UTF-8 plugin listing", async (t) => {
  const sandbox = await codexSandbox(t);
  const result = await runAdapter(["inspect", "--view", "fingerprint"], {
    root: PACKAGE_ROOT,
    env: sandbox.env({
      FAKE_CODEX_PLUGIN_LIST:
        '{"installed":[{"pluginId":"superpowers@superpowers-manager","version":"1.0.0@@BAD@@"}]}',
    }),
  });
  assert.equal(result.outcome.ok, false, JSON.stringify(result.outcome));
  assert.equal(result.outcome.error?.code, "inspect-failed");
  assert.equal(
    result.outcome.error?.message,
    `cannot parse output of '${FAKE_CODEX} plugin list --json'`,
  );
  assert.deepStrictEqual(await sandbox.commands(), ["plugin list --json"]);
});

// The ownership view's fail-open is silent: a lossy decode leaves the mangled
// plugin id simply not matching, so the adapter would answer `ok:true` with
// every resource `false`. The assertion therefore requires a rejection.
void test("the ownership view rejects an invalid-UTF-8 plugin listing", async (t) => {
  const sandbox = await codexSandbox(t);
  const result = await runAdapter(["inspect", "--view", "ownership"], {
    root: PACKAGE_ROOT,
    env: sandbox.env({
      FAKE_CODEX_PLUGIN_LIST:
        '{"installed":[{"pluginId":"superpowers@superpowers-manager@@BAD@@","version":"1.0.0"}]}',
      FAKE_CODEX_MARKETPLACE_LIST: '{"marketplaces":[]}',
    }),
  });
  assert.equal(result.outcome.ok, false, JSON.stringify(result.outcome));
  assert.equal(result.outcome.error?.code, "inspect-failed");
  assert.equal(
    result.outcome.error?.message,
    `cannot parse output of '${FAKE_CODEX} plugin list --json'`,
  );
});

// The install reconciliation read (`src/adapter.ts:603`) is the destructive
// one: a lossy decode turns the registered root into a value that cannot equal
// `--package-root`, so the adapter performs a real `marketplace remove` plus
// `add`. Assert both the parse diagnostic and the absence of any mutation.
void test("install rejects an invalid-UTF-8 marketplace listing without mutating", async (t) => {
  const sandbox = await codexSandbox(t);
  const result = await runAdapter(
    ["install", "--package-root", sandbox.packageRoot],
    {
      root: PACKAGE_ROOT,
      env: sandbox.env({
        FAKE_CODEX_MARKETPLACE_LIST:
          '{"marketplaces":[{"name":"superpowers-manager","root":"/registered@@BAD@@"}]}',
      }),
    },
  );
  assert.equal(result.outcome.ok, false, JSON.stringify(result.outcome));
  assert.equal(result.outcome.error?.code, "install-failed");
  assert.equal(
    result.outcome.error?.message,
    `cannot parse output of '${FAKE_CODEX} plugin marketplace list --json'`,
  );
  assert.deepStrictEqual(await sandbox.commands(), [
    "plugin marketplace list --json",
  ]);
});

// Row 2 (PR 11.4): the synthesized launch failure used to return an empty
// stderr buffer, making ENOEXEC/EMFILE/ENOMEM indistinguishable from Codex
// exiting non-zero. This is a unit test of the mapping itself, not an
// integration test through a real spawn: the errno path cannot be provoked
// hermetically. On Linux, glibc's execvp falls back to running /bin/sh when
// the kernel returns ENOEXEC, so the spawn succeeds (exit 127) and
// mapCodexLaunchFailure is never reached; on both platforms every other
// candidate errno (ELOOP, ENAMETOOLONG, ...) fails the X_OK availability
// check first and is peeled into command-not-found before a real spawn ever
// happens. So the branch-through-the-outcome property — that this text
// actually reaches `messages` via `log.appendBytes` — is exercised by
// calling the mapping directly and is not covered end-to-end by any test.
void test("mapCodexLaunchFailure carries a validated errno, guards free-form codes, and still peels off ENOENT/EACCES", () => {
  const codexBin = "/opt/fake/codex";

  for (const code of ["ENOEXEC", "EMFILE"]) {
    const result = mapCodexLaunchFailure({ code }, codexBin);
    assert.equal(result.status, 1);
    assert.equal(result.signal, null);
    assert.deepStrictEqual(result.stdout, Buffer.alloc(0));
    assert.deepStrictEqual(
      result.stderr,
      Buffer.from(`cannot launch Codex command ${codexBin}: ${code}\n`, "utf8"),
    );
  }

  // The shape guard's proof: a free-form code (not /^E[A-Z0-9]+$/) and a
  // non-string code are both omitted rather than interpolated, leaving no
  // dangling colon.
  for (const cause of [
    { code: "no such file or directory" },
    { code: 12 },
    new Error("boom"),
  ]) {
    const result = mapCodexLaunchFailure(cause, codexBin);
    assert.deepStrictEqual(
      result.stderr,
      Buffer.from(`cannot launch Codex command ${codexBin}\n`, "utf8"),
    );
  }

  // ENOENT/EACCES keep their existing routing: fail("command-not-found", ...)
  // throws an AdapterFailure (an Error subclass carrying `code` and
  // `message`), verified by reading src/adapter.ts's `fail` and
  // `AdapterFailure` directly rather than guessed.
  for (const code of ["ENOENT", "EACCES"]) {
    assert.throws(
      () => mapCodexLaunchFailure({ code }, codexBin),
      (error) => {
        const failure = /** @type {{ code?: unknown; message?: unknown }} */ (
          error
        );
        return (
          error instanceof Error &&
          failure.code === "command-not-found" &&
          failure.message === `required Codex command not found: ${codexBin}`
        );
      },
    );
  }
});

void test("runCommand strips NODE_OPTIONS and NODE_PATH from the child env", async (t) => {
  // scripts/core/common.sh:71 was the only scrubbing site in the system and
  // dies with scripts/ in 4c. The property that was load-bearing is that the
  // CHILD is clean; the part that was never true is that the dispatcher
  // scrubbed itself. Carried matrix row 11.
  const scratch = await mkdtemp(join(tmpdir(), "spw-adapter-env-"));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  const script = join(scratch, "print-env.js");
  await writeFile(
    script,
    "process.stdout.write(JSON.stringify({\n" +
      "  NODE_OPTIONS: process.env.NODE_OPTIONS ?? null,\n" +
      "  NODE_PATH: process.env.NODE_PATH ?? null,\n" +
      "  MARKER: process.env.MARKER ?? null,\n" +
      "}));\n",
  );
  const result = await runCommandForTest(process.execPath, [script], {
    NODE_OPTIONS: "--max-old-space-size=64",
    NODE_PATH: "/nowhere",
    MARKER: "kept",
    PATH: process.env.PATH ?? "",
  });
  assert.deepEqual(JSON.parse(result.stdout.toString("utf8")), {
    NODE_OPTIONS: null,
    NODE_PATH: null,
    // The scrub is targeted, not a whitelist: everything else passes through.
    MARKER: "kept",
  });
});

// ADAPTER-FINGERPRINT-01 / -REJECT-01 / -OWNERSHIP-01 were owned by
// tests/test_adapter_protocol.py until PR 11.5 slice 5. The protocol carried
// these results; it never produced them. `runInspect` does, so the contracts
// are asserted here directly over `runAdapter`.
//
// The fingerprint vocabulary itself lives in src/codex-state.ts
// (`codexMetadataCommit` accepts 40-hex or 7-hex; `manifestShortSha` returns
// "" for anything else), reached through this view.
//
// The contract's "accepts null" clause IS asserted. An earlier draft dropped
// it, claiming an unresolvable fingerprint is always "" and therefore always
// inspect-failed. That conflated two distinct states. runInspect's fingerprint
// view returns `fingerprint: null` as a SUCCESS result when no superpowers
// plugin is active at all; only the case where a plugin IS active but its
// commit cannot be resolved reaches :843-847 and fails closed. Both are live.

/**
 * Seed the installed-plugin cache the fingerprint view reads.
 * @param {{base: string}} sandbox
 * @param {string} version
 * @param {string} commit
 */
async function seedInstalledCommit(sandbox, version, commit) {
  const root = join(
    sandbox.base,
    "codex",
    "plugins",
    "cache",
    "superpowers-manager",
    "superpowers",
    version,
  );
  await mkdir(root, { recursive: true });
  await writeFile(
    join(root, ".superpowers-upstream.json"),
    `${JSON.stringify({ commit })}\n`,
  );
  return root;
}

/** @param {string} version */
const pluginListFor = (version) =>
  JSON.stringify({
    installed: [{ pluginId: "superpowers@superpowers-manager", version }],
  });

void test("ADAPTER-FINGERPRINT-01 fingerprint inspection reports 40-hex and 7-hex commits in its exact result shape", async (t) => {
  for (const fingerprint of [COMMIT, "d884ae0"]) {
    const sandbox = await codexSandbox(t);
    const version = "6.1.1+manager.d884ae0";
    await seedInstalledCommit(sandbox, version, fingerprint);
    const result = await runAdapter(["inspect", "--view", "fingerprint"], {
      root: PACKAGE_ROOT,
      env: sandbox.env({ FAKE_CODEX_PLUGIN_LIST: pluginListFor(version) }),
    });
    assert.equal(result.outcome.ok, true, JSON.stringify(result.outcome));
    // deepStrictEqual, not a field probe: "exact result shape" is the
    // contract, so an extra key must fail.
    assert.deepStrictEqual(result.outcome.result, {
      view: "fingerprint",
      fingerprint,
    });
  }

  // Third state: the listing parses and reports no superpowers plugin. This is
  // `ok`, not a failure, and reports null -- see runInspect's fingerprint view.
  // Nothing is seeded under the search root, proving the view returns before it
  // reads one.
  const empty = await codexSandbox(t);
  const nullResult = await runAdapter(["inspect", "--view", "fingerprint"], {
    root: PACKAGE_ROOT,
    env: empty.env({
      FAKE_CODEX_PLUGIN_LIST: JSON.stringify({ installed: [] }),
    }),
  });
  assert.equal(nullResult.outcome.ok, true, JSON.stringify(nullResult.outcome));
  assert.deepStrictEqual(nullResult.outcome.result, {
    view: "fingerprint",
    fingerprint: null,
  });
});

void test("ADAPTER-FINGERPRINT-REJECT-01 a commit that is neither 7 nor 40 hex characters is never reported as a fingerprint", async (t) => {
  // Two lengths, both valid hex. `d884ae0123` is ten characters; `123456` is
  // six -- one below the seven-character bound, which is what makes the
  // rejection specific to the bound rather than to "some wrong length". The
  // retiring tests/test_adapter_protocol.py:817 drove the six-character case
  // and this witness did not; dropping it would have retired a strictly
  // stronger input set. For both: codexMetadataCommit rejects the value,
  // manifestShortSha finds no plugin.json, installedCommitFromRoot returns "",
  // and the view fails closed rather than reporting the value.
  for (const commit of ["d884ae0123", "123456"]) {
    const sandbox = await codexSandbox(t);
    const version = "6.1.1+manager.d884ae0";
    const activeRoot = await seedInstalledCommit(sandbox, version, commit);
    const result = await runAdapter(["inspect", "--view", "fingerprint"], {
      root: PACKAGE_ROOT,
      env: sandbox.env({ FAKE_CODEX_PLUGIN_LIST: pluginListFor(version) }),
    });
    assert.equal(result.outcome.ok, false, JSON.stringify(result.outcome));
    assert.equal(result.outcome.error?.code, "inspect-failed");
    assert.equal(
      result.outcome.error?.message,
      `cannot inspect active Codex plugin fingerprint under ${activeRoot}`,
      commit,
    );
  }
});

// FOUR independent booleans, not two. src/adapter.ts:939-940 computes
//   managerPresent = managerPlugin || managerMarketplace
//   legacyPresent  = legacyPlugin  || legacyMarketplace
// A draft of this test pinned both marketplace booleans to false. With
// `marketplace === false`, `plugin || false` and `plugin && false` are
// distinguishable, so an `&&` mutation is caught -- but replacing
// `managerMarketplace` with a constant is NOT, because the case where it is
// the only true input never runs. The 16-case cross product closes that.
void test("ADAPTER-OWNERSHIP-01 identity_state is derived from all four manager and legacy resource booleans", async (t) => {
  const bits = [false, true];
  for (const managerPlugin of bits) {
    for (const managerMarketplace of bits) {
      for (const legacyPlugin of bits) {
        for (const legacyMarketplace of bits) {
          const sandbox = await codexSandbox(t);
          const installed = [];
          if (managerPlugin) {
            installed.push({
              pluginId: "superpowers@superpowers-manager",
              version: "6.1.1+manager.d884ae0",
            });
          }
          if (legacyPlugin) {
            installed.push({
              pluginId: "superpowers@superpowers-wrapper",
              version: "0.1.1",
            });
          }
          const marketplaces = [];
          if (managerMarketplace) {
            marketplaces.push({ name: "superpowers-manager" });
          }
          if (legacyMarketplace) {
            marketplaces.push({ name: "superpowers-wrapper" });
          }
          const managerPresent = managerPlugin || managerMarketplace;
          const legacyPresent = legacyPlugin || legacyMarketplace;
          const identity = managerPresent
            ? legacyPresent
              ? "both"
              : "manager"
            : legacyPresent
              ? "legacy"
              : "neither";
          const label = JSON.stringify({
            managerPlugin,
            managerMarketplace,
            legacyPlugin,
            legacyMarketplace,
          });
          const result = await runAdapter(["inspect", "--view", "ownership"], {
            root: PACKAGE_ROOT,
            env: sandbox.env({
              FAKE_CODEX_PLUGIN_LIST: JSON.stringify({ installed }),
              FAKE_CODEX_MARKETPLACE_LIST: JSON.stringify({ marketplaces }),
            }),
          });
          assert.equal(result.outcome.ok, true, label);
          assert.deepStrictEqual(
            result.outcome.result,
            {
              view: "ownership",
              resources: {
                plugin: managerPlugin,
                marketplace: managerMarketplace,
              },
              legacy_resources: {
                plugin: legacyPlugin,
                marketplace: legacyMarketplace,
              },
              identity_state: identity,
            },
            label,
          );
        }
      }
    }
  }
});

// ADAPTER-INSTALL-RESULT-01, ADAPTER-CONTROLLED-FAILURE-01 and
// DIAG-ADAPTER-01 were owned by tests/test_adapter_protocol.py until PR 11.5
// slice 5.
//
// INSTALL-RESULT-01 is NARROWED. Its protocol contract admitted
// verification_hints with neither, either, or both terms, which was the
// response schema's tolerance. src/adapter.ts emits `missing` unconditionally
// and `mismatch` exactly when the refresh mode is add-only, so two of those
// four shapes are reachable and those two are what this asserts.

void test("ADAPTER-INSTALL-RESULT-01 install reports the missing hint always and the mismatch hint only in add-only refresh mode", async (t) => {
  /** @type {[string, Record<string, string>][]} */
  const cases = [
    [
      "add-only",
      {
        mismatch: "retry with SUPERPOWERS_INSTALL_REFRESH_MODE=remove-add",
        missing: "verify with 'codex plugin list --json'.",
      },
    ],
    ["remove-add", { missing: "verify with 'codex plugin list --json'." }],
  ];
  for (const [refreshMode, hints] of cases) {
    const sandbox = await codexSandbox(t);
    const result = await runAdapter(
      ["install", "--package-root", sandbox.packageRoot],
      {
        root: PACKAGE_ROOT,
        env: sandbox.env({
          SUPERPOWERS_INSTALL_REFRESH_MODE: refreshMode,
          FAKE_CODEX_MARKETPLACE_LIST: JSON.stringify({
            marketplaces: [
              { name: "superpowers-manager", root: sandbox.packageRoot },
            ],
          }),
        }),
      },
    );
    assert.equal(result.outcome.ok, true, JSON.stringify(result.outcome));
    assert.deepStrictEqual(
      result.outcome.result,
      { verification_hints: hints },
      refreshMode,
    );
  }
});

/**
 * Drive the adapter install operation to `src/adapter.ts:654-662`, the one
 * in-process failure that carries MORE THAN ONE hint. The marketplace is
 * reported as registered at a different root, so the adapter removes it and
 * re-adds it; the stub accepts the remove and refuses the add, which is the
 * exact "removed but re-adding failed" state.
 *
 * A custom stub rather than tests/unit/helpers/fake-codex.sh: that helper has
 * no failure-injection channel, and adding one would change a shared fixture
 * from inside a PR that is meant to be additive.
 * @param {import('node:test').TestContext} t
 */
async function reAddFailureRun(t) {
  const base = await mkdtemp(join(tmpdir(), "spw-adapter-readd-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const packageRoot = join(base, "package");
  const registeredRoot = join(base, "previous");
  await mkdir(packageRoot);
  await mkdir(registeredRoot);
  const stub = join(base, "codex");
  await writeFile(
    stub,
    [
      "#!/bin/sh",
      'case "$*" in',
      "  'plugin marketplace list --json')",
      `    printf '%s\\n' '{"marketplaces":[{"name":"superpowers-manager","root":"${registeredRoot}"}]}' ;;`,
      "  'plugin marketplace remove superpowers-manager') exit 0 ;;",
      "  'plugin marketplace add '*) exit 1 ;;",
      "  *) exit 0 ;;",
      "esac",
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
  const result = await runAdapter(["install", "--package-root", packageRoot], {
    root: PACKAGE_ROOT,
    env: {
      SUPERPOWERS_CODEX: stub,
      // Pinned so the fixture does not inherit this variable from the
      // executor's shell: src/adapter.ts:578-585 enumerates only "add-only"
      // and "remove-add", and any other inherited value fails runInstall's
      // enumeration check before the failure this fixture drives is reached.
      // The value itself is not load-bearing -- the remove-then-add the stub
      // exercises is the marketplace branch at src/adapter.ts:631, which is
      // gated on pathsEqual alone and reads no refresh mode. "add-only" is
      // the default (src/adapter.ts:578) and so the value these witnesses
      // were written against.
      SUPERPOWERS_INSTALL_REFRESH_MODE: "add-only",
    },
  });
  return { result, stub, packageRoot, registeredRoot };
}

void test("ADAPTER-CONTROLLED-FAILURE-01 a controlled failure carries its error and its hints in order, yields no result, and returns status 1", async (t) => {
  const workspace = await buildWorkspace(t);
  await rm(join(workspace.candidate, "LICENSE"));
  const result = await runAdapter(buildArgv(workspace), { root: PACKAGE_ROOT });
  assert.equal(result.status, 1);
  assert.equal(result.outcome.ok, false, JSON.stringify(result.outcome));
  // "yields no result" is the half a field probe would miss.
  assert.equal(result.outcome.result, null);
  assert.equal(
    result.outcome.error?.code,
    "generated-plugin-validation-failed",
  );
  assert.equal(
    result.outcome.error?.message,
    "built-in generated plugin validation failed",
  );
  // Exact, not `Array.isArray`: a shape probe passes on any value and would
  // not notice hints disappearing.
  assert.deepStrictEqual(result.outcome.error?.hints, []);

  // The contract says "carries its hints", and a hints-empty scenario cannot
  // witness that. src/adapter.ts:654-662 is the one in-process failure with
  // two of them, and their ORDER is part of what replay preserves.
  const readd = await reAddFailureRun(t);
  assert.equal(readd.result.status, 1);
  assert.equal(readd.result.outcome.ok, false);
  assert.equal(readd.result.outcome.result, null);
  assert.equal(readd.result.outcome.error?.code, "install-failed");
  assert.equal(
    readd.result.outcome.error?.message,
    "marketplace superpowers-manager was removed but re-adding failed.",
  );
  assert.deepStrictEqual(readd.result.outcome.error?.hints, [
    `recover with: ${readd.stub} plugin marketplace add ${readd.packageRoot}`,
    `previous root (last known good): ${readd.registeredRoot}`,
  ]);
});

// The contract covers "validated adapter messages, controlled errors, and
// hints" -- all three, each on its declared stream and in array order. A
// messages-only assertion would leave the error and hint halves unwitnessed,
// which is what the retiring protocol suite used to cover.
void test("DIAG-ADAPTER-01 adapter messages, errors, and hints retain their declared stream and array order", async (t) => {
  const workspace = await buildWorkspace(t);
  await rm(join(workspace.candidate, "LICENSE"));
  await rm(join(workspace.candidate, "README.md"));
  const result = await runAdapter(buildArgv(workspace), { root: PACKAGE_ROOT });
  // Order AND stream together, as one deepStrictEqual over the whole array:
  // asserting membership, or per-record channel, would pass on a reordered
  // log. The validator emits the header first and then one record per error
  // in source order, so LICENSE precedes README.md.
  assert.deepStrictEqual(result.outcome.messages, [
    { channel: "stderr", text: "Generated plugin validation failed:" },
    { channel: "stderr", text: "- missing required file `LICENSE`" },
    { channel: "stderr", text: "- missing required file `README.md`" },
  ]);
  // The error and hint halves of the same contract, asserted exactly. Replay
  // order on the product path is messages, then `error: <message>`, then one
  // `hint: <text>` per hint -- see replayOutcome in src/commands/probe.ts.
  assert.equal(result.outcome.ok, false);
  assert.equal(
    result.outcome.error?.message,
    "built-in generated plugin validation failed",
  );
  assert.deepStrictEqual(result.outcome.error?.hints, []);
  // Every record on THIS path is stderr: a stdout record here would mean a
  // diagnostic reached the data stream, which is the failure this ID exists to
  // catch.
  assert.deepStrictEqual(
    [...new Set(result.outcome.messages.map((m) => m.channel))],
    ["stderr"],
  );

  // A single-stream scenario cannot witness "their DECLARED stream" -- it
  // passes just as well against an implementation that sends everything to
  // stderr unconditionally. The re-add failure is the one in-process path
  // carrying a stdout message and two ordered hints at once, so it closes both
  // halves the scenario above leaves open.
  const readd = await reAddFailureRun(t);
  assert.deepStrictEqual(readd.result.outcome.messages, [
    {
      channel: "stdout",
      text: `marketplace superpowers-manager registered at ${readd.registeredRoot}; re-registering at ${readd.packageRoot}`,
    },
  ]);
  assert.deepStrictEqual(readd.result.outcome.error?.hints, [
    `recover with: ${readd.stub} plugin marketplace add ${readd.packageRoot}`,
    `previous root (last known good): ${readd.registeredRoot}`,
  ]);
});
