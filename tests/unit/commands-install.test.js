// @ts-check
import assert from "node:assert/strict";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

const { runInstall, renderUnknownProbeStatus } = await import(
  new URL("../../dist/commands/install.js", import.meta.url).href
);
const { formatPorcelain } = await import(
  new URL("../../dist/commands/probe.js", import.meta.url).href
);
const { successResult, failureResult } = await import(
  new URL("../../dist/adapter-protocol.js", import.meta.url).href
);
const { workspaceRemovalFailure } = await import(
  new URL("../../dist/workspace.js", import.meta.url).href
);

/** Collects writes without a real stream, so no EPIPE hazard exists here. */
function sink() {
  /** @type {string[]} */
  const chunks = [];
  return {
    chunks,
    stream: /** @type {NodeJS.WritableStream} */ (
      /** @type {unknown} */ ({
        write(/** @type {string} */ text) {
          chunks.push(text);
          return true;
        },
      })
    ),
  };
}

/**
 * @param {readonly import("../../src/adapter-protocol.js").AdapterResult[]} responses
 */
function scriptedAdapter(responses) {
  /** @type {string[][]} */
  const calls = [];
  let index = 0;
  return {
    calls,
    /** @type {import("../../src/commands/context.js").CommandContext["adapter"]} */
    adapter: async (argv) => {
      calls.push([...argv]);
      const response = responses[index++];
      // Exhaustion is a FAILURE, not an empty answer. A double that runs out
      // and returns a benign value satisfies every absence assertion while
      // proving nothing -- the vacuity mode this slice exists to avoid.
      assert.ok(
        response !== undefined,
        `scriptedAdapter exhausted at call ${index}: ${argv.join(" ")}`,
      );
      return response;
    },
  };
}

const SCRATCH = mkdtempSync(join(tmpdir(), "spw-commands-install-"));
process.on("exit", () => rmSync(SCRATCH, { recursive: true, force: true }));

const NOTE =
  "Note: remove or disable conflicting Superpowers providers yourself before" +
  " relying on manager skills.\n";

/**
 * @param {string} path
 * @param {unknown} value
 */
function writeJsonFile(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value), "utf8");
}

/**
 * A hermetic install ctx: a 40-hex SUPERPOWERS_REF is a raw-commit resolution
 * (src/upstream.ts:160-162), so computeEffectiveSelection never touches git,
 * matching tests/unit/commands-prepare.test.js's unitContext.
 *
 * `savedCommit`, when given, is written as a SEPARATE, valid pinned
 * `selection.json` -- deliberately unrelated to `desiredCommit`, so a test can
 * prove install reads the GENERATED metadata file rather than the SAVED
 * selection for its own desired commit (AGENTS.md: "Saved upstream intent and
 * generated provenance are separate contracts").
 *
 * @param {{
 *   desiredCommit: string,
 *   generatedCommit?: string,
 *   savedCommit?: string,
 *   env?: Record<string, string>,
 * }} opts
 * @param {ReturnType<typeof sink>} out
 * @param {ReturnType<typeof sink>} err
 * @param {import("../../src/commands/context.js").CommandContext["adapter"]} adapter
 */
function makeCtx(opts, out, err, adapter) {
  const dir = mkdtempSync(join(SCRATCH, "case-"));
  mkdirSync(join(dir, "config"), { recursive: true });
  writeFileSync(join(dir, "config", "upstream-ref"), "v1.0.0\n");
  const configDir = join(dir, "config-dir");
  mkdirSync(configDir, { recursive: true });
  if (opts.savedCommit !== undefined) {
    writeJsonFile(join(configDir, "selection.json"), {
      schema_version: 1,
      mode: "pinned",
      source: "https://example.invalid/upstream",
      requested_ref: opts.savedCommit,
      resolved_ref: opts.savedCommit,
      commit: opts.savedCommit,
    });
  }
  if (opts.generatedCommit !== undefined) {
    writeJsonFile(
      join(dir, "plugins", "superpowers", ".superpowers-upstream.json"),
      { commit: opts.generatedCommit },
    );
  }
  return {
    root: dir,
    env: {
      HOME: join(dir, "home"),
      PATH: process.env.PATH ?? "",
      SUPERPOWERS_CONFIG_DIR: configDir,
      SUPERPOWERS_UPSTREAM_URL: "https://example.invalid/upstream",
      SUPERPOWERS_REF: opts.desiredCommit,
      ...opts.env,
    },
    stdout: out.stream,
    stderr: err.stream,
    adapter,
  };
}

