import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  failureResult,
  successResult,
} from "../../../../src/adapter-result.ts";
import type { CodexRemovalInput } from "../../../../src/harnesses/codex/adapter.ts";
import { codexHarness } from "../../../../src/harnesses/codex/harness.ts";
import {
  codexControlInspection,
  codexOwnershipInspection,
} from "../../../../src/harnesses/codex/lifecycle.ts";
import {
  codexInstallReceipt,
  codexPresentation,
  formatHuman,
  formatPorcelain,
} from "../../../../src/harnesses/codex/presentation.ts";
import type { EffectiveSelection } from "../../../../src/effective-selection.ts";
import type { HarnessAdapter, ProbeSnapshot } from "../../../../src/harness.ts";
import { codexPaths } from "../../../../src/harnesses/codex/paths.ts";
import { readCodexMarketplace } from "../../../../src/harnesses/codex/marketplace.ts";
import { writeQualifiedCodexFixture } from "../../../lib/harnesses/codex/prepared-fixture.ts";

const DESIRED = "d884ae04edebef577e82ff7c4e143debd0bbec99";
const OTHER = "1".repeat(40);
const PACKAGE_ROOT = resolve(
  fileURLToPath(new URL("../../../../", import.meta.url)),
);
const FAKE_CODEX = fileURLToPath(
  new URL("../../helpers/harnesses/codex/fake.sh", import.meta.url),
);

const codex: HarnessAdapter<CodexRemovalInput> = codexHarness;
void codex;
type OtherRemoval = { readonly receipt: string };
function assertOtherRemovalType(adapter: HarnessAdapter<OtherRemoval>) {
  void adapter.remove(
    // @ts-expect-error Codex presence flags are not this adapter's removal input.
    { pluginPresent: true, marketplacePresent: false },
    { root: "/unused" },
  );
}
void assertOtherRemovalType;

void test("Codex verification modules are safe in every supported entry order", () => {
  const urls = {
    harness: pathToFileURL(join(PACKAGE_ROOT, "src/harnesses/codex/harness.ts"))
      .href,
    lifecycle: pathToFileURL(
      join(PACKAGE_ROOT, "src/harnesses/codex/lifecycle.ts"),
    ).href,
    presentation: pathToFileURL(
      join(PACKAGE_ROOT, "src/harnesses/codex/presentation.ts"),
    ).href,
  };
  for (const order of [
    ["lifecycle", "presentation", "harness"],
    ["presentation", "lifecycle", "harness"],
    ["harness", "lifecycle", "presentation"],
  ] as const) {
    const script = `
      const urls = ${JSON.stringify(urls)};
      const loaded = {};
      for (const name of ${JSON.stringify(order)}) loaded[name] = await import(urls[name]);
      if (loaded.harness.codexHarness.presentation !== loaded.presentation.codexPresentation) {
        throw new Error("presentation identity changed");
      }
      const desired = "a".repeat(40);
      const ok = (result) => ({
        status: 0,
        outcome: { operation: "inspect", ok: true, messages: [], result, error: null },
      });
      const receipt = ok(loaded.presentation.codexInstallReceipt("", ""));
      const inspection = ok({ kind: "current", observedIdentity: desired });
      const output = loaded.presentation.codexPresentation.renderInstallVerification(
        desired, receipt, inspection,
      );
      if (!inspection.outcome.ok || inspection.outcome.result.kind !== "current") {
        throw new Error("verification normalization changed");
      }
      if (output.stderr.length !== 0) throw new Error("verification rendering changed");
    `;
    const result = spawnSync(
      process.execPath,
      ["--input-type=module", "--eval", script],
      { encoding: "utf8" },
    );
    assert.equal(
      result.status,
      0,
      `${order.join(" first, then ")}: ${result.stderr}`,
    );
  }
});

