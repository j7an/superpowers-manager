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
  type AdapterResult,
} from "../../src/adapter-result.ts";
import type { CodexRemovalInput } from "../../src/adapter.ts";
import {
  codexHarness,
  normalizeCodexControl,
  normalizeCodexInstall,
  normalizeCodexInstallForContext,
  normalizeCodexInstalled,
  normalizeCodexOwnership,
} from "../../src/codex-harness.ts";
import {
  codexPresentation,
  formatHuman,
  formatPorcelain,
} from "../../src/codex-presentation.ts";
import type { EffectiveSelection } from "../../src/effective-selection.ts";
import type {
  HarnessAdapter,
  InstalledState,
  ProbeSnapshot,
} from "../../src/harness.ts";
import type { JsonValue } from "../../src/strict-json.ts";

const DESIRED = "d884ae04edebef577e82ff7c4e143debd0bbec99";
const OTHER = "1".repeat(40);
const PACKAGE_ROOT = resolve(fileURLToPath(new URL("../../", import.meta.url)));
const FAKE_CODEX = fileURLToPath(
  new URL("helpers/fake-codex.sh", import.meta.url),
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

function unwrap<T>(result: AdapterResult<T>): T {
  assert.equal(result.status, 0);
  assert.equal(result.outcome.ok, true);
  if (!result.outcome.ok) assert.fail("expected successful adapter result");
  return result.outcome.result;
}

function ownershipResult(
  identityState: string | number | null | undefined,
  pluginPresent: boolean | string = false,
  marketplacePresent: boolean | string = false,
  conflicts?: unknown,
): AdapterResult {
  const payload: Record<string, JsonValue> = {
    resources: {
      plugin: pluginPresent,
      marketplace: marketplacePresent,
    },
  };
  if (identityState !== undefined) payload.identity_state = identityState;
  if (conflicts !== undefined) payload.conflicts = conflicts as JsonValue;
  return successResult("inspect", payload, []);
}

void test("Codex verification modules are safe in every supported entry order", () => {
  const urls = {
    harness: pathToFileURL(join(PACKAGE_ROOT, "src/codex-harness.ts")).href,
    lifecycle: pathToFileURL(join(PACKAGE_ROOT, "src/lifecycle.ts")).href,
    presentation: pathToFileURL(join(PACKAGE_ROOT, "src/codex-presentation.ts"))
      .href,
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
      const verdict = loaded.lifecycle.verifyInstalledFingerprint(
        desired,
        ok({ verification_hints: {} }),
        ok({ view: "fingerprint", fingerprint: desired }),
      );
      if (!verdict.ok) throw new Error("verification export changed");
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

void test("ownership normalization preserves every Codex removal flag combination", () => {
  for (const pluginPresent of [false, true]) {
    for (const marketplacePresent of [false, true]) {
      const normalized = unwrap(
        normalizeCodexOwnership(
          ownershipResult("manager", pluginPresent, marketplacePresent),
        ),
      );
      assert.deepEqual(normalized.removalInput, {
        pluginPresent,
        marketplacePresent,
      });
      assert.equal(
        normalized.removalVerification.kind,
        pluginPresent || marketplacePresent ? "blocked" : "allowed",
      );
    }
  }
});

void test("ownership normalization reuses legacy install and removal policy", async (t) => {
  const legacy = unwrap(
    normalizeCodexOwnership(ownershipResult("legacy", false, false)),
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

  const unknown = unwrap(
    normalizeCodexOwnership(ownershipResult("unexpected", false, false)),
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
    const normalized = unwrap(
      normalizeCodexOwnership(
        ownershipResult("manager", false, false, [
          "active Codex plugin superpowers@another-provider",
          "native Codex skills route ~/.agents/skills/superpowers has indeterminate activity",
        ]),
      ),
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
      const normalized = unwrap(
        normalizeCodexOwnership(
          ownershipResult("legacy", false, false, [
            "active Codex plugin superpowers@another-provider",
          ]),
        ),
      );
      assert.deepEqual(
        normalized.installEligibility,
        legacy.installEligibility,
      );
    },
  );
});

void test("missing, null, and empty ownership identity use the probe diagnostic", () => {
  for (const identityState of [undefined, null, ""]) {
    const normalized = unwrap(
      normalizeCodexOwnership(ownershipResult(identityState, false, false)),
    );
    assert.equal(normalized.presentationValue, "");
    assert.deepEqual(normalized.installEligibility, {
      kind: "blocked",
      output: {
        stdout: [],
        stderr: ["error: probe did not report adapter identity state"],
      },
    });
  }
});

void test("ownership normalization rejects malformed native fields at the reader boundary", () => {
  const malformedFlag = normalizeCodexOwnership(
    ownershipResult("manager", "yes", false),
  );
  assert.equal(malformedFlag.outcome.ok, false);
  if (malformedFlag.outcome.ok)
    assert.fail("expected malformed flag rejection");
  assert.equal(
    malformedFlag.outcome.error.message,
    "expected a Boolean adapter result at resources.plugin",
  );

  const malformedIdentity = normalizeCodexOwnership(
    ownershipResult(3, false, false),
  );
  assert.equal(malformedIdentity.outcome.ok, false);
  if (malformedIdentity.outcome.ok) {
    assert.fail("expected malformed identity rejection");
  }
  assert.equal(
    malformedIdentity.outcome.error.message,
    "adapter returned a non-string identity_state for inspect --view ownership",
  );

  for (const conflicts of ["conflict", ["valid", 7], ["unsafe\ntext"]]) {
    const malformedConflicts = normalizeCodexOwnership(
      ownershipResult("manager", false, false, conflicts),
    );
    assert.equal(malformedConflicts.outcome.ok, false);
    if (malformedConflicts.outcome.ok) {
      assert.fail("expected malformed conflicts rejection");
    }
    assert.equal(
      malformedConflicts.outcome.error.message,
      "expected an array of strings at conflicts",
    );
  }
});

void test("normalizers preserve controlled native failure outcomes unchanged", () => {
  const failure = failureResult(
    "inspect",
    "inspect-failed",
    "controlled failure",
    ["controlled hint"],
    [{ channel: "stderr", text: "context" }],
  );
  for (const normalized of [
    normalizeCodexOwnership(failure),
    normalizeCodexControl(failure),
    normalizeCodexInstalled(failure, DESIRED),
    normalizeCodexInstall(failure),
  ]) {
    assert.deepEqual(normalized, failure);
  }
});

void test("normalizers reject scalar, null, and array successful payloads before field defaults", () => {
  const messages = [{ channel: "stdout" as const, text: "captured context" }];
  const cases = [
    {
      operation: "inspect",
      normalize: (result: AdapterResult) => normalizeCodexOwnership(result),
      message:
        "adapter returned a non-object result for inspect --view ownership",
    },
    {
      operation: "inspect",
      normalize: (result: AdapterResult) => normalizeCodexControl(result),
      message:
        "adapter returned a non-object result for inspect --view update-control",
    },
    {
      operation: "inspect",
      normalize: (result: AdapterResult) =>
        normalizeCodexInstalled(result, DESIRED),
      message:
        "adapter returned a non-object result for inspect --view fingerprint",
    },
    {
      operation: "install",
      normalize: (result: AdapterResult) => normalizeCodexInstall(result),
      message: "adapter returned a non-object result for install",
    },
  ] as const;
  const invalidPayloads: JsonValue[] = ["scalar", null, []];
  for (const each of cases) {
    for (const payload of invalidPayloads) {
      const normalized = each.normalize(
        successResult(each.operation, payload, messages),
      );
      assert.equal(normalized.outcome.ok, false);
      if (normalized.outcome.ok) {
        assert.fail("expected non-object payload rejection");
      }
      assert.equal(normalized.outcome.error.code, "malformed-result");
      assert.equal(normalized.outcome.error.message, each.message);
      assert.deepEqual(normalized.outcome.messages, messages);
    }
  }
});

void test("nonzero successful statuses take precedence over top-level payload validation", () => {
  const outcome = successResult("inspect", null, []).outcome;
  const inconsistent: AdapterResult = { status: 1, outcome };
  const cases = [
    [
      normalizeCodexOwnership(inconsistent),
      "adapter reported a failure status for inspect --view ownership",
    ],
    [
      normalizeCodexControl(inconsistent),
      "adapter reported a failure status for inspect --view update-control",
    ],
    [
      normalizeCodexInstalled(inconsistent, DESIRED),
      "adapter reported a failure status for inspect --view fingerprint",
    ],
  ] as const;
  for (const [normalized, message] of cases) {
    assert.equal(normalized.outcome.ok, false);
    if (normalized.outcome.ok) assert.fail("expected invalid status rejection");
    assert.equal(normalized.outcome.error.code, "invalid-status");
    assert.equal(normalized.outcome.error.message, message);
  }
});

void test("control normalization separates probe completeness from mutation policy", () => {
  const managed = unwrap(
    normalizeCodexControl(
      successResult("inspect", { update_control: "managed" }, []),
    ),
  );
  assert.deepEqual(managed, {
    probeEligibility: { kind: "allowed" },
    mutationEligibility: { kind: "allowed" },
    presentationValue: "managed",
  });

  const unsupported = unwrap(
    normalizeCodexControl(
      successResult("inspect", { update_control: "unsupported" }, []),
    ),
  );
  assert.deepEqual(unsupported.probeEligibility, { kind: "allowed" });
  assert.deepEqual(unsupported.mutationEligibility, {
    kind: "blocked",
    output: {
      stdout: [],
      stderr: ["error: adapter cannot guarantee manager-controlled updates"],
    },
  });
});

void test("missing, null, and empty control block both probe and mutation", () => {
  for (const updateControl of [undefined, null, ""]) {
    const payload: Record<string, JsonValue> = {};
    if (updateControl !== undefined) payload.update_control = updateControl;
    const normalized = unwrap(
      normalizeCodexControl(successResult("inspect", payload, [])),
    );
    const blocked = {
      kind: "blocked" as const,
      output: {
        stdout: [],
        stderr: [
          "error: probe did not report adapter update-control capability",
        ],
      },
    };
    assert.deepEqual(normalized.probeEligibility, blocked);
    assert.deepEqual(normalized.mutationEligibility, blocked);
    assert.equal(normalized.presentationValue, "");
  }
});

void test("control normalization rejects non-string, non-null control", () => {
  const normalized = normalizeCodexControl(
    successResult("inspect", { update_control: false }, []),
  );
  assert.equal(normalized.outcome.ok, false);
  if (normalized.outcome.ok)
    assert.fail("expected malformed control rejection");
  assert.equal(
    normalized.outcome.error.message,
    "adapter returned a non-string update_control for inspect --view update-control",
  );
});

void test("installed normalization distinguishes absent, mismatch, and current identity", () => {
  const cases: readonly [unknown, InstalledState][] = [
    [undefined, { kind: "absent", observedIdentity: "" }],
    [null, { kind: "absent", observedIdentity: "" }],
    ["", { kind: "absent", observedIdentity: "" }],
    [OTHER, { kind: "mismatch", observedIdentity: OTHER }],
    [DESIRED, { kind: "current", observedIdentity: DESIRED }],
    [
      DESIRED.slice(0, 7),
      { kind: "current", observedIdentity: DESIRED.slice(0, 7) },
    ],
  ];
  for (const [fingerprint, expected] of cases) {
    const payload: Record<string, JsonValue> = {};
    if (fingerprint !== undefined)
      payload.fingerprint = fingerprint as JsonValue;
    assert.deepEqual(
      unwrap(
        normalizeCodexInstalled(successResult("inspect", payload, []), DESIRED),
      ),
      expected,
    );
  }
});

void test("installed normalization rejects a malformed fingerprint", () => {
  const normalized = normalizeCodexInstalled(
    successResult("inspect", { fingerprint: 7 }, []),
    DESIRED,
  );
  assert.equal(normalized.outcome.ok, false);
  if (normalized.outcome.ok) {
    assert.fail("expected malformed fingerprint rejection");
  }
  assert.equal(
    normalized.outcome.error.message,
    "adapter returned a non-string fingerprint for inspect --view fingerprint",
  );
});

void test("install normalization converts only safe verification hints into output", () => {
  const receipt = unwrap(
    normalizeCodexInstall(
      successResult(
        "install",
        {
          verification_hints: {
            missing: "verify the installed plugin",
            mismatch: "retry the installation",
          },
        },
        [],
      ),
    ),
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

  const unsafe = unwrap(
    normalizeCodexInstall(
      successResult(
        "install",
        { verification_hints: { missing: "unsafe\nline", mismatch: 4 } },
        [],
      ),
    ),
  );
  assert.equal(unsafe.missingVerificationOutput.stderr.length, 1);
  assert.equal(unsafe.mismatchVerificationOutput.stderr.length, 1);
});

void test("the concrete install status guard retains the context-dependent diagnostic", () => {
  const succeeded = successResult("install", { verification_hints: {} }, []);
  const inconsistent: AdapterResult = {
    status: 1,
    outcome: succeeded.outcome,
  };
  const normalized = normalizeCodexInstallForContext(inconsistent, {
    root: "/package root",
  });
  assert.equal(normalized.outcome.ok, false);
  if (normalized.outcome.ok) assert.fail("expected invalid status rejection");
  assert.equal(
    normalized.outcome.error.message,
    "adapter reported a failure status for install --package-root /package root",
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
    ownership: unwrap(
      normalizeCodexOwnership(ownershipResult("manager", true, true)),
    ),
    control: unwrap(
      normalizeCodexControl(
        successResult("inspect", { update_control: "managed" }, []),
      ),
    ),
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
  assert.equal(
    rendered.human,
    formatHuman({
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
  const receipt = normalizeCodexInstall(
    successResult("install", { verification_hints: {} }, []),
  );
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
  const receipt = normalizeCodexInstall(
    successResult(
      "install",
      {
        verification_hints: {
          missing: "verify the installed plugin",
          mismatch: "retry the installation",
        },
      },
      [],
    ),
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
  assert.deepEqual(
    codexPresentation.renderInstallVerification(
      DESIRED,
      receipt,
      normalizeCodexInstalled(
        successResult("inspect", { fingerprint: 7 }, []),
        DESIRED,
      ),
    ),
    {
      stdout: [],
      stderr: [
        "error: cannot parse installed manager fingerprint inspection result after install.",
      ],
    },
  );
});

void test("removal completion appends the frozen completion text after a legacy report", () => {
  const ownership = unwrap(
    normalizeCodexOwnership(ownershipResult("legacy", false, false)),
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
  const ownership = unwrap(await codexHarness.inspectOwnership(ctx));
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
  ]);
});

void test("Codex harness install retains the current package-root authority", async (t) => {
  const sandbox = await codexSandbox(t);
  const ctx = { root: PACKAGE_ROOT, env: sandbox.env };
  const installed = await codexHarness.install(
    {
      root: "/evidence-only",
      commit: DESIRED,
      compatibility: {
        kind: "supported",
        generation: "codex-native",
        reason: "fixture compatibility",
      },
      identity: DESIRED,
    },
    ctx,
  );
  assert.equal(installed.status, 0);
  assert.equal(installed.outcome.ok, true);
  assert.deepEqual(await sandbox.commands(), [
    "plugin marketplace list --json",
    `plugin marketplace add ${PACKAGE_ROOT}`,
    "plugin add superpowers@superpowers-manager",
  ]);
});

console.log("codex-harness.test.js: OK");