const X = "1".repeat(40);
const Z = "2".repeat(40);

/** The three probe-stage responses, in gatherProbe's own call order. */
const PROBE_OK = [
  successResult("inspect", { fingerprint: null }, []),
  successResult("inspect", { identity_state: "manager" }, []),
  successResult("inspect", { update_control: "managed" }, []),
];

// --- The four fail-closed rules (milestone spec §7 / spec §4.3) ---

void test("install re-inspects ownership and update control itself", async () => {
  // Rule 1. gatherProbe just reported both, and install asks AGAIN. Mutation
  // authority requires CURRENT, VALIDATED evidence -- a probe's answer is
  // neither by the time the mutation runs. AGENTS.md, milestone spec §7.
  const out = sink();
  const err = sink();
  const { adapter, calls } = scriptedAdapter([
    ...PROBE_OK,
    successResult("inspect", { identity_state: "manager" }, []),
    successResult("inspect", { update_control: "managed" }, []),
    successResult("install", {}, []),
    successResult("inspect", { fingerprint: X }, []),
  ]);
  const ctx = makeCtx(
    { desiredCommit: X, generatedCommit: X },
    out,
    err,
    adapter,
  );
  const status = await runInstall([], ctx);
  assert.equal(status, 0);
  // Asserted structurally over the recorded argv, not over a log: the point
  // is that the calls HAPPENED, in order, after the probe's own three.
  assert.deepEqual(calls.slice(3), [
    ["inspect", "--view", "ownership"],
    ["inspect", "--view", "update-control"],
    ["install", "--package-root", ctx.root],
    ["inspect", "--view", "fingerprint"],
  ]);
});

void test("a successful install prints the fingerprint verification lines and no porcelain", async () => {
  // The parity trap scripts/install:18's probe_output=$(...) capture creates:
  // the porcelain never reaches the terminal on a successful run.
  const out = sink();
  const err = sink();
  const { adapter } = scriptedAdapter([
    ...PROBE_OK,
    successResult("inspect", { identity_state: "manager" }, []),
    successResult("inspect", { update_control: "managed" }, []),
    successResult("install", {}, []),
    successResult("inspect", { fingerprint: X }, []),
  ]);
  const ctx = makeCtx(
    { desiredCommit: X, generatedCommit: X },
    out,
    err,
    adapter,
  );
  const status = await runInstall([], ctx);
  assert.equal(status, 0);
  assert.equal(
    out.chunks.join(""),
    `${NOTE}desired_commit=${X}\ninstalled_commit=${X}\nmanager updated\n`,
  );
  assert.equal(err.chunks.join(""), "");
});

void test("desiredCommit comes from generated provenance, never from selection", async () => {
  // Rule 2. Saved upstream intent and generated provenance are separate
  // contracts; never treat one as evidence of the other. The fixture writes a
  // SAVED commit (Z) that DIFFERS from the GENERATED one (X), and the
  // installed fingerprint (from the POST-install inspect, stage 4) is also X.
  // A port that reused facts.savedCommit as the fingerprint's desired commit
  // would report a mismatch here (Z vs X); a same-value fixture could not
  // tell the two sources apart at all.
  const out = sink();
  const err = sink();
  const { adapter, calls } = scriptedAdapter([
    ...PROBE_OK,
    successResult("inspect", { identity_state: "manager" }, []),
    successResult("inspect", { update_control: "managed" }, []),
    successResult("install", {}, []),
    successResult("inspect", { fingerprint: X }, []),
  ]);
  const ctx = makeCtx(
    { desiredCommit: X, generatedCommit: X, savedCommit: Z },
    out,
    err,
    adapter,
  );
  const status = await runInstall([], ctx);
  assert.equal(status, 0);
  assert.ok(
    out.chunks.join("").includes(`desired_commit=${X}\n`),
    `expected the GENERATED commit in stdout:\n${out.chunks.join("")}`,
  );
  assert.ok(
    !out.chunks.join("").includes(Z),
    `the SAVED commit must never appear:\n${out.chunks.join("")}`,
  );
  assert.equal(calls.length, 7);
});

