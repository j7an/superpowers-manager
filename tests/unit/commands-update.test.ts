import { writeQualifiedCodexFixture } from "../lib/harnesses/codex/prepared-fixture.ts";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  capture,
  observingCoordinator,
  operationNames,
  scriptedAdapter,
  successfulNonzeroResult,
} from "../lib/command-doubles.ts";

import { codexPresentation } from "../../src/harnesses/codex/presentation.ts";
import { runUpdate } from "../../src/commands/update.ts";
import { gatherProbe } from "../../src/commands/probe.ts";
import { successResult, failureResult } from "../../src/adapter-result.ts";

const SCRATCH = mkdtempSync(join(tmpdir(), "spw-commands-update-"));
process.on("exit", () => rmSync(SCRATCH, { recursive: true, force: true }));

const INSTALL_NOTE =
  "Note: remove or disable conflicting Superpowers providers yourself before" +
  " relying on manager skills.\n";

/**
 * A hermetic update ctx: a 40-hex SUPERPOWERS_REF is a raw-commit resolution
 * (`src/upstream.ts:162-164::return { kind: "raw-commit"`), so computeEffectiveSelection never touches git,
 * matching tests/unit/commands-install.test.js's own makeCtx.
 *
 */
async function makeCtx(
  opts: {
    desiredCommit: string;
    generatedCommit?: string;
    extraEnv?: Record<string, string>;
  },
  out: ReturnType<typeof capture>,
  err: ReturnType<typeof capture>,
  adapter: import("../../src/commands/context.ts").CommandContext<
    import("../../src/harnesses/codex/adapter.ts").CodexRemovalInput
  >["adapter"],
) {
  const dir = mkdtempSync(join(SCRATCH, "case-"));
  mkdirSync(join(dir, "config"), { recursive: true });
  writeFileSync(join(dir, "config", "upstream-ref"), "v1.0.0\n");
  const configDir = join(dir, "config-dir");
  mkdirSync(configDir, { recursive: true });
  if (opts.generatedCommit !== undefined) {
    await writeQualifiedCodexFixture(
      join(dir, "plugins", "superpowers"),
      opts.generatedCommit,
      opts.extraEnv?.SUPERPOWERS_UPSTREAM_URL ??
        "https://example.invalid/upstream",
    );
  }
  return {
    root: dir,
    env: {
      HOME: join(dir, "home"),
      PATH: process.env.PATH ?? "",
      SUPERPOWERS_CONFIG_DIR: configDir,
      SUPERPOWERS_PLUGIN_ROOT: join(dir, "plugins", "superpowers"),
      SUPERPOWERS_UPSTREAM_URL: "https://example.invalid/upstream",
      SUPERPOWERS_REF: opts.desiredCommit,
      ...opts.extraEnv,
    },
    stdout: out.stream,
    stderr: err.stream,
    options: { harness: "codex" as const, allowExperimental: false },
    coordination: observingCoordinator(),
    adapter,
  };
}

const X = "1".repeat(40);

function ownership(identityState: string | number | null) {
  return {
    resources: { plugin: false, marketplace: false },
    identity_state: identityState,
  };
}

/** gatherProbe's three stages, in call order, reporting a clean "current" state. */
function probeCurrent() {
  return [
    successResult("inspect", { fingerprint: X }, []),
    successResult("inspect", ownership("manager"), []),
    successResult("inspect", { update_control: "managed" }, []),
  ];
}

/** Same three stages, but with no installed fingerprint -- "needs install". */
function probeNeedsInstall() {
  return [
    successResult("inspect", { fingerprint: null }, []),
    successResult("inspect", ownership("manager"), []),
    successResult("inspect", { update_control: "managed" }, []),
  ];
}

// Per-invocation identity flags only -- these write no git config at any
// scope. GIT_CONFIG_GLOBAL deliberately names a file that does not exist and
// GIT_CONFIG_NOSYSTEM suppresses the system file, so the fixture repository is
// not machine-dependent. Same arrangement as
// `tests/baseline/prepare-fixture.ts:32-67::const GIT_ENV`, and the reason it is needed here is
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

