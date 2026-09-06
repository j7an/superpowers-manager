import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  failureResult,
  successResult,
  type AdapterResult,
} from "../../src/adapter-result.ts";
import { runInstall } from "../../src/commands/install.ts";
import { runPrepare } from "../../src/commands/prepare.ts";
import { gatherProbe, runProbe } from "../../src/commands/probe.ts";
import { runUninstall } from "../../src/commands/uninstall.ts";
import { runUpdate } from "../../src/commands/update.ts";
import type {
  InstalledState,
  OwnershipInspection,
  PreparedState,
  UpdateControlInspection,
} from "../../src/harness.ts";
import { workspaceRemovalFailure } from "../../src/workspace.ts";
import { createHarnessFixture } from "../lib/test-harness.ts";

void test("preparation does not require a Codex template or manifest", async (t) => {
  const fixture = await createHarnessFixture(t);

  assert.equal(await runPrepare([], fixture.ctx), 0);
  assert.equal(
    readFileSync(join(fixture.destinationRoot, "payload.txt"), "utf8"),
    "fixture\n",
  );
  assert.equal(
    existsSync(join(fixture.destinationRoot, ".codex-plugin")),
    false,
  );
  assert.deepEqual(fixture.calls, ["location", "prefetch", "prepare"]);
});

void test("a rejected candidate preserves the previous payload before validation or replacement", async (t) => {
  const fixture = await createHarnessFixture(t);
  let workspaceRoot: string | undefined;
  mkdirSync(fixture.destinationRoot, { recursive: true });
  writeFileSync(
    join(fixture.destinationRoot, "payload.txt"),
    "previous\n",
    "utf8",
  );
  const adapter = {
    ...fixture.adapter,
    async prepareCandidate(
      input: Parameters<typeof fixture.adapter.prepareCandidate>[0],
    ) {
      workspaceRoot = input.workspaceRoot;
      const prepared = await fixture.adapter.prepareCandidate(input, {
        root: fixture.ctx.root,
        env: fixture.ctx.env,
      });
      assert.equal(prepared.outcome.ok, true);
      return failureResult(
        "prepare",
        "fixture-rejected",
        "fixture candidate rejected",
        [],
        [],
      );
    },
  };
  const ctx = {
    ...fixture.ctx,
    env: {
      ...fixture.ctx.env,
      SUPERPOWERS_VALIDATOR_EXECUTABLE: join(
        fixture.ctx.root,
        "validator-must-not-run",
      ),
    },
    adapter,
  };

  assert.equal(await runPrepare([], ctx), 1);
  assert.equal(
    readFileSync(join(fixture.destinationRoot, "payload.txt"), "utf8"),
    "previous\n",
  );
  assert.deepEqual(fixture.calls, ["location", "prefetch", "prepare"]);
  assert.equal(fixture.err.text(), "error: fixture candidate rejected\n");
  assert.ok(workspaceRoot);
  assert.equal(existsSync(workspaceRoot), false);

  await t.test(
    "unsupported candidates do not reach validators or replacement",
    async (subtest) => {
      const unsupportedFixture = await createHarnessFixture(subtest);
      mkdirSync(unsupportedFixture.destinationRoot, { recursive: true });
      writeFileSync(
        join(unsupportedFixture.destinationRoot, "payload.txt"),
        "previous\n",
        "utf8",
      );
      const validator = join(
        unsupportedFixture.ctx.root,
        "forbidden-validator",
      );
      const validatorSentinel = join(
        unsupportedFixture.ctx.root,
        "validator-ran",
      );
      writeFileSync(
        validator,
        '#!/bin/sh\n: > "$SPW_TEST_VALIDATOR_SENTINEL"\n',
        "utf8",
      );
      chmodSync(validator, 0o755);
      const unsupportedAdapter = {
        ...unsupportedFixture.adapter,
        async prepareCandidate(
          input: Parameters<
            typeof unsupportedFixture.adapter.prepareCandidate
          >[0],
        ) {
          const prepared = await unsupportedFixture.adapter.prepareCandidate(
            input,
            {
              root: unsupportedFixture.ctx.root,
              env: unsupportedFixture.ctx.env,
            },
          );
          if (!prepared.outcome.ok) return prepared;
          return successResult(
            prepared.outcome.operation,
            {
              ...prepared.outcome.result,
              compatibility: {
                kind: "unsupported" as const,
                reason: "missing bootstrap",
              },
            },
            prepared.outcome.messages,
          );
        },
      };
      const unsupportedContext = {
        ...unsupportedFixture.ctx,
        env: {
          ...unsupportedFixture.ctx.env,
          SUPERPOWERS_VALIDATOR_EXECUTABLE: validator,
          SPW_TEST_VALIDATOR_SENTINEL: validatorSentinel,
        },
        adapter: unsupportedAdapter,
      };

      assert.equal(await runPrepare([], unsupportedContext), 1);
      assert.equal(
        readFileSync(
          join(unsupportedFixture.destinationRoot, "payload.txt"),
          "utf8",
        ),
        "previous\n",
      );
      assert.equal(existsSync(validatorSentinel), false);
      assert.deepEqual(unsupportedFixture.calls, [
        "location",
        "prefetch",
        "prepare",
      ]);
      assert.equal(unsupportedFixture.out.text(), "");
      assert.equal(unsupportedFixture.err.text(), "error: missing bootstrap\n");
    },
  );
});

