import type { AdapterContext, AdapterResult } from "./adapter-result.ts";
import type { EffectiveSelection } from "./effective-selection.ts";
import type { Compatibility } from "./harness-compatibility.ts";

export type HarnessCommand =
  | "pin"
  | "track-latest"
  | "unpin"
  | "prepare"
  | "probe"
  | "install"
  | "update"
  | "uninstall";

export interface Output {
  readonly stdout: readonly string[];
  readonly stderr: readonly string[];
}

export type Decision =
  | { readonly kind: "allowed" }
  | { readonly kind: "blocked"; readonly output: Output };

export interface PreparationLocation {
  readonly destinationRoot: string;
  readonly stagingLeaf: string;
}

export interface PrepareCandidateInput {
  readonly upstreamRoot: string;
  readonly workspaceRoot: string;
  readonly candidateRoot: string;
  readonly selection: EffectiveSelection;
}

export interface PreparedArtifact {
  readonly root: string;
  readonly commit: string;
  readonly compatibility: Compatibility;
  readonly identity: string;
}

export type PreparedState =
  | {
      readonly kind: "needs-prepare";
      readonly observedIdentity: string;
      readonly compatibility: Compatibility;
    }
  | {
      readonly kind: "current";
      readonly artifact: PreparedArtifact;
      readonly observedIdentity: string;
      readonly compatibility: Compatibility;
    };

export type InstalledState =
  | { readonly kind: "absent"; readonly observedIdentity: "" }
  | { readonly kind: "mismatch"; readonly observedIdentity: string }
  | { readonly kind: "current"; readonly observedIdentity: string };

export interface OwnershipInspection<R> {
  readonly installEligibility: Decision;
  readonly removalInput: R;
  readonly removalVerification: Decision;
  readonly postRemovalOutput: Output;
  readonly presentationValue: string;
}

export interface UpdateControlInspection {
  readonly probeEligibility: Decision;
  readonly mutationEligibility: Decision;
  readonly presentationValue: string;
}

export interface InstallTransaction {
  finalize(): Promise<AdapterResult<null>>;
  rollback(): Promise<AdapterResult<null>>;
}

export interface InstallReceipt {
  readonly missingVerificationOutput: Output;
  readonly mismatchVerificationOutput: Output;
  readonly transaction?: InstallTransaction;
}

export interface ProbeSnapshot<R> {
  readonly selection: EffectiveSelection;
  readonly prepared: PreparedState;
  readonly installed: InstalledState;
  readonly ownership: OwnershipInspection<R>;
  readonly control: UpdateControlInspection;
  readonly compatibility: Compatibility;
  readonly status: "needs prepare" | "needs install" | "current";
}

export interface ToolRequirement {
  readonly name: string;
  readonly executable: string;
  readonly lookup: "path" | "explicit-path-or-path";
  readonly missingMessage: string;
}

export type FailureSite =
  | "prepare"
  | "probe-installed"
  | "probe-ownership"
  | "probe-control"
  | "install-ownership"
  | "install-control"
  | "install"
  | "post-install"
  | "remove-ownership"
  | "remove"
  | "post-remove";

export interface HarnessPresentation<R> {
  readonly installNotice: string;
  readonly currentNotice: string;
  renderProbe(facts: ProbeSnapshot<R>): { human: string; porcelain: string };
  renderInstallVerification(
    desiredCommit: string,
    receipt: AdapterResult<InstallReceipt>,
    inspection: AdapterResult<InstalledState>,
  ): Output;
  renderRemovalCompletion(ownership: OwnershipInspection<R>): Output;
  callFailure(
    site: FailureSite,
    ctx: AdapterContext,
    removalInput?: R,
  ): { unexpected: string; invalidStatus: string };
}

export interface HarnessAdapter<R> {
  preparationLocation(ctx: AdapterContext): PreparationLocation;
  mutationRoots(ctx: AdapterContext): Promise<readonly string[]>;
  validatePreparationBeforeFetch(
    ctx: AdapterContext,
  ): Promise<AdapterResult<null>>;
  prepareCandidate(
    input: PrepareCandidateInput,
    ctx: AdapterContext,
  ): Promise<AdapterResult<PreparedArtifact>>;
  inspectPrepared(
    selection: EffectiveSelection,
    ctx: AdapterContext,
  ): Promise<AdapterResult<PreparedState>>;
  readPrepared(ctx: AdapterContext): Promise<AdapterResult<PreparedArtifact>>;
  inspectOwnership(
    ctx: AdapterContext,
  ): Promise<AdapterResult<OwnershipInspection<R>>>;
  inspectUpdateControl(
    ctx: AdapterContext,
  ): Promise<AdapterResult<UpdateControlInspection>>;
  inspectInstalled(
    selection: EffectiveSelection,
    ctx: AdapterContext,
  ): Promise<AdapterResult<InstalledState>>;
  install(
    artifact: PreparedArtifact,
    ctx: AdapterContext,
  ): Promise<AdapterResult<InstallReceipt>>;
  remove(removalInput: R, ctx: AdapterContext): Promise<AdapterResult<null>>;
  requirements(
    command: HarnessCommand,
    env: NodeJS.ProcessEnv,
  ): readonly ToolRequirement[];
  readonly presentation: HarnessPresentation<R>;
}
