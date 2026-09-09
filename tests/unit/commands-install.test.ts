import { writeQualifiedCodexFixture } from "../lib/harnesses/codex/prepared-fixture.ts";
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
import {
  capture,
  observingCoordinator,
  operationNames,
  scriptedAdapter,
  successfulNonzeroResult,
} from "../lib/command-doubles.ts";

import { runInstall } from "../../src/commands/install.ts";
import { successResult, failureResult } from "../../src/adapter-result.ts";
import { workspaceRemovalFailure } from "../../src/workspace.ts";

const SCRATCH = mkdtempSync(join(tmpdir(), "spw-commands-install-"));
process.on("exit", () => rmSync(SCRATCH, { recursive: true, force: true }));

const NOTE =
  "Note: remove or disable conflicting Superpowers providers yourself before" +
  " relying on manager skills.\n";

function writeJsonFile(path: string, value: unknown) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value), "utf8");
}

/**
 * A hermetic install ctx: a 40-hex SUPERPOWERS_REF is a raw-commit resolution
 * (`src/upstream.ts:162-164::return { kind: "raw-commit"`), so computeEffectiveSelection never touches git,
 * matching tests/unit/commands-prepare.test.js's unitContext.
 *
 * `savedCommit`, when given, is written as a SEPARATE, valid pinned
 * `selection.json` -- deliberately unrelated to `desiredCommit`, so a test can
 * prove install reads the GENERATED metadata file rather than the SAVED
 * selection for its own desired commit (AGENTS.md: "Saved upstream intent and
 * generated provenance are separate contracts").
 *
 */
async function makeCtx(
  opts: {
    desiredCommit: string;
    generatedCommit?: string;
    savedCommit?: string;
    env?: Record<string, string>;
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
    await writeQualifiedCodexFixture(
      join(dir, "plugins", "superpowers"),
      opts.generatedCommit,
      opts.env?.SUPERPOWERS_UPSTREAM_URL ?? "https://example.invalid/upstream",
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
    options: { harness: "codex" as const, allowExperimental: false },
    coordination: observingCoordinator(),
    adapter,
  };
}

const X = "1".repeat(40);
const Z = "2".repeat(40);

function ownership(identityState: string | number | null) {
  return {
    resources: { plugin: false, marketplace: false },
    identity_state: identityState,
  };
}

/** The three probe-stage responses, in gatherProbe's own call order. */
const PROBE_OK = [
  successResult("inspect", { fingerprint: null }, []),
  successResult("inspect", ownership("manager"), []),
  successResult("inspect", { update_control: "managed" }, []),
];

// --- The four fail-closed rules (milestone spec §7 / spec §4.3) ---

void test("install re-inspects ownership and update control itself", async (t) => {
  await t.test(
    "a conflict introduced after probe blocks the fresh pre-mutation inspection",
    async () => {
      const out = capture();
      const err = capture();
      const { adapter: scripted, calls } = scriptedAdapter([
        successResult("inspect", { fingerprint: null }, []),
        successResult("inspect", ownership("manager"), []),
        successResult("inspect", { update_control: "managed" }, []),
        successResult(
          "inspect",
          {
            ...ownership("manager"),
            conflicts: ["active Codex plugin superpowers@another-provider"],
          },
          [],
        ),
      ]);
      const compatibility = {
        kind: "supported" as const,
        generation: "codex-native",
        reason: "fixture compatibility",
      };
      const artifact = {
        root: "/prepared-plugin",
        commit: X,
        compatibility,
        identity: X,
      };
      const adapter = {
        ...scripted,
        async inspectPrepared() {
          calls.push({ operation: "inspect-prepared" });
          return successResult(
            "inspect-prepared",
            {
              kind: "current" as const,
              artifact,
              observedIdentity: X,
              compatibility,
            },
            [],
          );
        },
        async readPrepared() {
          calls.push({ operation: "read-prepared" });
          return successResult("read-prepared", artifact, []);
        },
      };
      const ctx = await makeCtx(
        { desiredCommit: X, generatedCommit: X },
        out,
        err,
        adapter,
      );

      const status = await runInstall([], ctx);

      assert.equal(status, 1);
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
        "read-prepared",
        "inspect-ownership",
      ]);
      assert.equal(
        err.text(),
        "Conflicting unmanaged Superpowers Codex resources require manual resolution:\n" +
          "- active Codex plugin superpowers@another-provider\n" +
          "Remove or disable each resource manually, then retry.\n",
      );
      assert.equal(out.text(), NOTE);
    },
  );

  // Rule 1. gatherProbe just reported both, and install asks AGAIN. Mutation
  // authority requires CURRENT, VALIDATED evidence -- a probe's answer is
  // neither by the time the mutation runs. AGENTS.md, milestone spec §7.
  const out = capture();
  const err = capture();
  const { adapter, calls } = scriptedAdapter([
    ...PROBE_OK,
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
  const status = await runInstall([], ctx);
  assert.equal(status, 0);
  // Asserted structurally over the recorded argv, not over a log: the point
  // is that the calls HAPPENED, in order, after the probe's own three.
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
    "read-prepared",
    "inspect-ownership",
    "inspect-update-control",
    "install",
    "inspect-installed",
  ]);
});