void test("saved selection is validated before any adapter access", async () => {
  // Rule 3. Ordering, not just outcome: with an invalid saved selection the
  // adapter must have been called ZERO times. computeEffectiveSelection loads
  // the saved selection before it ever branches on SUPERPOWERS_REF, so an
  // invalid record throws before gatherProbe's first inspect call.
  const out = sink();
  const err = sink();
  const { adapter, calls } = scriptedAdapter([]);
  const ctx = makeCtx({ desiredCommit: X }, out, err, adapter);
  writeFileSync(
    join(ctx.env.SUPERPOWERS_CONFIG_DIR, "selection.json"),
    '{"schema_version":1,"mode":"bogus"}',
    "utf8",
  );
  const status = await runInstall([], ctx);
  assert.equal(status, 1);
  assert.deepEqual(calls, []);
  assert.equal(
    err.chunks.join(""),
    "error: mode must be pinned or track-latest\n",
  );
  assert.equal(out.chunks.join(""), NOTE);
});

void test("an unparseable generated commit is never treated as success", async () => {
  // Rule 4. statusForCommits("") returns "needs prepare"; a failed inspection
  // (here, prepare itself failing) propagates rather than defaulting to
  // success. No generated metadata file is written, so
  // generatedCommitOrEmpty yields "" and facts.status is "needs prepare".
  // runPrepare is called as a function and its own failure -- a missing
  // fallback manifest template, since none was created in this fixture --
  // becomes install's return value verbatim.
  const out = sink();
  const err = sink();
  const { adapter, calls } = scriptedAdapter([...PROBE_OK]);
  const ctx = makeCtx({ desiredCommit: X }, out, err, adapter);
  const status = await runInstall([], ctx);
  assert.equal(status, 1);
  assert.equal(calls.length, 3);
  const template = join(
    ctx.root,
    "plugins",
    "superpowers",
    ".codex-plugin",
    "plugin.template.json",
  );
  assert.equal(
    err.chunks.join(""),
    `error: missing fallback manifest template: ${template}\n`,
  );
});

// --- Named parity cases ---

void test("a legacy identity state stops before the workspace is created", async () => {
  const out = sink();
  const err = sink();
  const { adapter, calls } = scriptedAdapter([
    successResult("inspect", { fingerprint: null }, []),
    successResult("inspect", { identity_state: "legacy" }, []),
    successResult("inspect", { update_control: "managed" }, []),
  ]);
  const ctx = makeCtx(
    { desiredCommit: X, generatedCommit: X },
    out,
    err,
    adapter,
  );
  const status = await runInstall([], ctx);
  assert.equal(status, 1);
  // scripts/core/lifecycle.sh:50-53 returns 1 without spw_die: three bare
  // lines to stderr, no `error: ` prefix.
  assert.equal(
    err.chunks.join(""),
    "Legacy superpowers-wrapper Codex state is installed.\n" +
      "Run: npx superpowers-wrapper@0.1.1 uninstall\n" +
      "Then run: npx superpowers-manager install\n",
  );
  assert.equal(out.chunks.join(""), NOTE);
  assert.equal(calls.length, 3);
});