void test("ownership policy preserves every Codex removal flag combination", () => {
  const cases = [
    [false, false, { kind: "allowed" }],
    [
      true,
      false,
      {
        kind: "blocked",
        output: {
          stdout: [],
          stderr: [
            "error: owned plugin resource is still installed after removal",
          ],
        },
      },
    ],
    [
      false,
      true,
      {
        kind: "blocked",
        output: {
          stdout: [],
          stderr: [
            "error: owned marketplace resource is still registered after removal",
          ],
        },
      },
    ],
    [
      true,
      true,
      {
        kind: "blocked",
        output: {
          stdout: [],
          stderr: [
            "error: owned plugin resource is still installed after removal",
          ],
        },
      },
    ],
  ] as const;
  for (const [pluginPresent, marketplacePresent, expected] of cases) {
    const normalized = codexOwnershipInspection(
      "manager",
      { pluginPresent, marketplacePresent },
      [],
    );
    assert.deepEqual(normalized.removalInput, {
      pluginPresent,
      marketplacePresent,
    });
    assert.deepEqual(normalized.removalVerification, expected);
  }
});

void test("ownership policy reuses legacy install and removal policy", async (t) => {
  const legacy = codexOwnershipInspection(
    "legacy",
    { pluginPresent: false, marketplacePresent: false },
    [],
  );
  assert.deepEqual(legacy.installEligibility, {
    kind: "blocked",
    output: {
      stdout: [],
      stderr: [
        "Legacy superpowers-wrapper Codex state is installed.",
        "Run: npx superpowers-wrapper@0.1.1 uninstall",
        "Then run: npx superpowers-manager install",
      ],
    },
  });
  assert.deepEqual(legacy.removalVerification, { kind: "allowed" });
  assert.deepEqual(legacy.postRemovalOutput, {
    stdout: [
      "Legacy superpowers-wrapper Codex state remains installed.",
      "Run: npx superpowers-wrapper@0.1.1 uninstall",
    ],
    stderr: [],
  });

  const unknown = codexOwnershipInspection(
    "unexpected",
    { pluginPresent: false, marketplacePresent: false },
    [],
  );
  assert.deepEqual(unknown.installEligibility, {
    kind: "blocked",
    output: {
      stdout: [],
      stderr: ["error: unknown adapter identity state: unexpected"],
    },
  });
  assert.deepEqual(unknown.removalVerification, {
    kind: "blocked",
    output: {
      stdout: [],
      stderr: ["error: unknown adapter identity state: unexpected"],
    },
  });

  await t.test("blocks unmanaged conflicts with manual guidance", () => {
    const normalized = codexOwnershipInspection(
      "manager",
      { pluginPresent: false, marketplacePresent: false },
      [
        "active Codex plugin superpowers@another-provider",
        "native Codex skills route ~/.agents/skills/superpowers has indeterminate activity",
      ],
    );
    assert.deepEqual(normalized.installEligibility, {
      kind: "blocked",
      output: {
        stdout: [],
        stderr: [
          "Conflicting unmanaged Superpowers Codex resources require manual resolution:",
          "- active Codex plugin superpowers@another-provider",
          "- native Codex skills route ~/.agents/skills/superpowers has indeterminate activity",
          "Remove or disable each resource manually, then retry.",
        ],
      },
    });
    assert.deepEqual(normalized.presentationConflicts, [
      "active Codex plugin superpowers@another-provider",
      "native Codex skills route ~/.agents/skills/superpowers has indeterminate activity",
    ]);
    assert.deepEqual(normalized.removalInput, {
      pluginPresent: false,
      marketplacePresent: false,
    });
  });

  await t.test(
    "legacy diagnostics remain authoritative when conflicts coexist",
    () => {
      const normalized = codexOwnershipInspection(
        "legacy",
        { pluginPresent: false, marketplacePresent: false },
        ["active Codex plugin superpowers@another-provider"],
      );
      assert.deepEqual(
        normalized.installEligibility,
        legacy.installEligibility,
      );
    },
  );
});

void test("empty ownership identity uses the probe diagnostic", () => {
  const normalized = codexOwnershipInspection(
    "",
    { pluginPresent: false, marketplacePresent: false },
    [],
  );
  assert.equal(normalized.presentationValue, "");
  assert.deepEqual(normalized.installEligibility, {
    kind: "blocked",
    output: {
      stdout: [],
      stderr: ["error: probe did not report adapter identity state"],
    },
  });
});