void test("a successful install prints the fingerprint verification lines and no porcelain", async () => {
  // The parity trap `git show ad56569a4c161e7b122967442e2b026eeb6395f6:scripts/install:18::porcelain`'s probe_output=$(...) capture creates:
  // the porcelain never reaches the terminal on a successful run.
  const out = capture();
  const err = capture();
  const { adapter } = scriptedAdapter([
    ...PROBE_OK,
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
  const status = await runInstall([], ctx);
  assert.equal(status, 0);
  assert.equal(
    out.text(),
    `${NOTE}desired_commit=${X}\ninstalled_commit=${X}\nmanager updated\n`,
  );
  assert.equal(err.text(), "");
});

void test("desiredCommit comes from generated provenance, never from selection", async () => {
  // Rule 2. Saved upstream intent and generated provenance are separate
  // contracts; never treat one as evidence of the other. The fixture writes a
  // SAVED commit (Z) that DIFFERS from the GENERATED one (X), and the
  // installed fingerprint (from the POST-install inspect, stage 4) is also X.
  // A port that reused facts.savedCommit as the fingerprint's desired commit
  // would report a mismatch here (Z vs X); a same-value fixture could not
  // tell the two sources apart at all.
  const out = capture();
  const err = capture();
  const { adapter, calls } = scriptedAdapter([
    ...PROBE_OK,
    successResult("inspect", ownership("manager"), []),
    successResult("inspect", { update_control: "managed" }, []),
    successResult("install", {}, []),
    successResult("inspect", { fingerprint: X }, []),
  ]);
  const ctx = await makeCtx(
    { desiredCommit: X, generatedCommit: X, savedCommit: Z },
    out,
    err,
    adapter,
  );
  const status = await runInstall([], ctx);
  assert.equal(status, 0);
  assert.ok(
    out.text().includes(`desired_commit=${X}\n`),
    `expected the GENERATED commit in stdout:\n${out.text()}`,
  );
  assert.ok(
    !out.text().includes(Z),
    `the SAVED commit must never appear:\n${out.text()}`,
  );
  assert.equal(calls.length, 16);
});

void test("saved selection is validated before any adapter access", async () => {
  // Rule 3. Ordering, not just outcome: with an invalid saved selection the
  // adapter must have been called ZERO times. computeEffectiveSelection loads
  // the saved selection before it ever branches on SUPERPOWERS_REF, so an
  // invalid record throws before gatherProbe's first inspect call.
  const out = capture();
  const err = capture();
  const { adapter, calls } = scriptedAdapter([]);
  const ctx = await makeCtx({ desiredCommit: X }, out, err, adapter);
  writeFileSync(
    join(ctx.env.SUPERPOWERS_CONFIG_DIR, "selection.json"),
    '{"schema_version":1,"mode":"bogus"}',
    "utf8",
  );
  const status = await runInstall([], ctx);
  assert.equal(status, 1);
  assert.deepEqual(calls, []);
  assert.equal(err.text(), "error: mode must be pinned or track-latest\n");
  assert.equal(out.text(), NOTE);
});

void test("an unparseable generated commit is never treated as success", async () => {
  // Rule 4. statusForCommits("") returns "needs prepare"; a failed inspection
  // (here, prepare itself failing) propagates rather than defaulting to
  // success. No generated metadata file is written, so
  // generatedCommitOrEmpty yields "" and facts.status is "needs prepare".
  // runPrepare is called as a function and its own failure -- a missing
  // fallback manifest template, since none was created in this fixture --
  // becomes install's return value verbatim.
  const out = capture();
  const err = capture();
  const { adapter, calls } = scriptedAdapter([...PROBE_OK]);
  const ctx = await makeCtx({ desiredCommit: X }, out, err, adapter);
  const status = await runInstall([], ctx);
  assert.equal(status, 1);
  assert.equal(calls.length, 15);
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
});

// --- gatherProbe's own failure (:320-325) is a stop, not a fall-through ---
//
// Mutation testing found this relay completely unexercised: a mutant that
// never stops on probe.status === 1 falls straight through into
// requireNoLegacyState on an undefined `facts`, then (if that somehow
// survived) into runPrepare and the install mutation itself -- the worst
// direction for this relay to fail in. Two cases: one where the failing
// call's outcome is ok (clause 3, so probe.message is a hand-written,
// non-null string) and one where it is not (clause 2, so probe.message is
// null and replayOutcome alone carries the diagnostic). Together they pin
// both "the stop happens" (calls never grows past gatherProbe's own failing
// call -- no prepare, no workspace, no install mutation) and "the message
// is not dropped" for the one shape where there is a message to drop.

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
  const status = await runInstall([], ctx);
  assert.equal(status, 1);
  assert.equal(
    err.text(),
    "error: adapter reported a failure status for inspect --view fingerprint\n",
  );
  assert.equal(out.text(), NOTE);
  // gatherProbe's OWN structure returns immediately on its first failing
  // call, before the ownership or update-control inspects run at all --
  // never mind runPrepare or the workspace stage's four.
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
  const status = await runInstall([], ctx);
  assert.equal(status, 1);
  // No second, command-authored line: replayOutcome already wrote the
  // adapter's own error:/hint: lines, and probe.message is null here.
  assert.equal(
    err.text(),
    "error: cannot inspect fingerprint\nhint: check codex is installed\n",
  );
  assert.equal(out.text(), NOTE);
  assert.deepEqual(operationNames(calls), [
    "preparation-location",
    "mutation-roots",
    "preparation-location",
    "mutation-roots",
    "inspect-prepared",
    "inspect-installed",
  ]);
});