void test("preparation rejects unsafe locations before allocating a workspace", async (t) => {
  const locations = [
    { destinationRoot: "relative", stagingLeaf: "candidate" },
    { destinationRoot: "absolute", stagingLeaf: "" },
    { destinationRoot: "absolute", stagingLeaf: "." },
    { destinationRoot: "absolute", stagingLeaf: ".." },
    { destinationRoot: "absolute", stagingLeaf: "nested/candidate" },
    { destinationRoot: "absolute", stagingLeaf: "nested\\candidate" },
  ] as const;
  for (const configured of locations) {
    const fixture = await createHarnessFixture(t);
    const destinationRoot =
      configured.destinationRoot === "absolute"
        ? fixture.destinationRoot
        : configured.destinationRoot;
    const adapter = {
      ...fixture.adapter,
      preparationLocation() {
        fixture.calls.push("location");
        return { destinationRoot, stagingLeaf: configured.stagingLeaf };
      },
      async validatePreparationBeforeFetch() {
        fixture.calls.push("prefetch");
        return failureResult(
          "prefetch",
          "sentinel",
          "location validation did not run first",
          [],
          [],
        );
      },
    };
    const status = await runPrepare([], { ...fixture.ctx, adapter });
    assert.equal(status, 1);
    assert.deepEqual(fixture.calls, ["location"]);
    assert.equal(
      fixture.err.text(),
      configured.destinationRoot === "relative"
        ? "error: adapter returned a non-absolute preparation destination\n"
        : "error: adapter returned an invalid preparation staging leaf\n",
    );
  }
});

void test("preparation hides a location resolver's thrown diagnostic", async (t) => {
  const fixture = await createHarnessFixture(t);
  const adapter = {
    ...fixture.adapter,
    preparationLocation(): never {
      fixture.calls.push("location");
      throw new Error("hostile location details");
    },
  };

  assert.equal(await runPrepare([], { ...fixture.ctx, adapter }), 1);
  assert.deepEqual(fixture.calls, ["location"]);
  assert.equal(
    fixture.err.text(),
    "error: cannot determine preparation location\n",
  );
});

void test("preparation hides a candidate builder's thrown diagnostic", async (t) => {
  const fixture = await createHarnessFixture(t);
  const adapter = {
    ...fixture.adapter,
    async prepareCandidate(): Promise<never> {
      fixture.calls.push("prepare");
      throw new Error("hostile candidate builder details");
    },
  };

  assert.equal(await runPrepare([], { ...fixture.ctx, adapter }), 1);
  assert.deepEqual(fixture.calls, ["location", "prefetch", "prepare"]);
  assert.equal(fixture.err.text(), "error: unexpected test adapter call\n");
});

