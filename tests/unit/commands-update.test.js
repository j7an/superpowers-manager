// @ts-check
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

const { runUpdate, renderUnknownProbeStatus } = await import(
  new URL("../../dist/commands/update.js", import.meta.url).href
);
const { formatPorcelain, gatherProbe } = await import(
  new URL("../../dist/commands/probe.js", import.meta.url).href
);
const { successResult, failureResult } = await import(
  new URL("../../dist/adapter-result.js", import.meta.url).href
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
 * @param {readonly import("../../src/adapter-result.js").AdapterResult[]} responses
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

const SCRATCH = mkdtempSync(join(tmpdir(), "spw-commands-update-"));
process.on("exit", () => rmSync(SCRATCH, { recursive: true, force: true }));

const INSTALL_NOTE =
  "Note: remove or disable conflicting Superpowers providers yourself before" +
  " relying on manager skills.\n";

/**
 * A hermetic update ctx: a 40-hex SUPERPOWERS_REF is a raw-commit resolution
 * (src/upstream.ts:160-162), so computeEffectiveSelection never touches git,
 * matching tests/unit/commands-install.test.js's own makeCtx.
 *
 * @param {{
 *   desiredCommit: string,
 *   generatedCommit?: string,
 *   extraEnv?: Record<string, string>,
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
  if (opts.generatedCommit !== undefined) {
    const metadataPath = join(
      dir,
      "plugins",
      "superpowers",
      ".superpowers-upstream.json",
    );
    mkdirSync(dirname(metadataPath), { recursive: true });
    writeFileSync(
      metadataPath,
      JSON.stringify({ commit: opts.generatedCommit }),
      "utf8",
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
      ...opts.extraEnv,
    },
    stdout: out.stream,
    stderr: err.stream,
    adapter,
  };
}

const X = "1".repeat(40);

/** gatherProbe's three stages, in call order, reporting a clean "current" state. */
function probeCurrent() {
  return [
    successResult("inspect", { fingerprint: X }, []),
    successResult("inspect", { identity_state: "manager" }, []),
    successResult("inspect", { update_control: "managed" }, []),
  ];
}

/** Same three stages, but with no installed fingerprint -- "needs install". */
function probeNeedsInstall() {
  return [
    successResult("inspect", { fingerprint: null }, []),
    successResult("inspect", { identity_state: "manager" }, []),
    successResult("inspect", { update_control: "managed" }, []),
  ];
}

// Per-invocation identity flags only -- these write no git config at any
// scope. GIT_CONFIG_GLOBAL deliberately names a file that does not exist and
// GIT_CONFIG_NOSYSTEM suppresses the system file, so the fixture repository is
// not machine-dependent. Same arrangement as
// tests/baseline/prepare-fixture.js:32-67, and the reason it is needed here is
// the same: `core.hooksPath` or `init.templateDir` inherited from the
// developer would change what this repository ends up containing.
const GIT_HOME = join(SCRATCH, "fixture-git-home");
mkdirSync(GIT_HOME, { recursive: true });
const GIT_IDENTITY = [
  "-c",
  "user.name=superpowers-manager",
  "-c",
  "user.email=superpowers-manager@example.invalid",
  "-c",
  "commit.gpgsign=false",
  "-c",
  "tag.gpgsign=false",
];
const GIT_ENV = {
  HOME: GIT_HOME,
  PATH: process.env.PATH ?? "",
  GIT_CONFIG_GLOBAL: join(GIT_HOME, "gitconfig"),
  GIT_CONFIG_NOSYSTEM: "1",
};

/**
 * @param {string} cwd
 * @param {readonly string[]} args
 * @returns {string}
 */
function git(cwd, args) {
  const ran = spawnSync("git", [...args], {
    cwd,
    env: GIT_ENV,
    encoding: "utf8",
  });
  assert.equal(ran.status, 0, `fixture git ${args.join(" ")}: ${ran.stderr}`);
  return ran.stdout;
}

/**
 * A local upstream repository carrying every REQUIRED_UPSTREAM path
 * (src/commands/prepare.ts:21-26), so runPrepare's clone-checkout-copy
 * pipeline can succeed without a network. Hermetic: a local clone, no remote.
 *
 * @returns {{ path: string, commit: string }}
 */
function makeUpstreamRepo() {
  const path = mkdtempSync(join(SCRATCH, "upstream-"));
  mkdirSync(join(path, "skills", "brainstorming"), { recursive: true });
  writeFileSync(
    join(path, "skills", "brainstorming", "SKILL.md"),
    "---\nname: brainstorming\ndescription: Fake upstream skill\n---\n",
  );
  writeFileSync(join(path, "LICENSE"), "license\n");
  writeFileSync(join(path, "README.md"), "readme\n");
  writeFileSync(join(path, "CODE_OF_CONDUCT.md"), "code\n");
  git(SCRATCH, ["init", path]);
  git(path, ["add", "skills", "LICENSE", "README.md", "CODE_OF_CONDUCT.md"]);
  git(path, [...GIT_IDENTITY, "commit", "-m", "fake upstream"]);
  return { path, commit: git(path, ["rev-parse", "HEAD"]).trim() };
}

/**
 * runPrepare's fallback manifest template at its default location
 * (src/commands/prepare.ts:262-269). Read before the adapter build, so the
 * atomic swap that later replaces the plugin root does not race it.
 *
 * @param {string} root
 */
function writeManifestTemplate(root) {
  const dir = join(root, "plugins", "superpowers", ".codex-plugin");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "plugin.template.json"), '{"name":"superpowers"}\n');
}