function git(cwd: string, args: readonly string[]): string {
  const ran = spawnSync("git", [...args], {
    cwd,
    env: GIT_ENV,
    encoding: "utf8",
  });
  assert.equal(ran.status, 0, `fixture git ${args.join(" ")}: ${ran.stderr}`);
  return ran.stdout;
}

/**
 * A local upstream repository carrying every REQUIRED_UPSTREAM path, so
 * runPrepare's clone-checkout-copy pipeline can succeed without a network.
 * Hermetic: a local clone, no remote.
 *
 */
function makeUpstreamRepo(): { path: string; commit: string } {
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
 * runPrepare's fallback manifest template at its default location, set by
 * gatherPrepare's manifestTemplate resolution. Read before the adapter build,
 * so the atomic swap that later replaces the plugin root does not race it.
 *
 */
function writeManifestTemplate(root: string) {
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
 */
async function makePreparableCtx(
  out: ReturnType<typeof capture>,
  err: ReturnType<typeof capture>,
  adapter: import("../../src/commands/context.ts").CommandContext<
    import("../../src/harnesses/codex/adapter.ts").CodexRemovalInput
  >["adapter"],
) {
  const ctx = await makeCtx(
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
  // lets it through on a successful run (`git show ad56569a4c161e7b122967442e2b026eeb6395f6:scripts/install:18::porcelain`'s
  // probe_output=$(...) capture). Two independent ctx/adapter pairs, built
  // from the same fixture: one drives gatherProbe directly to obtain the
  // real `facts` object, the other drives runUpdate. Comparing runUpdate's
  // stdout against formatPorcelain(facts) proves the exact text, not just a
  // substring of it.
  const probeOnly = capture();
  const probeErr = capture();
  const { adapter: probeAdapter } = scriptedAdapter(probeCurrent());
  const probeCtx = await makeCtx(
    { desiredCommit: X, generatedCommit: X },
    probeOnly,
    probeErr,
    probeAdapter,
  );
  const probe = await gatherProbe(probeCtx);
  assert.equal(probe.status, 0);
  assert.equal(probe.facts.status, "current");

  const out = capture();
  const err = capture();
  const { adapter, calls } = scriptedAdapter(probeCurrent());
  const ctx = await makeCtx(
    { desiredCommit: X, generatedCommit: X },
    out,
    err,
    adapter,
  );
  const status = await runUpdate([], ctx);
  assert.equal(status, 0);
  assert.equal(
    out.text(),
    `${codexPresentation.renderProbe(probe.facts).porcelain}manager is current\n`,
  );
  assert.equal(err.text(), "");
  // The current arm issues no adapter call of its own: only gatherProbe's
  // three.
  assert.deepEqual(operationNames(calls), [
    "preparation-location",
    "mutation-roots",
    "preparation-location",
    "mutation-roots",
    "inspect-prepared",
    "inspect-installed",
    "inspect-ownership",
    "inspect-update-control",
    "inspect-prepared",
    "inspect-installed",
    "inspect-update-control",
  ]);
});

void test("current: refuses an unsupported update control BEFORE printing anything", async () => {
  // §4.4's second correction: `git show ad56569a4c161e7b122967442e2b026eeb6395f6:scripts/update:18::spw_require_managed_update_control` gates before `git show ad56569a4c161e7b122967442e2b026eeb6395f6:scripts/update:19::printf`
  // prints anything. An update reporting "manager is current" under an
  // unsupported adapter would be asserting managed control it had not
  // verified.
  const out = capture();
  const err = capture();
  const { adapter, calls } = scriptedAdapter([
    successResult("inspect", { fingerprint: X }, []),
    successResult("inspect", ownership("manager"), []),
    successResult("inspect", { update_control: "unsupported" }, []),
  ]);
  const ctx = await makeCtx(
    { desiredCommit: X, generatedCommit: X },
    out,
    err,
    adapter,
  );
  const status = await runUpdate([], ctx);
  assert.equal(status, 1);
  assert.equal(out.text(), "");
  assert.equal(
    err.text(),
    "error: adapter cannot guarantee manager-controlled updates\n",
  );
  assert.equal(calls.length, 11);
});

void test('current: an UNRECOGNISED update control capability is its own diagnostic, distinct from "unsupported"', async () => {
  // requireManagedUpdateControl (src/harnesses/codex/lifecycle.ts) has three arms: managed,
  // unsupported, and a catch-all. A mutant collapsing the catch-all into the
  // "unsupported" arm would survive the case above alone.
  const out = capture();
  const err = capture();
  const { adapter, calls } = scriptedAdapter([
    successResult("inspect", { fingerprint: X }, []),
    successResult("inspect", ownership("manager"), []),
    successResult("inspect", { update_control: "wat" }, []),
  ]);
  const ctx = await makeCtx(
    { desiredCommit: X, generatedCommit: X },
    out,
    err,
    adapter,
  );
  const status = await runUpdate([], ctx);
  assert.equal(status, 1);
  assert.equal(out.text(), "");
  assert.equal(
    err.text(),
    "error: unknown adapter update-control capability: wat\n",
  );
  assert.equal(calls.length, 11);
});

void test("needs prepare: a failing prepare's status propagates verbatim, and install never runs", async () => {
  // No generated metadata file is written, so generatedCommitOrEmpty yields
  // "" and facts.status is "needs prepare". runPrepare is called as a
  // FUNCTION and its own failure -- a missing fallback manifest template,
  // since none was created in this fixture -- becomes update's return value
  // verbatim, the property `set -eu` gave the shell for free and a function
  // call does not.
  const out = capture();
  const err = capture();
  const { adapter, calls } = scriptedAdapter(probeCurrent());
  const ctx = await makeCtx({ desiredCommit: X }, out, err, adapter);
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
    err.text(),
    `error: missing fallback manifest template: ${template}\n`,
  );
  // Only gatherProbe's own three calls: prepare fails before issuing any
  // adapter call of its own, and install is never reached.
  assert.equal(calls.length, 15);
});

void test("needs prepare: a SUCCESSFUL prepare is followed by a real runInstall, not by a bare success", async () => {
  // `git show ad56569a4c161e7b122967442e2b026eeb6395f6:scripts/update:23-24::sh "$root/scripts/prepare` -- prepare THEN install. The sibling case above only
  // reaches the first of the two, because its prepare fails; this one is the
  // only proof that the second statement of the arm exists at all. Replacing
  // `return await runInstall([], ctx)` with `return 0` leaves update
  // preparing a fresh tree, skipping the install, and reporting success for
  // state it never installed -- so the assertion has to be the recorded
  // adapter sequence, not the exit status, which the defect reproduces
  // exactly.
  const out = capture();
  const err = capture();
  const { adapter, calls } = scriptedAdapter([
    // update's own probe. No generated tree exists yet, so statusForCommits
    // returns "needs prepare" whatever the installed fingerprint says.
    successResult("inspect", { fingerprint: null }, []),
    successResult("inspect", ownership("manager"), []),
    successResult("inspect", { update_control: "managed" }, []),
    // runPrepare's single adapter call. runPrepare itself creates and fills
    // the candidate root, so a scripted success is enough for the swap that
    // follows to find a real tree.
    successResult("build", {}, []),
    // runInstall's own probe, which now sees the freshly prepared tree.
    successResult("inspect", { fingerprint: null }, []),
    successResult("inspect", ownership("manager"), []),
    successResult("inspect", { update_control: "managed" }, []),
    // runInstall's four mutation stages.
    successResult("inspect", ownership("manager"), []),
    successResult("inspect", { update_control: "managed" }, []),
    successResult("install", {}, []),
    successResult("inspect", { fingerprint: UPSTREAM.commit }, []),
  ]);
  const ctx = await makePreparableCtx(out, err, adapter);

  const status = await runUpdate([], ctx);
  assert.equal(status, 0);
  assert.equal(err.text(), "");
  // runPrepare's own success line, then runInstall's. Neither is written by
  // update, so the presence of the second one is itself evidence the second
  // statement of the arm ran.
  assert.equal(
    out.text(),
    `prepared ${UPSTREAM.commit} at ${UPSTREAM.commit}\n` +
      `${INSTALL_NOTE}desired_commit=${UPSTREAM.commit}\n` +
      `installed_commit=${UPSTREAM.commit}\nmanager updated\n`,
  );
  assert.equal(calls.length, 32);
  assert.deepEqual(operationNames(calls), [
    "preparation-location",
    "mutation-roots",
    "preparation-location",
    "mutation-roots",
    "inspect-prepared",
    "inspect-installed",
    "inspect-ownership",
    "inspect-update-control",
    "inspect-prepared",
    "inspect-installed",
    "inspect-update-control",
    "preparation-location",
    "mutation-roots",
    "preparation-location",
    "validate-preparation-before-fetch",
    "prepare-candidate",
    "preparation-location",
    "mutation-roots",
    "preparation-location",
    "mutation-roots",
    "inspect-prepared",
    "inspect-installed",
    "inspect-ownership",
    "inspect-update-control",
    "inspect-prepared",
    "inspect-installed",
    "inspect-update-control",
    "read-prepared",
    "inspect-ownership",
    "inspect-update-control",
    "install",
    "inspect-installed",
  ]);
});

void test("needs install: delegates to runInstall alone, and a success propagates as status 0", async () => {
  // Ten calls, not seven: `git show ad56569a4c161e7b122967442e2b026eeb6395f6:scripts/update:26-27::needs\ install` spawned `sh scripts/install` as a
  // SEPARATE process, which re-ran `sh scripts/probe --porcelain` from
  // scratch (`git show ad56569a4c161e7b122967442e2b026eeb6395f6:scripts/install:18::porcelain`) before its own re-inspection. runInstall
  // preserves that double-probe as a second, independent gatherProbe call --
  // update's own probe (3 calls) is not the same call as install's own probe
  // (3 more calls) -- so the fixture scripts both, then install's four
  // mutation stages.
  const out = capture();
  const err = capture();
  const { adapter, calls } = scriptedAdapter([
    ...probeNeedsInstall(),
    ...probeNeedsInstall(),
    successResult("inspect", ownership("manager"), []),
    successResult("inspect", { update_control: "managed" }, []),
    successResult("install", {}, []),
    successResult("inspect", { fingerprint: X }, []),
  ]);
  const ctx = await makeCtx(
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
    out.text(),
    `${INSTALL_NOTE}desired_commit=${X}\ninstalled_commit=${X}\nmanager updated\n`,
  );
  assert.equal(err.text(), "");
  assert.deepEqual(operationNames(calls), [
    "preparation-location",
    "mutation-roots",
    "preparation-location",
    "mutation-roots",
    "inspect-prepared",
    "inspect-installed",
    "inspect-ownership",
    "inspect-update-control",
    "inspect-prepared",
    "inspect-installed",
    "inspect-update-control",
    "preparation-location",
    "mutation-roots",
    "preparation-location",
    "mutation-roots",
    "inspect-prepared",
    "inspect-installed",
    "inspect-ownership",
    "inspect-update-control",
    "inspect-prepared",
    "inspect-installed",
    "inspect-update-control",
    "read-prepared",
    "inspect-ownership",
    "inspect-update-control",
    "install",
    "inspect-installed",
  ]);
});

void test("needs install: a non-zero runInstall return propagates as update's status, not swallowed", async () => {
  const out = capture();
  const err = capture();
  const { adapter, calls } = scriptedAdapter([
    ...probeNeedsInstall(),
    ...probeNeedsInstall(),
    successResult("inspect", ownership("manager"), []),
    successResult("inspect", { update_control: "unsupported" }, []),
  ]);
  const ctx = await makeCtx(
    { desiredCommit: X, generatedCommit: X },
    out,
    err,
    adapter,
  );
  const status = await runUpdate([], ctx);
  assert.equal(status, 1);
  // runInstall's OWN diagnostic, verbatim -- update adds no second message.
  assert.equal(
    err.text(),
    "error: adapter cannot guarantee manager-controlled updates\n",
  );
  // runInstall's own NOTE line reaches stdout, unaltered; update writes
  // nothing of its own on this arm, success or failure alike.
  assert.equal(out.text(), INSTALL_NOTE);
  assert.equal(calls.length, 25);
});

// --- The two emptiness checks that run BEFORE the switch (§4.4's first
// correction). `git show ad56569a4c161e7b122967442e2b026eeb6395f6:scripts/update:10::[ -n "$identity_state` guards identity_state (matching install's
// equivalent guard); `git show ad56569a4c161e7b122967442e2b026eeb6395f6:scripts/update:14::capability` guards update_control, which install
// never checks at all. ---

void test("an empty probe-reported identity state is its own diagnostic, distinct from an unrecognised one", async () => {
  const out = capture();
  const err = capture();
  const { adapter, calls } = scriptedAdapter([
    successResult("inspect", { fingerprint: X }, []),
    successResult("inspect", ownership(null), []),
    successResult("inspect", { update_control: "managed" }, []),
  ]);
  const ctx = await makeCtx(
    { desiredCommit: X, generatedCommit: X },
    out,
    err,
    adapter,
  );
  const status = await runUpdate([], ctx);
  assert.equal(status, 1);
  assert.equal(
    err.text(),
    "error: probe did not report adapter identity state\n",
  );
  assert.equal(out.text(), "");
  assert.equal(calls.length, 11);
});

void test("a legacy identity state stops before the update-control guard even runs", async () => {
  const out = capture();
  const err = capture();
  const { adapter, calls } = scriptedAdapter([
    successResult("inspect", { fingerprint: X }, []),
    successResult("inspect", ownership("both"), []),
    successResult("inspect", { update_control: "managed" }, []),
  ]);
  const ctx = await makeCtx(
    { desiredCommit: X, generatedCommit: X },
    out,
    err,
    adapter,
  );
  const status = await runUpdate([], ctx);
  assert.equal(status, 1);
  // `git show ad56569a4c161e7b122967442e2b026eeb6395f6:scripts/core/lifecycle.sh:50-53::'Legacy superpowers-wrapper Codex state is` is a single printf writing three bare
  // lines to stderr, no `error: ` prefix; :54 is the `return 1` that follows
  // it, reached without spw_die.
  assert.equal(
    err.text(),
    "Legacy superpowers-wrapper Codex state is installed.\n" +
      "Run: npx superpowers-wrapper@0.1.1 uninstall\n" +
      "Then run: npx superpowers-manager install\n",
  );
  assert.equal(out.text(), "");
  assert.equal(calls.length, 11);
});

void test("an UNKNOWN probe identity state is a distinct diagnostic from the legacy-blocked one", async () => {
  // The sibling case above drives requireNoLegacyState's "blocked" arm; this
  // one drives its "unknown" arm (src/harnesses/codex/lifecycle.ts, reached for any
  // identity_state outside the four known ones). Each arm needs its own
  // case: a mutant disabling both at once dies to the "blocked" case alone.
  const out = capture();
  const err = capture();
  const { adapter, calls } = scriptedAdapter([
    successResult("inspect", { fingerprint: X }, []),
    successResult("inspect", ownership("chaos"), []),
    successResult("inspect", { update_control: "managed" }, []),
  ]);
  const ctx = await makeCtx(
    { desiredCommit: X, generatedCommit: X },
    out,
    err,
    adapter,
  );
  const status = await runUpdate([], ctx);
  assert.equal(status, 1);
  // scripts/core/lifecycle.sh calls spw_die for the catch-all, which DOES
  // prefix `error: ` -- unlike the bare three lines the "blocked" arm writes.
  assert.equal(err.text(), "error: unknown adapter identity state: chaos\n");
  assert.equal(out.text(), "");
  assert.equal(calls.length, 11);
});

void test("an empty probe-reported update-control capability fails closed, and runInstall never runs", async () => {
  // `git show ad56569a4c161e7b122967442e2b026eeb6395f6:scripts/update:14::capability`. install checks only identity_state
  // (`git show ad56569a4c161e7b122967442e2b026eeb6395f6:scripts/install:20::report`); update checks this too -- §4.4's first correction.
  // Proven with a call recorder, not just the absence of "manager is
  // current" output: the assertion is that NO call past gatherProbe's own
  // three ever happens, not merely that this particular arm's text is
  // absent.
  const out = capture();
  const err = capture();
  const { adapter, calls } = scriptedAdapter([
    successResult("inspect", { fingerprint: X }, []),
    successResult("inspect", ownership("manager"), []),
    successResult("inspect", { update_control: null }, []),
  ]);
  const ctx = await makeCtx(
    { desiredCommit: X, generatedCommit: X },
    out,
    err,
    adapter,
  );
  const status = await runUpdate([], ctx);
  assert.equal(status, 1);
  assert.equal(
    err.text(),
    "error: probe did not report adapter update-control capability\n",
  );
  assert.equal(out.text(), "");
  assert.deepEqual(operationNames(calls), [
    "preparation-location",
    "mutation-roots",
    "preparation-location",
    "mutation-roots",
    "inspect-prepared",
    "inspect-installed",
    "inspect-ownership",
    "inspect-update-control",
    "inspect-prepared",
    "inspect-installed",
    "inspect-update-control",
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
// that arrival loud. What must not happen is exactly what `git show ad56569a4c161e7b122967442e2b026eeb6395f6:scripts/update:10-14::[ -n "$identity_state`
// refuses -- a real generated-tree write under an identity or an update-control
// capability the command has not accepted.

void test("needs prepare: an empty identity state refuses before prepare, not inside the current arm", async () => {
  const out = capture();
  const err = capture();
  const { adapter, calls } = scriptedAdapter([
    successResult("inspect", { fingerprint: null }, []),
    successResult("inspect", ownership(null), []),
    successResult("inspect", { update_control: "managed" }, []),
  ]);
  const ctx = await makePreparableCtx(out, err, adapter);
  const status = await runUpdate([], ctx);
  assert.equal(status, 1);
  assert.equal(
    err.text(),
    "error: probe did not report adapter identity state\n",
  );
  assert.equal(out.text(), "");
  assert.deepEqual(operationNames(calls), [
    "preparation-location",
    "mutation-roots",
    "preparation-location",
    "mutation-roots",
    "inspect-prepared",
    "inspect-installed",
    "inspect-ownership",
    "inspect-update-control",
    "inspect-prepared",
    "inspect-installed",
    "inspect-update-control",
  ]);
});

void test("needs prepare: a legacy identity state refuses before prepare, not inside the current arm", async () => {
  const out = capture();
  const err = capture();
  const { adapter, calls } = scriptedAdapter([
    successResult("inspect", { fingerprint: null }, []),
    successResult("inspect", ownership("both"), []),
    successResult("inspect", { update_control: "managed" }, []),
  ]);
  const ctx = await makePreparableCtx(out, err, adapter);
  const status = await runUpdate([], ctx);
  assert.equal(status, 1);
  assert.equal(
    err.text(),
    "Legacy superpowers-wrapper Codex state is installed.\n" +
      "Run: npx superpowers-wrapper@0.1.1 uninstall\n" +
      "Then run: npx superpowers-manager install\n",
  );
  assert.equal(out.text(), "");
  assert.deepEqual(operationNames(calls), [
    "preparation-location",
    "mutation-roots",
    "preparation-location",
    "mutation-roots",
    "inspect-prepared",
    "inspect-installed",
    "inspect-ownership",
    "inspect-update-control",
    "inspect-prepared",
    "inspect-installed",
    "inspect-update-control",
  ]);
});

void test("needs prepare: an empty update control refuses before prepare, not inside the current arm", async () => {
  const out = capture();
  const err = capture();
  const { adapter, calls } = scriptedAdapter([
    successResult("inspect", { fingerprint: null }, []),
    successResult("inspect", ownership("manager"), []),
    successResult("inspect", { update_control: null }, []),
  ]);
  const ctx = await makePreparableCtx(out, err, adapter);
  const status = await runUpdate([], ctx);
  assert.equal(status, 1);
  assert.equal(
    err.text(),
    "error: probe did not report adapter update-control capability\n",
  );
  assert.equal(out.text(), "");
  assert.deepEqual(operationNames(calls), [
    "preparation-location",
    "mutation-roots",
    "preparation-location",
    "mutation-roots",
    "inspect-prepared",
    "inspect-installed",
    "inspect-ownership",
    "inspect-update-control",
    "inspect-prepared",
    "inspect-installed",
    "inspect-update-control",
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
  const out = capture();
  const err = capture();
  const { adapter: scripted, calls } = scriptedAdapter([]);
  const adapter = {
    ...scripted,
    async inspectInstalled(
      selection: Parameters<typeof scripted.inspectInstalled>[0],
    ) {
      calls.push({ operation: "inspect-installed", input: selection });
      return successfulNonzeroResult("inspect", {
        kind: "absent" as const,
        observedIdentity: "" as const,
      });
    },
  };
  const ctx = await makeCtx({ desiredCommit: X }, out, err, adapter);
  const status = await runUpdate([], ctx);
  assert.equal(status, 1);
  assert.equal(
    err.text(),
    "error: adapter reported a failure status for inspect --view fingerprint\n",
  );
  assert.equal(out.text(), "");
  assert.deepEqual(operationNames(calls), [
    "preparation-location",
    "mutation-roots",
    "preparation-location",
    "mutation-roots",
    "inspect-prepared",
    "inspect-installed",
  ]);
});

void test("gatherProbe's own clause-2 failure stops immediately, with ONLY the replayed diagnostic", async () => {
  const out = capture();
  const err = capture();
  const { adapter, calls } = scriptedAdapter([
    failureResult(
      "inspect",
      "E_ADAPTER",
      "cannot inspect fingerprint",
      ["check codex is installed"],
      [],
    ),
  ]);
  const ctx = await makeCtx({ desiredCommit: X }, out, err, adapter);
  const status = await runUpdate([], ctx);
  assert.equal(status, 1);
  // No second, command-authored line: replayOutcome already wrote the
  // adapter's own error:/hint: lines, and probe.message is null here.
  assert.equal(
    err.text(),
    "error: cannot inspect fingerprint\nhint: check codex is installed\n",
  );
  assert.equal(out.text(), "");
  assert.deepEqual(operationNames(calls), [
    "preparation-location",
    "mutation-roots",
    "preparation-location",
    "mutation-roots",
    "inspect-prepared",
    "inspect-installed",
  ]);
});

void test("argv is ignored by src/commands/update.ts", async () => {
  const out = capture();
  const err = capture();
  const { adapter } = scriptedAdapter(probeCurrent());
  const ctx = await makeCtx(
    { desiredCommit: X, generatedCommit: X },
    out,
    err,
    adapter,
  );
  const status = await runUpdate(["--bogus", "extra"], ctx);
  assert.equal(status, 0);
});