void test("preparation rejects artifact evidence for another root", async (t) => {
  const fixture = await createHarnessFixture(t);
  mkdirSync(fixture.destinationRoot, { recursive: true });
  writeFileSync(
    join(fixture.destinationRoot, "payload.txt"),
    "previous\n",
    "utf8",
  );
  const adapter = {
    ...fixture.adapter,
    async prepareCandidate(
      input: Parameters<typeof fixture.adapter.prepareCandidate>[0],
    ) {
      const result = await fixture.adapter.prepareCandidate(input, {
        root: fixture.ctx.root,
        env: fixture.ctx.env,
      });
      assert.equal(result.outcome.ok, true);
      return successResult(
        result.outcome.operation,
        {
          ...result.outcome.result,
          root: `${input.candidateRoot}-other`,
        },
        result.outcome.messages,
      );
    },
  };

  assert.equal(await runPrepare([], { ...fixture.ctx, adapter }), 1);
  assert.deepEqual(fixture.calls, ["location", "prefetch", "prepare"]);
  assert.equal(
    fixture.err.text(),
    "error: adapter returned an unexpected preparation root\n",
  );
  assert.equal(
    readFileSync(join(fixture.destinationRoot, "payload.txt"), "utf8"),
    "previous\n",
  );
});

void test("preparation rejects artifact evidence for another commit", async (t) => {
  const fixture = await createHarnessFixture(t);
  const adapter = {
    ...fixture.adapter,
    async prepareCandidate(
      input: Parameters<typeof fixture.adapter.prepareCandidate>[0],
    ) {
      const result = await fixture.adapter.prepareCandidate(input, {
        root: fixture.ctx.root,
        env: fixture.ctx.env,
      });
      assert.equal(result.outcome.ok, true);
      return successResult(
        result.outcome.operation,
        { ...result.outcome.result, commit: "0".repeat(40) },
        result.outcome.messages,
      );
    },
  };

  assert.equal(await runPrepare([], { ...fixture.ctx, adapter }), 1);
  assert.deepEqual(fixture.calls, ["location", "prefetch", "prepare"]);
  assert.equal(
    fixture.err.text(),
    "error: adapter returned an unexpected preparation commit\n",
  );
});

void test("a malformed saved selection stops before fetch or integration inspection", async (t) => {
  const fixture = await createHarnessFixture(t);
  const config = fixture.ctx.env.SUPERPOWERS_CONFIG_DIR;
  assert.ok(config);
  writeFileSync(join(config, "selection.json"), "{", "utf8");
  const env = {
    ...fixture.ctx.env,
    SUPERPOWERS_UPSTREAM_URL: join(
      fixture.ctx.root,
      "upstream-resolution-must-not-run",
    ),
    SUPERPOWERS_REF: "resolution-must-not-run",
  };

  assert.equal(await runProbe([], { ...fixture.ctx, env }), 1);
  assert.deepEqual(fixture.calls, []);
  assert.match(
    fixture.err.text(),
    /^error: invalid JSON in .*selection\.json: line 1 column 2:/,
  );
});

void test("probe performs only the four read-only inspections", async (t) => {
  const fixture = await createHarnessFixture(t);
  const adapter = {
    ...fixture.adapter,
    inspectPrepared: fixture.methods.inspectPrepared,
    inspectInstalled: fixture.methods.inspectInstalled,
    inspectOwnership: fixture.methods.inspectOwnership,
    inspectUpdateControl: fixture.methods.inspectUpdateControl,
  };

  assert.equal(await runProbe([], { ...fixture.ctx, adapter }), 0);
  assert.deepEqual(fixture.calls, [
    "inspect-prepared",
    "inspect-installed",
    "inspect-ownership",
    "inspect-control",
  ]);
  assert.equal(fixture.out.text(), "fixture status current\n");
  assert.equal(fixture.err.text(), "");

  await t.test(
    "unsupported prepared content does not suppress installed inspection",
    async (subtest) => {
      const unsupportedFixture = await createHarnessFixture(subtest);
      const compatibility = {
        kind: "unsupported" as const,
        reason: "missing bootstrap",
      };
      const unsupportedAdapter = {
        ...unsupportedFixture.adapter,
        async inspectPrepared(
          inputSelection: typeof unsupportedFixture.selection,
        ) {
          unsupportedFixture.calls.push("inspect-prepared");
          assert.deepEqual(inputSelection, unsupportedFixture.selection);
          return successResult(
            "inspect-prepared",
            {
              kind: "needs-prepare" as const,
              observedIdentity: "",
              compatibility,
            },
            [],
          );
        },
        inspectInstalled: unsupportedFixture.methods.inspectInstalled,
        inspectOwnership: unsupportedFixture.methods.inspectOwnership,
        inspectUpdateControl: unsupportedFixture.methods.inspectUpdateControl,
      };

      const outcome = await gatherProbe({
        ...unsupportedFixture.ctx,
        adapter: unsupportedAdapter,
      });

      assert.equal(outcome.status, 0);
      assert.deepEqual(unsupportedFixture.calls, [
        "inspect-prepared",
        "inspect-installed",
        "inspect-ownership",
        "inspect-control",
      ]);
      if (outcome.status === 0) {
        assert.deepEqual(outcome.facts.compatibility, compatibility);
      }
    },
  );
});