void test("install receipt converts only safe verification hints into output", () => {
  const receipt = codexInstallReceipt(
    "verify the installed plugin",
    "retry the installation",
  );
  assert.deepEqual(receipt.missingVerificationOutput, {
    stdout: [],
    stderr: [
      "error: installed manager fingerprint is not detectable after install.",
      "hint: verify the installed plugin",
    ],
  });
  assert.deepEqual(receipt.mismatchVerificationOutput, {
    stdout: [],
    stderr: [
      "error: installed manager fingerprint does not match the prepared plugin after install.",
      "hint: retry the installation",
    ],
  });

  const unsafe = codexInstallReceipt("unsafe\nline", 4);
  assert.equal(unsafe.missingVerificationOutput.stderr.length, 1);
  assert.equal(unsafe.mismatchVerificationOutput.stderr.length, 1);
});

function selection(): EffectiveSelection {
  return {
    selectionOrigin: "package-default",
    selectionMode: "default",
    upstreamSourceOrigin: "package-default",
    effectiveSource: "https://example.invalid/superpowers.git",
    requestedRef: "latest-release",
    resolvedRef: "v6.1.1",
    desiredCommit: DESIRED,
    resolutionKind: "latest-release",
    saved: {
      saved_mode: "none",
      saved_source: "",
      saved_requested_ref: "",
      saved_resolved_ref: "",
      saved_commit: "",
    },
  };
}

function snapshot(): ProbeSnapshot<CodexRemovalInput> {
  return {
    selection: selection(),
    prepared: {
      kind: "current",
      artifact: {
        root: "/plugin",
        commit: DESIRED,
        compatibility: {
          kind: "supported",
          generation: "codex-native",
          reason: "fixture compatibility",
        },
        identity: DESIRED,
      },
      observedIdentity: DESIRED,
      compatibility: {
        kind: "supported",
        generation: "codex-native",
        reason: "fixture compatibility",
      },
    },
    installed: { kind: "current", observedIdentity: DESIRED.slice(0, 7) },
    ownership: codexOwnershipInspection(
      "manager",
      { pluginPresent: true, marketplacePresent: true },
      [],
    ),
    control: codexControlInspection("managed"),
    compatibility: {
      kind: "supported",
      generation: "codex-native",
      reason: "fixture compatibility",
    },
    status: "current",
  };
}

void test("Codex probe presentation preserves legacy fields and appends independent state", async (t) => {
  const rendered = codexPresentation.renderProbe(snapshot());
  assert.match(rendered.human, /^harness: codex\n/);
  assert.match(rendered.porcelain, /^harness=codex\n/);
  assert.equal(
    rendered.human,
    formatHuman({
      harness: "codex",
      requestedRef: "latest-release",
      resolvedRef: "v6.1.1",
      desiredCommit: DESIRED,
      generatedCommit: DESIRED,
      installedCommit: DESIRED.slice(0, 7),
      identityState: "manager",
      status: "current",
      selectionOrigin: "package-default",
      selectionMode: "default",
      upstreamSourceOrigin: "package-default",
      effectiveSource: "https://example.invalid/superpowers.git",
      savedMode: "none",
      savedSource: "",
      savedRequestedRef: "",
      savedResolvedRef: "",
      savedCommit: "",
      updateControl: "managed",
    }) +
      "installation state: current\nresource state: idle\ncompatibility: supported\ncompatibility reason: fixture compatibility\n",
  );
  assert.equal(
    rendered.porcelain,
    formatPorcelain({
      harness: "codex",
      requestedRef: "latest-release",
      resolvedRef: "v6.1.1",
      desiredCommit: DESIRED,
      generatedCommit: DESIRED,
      installedCommit: DESIRED.slice(0, 7),
      identityState: "manager",
      status: "current",
      selectionOrigin: "package-default",
      selectionMode: "default",
      upstreamSourceOrigin: "package-default",
      effectiveSource: "https://example.invalid/superpowers.git",
      savedMode: "none",
      savedSource: "",
      savedRequestedRef: "",
      savedResolvedRef: "",
      savedCommit: "",
      updateControl: "managed",
    }) +
      "installation_state=current\nresource_state=idle\ncompatibility=supported\ncompatibility_reason=fixture compatibility\n",
  );

  await t.test("appends conflicts without changing clean probe output", () => {
    const base = snapshot();
    const conflicted = {
      ...base,
      ownership: {
        ...base.ownership,
        presentationConflicts: [
          "active Codex plugin superpowers@another-provider",
        ],
      },
    };
    const conflictOutput = codexPresentation.renderProbe(conflicted);
    assert.equal(
      conflictOutput.human,
      `${rendered.human}ownership conflict: active Codex plugin superpowers@another-provider\n`,
    );
    assert.equal(
      conflictOutput.porcelain,
      `${rendered.porcelain}ownership_conflict=active Codex plugin superpowers@another-provider\n`,
    );
  });
});

