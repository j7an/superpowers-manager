import assert from "node:assert/strict";
import test from "node:test";
import { piHarness } from "../../src/harnesses/pi/harness.ts";
import type { ProbeSnapshot } from "../../src/harness.ts";
import type { PiRemovalInput } from "../../src/harnesses/pi/state.ts";
import { nativeSelection } from "../lib/pi-package-fixture.ts";
import {
  mkdtemp,
  mkdir,
  writeFile,
  rm,
  symlink,
  readdir,
} from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { piPaths } from "../../src/harnesses/pi/paths.ts";
import { inspectPiControl } from "../../src/harnesses/pi/state.ts";
import { codexPresentation } from "../../src/harnesses/codex/presentation.ts";

void test("the public Pi probe dispatch needs neither native harness executable nor resource writes", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "spw-pi-dispatch-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const tools = join(root, "tools");
  await mkdir(tools);
  await symlink(process.execPath, join(tools, "git"));
  const env = {
    HOME: root,
    PATH: tools,
    PI_CODING_AGENT_DIR: join(root, "agent"),
    SUPERPOWERS_REF: "1".repeat(40),
    SUPERPOWERS_UPSTREAM_URL: "https://example.invalid/upstream",
    SUPERPOWERS_CONFIG_DIR: join(root, "config"),
  };
  for (const args of [["--harness", "pi"], ["--harness=pi"]]) {
    const result = spawnSync(
      process.execPath,
      [
        new URL("../../src/cli.ts", import.meta.url).pathname,
        "probe",
        ...args,
        "--porcelain",
      ],
      { env, encoding: "utf8" },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /^harness=pi\n/);
    assert.match(result.stdout, /installation_state=absent\n/);
    assert.match(result.stdout, /resource_state=idle\n/);
    assert.equal(result.stderr, "");
    assert.deepEqual(await readdir(root), ["tools"]);
  }
});

void test("Pi adapter reports recovery without blocking its low-level transaction control", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "spw-pi-recovery-probe-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const env = { HOME: root, PI_CODING_AGENT_DIR: join(root, "agent") };
  const paths = piPaths(env, root);
  const ctx = { root, env };
  await mkdir(paths.recoveryRoot, { recursive: true });
  const marker = join(paths.recoveryRoot, "transaction.json");
  await writeFile(marker, "preserve recovery bytes");
  const result = await piHarness.inspectUpdateControl(ctx);
  assert.equal(result.status, 0);
  assert.ok(result.outcome.ok);
  assert.equal(result.outcome.result.probeEligibility.kind, "blocked");
  assert.equal(result.outcome.result.mutationEligibility.kind, "blocked");
  assert.equal(result.outcome.result.recoveryState, "required");
  assert.match(result.outcome.result.presentationValue, /recovery/);
  const lowLevel = await inspectPiControl(ctx);
  assert.ok(lowLevel.outcome.ok);
  assert.equal(lowLevel.outcome.result.recoveryState, undefined);
  assert.equal(lowLevel.outcome.result.mutationEligibility.kind, "allowed");
  const { readFile } = await import("node:fs/promises");
  assert.equal(await readFile(marker, "utf8"), "preserve recovery bytes");
});

void test("Pi local inspection requires no executable and mutations honor the override", () => {
  for (const command of [
    "probe",
    "prepare",
    "pin",
    "unpin",
    "track-latest",
  ] as const)
    assert.deepEqual(piHarness.requirements(command, {}), []);
  for (const command of ["install", "update", "uninstall"] as const) {
    assert.equal(piHarness.requirements(command, {})[0]?.executable, "pi");
    assert.equal(
      piHarness.requirements(command, { SUPERPOWERS_PI: "./selected-pi" })[0]
        ?.executable,
      "./selected-pi",
    );
  }
  assert.equal(piHarness.presentation.installNotice, "");
  assert.doesNotMatch(piHarness.presentation.currentNotice, /restart/i);
});

