import assert from "node:assert/strict";
import { writeQualifiedCodexFixture } from "./codex-prepared-fixture.ts";

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
  HarnessCommand,
  PrepareCandidateInput,
  PreparedArtifact,
} from "../../src/harness.ts";
import type { ResourceCoordinator } from "../../src/resource-lock.ts";

export interface HarnessCall {
  readonly operation: string;
  readonly input?: unknown;
}

const notCalled = (operation: string): never => {
  throw new Error(`ctx.adapter must not be called: ${operation}`);
};

export const notCalledAdapter: HarnessAdapter<CodexRemovalInput> = {
  preparationLocation() {
    return notCalled("preparation-location");
  },
  async mutationRoots() {
    return notCalled("mutation-roots");
  },
  async validatePreparationBeforeFetch() {
    return notCalled("validate-preparation-before-fetch");
  },
  async prepareCandidate() {
    return notCalled("prepare-candidate");
  },
  async inspectPrepared() {
    return notCalled("inspect-prepared");
  },
  async readPrepared() {
    return notCalled("read-prepared");
  },
  async inspectOwnership() {
    return notCalled("inspect-ownership");
  },
  async inspectUpdateControl() {
    return notCalled("inspect-update-control");
  },
  async inspectInstalled() {
    return notCalled("inspect-installed");
  },
  async install() {
    return notCalled("install");
  },
  async remove() {
    return notCalled("remove");
  },
  requirements() {
    return notCalled("requirements");
  },
  presentation: codexHarness.presentation,
};

export function capture(): {
  stream: NodeJS.WritableStream;
  text: () => string;
} {
  const chunks: string[] = [];
  return {
    stream: {
      write(text: string) {
        chunks.push(text);
        return true;
      },
    } as unknown as NodeJS.WritableStream,
    text: () => chunks.join(""),
  };
}

export function observingCoordinator(
  observations: string[][] = [],
): ResourceCoordinator {
  return {
    async observeResources(paths) {
      return paths.map((resource) => ({
        resource,
        state: "idle" as const,
        markerIdentity: "",
      }));
    },
    async withResources(paths, action) {
      observations.push([...paths]);
      return await action();
    },
  };
}

export function successfulNonzeroResult<T>(
  operation: string,
  result: T,
): AdapterResult<T> {
  return {
    status: 1,
    outcome: {
      operation,
      ok: true,
      messages: [],
      result,
      error: null,
    },
  };
}

function preserveFailure<T>(result: AdapterResult): AdapterResult<T> {
  assert.equal(result.outcome.ok, false);
  return { status: result.status, outcome: result.outcome };
}

export function scriptedAdapter(responses: readonly AdapterResult[]) {
  // A fingerprint/ownership/control triple describes one stable probe. Supply
  // its independent closing observations explicitly, without consuming the
  // subsequent mutation-stage responses. Preserve their complete adapter
  // responses; gatherProbe decides which successful observation messages are
  // operator-facing.
  const expanded: AdapterResult[] = [];
  for (let offset = 0; offset < responses.length; offset += 1) {
    const first = responses[offset]!;
    const ownership = responses[offset + 1];
    const control = responses[offset + 2];
    const field = (response: AdapterResult | undefined, name: string) =>
      response?.outcome.ok &&
      response.outcome.result !== null &&
      typeof response.outcome.result === "object" &&
      name in response.outcome.result;
    if (
      field(first, "fingerprint") &&
      field(ownership, "identity_state") &&
      field(control, "update_control")
    ) {
      expanded.push(first, ownership!, control!, first, control!);
      offset += 2;
    } else expanded.push(first);
  }
  const calls: HarnessCall[] = [];
  let index = 0;
  const record = (operation: string, input?: unknown): void => {
    calls.push(input === undefined ? { operation } : { operation, input });
  };
  const next = (operation: string): AdapterResult => {
    const response = expanded[index++];
    assert.ok(
      response !== undefined,
      `scriptedAdapter exhausted at response ${index} for ${operation}`,
    );
    return response;
  };
  const adapter: HarnessAdapter<CodexRemovalInput> = {
    preparationLocation(ctx) {
      record("preparation-location");
      return codexHarness.preparationLocation(ctx);
    },
    async mutationRoots(ctx) {
      record("mutation-roots");
      return await codexHarness.mutationRoots({
        ...ctx,
        env: { HOME: ctx.root, ...ctx.env },
      });
    },
    async validatePreparationBeforeFetch(ctx) {
      record("validate-preparation-before-fetch");
      return await codexHarness.validatePreparationBeforeFetch(ctx);
    },
    async prepareCandidate(input: PrepareCandidateInput) {
      record("prepare-candidate", input);
      const result = next("prepare-candidate");
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
      const artifact: PreparedArtifact = await writeQualifiedCodexFixture(
        input.candidateRoot,
        input.selection.desiredCommit,
        input.selection.effectiveSource,
      );
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
      return normalizeCodexOwnership(next("inspect-ownership"));
    },
    async inspectUpdateControl() {
      record("inspect-update-control");
      return normalizeCodexControl(next("inspect-update-control"));
    },
    async inspectInstalled(selection) {
      record("inspect-installed", selection);
      return normalizeCodexInstalled(
        next("inspect-installed"),
        selection.desiredCommit,
      );
    },
    async install(artifact, ctx) {
      record("install", artifact);
      return normalizeCodexInstallForContext(next("install"), ctx);
    },
    async remove(removalInput, ctx) {
      record("remove", removalInput);
      const result = next("remove");
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
    requirements(command: HarnessCommand, env: NodeJS.ProcessEnv) {
      record("requirements", command);
      return codexHarness.requirements(command, env);
    },
    presentation: codexHarness.presentation,
  };
  return { calls, adapter };
}

export function operationNames(calls: readonly HarnessCall[]): string[] {
  return calls.map((call) => call.operation);
}
