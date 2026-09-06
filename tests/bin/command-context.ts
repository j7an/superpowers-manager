import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";

import {
  failureResult,
  successResult,
  type AdapterResult,
} from "../../src/adapter-result.ts";
import type { CodexRemovalInput } from "../../src/adapter.ts";
import {
  codexHarness,
  normalizeCodexControl,
  normalizeCodexInstallForContext,
  normalizeCodexInstalled,
  normalizeCodexOwnership,
} from "../../src/codex-harness.ts";
import type {
  HarnessAdapter,
  PrepareCandidateInput,
  PreparedArtifact,
} from "../../src/harness.ts";
import type { HarnessCall } from "../lib/command-doubles.ts";
import { SCRATCH, UPSTREAM } from "./lifecycle-fixture.ts";

export function caseEnvVars(
  c: import("./lifecycle-fixture.ts").CaseEnv,
  extra: Record<string, string> = {},
): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH ?? "",
    HOME: c.home,
    XDG_CONFIG_HOME: join(c.home, ".config"),
    TMPDIR: c.tmp,
    SPW_FIXTURE_STATE: c.state,
    SPW_TEST_PKG_ROOT: c.pkg,
    SUPERPOWERS_CODEX: c.codexBin,
    SUPERPOWERS_UPSTREAM_URL: UPSTREAM,
    SUPERPOWERS_INSTALLED_SEARCH_ROOT: join(c.state, "codex-home"),
    ...extra,
  };
}

function preserveFailure<T>(result: AdapterResult): AdapterResult<T> {
  if (result.outcome.ok) {
    throw new Error("cannot preserve a successful adapter result as failure");
  }
  return { status: result.status, outcome: result.outcome };
}

export function recordingAdapter(
  handler: (argv: readonly string[], call: number) => unknown,
) {
  const calls: HarnessCall[] = [];
  let handlerCalls = 0;
  const record = (operation: string, input?: unknown): void => {
    calls.push(input === undefined ? { operation } : { operation, input });
  };
  const answer = (argv: readonly string[]): AdapterResult => {
    handlerCalls += 1;
    let value;
    try {
      value = handler(argv, handlerCalls);
    } catch (cause) {
      assert.fail(
        `recordingAdapter: handler threw for call ${handlerCalls} ` +
          `(${argv.join(" ")}): ${cause instanceof Error ? cause.message : String(cause)}`,
      );
    }
    assert.ok(
      value !== undefined,
      `recordingAdapter exhausted at call ${handlerCalls}: ${argv.join(" ")}`,
    );
    return value as AdapterResult;
  };
  const adapter: HarnessAdapter<CodexRemovalInput> & {
    calls: HarnessCall[];
  } = {
    preparationLocation(ctx) {
      record("preparation-location");
      return codexHarness.preparationLocation(ctx);
    },
    async validatePreparationBeforeFetch(ctx) {
      record("validate-preparation-before-fetch");
      return await codexHarness.validatePreparationBeforeFetch(ctx);
    },
    async prepareCandidate(input: PrepareCandidateInput, ctx) {
      record("prepare-candidate", input);
      const fallbackManifest =
        ctx.env?.SUPERPOWERS_MANIFEST_TEMPLATE ||
        join(
          ctx.root,
          "plugins",
          "superpowers",
          ".codex-plugin",
          "plugin.template.json",
        );
      const result = answer([
        "build",
        "--candidate-root",
        input.candidateRoot,
        "--fallback-manifest",
        fallbackManifest,
      ]);
      if (!result.outcome.ok) return preserveFailure(result);
      if (result.status !== 0) {
        return failureResult(
          result.outcome.operation,
          "invalid-status",
          "adapter reported failure without an error outcome",
          [],
          result.outcome.messages,
        );
      }
      mkdirSync(input.candidateRoot, { recursive: true });
      writeFileSync(
        join(input.candidateRoot, ".superpowers-upstream.json"),
        JSON.stringify({ commit: input.selection.desiredCommit }),
        "utf8",
      );
      const artifact: PreparedArtifact = {
        root: input.candidateRoot,
        commit: input.selection.desiredCommit,
        compatibility: {
          kind: "unknown",
          reason: "legacy Codex-shaped scripted result",
        },
        identity: input.selection.desiredCommit,
      };
      return successResult(
        result.outcome.operation,
        artifact,
        result.outcome.messages,
      );
    },
    async inspectPrepared(selection, ctx) {
      record("inspect-prepared", selection);
      return await codexHarness.inspectPrepared(selection, ctx);
    },
    async readPrepared(ctx) {
      record("read-prepared");
      return await codexHarness.readPrepared(ctx);
    },
    async inspectOwnership() {
      record("inspect-ownership");
      return normalizeCodexOwnership(
        answer(["inspect", "--view", "ownership"]),
      );
    },
    async inspectUpdateControl() {
      record("inspect-update-control");
      return normalizeCodexControl(
        answer(["inspect", "--view", "update-control"]),
      );
    },
    async inspectInstalled(selection) {
      record("inspect-installed", selection);
      return normalizeCodexInstalled(
        answer(["inspect", "--view", "fingerprint"]),
        selection.desiredCommit,
      );
    },
    async install(artifact, ctx) {
      record("install", artifact);
      return normalizeCodexInstallForContext(
        answer(["install", "--package-root", ctx.root]),
        ctx,
      );
    },
    async remove(removalInput, ctx) {
      record("remove", removalInput);
      const result = answer([
        "uninstall",
        "--plugin-present",
        String(removalInput.pluginPresent),
        "--marketplace-present",
        String(removalInput.marketplacePresent),
      ]);
      if (!result.outcome.ok) return preserveFailure(result);
      if (result.status !== 0) {
        return failureResult(
          result.outcome.operation,
          "invalid-status",
          codexHarness.presentation.callFailure("remove", ctx, removalInput)
            .invalidStatus,
          [],
          result.outcome.messages,
        );
      }
      return successResult(
        result.outcome.operation,
        null,
        result.outcome.messages,
      );
    },
    requirements(command, env) {
      record("requirements", command);
      return codexHarness.requirements(command, env);
    },
    presentation: codexHarness.presentation,
    calls,
  };
  return adapter;
}

export function caseContext(
  c: import("./lifecycle-fixture.ts").CaseEnv,
  options: {
    adapter: HarnessAdapter<CodexRemovalInput>;
    env?: Record<string, string>;
  },
): {
  ctx: import("../../src/commands/context.ts").CommandContext<CodexRemovalInput>;
  stdout: () => string;
  stderr: () => string;
} {
  const resolvedPkg = resolve(c.pkg);
  const resolvedScratch = resolve(SCRATCH);
  if (
    resolvedPkg !== resolvedScratch &&
    !resolvedPkg.startsWith(resolvedScratch + sep)
  ) {
    throw new Error(
      `refusing to build a CommandContext against a package root outside the fixture scratch tree: ${c.pkg}`,
    );
  }
  let stdoutBuf = "";
  let stderrBuf = "";
  const stdout = {
    write(text: string) {
      stdoutBuf += text;
      return true;
    },
  } as unknown as NodeJS.WritableStream;
  const stderr = {
    write(text: string) {
      stderrBuf += text;
      return true;
    },
  } as unknown as NodeJS.WritableStream;
  const ctx = {
    root: c.pkg,
    env: caseEnvVars(c, options.env),
    stdout,
    stderr,
    options: { harness: "codex" as const, allowExperimental: false },
    adapter: options.adapter,
  };
  return { ctx, stdout: () => stdoutBuf, stderr: () => stderrBuf };
}