void test("an unsupported update-control capability refuses before any install mutation", async () => {
  const out = sink();
  const err = sink();
  const { adapter, calls } = scriptedAdapter([
    ...PROBE_OK,
    successResult("inspect", { identity_state: "manager" }, []),
    successResult("inspect", { update_control: "unsupported" }, []),
  ]);
  const ctx = makeCtx(
    { desiredCommit: X, generatedCommit: X },
    out,
    err,
    adapter,
  );
  const status = await runInstall([], ctx);
  assert.equal(status, 1);
  assert.equal(
    err.chunks.join(""),
    "error: adapter cannot guarantee manager-controlled updates\n",
  );
  assert.deepEqual(calls, [
    ["inspect", "--view", "fingerprint"],
    ["inspect", "--view", "ownership"],
    ["inspect", "--view", "update-control"],
    ["inspect", "--view", "ownership"],
    ["inspect", "--view", "update-control"],
  ]);
});

void test("an unrecognised probe status writes the porcelain then dies without swallowing it", () => {
  // scripts/install:29-32's `case ... *)` wildcard. statusForCommits
  // (src/status.ts) can only ever return one of three literals, so this
  // branch is unreachable through runInstall's own call to gatherProbe --
  // ProbeFacts.status is typed `string`, though, and a hand-built facts
  // object (as here) must still see it fail closed.
  const FACTS = {
    requestedRef: "v1.2.3",
    resolvedRef: "v1.2.3",
    desiredCommit: "a".repeat(40),
    generatedCommit: "b".repeat(40),
    installedCommit: "c".repeat(40),
    identityState: "manager",
    status: "weird",
    selectionOrigin: "user-config",
    selectionMode: "pinned",
    upstreamSourceOrigin: "user-config",
    effectiveSource: "https://example.invalid/upstream",
    savedMode: "pinned",
    savedSource: "https://example.invalid/upstream",
    savedRequestedRef: "v1.2.3",
    savedResolvedRef: "v1.2.3",
    savedCommit: "a".repeat(40),
    updateControl: "managed",
  };
  const out = sink();
  const err = sink();
  renderUnknownProbeStatus(FACTS, {
    root: "/unused",
    env: {},
    stdout: out.stream,
    stderr: err.stream,
    adapter: async () => {
      throw new Error("must not be called");
    },
  });
  assert.equal(out.chunks.join(""), formatPorcelain(FACTS));
  assert.equal(err.chunks.join(""), "error: unknown probe status: weird\n");
});

// --- Spec §4.2a's closing requirement: a deterministic failure case AND an
// ordering case for every lifecycle adapter stage. `install` has four stages
// after the probe's three -- ownership, update-control, install, fingerprint.
// The failure and malformed cases for a given stage are the pair that must
// NOT be collapsed: if they ever produce identical stderr text, the collapse
// spec §4.2a exists to forbid has reappeared. ---

void test("stage 1 (inspect ownership) failure stops with ONLY the replayed diagnostic", async () => {
  const out = sink();
  const err = sink();
  const { adapter, calls } = scriptedAdapter([
    ...PROBE_OK,
    failureResult(
      "inspect",
      "E_ADAPTER",
      "cannot inspect ownership",
      ["check codex is installed"],
      [],
    ),
  ]);
  const ctx = makeCtx(
    { desiredCommit: X, generatedCommit: X },
    out,
    err,
    adapter,
  );
  const status = await runInstall([], ctx);
  assert.equal(status, 1);
  assert.equal(
    err.chunks.join(""),
    "error: cannot inspect ownership\nhint: check codex is installed\n",
  );
  assert.equal(calls.length, 4);
});

void test("stage 1 malformed identity_state is a DIFFERENT failure than stage 1's adapter failure", async () => {
  const out = sink();
  const err = sink();
  const { adapter, calls } = scriptedAdapter([
    ...PROBE_OK,
    successResult("inspect", { identity_state: 42 }, []),
  ]);
  const ctx = makeCtx(
    { desiredCommit: X, generatedCommit: X },
    out,
    err,
    adapter,
  );
  const status = await runInstall([], ctx);
  assert.equal(status, 1);
  assert.equal(
    err.chunks.join(""),
    "error: adapter returned a non-string identity_state for inspect --view ownership\n",
  );
  assert.equal(calls.length, 4);
});