void test("verification presentation keeps desired and observed identity separate from success", () => {
  const receipt = successResult("install", codexInstallReceipt("", ""), []);
  assert.deepEqual(
    codexPresentation.renderInstallVerification(
      DESIRED,
      receipt,
      successResult(
        "inspect",
        { kind: "current", observedIdentity: DESIRED.slice(0, 7) },
        [],
      ),
    ),
    {
      stdout: [
        `desired_commit=${DESIRED}`,
        `installed_commit=${DESIRED.slice(0, 7)}`,
        "manager updated",
      ],
      stderr: [],
    },
  );
});

void test("verification presentation preserves missing, mismatch, and inspection-failure distinctions", () => {
  const receipt = successResult(
    "install",
    codexInstallReceipt(
      "verify the installed plugin",
      "retry the installation",
    ),
    [],
  );
  assert.deepEqual(
    codexPresentation.renderInstallVerification(
      DESIRED,
      receipt,
      successResult("inspect", { kind: "absent", observedIdentity: "" }, []),
    ),
    {
      stdout: [`desired_commit=${DESIRED}`, "installed_commit="],
      stderr: [
        "error: installed manager fingerprint is not detectable after install.",
        "hint: verify the installed plugin",
      ],
    },
  );
  assert.deepEqual(
    codexPresentation.renderInstallVerification(
      DESIRED,
      receipt,
      successResult("inspect", { kind: "mismatch", observedIdentity: "" }, []),
    ),
    {
      stdout: [`desired_commit=${DESIRED}`, "installed_commit="],
      stderr: [
        "error: installed manager fingerprint is not detectable after install.",
        "hint: verify the installed plugin",
      ],
    },
  );
  assert.deepEqual(
    codexPresentation.renderInstallVerification(
      DESIRED,
      receipt,
      successResult(
        "inspect",
        { kind: "mismatch", observedIdentity: OTHER },
        [],
      ),
    ),
    {
      stdout: [`desired_commit=${DESIRED}`, `installed_commit=${OTHER}`],
      stderr: [
        "error: installed manager fingerprint does not match the prepared plugin after install.",
        "hint: retry the installation",
      ],
    },
  );
  assert.deepEqual(
    codexPresentation.renderInstallVerification(
      DESIRED,
      receipt,
      failureResult("inspect", "inspect-failed", "controlled", [], []),
    ),
    {
      stdout: [],
      stderr: [
        "error: installed manager fingerprint inspection failed after install.",
      ],
    },
  );
});

void test("removal completion appends the frozen completion text after a legacy report", () => {
  const ownership = codexOwnershipInspection(
    "legacy",
    { pluginPresent: false, marketplacePresent: false },
    [],
  );
  assert.deepEqual(
    codexPresentation.renderRemovalCompletion(
      ownership,
      ownership.removalInput,
    ),
    {
      stdout: [
        "Legacy superpowers-wrapper Codex state remains installed.",
        "Run: npx superpowers-wrapper@0.1.1 uninstall",
        "uninstall complete",
        "note: local generated artifacts under plugins/superpowers/ and .cache/upstream/ were left in place; remove them manually or regenerate with npx superpowers-manager prepare.",
      ],
      stderr: [],
    },
  );
});