// --- Named parity cases ---

void test("an empty probe-reported identity state is its own diagnostic, distinct from an unrecognised one", async () => {
  // `git show ad56569a4c161e7b122967442e2b026eeb6395f6:scripts/install:19-20::identity_state=$(spw_probe_field`. Guards the PROBE-derived value, not the
  // re-inspected one (src/commands/install.ts's `identity.kind ===
  // "malformed"` arm already owns that path). A JSON null identity_state on
  // gatherProbe's own ownership inspect becomes "" (the JSON-null
  // convention), and this check must fire BEFORE requireNoLegacyState would
  // otherwise reach its "unknown" arm and print a symptom
  // ("unknown adapter identity state: ", empty-suffixed) instead of the
  // actual cause.
  const out = capture();
  const err = capture();
  const { adapter, calls } = scriptedAdapter([
    successResult("inspect", { fingerprint: null }, []),
    successResult("inspect", ownership(null), []),
    successResult("inspect", { update_control: "managed" }, []),
  ]);
  const ctx = await makeCtx(
    { desiredCommit: X, generatedCommit: X },
    out,
    err,
    adapter,
  );
  const status = await runInstall([], ctx);
  assert.equal(status, 1);
  assert.equal(
    err.text(),
    "error: probe did not report adapter identity state\n",
  );
  assert.equal(out.text(), NOTE);
  assert.equal(calls.length, 11);
});

void test("a legacy identity state stops before the workspace is created", async () => {
  const out = capture();
  const err = capture();
  const { adapter, calls } = scriptedAdapter([
    successResult("inspect", { fingerprint: null }, []),
    successResult("inspect", ownership("legacy"), []),
    successResult("inspect", { update_control: "managed" }, []),
  ]);
  const ctx = await makeCtx(
    { desiredCommit: X, generatedCommit: X },
    out,
    err,
    adapter,
  );
  const status = await runInstall([], ctx);
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
  assert.equal(out.text(), NOTE);
  assert.equal(calls.length, 11);
});