void test("update composes probe, preparation, and installation through a non-Codex adapter", async (t) => {
  const fixture = await createHarnessFixture(t);
  let preparedReads = 0;
  const adapter = {
    ...fixture.adapter,
    async inspectPrepared(
      inputSelection: typeof fixture.selection,
      adapterCtx: {
        readonly root: string;
        readonly env?: NodeJS.ProcessEnv;
      },
    ): Promise<AdapterResult<PreparedState>> {
      const result = await fixture.methods.inspectPrepared(
        inputSelection,
        adapterCtx,
      );
      preparedReads += 1;
      if (preparedReads !== 1 || !result.outcome.ok) return result;
      return successResult(
        "inspect-prepared",
        {
          kind: "needs-prepare",
          observedIdentity: fixture.selection.desiredCommit,
          compatibility: result.outcome.result.compatibility,
        },
        result.outcome.messages,
      );
    },
    inspectInstalled: fixture.methods.inspectInstalled,
    inspectOwnership: fixture.methods.inspectOwnership,
    inspectUpdateControl: fixture.methods.inspectUpdateControl,
    readPrepared: fixture.methods.readPrepared,
    install: fixture.methods.install,
  };

  assert.equal(await runUpdate([], { ...fixture.ctx, adapter }), 0);
  assert.deepEqual(fixture.calls, [
    "inspect-prepared",
    "inspect-installed",
    "inspect-ownership",
    "inspect-control",
    "location",
    "prefetch",
    "prepare",
    "inspect-prepared",
    "inspect-installed",
    "inspect-ownership",
    "inspect-control",
    "read-prepared",
    "inspect-ownership",
    "inspect-control",
    "install",
    "inspect-installed",
  ]);
  assert.equal(
    fixture.out.text(),
    `prepared ${fixture.selection.resolvedRef} at ${fixture.selection.desiredCommit}\n` +
      `test install notice\n` +
      `fixture installed ${fixture.selection.desiredCommit}\n`,
  );
  assert.equal(fixture.err.text(), "");
});

void test("install obeys a fresh ownership denial after an allowed probe", async (t) => {
  const fixture = await createHarnessFixture(t);
  let ownershipReads = 0;
  const denied = {
    kind: "blocked" as const,
    output: {
      stdout: [],
      stderr: ["error: fixture ownership changed"],
    },
  };
  const adapter = {
    ...fixture.adapter,
    inspectPrepared: fixture.methods.inspectPrepared,
    inspectInstalled: fixture.methods.inspectInstalled,
    inspectUpdateControl: fixture.methods.inspectUpdateControl,
    readPrepared: fixture.methods.readPrepared,
    async inspectOwnership(adapterCtx: {
      readonly root: string;
      readonly env?: NodeJS.ProcessEnv;
    }) {
      const result = await fixture.methods.inspectOwnership(adapterCtx);
      ownershipReads += 1;
      if (ownershipReads !== 2 || !result.outcome.ok) return result;
      return successResult(
        "inspect-ownership",
        { ...result.outcome.result, installEligibility: denied },
        result.outcome.messages,
      );
    },
  };

  assert.equal(await runInstall([], { ...fixture.ctx, adapter }), 1);
  assert.deepEqual(fixture.calls, [
    "inspect-prepared",
    "inspect-installed",
    "inspect-ownership",
    "inspect-control",
    "read-prepared",
    "inspect-ownership",
  ]);
  assert.equal(fixture.calls.includes("install"), false);
  assert.equal(fixture.err.text(), "error: fixture ownership changed\n");
});