// Built once: every case below clones it into its own cache, so they share the
// source without sharing any state the subject writes.
const UPSTREAM = makeUpstreamRepo();

/**
 * A fixture whose status is "needs prepare" -- no generated metadata is written
 * -- and whose prepare would SUCCEED if it were reached. That second half is
 * what makes the pre-switch guard cases below load-bearing: a guard wrongly
 * relocated into the `current` arm lets this status run runPrepare, whose
 * adapter build call then shows up in `calls`.
 *
 * @param {ReturnType<typeof sink>} out
 * @param {ReturnType<typeof sink>} err
 * @param {import("../../src/commands/context.js").CommandContext["adapter"]} adapter
 */
function makePreparableCtx(out, err, adapter) {
  const ctx = makeCtx(
    {
      desiredCommit: UPSTREAM.commit,
      extraEnv: { SUPERPOWERS_UPSTREAM_URL: UPSTREAM.path },
    },
    out,
    err,
    adapter,
  );
  writeManifestTemplate(ctx.root);
  return ctx;
}

// --- The four-way switch ---

void test('current: replays outcomes, prints the exact porcelain, then "manager is current"', async () => {
  // The porcelain reaches the terminal here -- unlike install, which never
  // lets it through on a successful run (scripts/install:18's
  // probe_output=$(...) capture). Two independent ctx/adapter pairs, built
  // from the same fixture: one drives gatherProbe directly to obtain the
  // real `facts` object, the other drives runUpdate. Comparing runUpdate's
  // stdout against formatPorcelain(facts) proves the exact text, not just a
  // substring of it.
  const probeOnly = sink();
  const probeErr = sink();
  const { adapter: probeAdapter } = scriptedAdapter(probeCurrent());
  const probeCtx = makeCtx(
    { desiredCommit: X, generatedCommit: X },
    probeOnly,
    probeErr,
    probeAdapter,
  );
  const probe = await gatherProbe(probeCtx);
  assert.equal(probe.status, 0);
  assert.equal(probe.facts.status, "current");

  const out = sink();
  const err = sink();
  const { adapter, calls } = scriptedAdapter(probeCurrent());
  const ctx = makeCtx(
    { desiredCommit: X, generatedCommit: X },
    out,
    err,
    adapter,
  );
  const status = await runUpdate([], ctx);
  assert.equal(status, 0);
  assert.equal(
    out.chunks.join(""),
    `${formatPorcelain(probe.facts)}manager is current\n`,
  );
  assert.equal(err.chunks.join(""), "");
  // The current arm issues no adapter call of its own: only gatherProbe's
  // three.
  assert.deepEqual(calls, [
    ["inspect", "--view", "fingerprint"],
    ["inspect", "--view", "ownership"],
    ["inspect", "--view", "update-control"],
  ]);
});