void test("stage 1 clause 3: envelope.ok but status !== 0 gets its own hand-written message", async () => {
  // Spec §4.2a clause 3. successResult/failureResult cannot express this
  // input, so the envelope is hand-built here to reach the one combination
  // invoke()'s gate must distinguish from both clause 2 (!envelope.ok,
  // replay-only) and clause 4 (a malformed but successful result).
  const out = sink();
  const err = sink();
  /** @type {readonly import("../../src/adapter-protocol.js").AdapterResult[]} */
  const responses = [
    ...PROBE_OK,
    {
      status: 1,
      envelope: {
        protocol: 1,
        operation: "inspect",
        ok: true,
        messages: [],
        result: null,
        error: null,
      },
    },
  ];
  const { adapter, calls } = scriptedAdapter(responses);
  const ctx = makeCtx(
    { desiredCommit: X, generatedCommit: X },
    out,
    err,
    adapter,
  );
  const status = await runInstall([], ctx);
  assert.equal(status, 1);
  assert.equal(
    err.chunks.join(""),
    "error: adapter reported a failure status for inspect --view ownership\n",
  );
  assert.equal(calls.length, 4);
});

void test("stage 2 (inspect update-control) failure stops before the install mutation", async () => {
  const out = sink();
  const err = sink();
  const { adapter, calls } = scriptedAdapter([
    ...PROBE_OK,
    successResult("inspect", { identity_state: "manager" }, []),
    failureResult(
      "inspect",
      "E_ADAPTER",
      "cannot inspect update control",
      [],
      [],
    ),
  ]);
  const ctx = makeCtx(
    { desiredCommit: X, generatedCommit: X },
    out,
    err,
    adapter,
  );
  const status = await runInstall([], ctx);
  assert.equal(status, 1);
  assert.equal(err.chunks.join(""), "error: cannot inspect update control\n");
  assert.equal(calls.length, 5);
});

void test("stage 2 malformed update_control is a DIFFERENT failure than stage 2's adapter failure", async () => {
  const out = sink();
  const err = sink();
  const { adapter, calls } = scriptedAdapter([
    ...PROBE_OK,
    successResult("inspect", { identity_state: "manager" }, []),
    successResult("inspect", { update_control: 7 }, []),
  ]);
  const ctx = makeCtx(
    { desiredCommit: X, generatedCommit: X },
    out,
    err,
    adapter,
  );
  const status = await runInstall([], ctx);
  assert.equal(status, 1);
  assert.equal(
    err.chunks.join(""),
    "error: adapter returned a non-string update_control for inspect --view update-control\n",
  );
  assert.equal(calls.length, 5);
});

void test("stage 3 (install) failure stops before the post-install fingerprint inspection", async () => {
  const out = sink();
  const err = sink();
  const { adapter, calls } = scriptedAdapter([
    ...PROBE_OK,
    successResult("inspect", { identity_state: "manager" }, []),
    successResult("inspect", { update_control: "managed" }, []),
    failureResult("install", "E_ADAPTER", "cannot install plugin", [], []),
  ]);
  const ctx = makeCtx(
    { desiredCommit: X, generatedCommit: X },
    out,
    err,
    adapter,
  );
  const status = await runInstall([], ctx);
  assert.equal(status, 1);
  assert.equal(err.chunks.join(""), "error: cannot install plugin\n");
  assert.equal(calls.length, 6);
});

void test("stage 4 (post-install inspect fingerprint) failure stops with ONLY the replayed diagnostic", async () => {
  const out = sink();
  const err = sink();
  const { adapter, calls } = scriptedAdapter([
    ...PROBE_OK,
    successResult("inspect", { identity_state: "manager" }, []),
    successResult("inspect", { update_control: "managed" }, []),
    successResult("install", {}, []),
    failureResult(
      "inspect",
      "E_ADAPTER",
      "cannot inspect fingerprint after install",
      [],
      [],
    ),
  ]);
  const ctx = makeCtx(
    { desiredCommit: X, generatedCommit: X },
    out,
    err,
    adapter,
  );
  const status = await runInstall([], ctx);
  assert.equal(status, 1);
  assert.equal(
    err.chunks.join(""),
    "error: cannot inspect fingerprint after install\n",
  );
  assert.equal(calls.length, 7);
});