void test("install stops when fresh update control fails", async (t) => {
  const fixture = await createHarnessFixture(t);
  let controlReads = 0;
  const adapter = {
    ...fixture.adapter,
    inspectPrepared: fixture.methods.inspectPrepared,
    inspectInstalled: fixture.methods.inspectInstalled,
    inspectOwnership: fixture.methods.inspectOwnership,
    readPrepared: fixture.methods.readPrepared,
    async inspectUpdateControl(adapterCtx: {
      readonly root: string;
      readonly env?: NodeJS.ProcessEnv;
    }): Promise<AdapterResult<UpdateControlInspection>> {
      controlReads += 1;
      if (controlReads === 2) {
        fixture.calls.push("inspect-control");
        return failureResult(
          "inspect-control",
          "fixture-control-failure",
          "fixture fresh control failed",
          [],
          [],
        );
      }
      return await fixture.methods.inspectUpdateControl(adapterCtx);
    },
  };

  assert.equal(await runInstall([], { ...fixture.ctx, adapter }), 1);
  assert.deepEqual(fixture.calls, [
    "inspect-prepared",
    "inspect-installed",
    "inspect-ownership",
    "inspect-control",
    "read-prepared",
    "inspect-ownership",
    "inspect-control",
  ]);
  assert.equal(fixture.calls.includes("install"), false);
  assert.equal(fixture.err.text(), "error: fixture fresh control failed\n");
});

void test("install stops when fresh update control blocks mutation", async (t) => {
  const fixture = await createHarnessFixture(t);
  let controlReads = 0;
  const adapter = {
    ...fixture.adapter,
    inspectPrepared: fixture.methods.inspectPrepared,
    inspectInstalled: fixture.methods.inspectInstalled,
    inspectOwnership: fixture.methods.inspectOwnership,
    readPrepared: fixture.methods.readPrepared,
    async inspectUpdateControl(adapterCtx: {
      readonly root: string;
      readonly env?: NodeJS.ProcessEnv;
    }): Promise<AdapterResult<UpdateControlInspection>> {
      const result = await fixture.methods.inspectUpdateControl(adapterCtx);
      controlReads += 1;
      if (controlReads !== 2 || !result.outcome.ok) return result;
      return successResult(
        "inspect-control",
        {
          ...result.outcome.result,
          mutationEligibility: {
            kind: "blocked",
            output: {
              stdout: [],
              stderr: ["error: fixture control changed"],
            },
          },
        },
        result.outcome.messages,
      );
    },
  };

  assert.equal(await runInstall([], { ...fixture.ctx, adapter }), 1);
  assert.deepEqual(fixture.calls, [
    "inspect-prepared",
    "inspect-installed",
    "inspect-ownership",
    "inspect-control",
    "read-prepared",
    "inspect-ownership",
    "inspect-control",
  ]);
  assert.equal(fixture.calls.includes("install"), false);
  assert.equal(fixture.err.text(), "error: fixture control changed\n");
});