void test("call-failure presentation uses fixed text and Codex removal flags", () => {
  const ctx = { root: "/package root" };
  assert.deepEqual(codexPresentation.callFailure("probe-installed", ctx), {
    unexpected: "cannot inspect Codex adapter state for view fingerprint",
    invalidStatus:
      "adapter reported a failure status for inspect --view fingerprint",
  });
  assert.deepEqual(codexPresentation.callFailure("install", ctx), {
    unexpected:
      "cannot invoke Codex adapter for install --package-root /package root",
    invalidStatus:
      "adapter reported a failure status for install --package-root /package root",
  });
  assert.deepEqual(
    codexPresentation.callFailure("remove", ctx, {
      pluginPresent: true,
      marketplacePresent: false,
    }),
    {
      unexpected:
        "cannot invoke Codex adapter for uninstall --plugin-present true --marketplace-present false",
      invalidStatus:
        "adapter reported a failure status for uninstall --plugin-present true --marketplace-present false",
    },
  );
});

void test("every fixed call-failure site retains its existing controlled text", () => {
  const ctx = { root: "/package" };
  const cases = [
    [
      "prepare",
      "cannot build the generated plugin candidate",
      "adapter reported failure without an error outcome",
    ],
    [
      "probe-ownership",
      "cannot inspect Codex adapter state for view ownership",
      "adapter reported a failure status for inspect --view ownership",
    ],
    [
      "probe-control",
      "cannot inspect Codex adapter state for view update-control",
      "adapter reported a failure status for inspect --view update-control",
    ],
    [
      "install-ownership",
      "cannot invoke Codex adapter for inspect --view ownership",
      "adapter reported a failure status for inspect --view ownership",
    ],
    [
      "install-control",
      "cannot invoke Codex adapter for inspect --view update-control",
      "adapter reported a failure status for inspect --view update-control",
    ],
    [
      "post-install",
      "cannot invoke Codex adapter for inspect --view fingerprint",
      "installed manager fingerprint inspection failed after install.",
    ],
    [
      "remove-ownership",
      "cannot invoke Codex adapter for inspect --view ownership",
      "adapter reported a failure status for inspect --view ownership",
    ],
    [
      "post-remove",
      "cannot invoke Codex adapter for inspect --view ownership",
      "adapter reported a failure status for inspect --view ownership",
    ],
  ] as const;
  for (const [site, unexpected, invalidStatus] of cases) {
    assert.deepEqual(codexPresentation.callFailure(site, ctx), {
      unexpected,
      invalidStatus,
    });
  }
});

void test("requirements describe Codex only for commands that invoke it", () => {
  for (const command of ["probe", "install", "update", "uninstall"] as const) {
    assert.deepEqual(codexHarness.requirements(command, {}), [
      {
        name: "codex",
        executable: "codex",
        lookup: "explicit-path-or-path",
        missingMessage:
          "required command not found: codex — install the Codex CLI or set SUPERPOWERS_CODEX",
      },
    ]);
  }
  for (const command of ["pin", "track-latest", "unpin", "prepare"] as const) {
    assert.deepEqual(
      codexHarness.requirements(command, {
        SUPERPOWERS_CODEX: "/custom/codex",
      }),
      [],
    );
  }
  assert.equal(
    codexHarness.requirements("probe", {
      SUPERPOWERS_CODEX: "/custom/codex",
    })[0]?.executable,
    "/custom/codex",
  );
});