void test("Pi presentation separates installed facts from unsupported desired compatibility", () => {
  const compatibility = {
    kind: "unsupported",
    reason: "desired package lacks the qualified bootstrap",
  } as const;
  const ownership = {
    installEligibility: { kind: "allowed" },
    removalInput: {
      installedRoot: "/isolated/installed",
      receiptDigest: "old-digest",
      registrationIdentity: "/isolated/installed",
    },
    removalVerification: {
      kind: "blocked",
      output: { stdout: [], stderr: ["still installed"] },
    },
    postRemovalOutput: { stdout: [], stderr: [] },
    presentationValue: "managed old-digest",
    presentationConflicts: ["native Pi extension superpowers.ts"],
  } as const;
  const facts: ProbeSnapshot<PiRemovalInput> = {
    selection: nativeSelection(),
    prepared: { kind: "needs-prepare", observedIdentity: "", compatibility },
    installed: { kind: "mismatch", observedIdentity: "old-digest" },
    ownership,
    control: {
      probeEligibility: { kind: "allowed" },
      mutationEligibility: { kind: "allowed" },
      presentationValue: "managed local registration",
    },
    compatibility,
    status: "needs prepare",
  };
  const rendered = piHarness.presentation.renderProbe(facts);
  assert.match(rendered.porcelain, /installed_identity=old-digest\n/);
  assert.match(rendered.porcelain, /compatibility=unsupported\n/);
  const codex = codexPresentation.renderProbe({
    ...facts,
    ownership: {
      ...ownership,
      removalInput: { pluginPresent: false, marketplacePresent: false },
    },
  });
  assert.match(codex.porcelain, /installation_state=mismatch\n/);
  assert.match(codex.porcelain, /resource_state=idle\n/);
  assert.match(codex.porcelain, /compatibility=unsupported\n/);
  assert.match(rendered.human, /native Pi extension superpowers.ts/);
  assert.doesNotMatch(rendered.human, /restart/i);
});

void test("Pi removal completion distinguishes verified removal from prior absence", () => {
  const absentInput: PiRemovalInput = {
    installedRoot: "/isolated/installed",
    receiptDigest: null,
    registrationIdentity: null,
  };
  const postRemovalOwnership = {
    installEligibility: { kind: "allowed" },
    removalInput: absentInput,
    removalVerification: { kind: "allowed" },
    postRemovalOutput: { stdout: [], stderr: [] },
    presentationValue: "absent",
  } as const;
  const installedInput: PiRemovalInput = {
    ...absentInput,
    receiptDigest: "removed-digest",
    registrationIdentity: "/isolated/installed",
  };

  assert.deepEqual(
    piHarness.presentation.renderRemovalCompletion(
      postRemovalOwnership,
      installedInput,
    ),
    {
      stdout: [
        "Removed the managed Superpowers Pi installation. Restart Pi to load the resulting state.",
      ],
      stderr: [],
    },
  );
  assert.deepEqual(
    piHarness.presentation.renderRemovalCompletion(
      postRemovalOwnership,
      absentInput,
    ),
    {
      stdout: ["No managed Superpowers Pi installation is present."],
      stderr: [],
    },
  );
});

void test("Pi verification output follows inspection failures rather than a claimed receipt", () => {
  const receipt = {
    status: 0,
    outcome: {
      operation: "install-pi",
      ok: true,
      result: {
        missingVerificationOutput: { stdout: [], stderr: ["missing"] },
        mismatchVerificationOutput: { stdout: [], stderr: ["mismatch"] },
      },
      error: null,
      messages: [],
    },
  } as const;
  const result = (kind: "absent" | "current" | "mismatch") =>
    ({
      status: 0,
      outcome: {
        operation: "inspect-pi-installed",
        ok: true,
        result:
          kind === "absent"
            ? ({ kind, observedIdentity: "" } as const)
            : { kind, observedIdentity: "digest" },
        error: null,
        messages: [],
      },
    }) as const;
  assert.deepEqual(
    piHarness.presentation.renderInstallVerification(
      "commit",
      receipt,
      result("absent"),
    ).stderr,
    ["missing"],
  );
  assert.deepEqual(
    piHarness.presentation.renderInstallVerification(
      "commit",
      receipt,
      result("mismatch"),
    ).stderr,
    ["mismatch"],
  );
  assert.deepEqual(
    piHarness.presentation.renderInstallVerification(
      "commit",
      receipt,
      result("current"),
    ),
    {
      stdout: [
        "Installed the frozen Superpowers Pi snapshot. Restart Pi to load it.",
      ],
      stderr: [],
    },
  );
});