void test("current: refuses an unsupported update control BEFORE printing anything", async () => {
  // §4.4's second correction: scripts/update:18 gates before scripts/update:19
  // prints anything. An update reporting "manager is current" under an
  // unsupported adapter would be asserting managed control it had not
  // verified.
  const out = sink();
  const err = sink();
  const { adapter, calls } = scriptedAdapter([
    successResult("inspect", { fingerprint: X }, []),
    successResult("inspect", { identity_state: "manager" }, []),
    successResult("inspect", { update_control: "unsupported" }, []),
  ]);
  const ctx = makeCtx(
    { desiredCommit: X, generatedCommit: X },
    out,
    err,
    adapter,
  );
  const status = await runUpdate([], ctx);
  assert.equal(status, 1);
  assert.equal(out.chunks.join(""), "");
  assert.equal(
    err.chunks.join(""),
    "error: adapter cannot guarantee manager-controlled updates\n",
  );
  assert.equal(calls.length, 3);
});

void test('current: an UNRECOGNISED update control capability is its own diagnostic, distinct from "unsupported"', async () => {
  // requireManagedUpdateControl (src/lifecycle.ts) has three arms: managed,
  // unsupported, and a catch-all. A mutant collapsing the catch-all into the
  // "unsupported" arm would survive the case above alone.
  const out = sink();
  const err = sink();
  const { adapter, calls } = scriptedAdapter([
    successResult("inspect", { fingerprint: X }, []),
    successResult("inspect", { identity_state: "manager" }, []),
    successResult("inspect", { update_control: "wat" }, []),
  ]);
  const ctx = makeCtx(
    { desiredCommit: X, generatedCommit: X },
    out,
    err,
    adapter,
  );
  const status = await runUpdate([], ctx);
  assert.equal(status, 1);
  assert.equal(out.chunks.join(""), "");
  assert.equal(
    err.chunks.join(""),
    "error: unknown adapter update-control capability: wat\n",
  );
  assert.equal(calls.length, 3);
});

void test("needs prepare: a failing prepare's status propagates verbatim, and install never runs", async () => {
  // No generated metadata file is written, so generatedCommitOrEmpty yields
  // "" and facts.status is "needs prepare". runPrepare is called as a
  // FUNCTION and its own failure -- a missing fallback manifest template,
  // since none was created in this fixture -- becomes update's return value
  // verbatim, the property `set -eu` gave the shell for free and a function
  // call does not.
  const out = sink();
  const err = sink();
  const { adapter, calls } = scriptedAdapter(probeCurrent());
  const ctx = makeCtx({ desiredCommit: X }, out, err, adapter);
  const status = await runUpdate([], ctx);
  assert.equal(status, 1);
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
  // Only gatherProbe's own three calls: prepare fails before issuing any
  // adapter call of its own, and install is never reached.
  assert.equal(calls.length, 3);
});