async function codexSandbox(t: import("node:test").TestContext) {
  const base = await mkdtemp(join(tmpdir(), "spw-codex-harness-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const log = join(base, "commands.log");
  await writeFile(log, "");
  const searchRoot = join(base, "codex");
  await mkdir(searchRoot);
  return {
    env: {
      CODEX_HOME: searchRoot,
      SUPERPOWERS_CODEX: FAKE_CODEX,
      SUPERPOWERS_INSTALLED_SEARCH_ROOT: searchRoot,
      FAKE_CODEX_LOG: log,
      FAKE_CODEX_PLUGIN_LIST: '{"installed":[]}',
      FAKE_CODEX_MARKETPLACE_LIST: '{"marketplaces":[]}',
    },
    async commands() {
      return (await readFile(log, "utf8")).split("\n").filter(Boolean);
    },
  };
}

void test("Codex harness inspection and removal stay inside the isolated fake Codex fixture", async (t) => {
  const sandbox = await codexSandbox(t);
  const ctx = { root: PACKAGE_ROOT, env: sandbox.env };
  const inspected = await codexHarness.inspectOwnership(ctx);
  assert.equal(inspected.outcome.ok, true, JSON.stringify(inspected));
  if (!inspected.outcome.ok) assert.fail("expected ownership inspection");
  const ownership = inspected.outcome.result;
  assert.deepEqual(ownership.removalInput, {
    pluginPresent: false,
    marketplacePresent: false,
  });
  assert.equal(
    (await codexHarness.remove(ownership.removalInput, ctx)).status,
    0,
  );
  assert.deepEqual(await sandbox.commands(), [
    "plugin list --json",
    "plugin marketplace list --json",
    "plugin list --json",
    "plugin marketplace list --json",
    "plugin list --json",
    "plugin marketplace list --json",
    "plugin list --json",
    "plugin marketplace list --json",
  ]);
});

void test("Codex harness reports malformed recovery as required and blocks mutation", async (t) => {
  const sandbox = await codexSandbox(t);
  const env = {
    ...sandbox.env,
    CODEX_HOME: sandbox.env.SUPERPOWERS_INSTALLED_SEARCH_ROOT,
  };
  const paths = codexPaths(env, process.cwd());
  await mkdir(paths.recoveryRoot, { recursive: true });
  await writeFile(join(paths.recoveryRoot, "transaction.json"), "{\n");
  const result = await codexHarness.inspectUpdateControl({
    root: PACKAGE_ROOT,
    env,
  });
  assert.equal(result.outcome.ok, true, JSON.stringify(result));
  if (!result.outcome.ok) assert.fail("expected recovery observation");
  assert.equal(result.outcome.result.recoveryState, "required");
  assert.equal(result.outcome.result.probeEligibility.kind, "blocked");
  assert.equal(result.outcome.result.mutationEligibility.kind, "blocked");
  assert.match(
    result.outcome.result.presentationValue,
    /cannot inspect Codex recovery state at/,
  );
});

void test("Codex harness install publishes and activates the durable marketplace root", async (t) => {
  const sandbox = await codexSandbox(t);
  const env = {
    ...sandbox.env,
    CODEX_HOME: sandbox.env.SUPERPOWERS_INSTALLED_SEARCH_ROOT,
  };
  const ctx = { root: PACKAGE_ROOT, env };
  const paths = codexPaths(env, process.cwd());
  const artifact = await writeQualifiedCodexFixture(
    paths.preparedRoot,
    DESIRED,
    "https://example.invalid/upstream",
  );
  const installed = await codexHarness.install(artifact, ctx);
  assert.equal(installed.status, 0);
  assert.equal(installed.outcome.ok, true);
  assert.ok(installed.outcome.ok && installed.outcome.result.transaction);
  assert.ok(await readCodexMarketplace(paths.marketplaceRoot));
  assert.deepEqual(await sandbox.commands(), [
    "plugin list --json",
    "plugin marketplace list --json",
    "plugin list --json",
    "plugin marketplace list --json",
    "plugin list --json",
    "plugin marketplace list --json",
    "plugin marketplace list --json",
    `plugin marketplace add ${paths.marketplaceRoot}`,
    "plugin add superpowers@superpowers-manager",
  ]);
});

console.log("codex-harness.test.js: OK");