void test('argv is ignored, matching scripts/install never reading "$@"', async () => {
  const out = sink();
  const err = sink();
  const { adapter } = scriptedAdapter([
    ...PROBE_OK,
    successResult("inspect", { identity_state: "manager" }, []),
    successResult("inspect", { update_control: "managed" }, []),
    successResult("install", {}, []),
    successResult("inspect", { fingerprint: X }, []),
  ]);
  const ctx = makeCtx(
    { desiredCommit: X, generatedCommit: X },
    out,
    err,
    adapter,
  );
  const status = await runInstall(["--bogus", "extra"], ctx);
  assert.equal(status, 0);
});

// --- Post-success withWorkspace cleanup failure carries the outcome ---
//
// Unlike src/commands/uninstall.ts's GatherFailure (which carries only the
// collected envelopes, not the computed outcome, because withWorkspace
// discards the callback's return value on a post-success cleanup failure),
// install's gatherInstallStages passes withWorkspace an `onCleanupFailure`
// reporter. That suppresses the discard: the callback's already-computed
// StageOutcome -- including "manager updated" -- still comes back, and the
// cleanup failure is layered on top as a SEPARATE, additional stderr line
// that still forces status 1. See install.ts's report for why this is safe:
// the callback here never throws, so there is no "domain failure AND cleanup
// failure" case to lose a message to.

void test("a post-success workspace cleanup failure still reports the domain outcome, then fails closed", async () => {
  if (process.getuid?.() === 0) return; // chmod does not gate root
  const parent = mkdtempSync(join(tmpdir(), "spw-install-workspace-"));
  try {
    const out = sink();
    const err = sink();
    const responses = [
      ...PROBE_OK,
      successResult("inspect", { identity_state: "manager" }, []),
      successResult("inspect", { update_control: "managed" }, []),
      successResult("install", {}, []),
      successResult("inspect", { fingerprint: X }, []),
    ];
    let index = 0;
    /** @type {string[][]} */
    const calls = [];
    // The FINAL scripted call chmods the workspace's own PARENT directory
    // read-only, after every earlier call has already pushed its envelope.
    // By the time withWorkspace's post-callback `rm(workspace, ...)` runs,
    // the parent cannot be written to, so the removal genuinely fails with
    // EACCES/EPERM -- a real filesystem failure, not a mocked one. Matches
    // tests/unit/commands-uninstall.test.js's own technique.
    const adapter = async (/** @type {readonly string[]} */ argv) => {
      calls.push([...argv]);
      const response = responses[index++];
      assert.ok(
        response !== undefined,
        `adapter exhausted at call ${index}: ${argv.join(" ")}`,
      );
      if (index === responses.length) {
        chmodSync(parent, 0o500);
      }
      return response;
    };
    const ctx = makeCtx(
      { desiredCommit: X, generatedCommit: X, env: { TMPDIR: parent } },
      out,
      err,
      adapter,
    );
    const status = await runInstall([], ctx);
    assert.equal(status, 1);
    assert.equal(calls.length, 7);
    // The domain outcome is preserved -- "manager updated" -- even though the
    // workspace could not be removed afterward: the fingerprint verify that
    // produced it already completed against the adapter before cleanup ran.
    assert.equal(
      out.chunks.join(""),
      `${NOTE}desired_commit=${X}\ninstalled_commit=${X}\nmanager updated\n`,
    );
    const entries = readdirSync(parent);
    assert.equal(
      entries.length,
      1,
      `expected exactly one leftover workspace directory in ${parent}, found: ${entries.join(", ")}`,
    );
    const workspace = join(parent, entries[0]);
    assert.equal(
      err.chunks.join(""),
      `error: ${workspaceRemovalFailure(workspace)}\n`,
    );
  } finally {
    try {
      chmodSync(parent, 0o700);
    } catch {
      // Best-effort: the real cleanup below tolerates a missing or
      // already-writable directory either way.
    }
    rmSync(parent, { recursive: true, force: true });
  }
});