void test("an UNKNOWN probe identity state stops before the workspace is created", async () => {
  // The sibling case and this one exercise distinct concrete normalization
  // decisions (`src/harnesses/codex/harness.ts::const installEligibility`),
  // both enforced by the same shared guard
  // (`src/commands/install.ts:471::if (facts.ownership.installEligibility.kind`).
  // "chaos" is non-empty, so its exact diagnostic remains distinct from the
  // empty-state decision asserted above.
  const out = capture();
  const err = capture();
  const { adapter, calls } = scriptedAdapter([
    successResult("inspect", { fingerprint: null }, []),
    successResult("inspect", ownership("chaos"), []),
    successResult("inspect", { update_control: "managed" }, []),
  ]);
  const ctx = await makeCtx(
    { desiredCommit: X, generatedCommit: X },
    out,
    err,
    adapter,
  );
  const status = await runInstall([], ctx);
  assert.equal(status, 1);
  // `git show ad56569a4c161e7b122967442e2b026eeb6395f6:scripts/core/lifecycle.sh:57::spw_die "unknown adapter identity state: $identity_state` calls spw_die, which DOES prefix `error: ` --
  // unlike the bare three lines the `"blocked"` arm writes.
  assert.equal(err.text(), "error: unknown adapter identity state: chaos\n");
  assert.equal(out.text(), NOTE);
  // Stops before the workspace: only gatherProbe's own three calls.
  assert.equal(calls.length, 11);
});

void test("an unsupported update-control capability refuses before any install mutation", async () => {
  const out = capture();
  const err = capture();
  const { adapter, calls } = scriptedAdapter([
    ...PROBE_OK,
    successResult("inspect", ownership("manager"), []),
    successResult("inspect", { update_control: "unsupported" }, []),
  ]);
  const ctx = await makeCtx(
    { desiredCommit: X, generatedCommit: X },
    out,
    err,
    adapter,
  );
  const status = await runInstall([], ctx);
  assert.equal(status, 1);
  assert.equal(
    err.text(),
    "error: adapter cannot guarantee manager-controlled updates\n",
  );
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
    "read-prepared",
    "inspect-ownership",
    "inspect-update-control",
  ]);
});

// --- Spec §4.2a's closing requirement: a deterministic failure case AND an
// ordering case for every lifecycle adapter stage. `install` has four stages
// after the probe's three -- ownership, update-control, install, fingerprint.
// The failure and malformed cases for a given stage are the pair that must
// NOT be collapsed: if they ever produce identical stderr text, the collapse
// spec §4.2a exists to forbid has reappeared. ---

void test("stage 1 (inspect ownership) failure stops with ONLY the replayed diagnostic", async () => {
  const out = capture();
  const err = capture();
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
  const ctx = await makeCtx(
    { desiredCommit: X, generatedCommit: X },
    out,
    err,
    adapter,
  );
  const status = await runInstall([], ctx);
  assert.equal(status, 1);
  assert.equal(
    err.text(),
    "error: cannot inspect ownership\nhint: check codex is installed\n",
  );
  assert.equal(calls.length, 13);
});

void test("stage 1 malformed identity_state is a DIFFERENT failure than stage 1's adapter failure", async () => {
  const out = capture();
  const err = capture();
  const { adapter, calls } = scriptedAdapter([
    ...PROBE_OK,
    successResult("inspect", ownership(42), []),
  ]);
  const ctx = await makeCtx(
    { desiredCommit: X, generatedCommit: X },
    out,
    err,
    adapter,
  );
  const status = await runInstall([], ctx);
  assert.equal(status, 1);
  assert.equal(
    err.text(),
    "error: adapter returned a non-string identity_state for inspect --view ownership\n",
  );
  assert.equal(calls.length, 13);
});

