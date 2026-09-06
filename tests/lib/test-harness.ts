import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";

import { successResult } from "../../src/adapter-result.ts";
import { computeEffectiveSelection } from "../../src/effective-selection.ts";
import type {
  HarnessAdapter,
  HarnessPresentation,
  OwnershipInspection,
  PreparedArtifact,
} from "../../src/harness.ts";
import { capture } from "./command-doubles.ts";

export interface TestRemovalInput {
  readonly receipt: string;
}

const TEST_PRESENTATION: HarnessPresentation<TestRemovalInput> = {
  installNotice: "test install notice",
  currentNotice: "test current notice",
  renderProbe() {
    return { human: "", porcelain: "" };
  },
  renderInstallVerification() {
    return { stdout: [], stderr: [] };
  },
  renderRemovalCompletion() {
    return { stdout: [], stderr: [] };
  },
  callFailure() {
    return {
      unexpected: "unexpected test adapter call",
      invalidStatus: "invalid test adapter status",
    };
  },
};

export async function createHarnessFixture(t: TestContext) {
  const scratch = mkdtempSync(join(tmpdir(), "spw-harness-"));
  t.after(() => rmSync(scratch, { recursive: true, force: true }));

  const root = join(scratch, "package");
  const upstream = join(scratch, "upstream");
  const home = join(scratch, "home");
  const config = join(scratch, "config");
  const cache = join(scratch, "cache");
  for (const path of [root, upstream, home, config, cache]) {
    mkdirSync(path, { recursive: true });
  }

  const gitEnv = {
    PATH: process.env.PATH,
    HOME: join(scratch, "git-home"),
    GIT_CONFIG_GLOBAL: join(scratch, "gitconfig"),
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_AUTHOR_NAME: "Harness Fixture",
    GIT_AUTHOR_EMAIL: "harness@example.invalid",
    GIT_COMMITTER_NAME: "Harness Fixture",
    GIT_COMMITTER_EMAIL: "harness@example.invalid",
  };
  mkdirSync(gitEnv.HOME, { recursive: true });
  execFileSync("git", ["init", "--quiet", upstream], { env: gitEnv });
  writeFileSync(join(upstream, "payload.txt"), "fixture\n", "utf8");
  execFileSync("git", ["-C", upstream, "add", "payload.txt"], {
    env: gitEnv,
  });
  execFileSync("git", ["-C", upstream, "commit", "--quiet", "-m", "fixture"], {
    env: gitEnv,
  });
  const commit = execFileSync("git", ["-C", upstream, "rev-parse", "HEAD"], {
    encoding: "utf8",
    env: gitEnv,
  }).trim();

  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: home,
    SUPERPOWERS_CONFIG_DIR: config,
    SUPERPOWERS_CACHE_DIR: cache,
    SUPERPOWERS_UPSTREAM_URL: upstream,
    SUPERPOWERS_REF: commit,
  };
  const selection = await computeEffectiveSelection(root, env);
  assert.equal(selection.desiredCommit, commit);

  const calls: string[] = [];
  const destinationRoot = join(root, "artifacts", "fixture");
  const unexpected = (operation: string): never => {
    calls.push(operation);
    throw new Error(`unexpected test harness operation: ${operation}`);
  };
  const removalInput: TestRemovalInput = { receipt: "fixture" };
  const ownership: OwnershipInspection<TestRemovalInput> = {
    installEligibility: { kind: "allowed" },
    removalInput,
    removalVerification: { kind: "allowed" },
    postRemovalOutput: { stdout: [], stderr: [] },
    presentationValue: "fixture",
  };
  const adapter: HarnessAdapter<TestRemovalInput> = {
    preparationLocation() {
      calls.push("location");
      return { destinationRoot, stagingLeaf: "candidate" };
    },
    async validatePreparationBeforeFetch() {
      calls.push("prefetch");
      return successResult("prefetch", null, []);
    },
    async prepareCandidate(input) {
      calls.push("prepare");
      assert.deepEqual(input.selection, selection);
      mkdirSync(input.candidateRoot, { recursive: true });
      cpSync(
        join(input.upstreamRoot, "payload.txt"),
        join(input.candidateRoot, "payload.txt"),
      );
      const artifact: PreparedArtifact = {
        root: input.candidateRoot,
        commit: input.selection.desiredCommit,
      };
      return successResult("prepare", artifact, []);
    },
    async inspectPrepared() {
      return unexpected("inspect-prepared");
    },
    async readPrepared() {
      return unexpected("read-prepared");
    },
    async inspectOwnership() {
      calls.push("inspect-ownership");
      return successResult("inspect-ownership", ownership, []);
    },
    async inspectUpdateControl() {
      return unexpected("inspect-control");
    },
    async inspectInstalled() {
      return unexpected("inspect-installed");
    },
    async install() {
      return unexpected("install");
    },
    async remove() {
      return unexpected("remove");
    },
    requirements() {
      return unexpected("requirements");
    },
    presentation: TEST_PRESENTATION,
  };

  const out = capture();
  const err = capture();
  const ctx = {
    root,
    env,
    stdout: out.stream,
    stderr: err.stream,
    adapter,
  };
  return { ctx, calls, destinationRoot, selection, adapter, out, err };
}