void test("post-install failure, absence, and mismatch cannot report success", async (t) => {
  const cases: readonly {
    readonly name: string;
    readonly response: () => AdapterResult<InstalledState>;
    readonly stderr: string;
  }[] = [
    {
      name: "inspection failure",
      response: () =>
        failureResult(
          "inspect-installed",
          "fixture-inspection-failure",
          "fixture installed-state read failed",
          [],
          [],
        ),
      stderr:
        "error: fixture installed-state read failed\n" +
        "error: fixture post-install inspection failed\n",
    },
    {
      name: "absent",
      response: () =>
        successResult(
          "inspect-installed",
          { kind: "absent", observedIdentity: "" },
          [],
        ),
      stderr: "error: fixture installation is absent\n",
    },
    {
      name: "mismatch",
      response: () =>
        successResult(
          "inspect-installed",
          { kind: "mismatch", observedIdentity: "other" },
          [],
        ),
      stderr: "error: fixture installation is mismatched\n",
    },
  ];

  for (const each of cases) {
    await t.test(each.name, async (subtest) => {
      const fixture = await createHarnessFixture(subtest);
      let installedReads = 0;
      const adapter = {
        ...fixture.adapter,
        inspectPrepared: fixture.methods.inspectPrepared,
        inspectOwnership: fixture.methods.inspectOwnership,
        inspectUpdateControl: fixture.methods.inspectUpdateControl,
        readPrepared: fixture.methods.readPrepared,
        install: fixture.methods.install,
        async inspectInstalled(
          inputSelection: typeof fixture.selection,
          adapterCtx: {
            readonly root: string;
            readonly env?: NodeJS.ProcessEnv;
          },
        ): Promise<AdapterResult<InstalledState>> {
          installedReads += 1;
          if (installedReads === 2) {
            fixture.calls.push("inspect-installed");
            assert.deepEqual(inputSelection, fixture.selection);
            return each.response();
          }
          return await fixture.methods.inspectInstalled(
            inputSelection,
            adapterCtx,
          );
        },
      };

      assert.equal(await runInstall([], { ...fixture.ctx, adapter }), 1);
      assert.deepEqual(fixture.calls, [
        "inspect-prepared",
        "inspect-installed",
        "inspect-ownership",
        "inspect-control",
        "read-prepared",
        "inspect-ownership",
        "inspect-control",
        "install",
        "inspect-installed",
      ]);
      assert.equal(fixture.out.text().includes("fixture installed"), false);
      assert.equal(fixture.err.text(), each.stderr);
    });
  }
});

void test("removal passes private input unchanged and reinspects ownership", async (t) => {
  const fixture = await createHarnessFixture(t);
  const adapter = {
    ...fixture.adapter,
    inspectOwnership: fixture.methods.inspectOwnership,
    remove: fixture.methods.remove,
  };

  assert.equal(await runUninstall([], { ...fixture.ctx, adapter }), 0);
  assert.deepEqual(fixture.calls, [
    "inspect-ownership",
    "remove",
    "inspect-ownership",
  ]);
  assert.equal(fixture.removalInputs.length, 1);
  assert.strictEqual(fixture.removalInputs[0], fixture.removalInput);
  assert.equal(fixture.out.text(), "fixture uninstall complete\n");
  assert.equal(fixture.err.text(), "");
});

void test("residual owned resources fail after a successful remove", async (t) => {
  const fixture = await createHarnessFixture(t);
  let ownershipReads = 0;
  const adapter = {
    ...fixture.adapter,
    remove: fixture.methods.remove,
    async inspectOwnership(adapterCtx: {
      readonly root: string;
      readonly env?: NodeJS.ProcessEnv;
    }): Promise<
      AdapterResult<OwnershipInspection<{ readonly receipt: string }>>
    > {
      const result = await fixture.methods.inspectOwnership(adapterCtx);
      ownershipReads += 1;
      if (ownershipReads !== 2 || !result.outcome.ok) return result;
      return successResult(
        "inspect-ownership",
        {
          ...result.outcome.result,
          removalVerification: {
            kind: "blocked",
            output: {
              stdout: [],
              stderr: ["error: fixture resources remain"],
            },
          },
        },
        result.outcome.messages,
      );
    },
  };

  assert.equal(await runUninstall([], { ...fixture.ctx, adapter }), 1);
  assert.deepEqual(fixture.calls, [
    "inspect-ownership",
    "remove",
    "inspect-ownership",
  ]);
  assert.equal(fixture.out.text().includes("uninstall complete"), false);
  assert.equal(fixture.err.text(), "error: fixture resources remain\n");
});