void test("needs prepare: a SUCCESSFUL prepare is followed by a real runInstall, not by a bare success", async () => {
  // scripts/update:23-24 -- prepare THEN install. The sibling case above only
  // reaches the first of the two, because its prepare fails; this one is the
  // only proof that the second statement of the arm exists at all. Replacing
  // `return await runInstall([], ctx)` with `return 0` leaves update
  // preparing a fresh tree, skipping the install, and reporting success for
  // state it never installed -- so the assertion has to be the recorded
  // adapter sequence, not the exit status, which the defect reproduces
  // exactly.
  const out = sink();
  const err = sink();
  const { adapter, calls } = scriptedAdapter([
    // update's own probe. No generated tree exists yet, so statusForCommits
    // returns "needs prepare" whatever the installed fingerprint says.
    successResult("inspect", { fingerprint: null }, []),
    successResult("inspect", { identity_state: "manager" }, []),
    successResult("inspect", { update_control: "managed" }, []),
    // runPrepare's single adapter call. runPrepare itself creates and fills
    // the candidate root, so a scripted success is enough for the swap that
    // follows to find a real tree.
    successResult("build", {}, []),
    // runInstall's own probe, which now sees the freshly prepared tree.
    successResult("inspect", { fingerprint: null }, []),
    successResult("inspect", { identity_state: "manager" }, []),
    successResult("inspect", { update_control: "managed" }, []),
    // runInstall's four mutation stages.
    successResult("inspect", { identity_state: "manager" }, []),
    successResult("inspect", { update_control: "managed" }, []),
    successResult("install", {}, []),
    successResult("inspect", { fingerprint: UPSTREAM.commit }, []),
  ]);
  const ctx = makePreparableCtx(out, err, adapter);

  const status = await runUpdate([], ctx);
  assert.equal(status, 0);
  assert.equal(err.chunks.join(""), "");
  // runPrepare's own success line, then runInstall's. Neither is written by
  // update, so the presence of the second one is itself evidence the second
  // statement of the arm ran.
  assert.equal(
    out.chunks.join(""),
    `prepared ${UPSTREAM.commit} at ${UPSTREAM.commit}\n` +
      `${INSTALL_NOTE}desired_commit=${UPSTREAM.commit}\n` +
      `installed_commit=${UPSTREAM.commit}\nmanager updated\n`,
  );
  assert.equal(calls.length, 11);
  assert.deepEqual(calls.slice(0, 3), [
    ["inspect", "--view", "fingerprint"],
    ["inspect", "--view", "ownership"],
    ["inspect", "--view", "update-control"],
  ]);
  // The build call's --candidate-root is a fresh workspace path, so only its
  // operation is stable; everything on either side of it is asserted exactly.
  assert.equal(calls[3][0], "build");
  assert.deepEqual(calls.slice(4), [
    ["inspect", "--view", "fingerprint"],
    ["inspect", "--view", "ownership"],
    ["inspect", "--view", "update-control"],
    ["inspect", "--view", "ownership"],
    ["inspect", "--view", "update-control"],
    ["install", "--package-root", ctx.root],
    ["inspect", "--view", "fingerprint"],
  ]);
});