void test("stage 1 clause 3: outcome.ok but status !== 0 gets its own hand-written message", async () => {
  // Spec §4.2a clause 3. successResult/failureResult cannot express this
  // input, so the outcome is hand-built here to reach the one combination
  // invoke()'s gate must distinguish from both clause 2 (!outcome.ok,
  // replay-only) and clause 4 (a malformed but successful result).
  const out = capture();
  const err = capture();

  const { adapter: scripted, calls } = scriptedAdapter(PROBE_OK);
  let ownershipCalls = 0;
  const adapter = {
    ...scripted,
    async inspectOwnership(
      adapterContext: Parameters<typeof scripted.inspectOwnership>[0],
    ) {
      ownershipCalls += 1;
      if (ownershipCalls === 1) {
        return await scripted.inspectOwnership(adapterContext);
      }
      calls.push({ operation: "inspect-ownership" });
      return successfulNonzeroResult("inspect", {
        installEligibility: { kind: "allowed" as const },
        removalInput: { pluginPresent: false, marketplacePresent: false },
        removalVerification: { kind: "allowed" as const },
        postRemovalOutput: { stdout: [], stderr: [] },
        presentationValue: "manager",
      });
    },
  };
  const ctx = await makeCtx(
    { desiredCommit: X, generatedCommit: X },
    out,
    err,
    adapter,
  );
  const status = await runInstall([], ctx);
  assert.equal(status, 1);
  assert.equal(
    err.text(),
    "error: adapter reported a failure status for inspect --view ownership\n",
  );
  assert.equal(calls.length, 13);
});

void test("stage 1's re-inspection legacy verdict is OBEYED, not just requested", async () => {
  // Rule 1 (`calls.slice(3)`) only proves the re-inspection HAPPENS. Nothing
  // in the suite before this proved its ANSWER is acted on: a mutant that
  // ignores requireNoLegacyState's verdict on the re-inspected value would
  // sail through to update-control and the install mutation with a legacy
  // identity re-confirmed one line above. gatherProbe's own ownership
  // inspect reports "manager" (clean) here -- only the RE-inspection inside
  // the workspace reports "legacy" -- so this is the stage-1 re-check
  // failing on its own evidence, not a repeat of the outer, pre-workspace
  // legacy-state case above.
  const out = capture();
  const err = capture();
  const { adapter, calls } = scriptedAdapter([
    ...PROBE_OK,
    successResult("inspect", ownership("legacy"), []),
  ]);
  const ctx = await makeCtx(
    { desiredCommit: X, generatedCommit: X },
    out,
    err,
    adapter,
  );
  const status = await runInstall([], ctx);
  assert.equal(status, 1);
  assert.equal(
    err.text(),
    "Legacy superpowers-wrapper Codex state is installed.\n" +
      "Run: npx superpowers-wrapper@0.1.1 uninstall\n" +
      "Then run: npx superpowers-manager install\n",
  );
  assert.equal(out.text(), NOTE);
  // Stops at the re-inspection: no update-control inspect, no install, no
  // fingerprint inspect.
  assert.equal(calls.length, 13);
});

void test("stage 1's re-inspection UNKNOWN verdict is OBEYED, not just requested", async () => {
  // The sibling case above drives requireNoLegacyState's `"blocked"` arm; this
  // one drives its `"unknown"` arm (reached for any identity_state outside the
  // four known ones). Both arms need their own case: a mutant that disables
  // BOTH at once dies to the `"blocked"` case alone, which proves only that one
  // of the two is live. Disabling just the `"unknown"` arm previously survived
  // the whole suite, and the survivor was a live fail-open -- re-inspect,
  // receive an unrecognised answer, then install anyway and exit 0.
  // gatherProbe's own ownership inspect reports "manager" here, so the
  // unrecognised value is the RE-inspection's own evidence, not the outer
  // pre-workspace check's.
  const out = capture();
  const err = capture();
  const { adapter, calls } = scriptedAdapter([
    ...PROBE_OK,
    successResult("inspect", ownership("chaos"), []),
  ]);
  const ctx = await makeCtx(
    { desiredCommit: X, generatedCommit: X },
    out,
    err,
    adapter,
  );
  const status = await runInstall([], ctx);
  assert.equal(status, 1);
  // `git show ad56569a4c161e7b122967442e2b026eeb6395f6:scripts/core/lifecycle.sh:57::spw_die "unknown adapter identity state: $identity_state` calls spw_die, which DOES prefix `error: `.
  assert.equal(err.text(), "error: unknown adapter identity state: chaos\n");
  assert.equal(out.text(), NOTE);
  // Stops at the re-inspection: no update-control inspect, no install, no
  // fingerprint inspect.
  assert.equal(calls.length, 13);
});

