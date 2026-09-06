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
  InstallReceipt,
  InstalledState,
  OwnershipInspection,
  PreparedArtifact,
  PreparedState,
  UpdateControlInspection,
} from "../../src/harness.ts";
import { capture } from "./command-doubles.ts";

export interface TestRemovalInput {
  readonly receipt: string;
}

const TEST_PRESENTATION: HarnessPresentation<TestRemovalInput> = {
  installNotice: "test install notice",
  currentNotice: "test current notice",
  renderProbe(facts) {
    return {
      human: `fixture status ${facts.status}\n`,
      porcelain: `status=${facts.status}\n`,
    };
  },
  renderInstallVerification(desiredCommit, _receipt, inspection) {
    if (inspection.status !== 0 || !inspection.outcome.ok) {
      return {
        stdout: [],
        stderr: ["error: fixture post-install inspection failed"],
      };
    }
    if (inspection.outcome.result.kind === "absent") {
      return {
        stdout: [],
        stderr: ["error: fixture installation is absent"],
      };
    }
    if (inspection.outcome.result.kind === "mismatch") {
      return {
        stdout: [],
        stderr: ["error: fixture installation is mismatched"],
      };
    }
    return { stdout: [`fixture installed ${desiredCommit}`], stderr: [] };
  },
  renderRemovalCompletion(ownership) {
    return {
      stdout: [
        ...ownership.postRemovalOutput.stdout,
        "fixture uninstall complete",
      ],
      stderr: ownership.postRemovalOutput.stderr,
    };
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
  const preparedArtifact: PreparedArtifact = {
    root: destinationRoot,
    commit: selection.desiredCommit,
  };
  const prepared: PreparedState = {
    kind: "current",
    artifact: preparedArtifact,
    observedIdentity: selection.desiredCommit,
  };
  const installed: InstalledState = {
    kind: "current",
    observedIdentity: selection.desiredCommit,
  };
  const control: UpdateControlInspection = {
    probeEligibility: { kind: "allowed" },
    mutationEligibility: { kind: "allowed" },
    presentationValue: "fixture",
  };
  const installReceipt: InstallReceipt = {
    missingVerificationOutput: {
      stdout: [],
      stderr: ["error: fixture installation is absent"],
    },
    mismatchVerificationOutput: {
      stdout: [],
      stderr: ["error: fixture installation is mismatched"],
    },
  };
  const removalInputs: TestRemovalInput[] = [];

  // These are opt-in method replacements for the strict adapter below. Each
  // records the real boundary call and returns one typed response. Tests spread
  // only the methods their scenario permits, so an unexpected call still
  // throws instead of inheriting a catch-all success default.
  const methods: Pick<
    HarnessAdapter<TestRemovalInput>,
    | "inspectPrepared"
    | "readPrepared"
    | "inspectOwnership"
    | "inspectUpdateControl"
    | "inspectInstalled"
    | "install"
    | "remove"
  > = {
    inspectPrepared: async (inputSelection) => {
      calls.push("inspect-prepared");
      assert.deepEqual(inputSelection, selection);
      return successResult("inspect-prepared", prepared, []);
    },
    readPrepared: async () => {
      calls.push("read-prepared");
      return successResult("read-prepared", preparedArtifact, []);
    },
    inspectOwnership: async () => {
      calls.push("inspect-ownership");
      return successResult("inspect-ownership", ownership, []);
    },
    inspectUpdateControl: async () => {
      calls.push("inspect-control");
      return successResult("inspect-control", control, []);
    },
    inspectInstalled: async (inputSelection) => {
      calls.push("inspect-installed");
      assert.deepEqual(inputSelection, selection);
      return successResult("inspect-installed", installed, []);
    },
    install: async (artifact) => {
      calls.push("install");
      assert.deepEqual(artifact, preparedArtifact);
      return successResult("install", installReceipt, []);
    },
    remove: async (input) => {
      calls.push("remove");
      removalInputs.push(input);
      return successResult("remove", null, []);
    },
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
  return {
    ctx,
    calls,
    destinationRoot,
    selection,
    adapter,
    methods,
    preparedArtifact,
    ownership,
    control,
    installed,
    installReceipt,
    removalInput,
    removalInputs,
    out,
    err,
  };
}
