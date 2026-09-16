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
import {
  codexHarness,
  rejectSuccessfulNonzeroStatus,
} from "../../../../src/harnesses/codex/harness.ts";
import {
  codexControlInspection,
  codexOwnershipInspection,
} from "../../../../src/harnesses/codex/lifecycle.ts";
import {
  codexInstallReceipt,
  codexPresentation,
} from "../../../../src/harnesses/codex/presentation.ts";
import type { EffectiveSelection } from "../../../../src/effective-selection.ts";
import type { HarnessAdapter, ProbeSnapshot } from "../../../../src/harness.ts";
import { codexPaths } from "../../../../src/harnesses/codex/paths.ts";
import { readCodexMarketplace } from "../../../../src/harnesses/codex/marketplace.ts";
import { writeQualifiedCodexFixture } from "../../../lib/harnesses/codex/prepared-fixture.ts";

const DESIRED = "d884ae04edebef577e82ff7c4e143debd0bbec99";
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

void test("Codex boundaries reject successful nonzero statuses before reading typed results", () => {
  const messages = [
    { channel: "stderr" as const, text: "captured adapter context" },
  ];
  const cases = [
    {
      operation: "inspect",
      message:
        "adapter reported a failure status for inspect --view update-control",
    },
    {
      operation: "install",
      message:
        "adapter reported a failure status for install --package-root /package root",
    },
  ] as const;
  for (const { operation, message } of cases) {
    const succeeded = successResult(operation, null, messages);
    const guarded = rejectSuccessfulNonzeroStatus(
      { status: 1, outcome: succeeded.outcome },
      message,
    );
    assert.equal(guarded.status, 1);
    assert.equal(guarded.outcome.ok, false);
    if (guarded.outcome.ok) assert.fail("expected invalid status rejection");
    assert.equal(guarded.outcome.operation, operation);
    assert.equal(guarded.outcome.error.code, "invalid-status");
    assert.equal(guarded.outcome.error.message, message);
    assert.deepEqual(guarded.outcome.error.hints, []);
    assert.deepEqual(guarded.outcome.messages, messages);
  }
});

void test("Codex status guard passes zero successes and controlled failures through unchanged", () => {
  const succeeded = successResult(
    "inspect",
    codexControlInspection("managed"),
    [],
  );
  const failed = failureResult(
    "install",
    "controlled-failure",
    "controlled failure",
    ["controlled hint"],
    [{ channel: "stdout", text: "captured context" }],
  );
  assert.strictEqual(
    rejectSuccessfulNonzeroStatus(succeeded, "unused status diagnostic"),
    succeeded,
  );
  assert.strictEqual(
    rejectSuccessfulNonzeroStatus(failed, "unused status diagnostic"),
    failed,
  );
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

const EXPECTED_PROBE_KEYS = [
  "harness",
  "requested_ref",
  "resolved_ref",
  "desired_commit",
  "generated_commit",
  "installed_commit",
  "identity_state",
  "status",
  "selection_origin",
  "selection_mode",
  "upstream_source_origin",
  "effective_source",
  "saved_mode",
  "saved_source",
  "saved_requested_ref",
  "saved_resolved_ref",
  "saved_commit",
  "update_control",
  "installation_state",
  "resource_state",
  "compatibility",
  "compatibility_reason",
];

void test("Codex probe presentation preserves legacy fields and appends independent state", async (t) => {
  const facts = snapshot();
  const rendered = codexPresentation.renderProbe(facts);
  assert.match(rendered.human, /^harness: codex\n/);
  assert.match(rendered.porcelain, /^harness=codex\n/);
  assert.equal(
    rendered.human,
    [
      "harness: codex",
      "requested ref: latest-release",
      `resolved ref: ${facts.selection.resolvedRef}`,
      `desired commit: ${DESIRED}`,
      `generated plugin commit: ${DESIRED}`,
      `installed manager commit or fingerprint: ${DESIRED.slice(0, 7)}`,
      "Codex identity state: manager",
      "status: current",
      "selection origin: package-default",
      "selection mode: default",
      "upstream source origin: package-default",
      "effective source: https://example.invalid/superpowers.git",
      "saved mode: none",
      "saved source: ",
      "saved requested ref: ",
      "saved resolved ref: ",
      "saved commit: ",
      "update control: managed",
      "installation state: current",
      "resource state: idle",
      "compatibility: supported",
      "compatibility reason: fixture compatibility",
      "",
    ].join("\n"),
  );
  assert.equal(
    rendered.porcelain,
    [
      "harness=codex",
      "requested_ref=latest-release",
      `resolved_ref=${facts.selection.resolvedRef}`,
      `desired_commit=${DESIRED}`,
      `generated_commit=${DESIRED}`,
      `installed_commit=${DESIRED.slice(0, 7)}`,
      "identity_state=manager",
      "status=current",
      "selection_origin=package-default",
      "selection_mode=default",
      "upstream_source_origin=package-default",
      "effective_source=https://example.invalid/superpowers.git",
      "saved_mode=none",
      "saved_source=",
      "saved_requested_ref=",
      "saved_resolved_ref=",
      "saved_commit=",
      "update_control=managed",
      "installation_state=current",
      "resource_state=idle",
      "compatibility=supported",
      "compatibility_reason=fixture compatibility",
      "",
    ].join("\n"),
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

void test("Codex renderer preserves the complete ordered probe keys", () => {
  const text = codexPresentation.renderProbe(snapshot()).porcelain;
  assert.deepEqual(
    text
      .trimEnd()
      .split("\n")
      .map((line) => line.split("=", 1)[0]),
    EXPECTED_PROBE_KEYS,
  );
});

void test("Codex renderer preserves absence labels without filling empty source", () => {
  const facts = snapshot();
  const text = codexPresentation.renderProbe({
    ...facts,
    prepared: { ...facts.prepared, observedIdentity: "" },
    installed: { kind: "absent", observedIdentity: "" },
  });
  assert.match(text.human, /^generated plugin commit: not present$/m);
  assert.match(
    text.human,
    /^installed manager commit or fingerprint: not detected$/m,
  );
  assert.match(text.human, /^saved source: $/m);
  assert.match(text.porcelain, /^generated_commit=$/m);
  assert.match(text.porcelain, /^installed_commit=$/m);
});

void test("Codex renderer reports mixed origins before appended state fields", () => {
  const facts = snapshot();
  const text = codexPresentation.renderProbe({
    ...facts,
    selection: { ...facts.selection, selectionOrigin: "environment" },
  });
  assert.match(
    text.human,
    /^warning: effective ref and source have mixed origins \(ref: environment, source: package-default\)$/m,
  );
  assert.match(
    text.human,
    /warning: effective ref and source have mixed origins \(ref: environment, source: package-default\)\ninstallation state: current\n/,
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