void test("stage 2 (inspect update-control) failure stops before the install mutation", async () => {
  const out = capture();
  const err = capture();
  const { adapter, calls } = scriptedAdapter([
    ...PROBE_OK,
    successResult("inspect", ownership("manager"), []),
    failureResult(
      "inspect",
      "E_ADAPTER",
      "cannot inspect update control",
      [],
      [],
    ),
  ]);
  const ctx = await makeCtx(
    { desiredCommit: X, generatedCommit: X },
    out,
    err,
    adapter,
  );
  const status = await runInstall([], ctx);
  assert.equal(status, 1);
  assert.equal(err.text(), "error: cannot inspect update control\n");
  assert.equal(calls.length, 14);
});

void test("stage 2 malformed update_control is a DIFFERENT failure than stage 2's adapter failure", async () => {
  const out = capture();
  const err = capture();
  const { adapter, calls } = scriptedAdapter([
    ...PROBE_OK,
    successResult("inspect", ownership("manager"), []),
    successResult("inspect", { update_control: 7 }, []),
  ]);
  const ctx = await makeCtx(
    { desiredCommit: X, generatedCommit: X },
    out,
    err,
    adapter,
  );
  const status = await runInstall([], ctx);
  assert.equal(status, 1);
  assert.equal(
    err.text(),
    "error: adapter returned a non-string update_control for inspect --view update-control\n",
  );
  assert.equal(calls.length, 14);
});

void test("stage 3 (install) failure stops before the post-install fingerprint inspection", async () => {
  const out = capture();
  const err = capture();
  const { adapter, calls } = scriptedAdapter([
    ...PROBE_OK,
    successResult("inspect", ownership("manager"), []),
    successResult("inspect", { update_control: "managed" }, []),
    failureResult("install", "E_ADAPTER", "cannot install plugin", [], []),
  ]);
  const ctx = await makeCtx(
    { desiredCommit: X, generatedCommit: X },
    out,
    err,
    adapter,
  );
  const status = await runInstall([], ctx);
  assert.equal(status, 1);
  assert.equal(err.text(), "error: cannot install plugin\n");
  assert.equal(calls.length, 15);
});