void test("a failed post-remove ownership inspection suppresses completion", async (t) => {
  const fixture = await createHarnessFixture(t);
  let ownershipReads = 0;
  const adapter = {
    ...fixture.adapter,
    remove: fixture.methods.remove,
    async inspectOwnership(adapterCtx: {
      readonly root: string;
      readonly env?: NodeJS.ProcessEnv;
    }): Promise<
      AdapterResult<OwnershipInspection<{ readonly receipt: string }>>
    > {
      ownershipReads += 1;
      if (ownershipReads === 2) {
        fixture.calls.push("inspect-ownership");
        return failureResult(
          "inspect-ownership",
          "fixture-post-remove-failure",
          "fixture post-remove inspection failed",
          [],
          [],
        );
      }
      return await fixture.methods.inspectOwnership(adapterCtx);
    },
  };

  assert.equal(await runUninstall([], { ...fixture.ctx, adapter }), 1);
  assert.deepEqual(fixture.calls, [
    "inspect-ownership",
    "remove",
    "inspect-ownership",
  ]);
  assert.equal(fixture.out.text(), "");
  assert.equal(
    fixture.err.text(),
    "error: fixture post-remove inspection failed\n",
  );
});

void test("retained legacy state is reported without changing the private removal input", async (t) => {
  const fixture = await createHarnessFixture(t);
  let ownershipReads = 0;
  const adapter = {
    ...fixture.adapter,
    remove: fixture.methods.remove,
    async inspectOwnership(adapterCtx: {
      readonly root: string;
      readonly env?: NodeJS.ProcessEnv;
    }) {
      const result = await fixture.methods.inspectOwnership(adapterCtx);
      ownershipReads += 1;
      if (ownershipReads !== 2 || !result.outcome.ok) return result;
      return successResult(
        "inspect-ownership",
        {
          ...result.outcome.result,
          postRemovalOutput: {
            stdout: ["fixture legacy provider remains"],
            stderr: [],
          },
        },
        result.outcome.messages,
      );
    },
  };

  assert.equal(await runUninstall([], { ...fixture.ctx, adapter }), 0);
  assert.strictEqual(fixture.removalInputs[0], fixture.removalInput);
  assert.deepEqual(fixture.calls, [
    "inspect-ownership",
    "remove",
    "inspect-ownership",
  ]);
  assert.equal(
    fixture.out.text(),
    "fixture legacy provider remains\nfixture uninstall complete\n",
  );
  assert.equal(fixture.err.text(), "");
});

void test("cleanup failure preserves the completed result and unrelated sibling", async (t) => {
  if (process.getuid?.() === 0) return;
  const fixture = await createHarnessFixture(t);
  const parent = mkdtempSync(join(tmpdir(), "spw-harness-cleanup-"));
  const sibling = join(parent, "unrelated.txt");
  writeFileSync(sibling, "keep\n", "utf8");
  try {
    let ownershipReads = 0;
    const adapter = {
      ...fixture.adapter,
      remove: fixture.methods.remove,
      async inspectOwnership(adapterCtx: {
        readonly root: string;
        readonly env?: NodeJS.ProcessEnv;
      }) {
        const result = await fixture.methods.inspectOwnership(adapterCtx);
        ownershipReads += 1;
        if (ownershipReads === 2) chmodSync(parent, 0o500);
        return result;
      },
    };
    const status = await runUninstall([], {
      ...fixture.ctx,
      env: { ...fixture.ctx.env, TMPDIR: parent },
      adapter,
    });

    assert.equal(status, 1);
    assert.deepEqual(fixture.calls, [
      "inspect-ownership",
      "remove",
      "inspect-ownership",
    ]);
    assert.equal(fixture.out.text(), "fixture uninstall complete\n");
    assert.equal(readFileSync(sibling, "utf8"), "keep\n");
    const workspace = readdirSync(parent)
      .filter((name) => name !== "unrelated.txt")
      .map((name) => join(parent, name));
    assert.equal(workspace.length, 1);
    assert.equal(
      fixture.err.text(),
      `error: ${workspaceRemovalFailure(workspace[0]!)}\n`,
    );
  } finally {
    chmodSync(parent, 0o700);
    rmSync(parent, { recursive: true, force: true });
  }
});