void test("needs install: delegates to runInstall alone, and a success propagates as status 0", async () => {
  // Ten calls, not seven: scripts/update:27 spawned `sh scripts/install` as a
  // SEPARATE process, which re-ran `sh scripts/probe --porcelain` from
  // scratch (scripts/install:18) before its own re-inspection. runInstall
  // preserves that double-probe as a second, independent gatherProbe call --
  // update's own probe (3 calls) is not the same call as install's own probe
  // (3 more calls) -- so the fixture scripts both, then install's four
  // mutation stages.
  const out = sink();
  const err = sink();
  const { adapter, calls } = scriptedAdapter([
    ...probeNeedsInstall(),
    ...probeNeedsInstall(),
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
  const status = await runUpdate([], ctx);
  assert.equal(status, 0);
  // runInstall's own NOTE line, then its own success lines -- update writes
  // nothing of its own on this arm.
  assert.equal(
    out.chunks.join(""),
    `${INSTALL_NOTE}desired_commit=${X}\ninstalled_commit=${X}\nmanager updated\n`,
  );
  assert.equal(err.chunks.join(""), "");
  assert.deepEqual(calls.slice(6), [
    ["inspect", "--view", "ownership"],
    ["inspect", "--view", "update-control"],
    ["install", "--package-root", ctx.root],
    ["inspect", "--view", "fingerprint"],
  ]);
});

void test("needs install: a non-zero runInstall return propagates as update's status, not swallowed", async () => {
  const out = sink();
  const err = sink();
  const { adapter, calls } = scriptedAdapter([
    ...probeNeedsInstall(),
    ...probeNeedsInstall(),
    successResult("inspect", { identity_state: "manager" }, []),
    successResult("inspect", { update_control: "unsupported" }, []),
  ]);
  const ctx = makeCtx(
    { desiredCommit: X, generatedCommit: X },
    out,
    err,
    adapter,
  );
  const status = await runUpdate([], ctx);
  assert.equal(status, 1);
  // runInstall's OWN diagnostic, verbatim -- update adds no second message.
  assert.equal(
    err.chunks.join(""),
    "error: adapter cannot guarantee manager-controlled updates\n",
  );
  // runInstall's own NOTE line reaches stdout, unaltered; update writes
  // nothing of its own on this arm, success or failure alike.
  assert.equal(out.chunks.join(""), INSTALL_NOTE);
  assert.equal(calls.length, 8);
});

void test("an unrecognised probe status writes the porcelain then reports the error without swallowing it", () => {
  // scripts/update:29-32's `case ... *)` wildcard. statusForCommits
  // (src/status.ts) can only ever return one of three literals, so this
  // branch is unreachable through runUpdate's own call to gatherProbe --
  // ProbeFacts.status is typed `string`, though, and a hand-built facts
  // object (as here) must still see it fail closed. Same technique as
  // tests/unit/commands-install.test.js's own renderUnknownProbeStatus case.
  const FACTS = {
    requestedRef: "v1.2.3",
    resolvedRef: "v1.2.3",
    desiredCommit: X,
    generatedCommit: X,
    installedCommit: X,
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
    savedCommit: X,
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
  // scripts/update:30-31 -- `echo "$probe_output"` on stdout, the error on
  // stderr via an explicit `>&2`. Each stream is asserted on its own channel,
  // not just as a joined substring, so a mutant that swapped the two streams
  // cannot pass by accident.
  assert.equal(out.chunks.join(""), formatPorcelain(FACTS));
  assert.equal(err.chunks.join(""), "error: unknown probe status: weird\n");
});

// --- The two emptiness checks that run BEFORE the switch (§4.4's first
// correction). scripts/update:10 guards identity_state (matching install's
// equivalent guard); scripts/update:14 guards update_control, which install
// never checks at all. ---

void test("an empty probe-reported identity state is its own diagnostic, distinct from an unrecognised one", async () => {
  const out = sink();
  const err = sink();
  const { adapter, calls } = scriptedAdapter([
    successResult("inspect", { fingerprint: X }, []),
    successResult("inspect", { identity_state: null }, []),
    successResult("inspect", { update_control: "managed" }, []),
  ]);
  const ctx = makeCtx(
    { desiredCommit: X, generatedCommit: X },
    out,
    err,
    adapter,
  );
  const status = await runUpdate([], ctx);
  assert.equal(status, 1);
  assert.equal(
    err.chunks.join(""),
    "error: probe did not report adapter identity state\n",
  );
  assert.equal(out.chunks.join(""), "");
  assert.equal(calls.length, 3);
});

void test("a legacy identity state stops before the update-control guard even runs", async () => {
  const out = sink();
  const err = sink();
  const { adapter, calls } = scriptedAdapter([
    successResult("inspect", { fingerprint: X }, []),
    successResult("inspect", { identity_state: "both" }, []),
    successResult("inspect", { update_control: "managed" }, []),
  ]);
  const ctx = makeCtx(
    { desiredCommit: X, generatedCommit: X },
    out,
    err,
    adapter,
  );
  const status = await runUpdate([], ctx);
  assert.equal(status, 1);
  // scripts/core/lifecycle.sh:50-53 is a single printf writing three bare
  // lines to stderr, no `error: ` prefix; :54 is the `return 1` that follows
  // it, reached without spw_die.
  assert.equal(
    err.chunks.join(""),
    "Legacy superpowers-wrapper Codex state is installed.\n" +
      "Run: npx superpowers-wrapper@0.1.1 uninstall\n" +
      "Then run: npx superpowers-manager install\n",
  );
  assert.equal(out.chunks.join(""), "");
  assert.equal(calls.length, 3);
});

void test("an UNKNOWN probe identity state is a distinct diagnostic from the legacy-blocked one", async () => {
  // The sibling case above drives requireNoLegacyState's "blocked" arm; this
  // one drives its "unknown" arm (src/lifecycle.ts, reached for any
  // identity_state outside the four known ones). Each arm needs its own
  // case: a mutant disabling both at once dies to the "blocked" case alone.
  const out = sink();
  const err = sink();
  const { adapter, calls } = scriptedAdapter([
    successResult("inspect", { fingerprint: X }, []),
    successResult("inspect", { identity_state: "chaos" }, []),
    successResult("inspect", { update_control: "managed" }, []),
  ]);
  const ctx = makeCtx(
    { desiredCommit: X, generatedCommit: X },
    out,
    err,
    adapter,
  );
  const status = await runUpdate([], ctx);
  assert.equal(status, 1);
  // scripts/core/lifecycle.sh calls spw_die for the catch-all, which DOES
  // prefix `error: ` -- unlike the bare three lines the "blocked" arm writes.
  assert.equal(
    err.chunks.join(""),
    "error: unknown adapter identity state: chaos\n",
  );
  assert.equal(out.chunks.join(""), "");
  assert.equal(calls.length, 3);
});

void test("an empty probe-reported update-control capability fails closed, and runInstall never runs", async () => {
  // scripts/update:14. install checks only identity_state
  // (scripts/install:20); update checks this too -- §4.4's first correction.
  // Proven with a call recorder, not just the absence of "manager is
  // current" output: the assertion is that NO call past gatherProbe's own
  // three ever happens, not merely that this particular arm's text is
  // absent.
  const out = sink();
  const err = sink();
  const { adapter, calls } = scriptedAdapter([
    successResult("inspect", { fingerprint: X }, []),
    successResult("inspect", { identity_state: "manager" }, []),
    successResult("inspect", { update_control: null }, []),
  ]);
  const ctx = makeCtx(
    { desiredCommit: X, generatedCommit: X },
    out,
    err,
    adapter,
  );
  const status = await runUpdate([], ctx);
  assert.equal(status, 1);
  assert.equal(
    err.chunks.join(""),
    "error: probe did not report adapter update-control capability\n",
  );
  assert.equal(out.chunks.join(""), "");
  assert.deepEqual(calls, [
    ["inspect", "--view", "fingerprint"],
    ["inspect", "--view", "ownership"],
    ["inspect", "--view", "update-control"],
  ]);
});

// --- The same three guards, driven by a NON-`current` status ---
//
// §4.4's correction is a placement claim: both emptiness checks and the
// legacy-identity guard run BEFORE the switch, not inside the `current` arm.
// Every case above uses a `current` fixture, so none of them can tell the two
// arrangements apart -- each guard fires either way. These cases use a
// "needs prepare" fixture whose prepare would succeed, so a guard relocated
// into the `current` arm lets update reach runPrepare: the adapter build call
// appears in `calls` and scripting only gatherProbe's three responses makes
// that arrival loud. What must not happen is exactly what scripts/update:10-14
// refuses -- a real generated-tree write under an identity or an update-control
// capability the command has not accepted.

void test("needs prepare: an empty identity state refuses before prepare, not inside the current arm", async () => {
  const out = sink();
  const err = sink();
  const { adapter, calls } = scriptedAdapter([
    successResult("inspect", { fingerprint: null }, []),
    successResult("inspect", { identity_state: null }, []),
    successResult("inspect", { update_control: "managed" }, []),
  ]);
  const ctx = makePreparableCtx(out, err, adapter);
  const status = await runUpdate([], ctx);
  assert.equal(status, 1);
  assert.equal(
    err.chunks.join(""),
    "error: probe did not report adapter identity state\n",
  );
  assert.equal(out.chunks.join(""), "");
  assert.deepEqual(calls, [
    ["inspect", "--view", "fingerprint"],
    ["inspect", "--view", "ownership"],
    ["inspect", "--view", "update-control"],
  ]);
});

void test("needs prepare: a legacy identity state refuses before prepare, not inside the current arm", async () => {
  const out = sink();
  const err = sink();
  const { adapter, calls } = scriptedAdapter([
    successResult("inspect", { fingerprint: null }, []),
    successResult("inspect", { identity_state: "both" }, []),
    successResult("inspect", { update_control: "managed" }, []),
  ]);
  const ctx = makePreparableCtx(out, err, adapter);
  const status = await runUpdate([], ctx);
  assert.equal(status, 1);
  assert.equal(
    err.chunks.join(""),
    "Legacy superpowers-wrapper Codex state is installed.\n" +
      "Run: npx superpowers-wrapper@0.1.1 uninstall\n" +
      "Then run: npx superpowers-manager install\n",
  );
  assert.equal(out.chunks.join(""), "");
  assert.deepEqual(calls, [
    ["inspect", "--view", "fingerprint"],
    ["inspect", "--view", "ownership"],
    ["inspect", "--view", "update-control"],
  ]);
});

void test("needs prepare: an empty update control refuses before prepare, not inside the current arm", async () => {
  const out = sink();
  const err = sink();
  const { adapter, calls } = scriptedAdapter([
    successResult("inspect", { fingerprint: null }, []),
    successResult("inspect", { identity_state: "manager" }, []),
    successResult("inspect", { update_control: null }, []),
  ]);
  const ctx = makePreparableCtx(out, err, adapter);
  const status = await runUpdate([], ctx);
  assert.equal(status, 1);
  assert.equal(
    err.chunks.join(""),
    "error: probe did not report adapter update-control capability\n",
  );
  assert.equal(out.chunks.join(""), "");
  assert.deepEqual(calls, [
    ["inspect", "--view", "fingerprint"],
    ["inspect", "--view", "ownership"],
    ["inspect", "--view", "update-control"],
  ]);
});

// --- gatherProbe's own failure is a stop, not a fall-through (spec §4.2a) ---
//
// update's OWN adapter footprint is exactly gatherProbe's three stages: it
// issues no ctx.adapter call of its own (unlike install, which re-inspects
// before mutating). These two cases are update's whole §4.2a obligation for
// that shared call site: a deterministic failure case for clause 3 (a
// hand-written message) and one for clause 2 (replay-only, no second line).

void test("gatherProbe's own clause-3 failure stops immediately, with its hand-written message", async () => {
  const out = sink();
  const err = sink();
  /** @type {readonly import("../../src/adapter-result.js").AdapterResult[]} */
  const responses = [
    {
      status: 1,
      outcome: {
        operation: "inspect",
        ok: true,
        messages: [],
        result: null,
        error: null,
      },
    },
  ];
  const { adapter, calls } = scriptedAdapter(responses);
  const ctx = makeCtx({ desiredCommit: X }, out, err, adapter);
  const status = await runUpdate([], ctx);
  assert.equal(status, 1);
  assert.equal(
    err.chunks.join(""),
    "error: adapter reported a failure status for inspect --view fingerprint\n",
  );
  assert.equal(out.chunks.join(""), "");
  assert.deepEqual(calls, [["inspect", "--view", "fingerprint"]]);
});

void test("gatherProbe's own clause-2 failure stops immediately, with ONLY the replayed diagnostic", async () => {
  const out = sink();
  const err = sink();
  const { adapter, calls } = scriptedAdapter([
    failureResult(
      "inspect",
      "E_ADAPTER",
      "cannot inspect fingerprint",
      ["check codex is installed"],
      [],
    ),
  ]);
  const ctx = makeCtx({ desiredCommit: X }, out, err, adapter);
  const status = await runUpdate([], ctx);
  assert.equal(status, 1);
  // No second, command-authored line: replayOutcome already wrote the
  // adapter's own error:/hint: lines, and probe.message is null here.
  assert.equal(
    err.chunks.join(""),
    "error: cannot inspect fingerprint\nhint: check codex is installed\n",
  );
  assert.equal(out.chunks.join(""), "");
  assert.deepEqual(calls, [["inspect", "--view", "fingerprint"]]);
});

void test("argv is ignored by src/commands/update.ts", async () => {
  const out = sink();
  const err = sink();
  const { adapter } = scriptedAdapter(probeCurrent());
  const ctx = makeCtx(
    { desiredCommit: X, generatedCommit: X },
    out,
    err,
    adapter,
  );
  const status = await runUpdate(["--bogus", "extra"], ctx);
  assert.equal(status, 0);
});