// Rewritten at PR 11.5 slice 4b, Task 8. This case previously asserted the
// stderr was ONLY the replayed adapter diagnostic, which pinned a port defect
// rather than a contract: stage 4 short-circuited on `!inspected.ok` and never
// reached renderInstallVerification, leaving its failed-inspection arm
// (`src/harnesses/codex/presentation.ts::if (inspection.status !== 0 || !inspection.outcome.ok) {`) dead and dropping the post-install verification claim entirely. The shell handed its inspect result to
// spw_verify_installed_fingerprint unconditionally (`git show ad56569a4c161e7b122967442e2b026eeb6395f6:scripts/install:57::spw_verify_installed_fingerprint`) and
// printed BOTH lines — the adapter's own error and
// `git show ad56569a4c161e7b122967442e2b026eeb6395f6:scripts/core/lifecycle.sh:92::echo "error: installed manager fingerprint inspection`'s. The flip surfaced it: the shell-parity case
// in tests/bin/install-commands.test.js titled "a failed fingerprint
// inspection is reported as an inspection failure (:687-700)", green against
// /bin/sh through this same channel before Task 8, went red the moment the
// subject changed.
// Both lines are asserted here, in order, so the divergence cannot come back in
// either direction.
void test("stage 4 (post-install inspect fingerprint) failure reports the replayed diagnostic AND the verification failure", async () => {
  const out = capture();
  const err = capture();
  const { adapter, calls } = scriptedAdapter([
    ...PROBE_OK,
    successResult("inspect", ownership("manager"), []),
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
  const ctx = await makeCtx(
    { desiredCommit: X, generatedCommit: X },
    out,
    err,
    adapter,
  );
  const status = await runInstall([], ctx);
  assert.equal(status, 1);
  assert.equal(
    err.text(),
    "error: cannot inspect fingerprint after install\n" +
      "error: installed manager fingerprint inspection failed after install.\n",
  );
  assert.equal(calls.length, 16);
});

// The OTHER arm of the same guard, added with it (PR 11.5 slice 4b, Task 8).
// Stage 4 no longer short-circuits on `!inspected.ok`, but it still does on the
// one failure `invoke()` cannot produce a result for: `ctx.adapter` itself
// throwing. Without its own case, a mutant collapsing the two arms — sending
// the throw path into renderInstallVerification too, or restoring the blanket
// short-circuit — would die to only one of them and falsely certify both. The
// distinguishing observation is the stderr: a throw has no outcome to replay
// and no result to verify, so it must produce invoke()'s own hand-written
// diagnostic and NOTHING else.
void test("stage 4 (post-install inspect fingerprint) reports a ctx.adapter throw as an invocation failure, alone", async () => {
  const out = capture();
  const err = capture();
  const { adapter, calls } = scriptedAdapter([
    ...PROBE_OK,
    successResult("inspect", ownership("manager"), []),
    successResult("inspect", { update_control: "managed" }, []),
    successResult("install", {}, []),
  ]);

  const throwingAdapter = {
    ...adapter,
    async inspectInstalled(
      selection: Parameters<typeof adapter.inspectInstalled>[0],
      adapterCtx: Parameters<typeof adapter.inspectInstalled>[1],
    ) {
      if (calls.length >= 15) {
        calls.push({ operation: "inspect-installed", input: selection });
        throw new Error("synthetic adapter transport failure");
      }
      return await adapter.inspectInstalled(selection, adapterCtx);
    },
  };
  const ctx = await makeCtx(
    { desiredCommit: X, generatedCommit: X },
    out,
    err,
    throwingAdapter,
  );
  const status = await runInstall([], ctx);
  assert.equal(status, 1);
  assert.equal(
    err.text(),
    "error: cannot invoke Codex adapter for inspect --view fingerprint\n",
  );
  assert.equal(calls.length, 16);
});

// --- A fingerprint MISMATCH, not just an inspection failure (:244-255) ---
//
// Every stage-4 case above tests the INSPECT CALL failing. None of them ever
// let renderInstallVerification actually RUN with a mismatch -- so nothing
// pinned that it (a) still returns status 1, not 0 through the command's
// current-kind check (`src/commands/install.ts::const verified =`), and
// (b) still writes BOTH `desired_commit=` and
// `installed_commit=` to stdout, not just on the success path. (b) is
// spec §4.3's own explicit prohibition ("the port must not move them into
// the success branch") -- this is the case that would notice a port that
// violated it.

void test("a fingerprint MISMATCH still reports both commit lines, then fails closed (not 0)", async () => {
  const Y = "3".repeat(40); // unrelated to X: no shared 7-char prefix.
  const out = capture();
  const err = capture();
  const { adapter, calls } = scriptedAdapter([
    ...PROBE_OK,
    successResult("inspect", ownership("manager"), []),
    successResult("inspect", { update_control: "managed" }, []),
    successResult("install", {}, []),
    successResult("inspect", { fingerprint: Y }, []),
  ]);
  const ctx = await makeCtx(
    { desiredCommit: X, generatedCommit: X },
    out,
    err,
    adapter,
  );
  const status = await runInstall([], ctx);
  assert.equal(status, 1);
  assert.equal(
    out.text(),
    `${NOTE}desired_commit=${X}\ninstalled_commit=${Y}\n`,
  );
  assert.equal(
    err.text(),
    "error: installed manager fingerprint does not match the prepared plugin after install.\n",
  );
  assert.equal(calls.length, 16);
});

// --- The STRICT reader, not the LENIENT one, and the empty-desiredCommit
// gate it feeds (:372-392) ---
//
// Both src/provenance.ts profiles agree on an ordinary flat JSON value, so a
// plain {"commit": "<hex>"} file cannot tell readStrictProvenanceField
// (maxDepth: 256) apart from the lenient reader gatherProbe already used
// (unbounded depth) -- the two would read back the identical string. The one
// place they can disagree is depth: a document nested past 256 containers
// parses fine under the lenient profile and fails closed under the strict
// one. The fixture starts with a fully qualified native prepared tree, then
// introduces that nesting after prepared inspection. This models provenance
// changing between the read-only probe and install's required strict re-read.
// If a change relaxed the strict call back to the lenient one, this fixture
// would read a commit and sail into the workspace stage instead of stopping
// here with zero further adapter calls.

void test("the STRICT provenance reader, not the lenient one, feeds desiredCommit -- and its own absence still fails closed", async () => {
  const out = capture();
  const err = capture();
  const { adapter, calls } = scriptedAdapter([...PROBE_OK]);
  const ctx = await makeCtx(
    { desiredCommit: X, generatedCommit: X },
    out,
    err,
    adapter,
  );

  let junk: unknown[] = [];
  for (let depth = 0; depth < 300; depth += 1) junk = [junk];
  const generatedDir = join(ctx.root, "plugins", "superpowers");
  mkdirSync(generatedDir, { recursive: true });
  let preparedReads = 0;
  ctx.adapter = {
    ...adapter,
    async inspectPrepared(selection, context) {
      const result = await adapter.inspectPrepared(selection, context);
      preparedReads += 1;
      if (preparedReads < 2) return result;
      writeFileSync(
        join(generatedDir, ".superpowers-upstream.json"),
        JSON.stringify({ commit: X, junk }),
        "utf8",
      );
      return result;
    },
  };
  const status = await runInstall([], ctx);
  assert.equal(status, 1);
  assert.equal(
    err.text(),
    "error: generated metadata missing desired commit after prepare\n",
  );
  assert.equal(out.text(), NOTE);
  // Zero calls past the probe's own three: the workspace stage never runs.
  assert.equal(calls.length, 12);
});

void test("argv is ignored by src/commands/install.ts", async () => {
  const out = capture();
  const err = capture();
  const { adapter } = scriptedAdapter([
    ...PROBE_OK,
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
  const status = await runInstall(["--bogus", "extra"], ctx);
  assert.equal(status, 0);
});

// --- Post-success withWorkspace cleanup failure carries the outcome ---
//
// Unlike src/commands/uninstall.ts's GatherFailure (which carries only the
// collected outcomes, not the computed outcome, because withWorkspace
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
    const out = capture();
    const err = capture();
    const responses = [
      ...PROBE_OK,
      successResult("inspect", ownership("manager"), []),
      successResult("inspect", { update_control: "managed" }, []),
      successResult("install", {}, []),
      successResult("inspect", { fingerprint: X }, []),
    ];
    const { adapter: scripted, calls } = scriptedAdapter(responses);
    // The FINAL scripted call chmods the workspace's own PARENT directory
    // read-only, after every earlier call has already pushed its outcome.
    // By the time withWorkspace's post-callback `rm(workspace, ...)` runs,
    // the parent cannot be written to, so the removal genuinely fails with
    // EACCES/EPERM -- a real filesystem failure, not a mocked one. Matches
    // tests/unit/commands-uninstall.test.js's own technique.
    const adapter = {
      ...scripted,
      async inspectInstalled(
        selection: Parameters<typeof scripted.inspectInstalled>[0],
        adapterCtx: Parameters<typeof scripted.inspectInstalled>[1],
      ) {
        const result = await scripted.inspectInstalled(selection, adapterCtx);
        if (calls.length === 16) chmodSync(parent, 0o500);
        return result;
      },
    };
    const ctx = await makeCtx(
      { desiredCommit: X, generatedCommit: X, env: { TMPDIR: parent } },
      out,
      err,
      adapter,
    );
    const status = await runInstall([], ctx);
    assert.equal(status, 1);
    assert.equal(calls.length, 16);
    // The domain outcome is preserved -- "manager updated" -- even though the
    // workspace could not be removed afterward: the fingerprint verify that
    // produced it already completed against the adapter before cleanup ran.
    assert.equal(
      out.text(),
      `${NOTE}desired_commit=${X}\ninstalled_commit=${X}\nmanager updated\n`,
    );
    const entries = readdirSync(parent);
    assert.equal(
      entries.length,
      1,
      `expected exactly one leftover workspace directory in ${parent}, found: ${entries.join(", ")}`,
    );
    const workspace = join(parent, entries[0]);
    assert.equal(err.text(), `error: ${workspaceRemovalFailure(workspace)}\n`);
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
