import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { readArtifactFile } from "../../artifact-tree.ts";
import {
  inspectionFailure,
  successResult,
  type AdapterContext,
  type AdapterResult,
} from "../../adapter-result.ts";
import type { EffectiveSelection } from "../../effective-selection.ts";
import type {
  Decision,
  InstalledState,
  OwnershipInspection,
  UpdateControlInspection,
} from "../../harness.ts";
import {
  canonicalizeProspectivePath,
  classifyPathNoFollow,
} from "../../safe-path.ts";
import {
  observeSnapshot,
  sameSnapshotSource,
  type SnapshotObservation,
} from "../../snapshot-package.ts";
import { displayPath } from "../../validator.ts";
import {
  readClaudeCodeState,
  runClaude,
  type ClaudeCodeNativeState,
  type ClaudeCodePlugin,
  type RunClaude,
} from "./native.ts";
import {
  assertClaudeCodeStorageSafe,
  claudeCodePaths,
  type ClaudeCodePaths,
} from "./paths.ts";
import {
  expectedClaudeCodeVersion,
  readClaudeCodeManifestVersion,
  readClaudeCodePackageAssessment,
  readClaudeCodeReceipt,
  type ClaudeCodeReceipt,
} from "./prepare.ts";

export const CLAUDE_CODE_MARKETPLACE = "superpowers-manager";
export const CLAUDE_CODE_PLUGIN_ID = "superpowers@superpowers-manager";
export const CLAUDE_CODE_MARKETPLACE_BYTES = Buffer.from(
  JSON.stringify({
    name: CLAUDE_CODE_MARKETPLACE,
    owner: { name: CLAUDE_CODE_MARKETPLACE },
    plugins: [{ name: "superpowers", source: "./plugins/superpowers" }],
  }) + "\n",
);
const SYNCED_ID = "superpowers@synced";
const DISPLAYABLE_ID = /^superpowers@[A-Za-z0-9][A-Za-z0-9._-]{0,200}$/;

export type MarketplaceRegistration = "absent" | "owned" | "foreign";

export interface ClaudeCodeRemovalInput {
  readonly registration: MarketplaceRegistration;
  readonly pluginInstalled: boolean;
  readonly published: boolean;
}

interface Facts {
  readonly paths: ClaudeCodePaths;
  readonly registration: MarketplaceRegistration;
  readonly marketplaceSource:
    { source: string; path: string | null } | undefined;
  readonly plugin: ClaudeCodePlugin | undefined;
  readonly conflicts: readonly string[];
  readonly snapshot: SnapshotObservation<ClaudeCodeReceipt>;
  readonly published: boolean;
}

function blocked(...stderr: string[]): Decision {
  return {
    kind: "blocked",
    output: { stdout: [], stderr: stderr.map((line) => displayPath(line)) },
  };
}

function pathsFor(ctx: AdapterContext): ClaudeCodePaths {
  return claudeCodePaths(ctx.env ?? {}, process.cwd());
}

export async function marketplaceRegistration(
  native: ClaudeCodeNativeState,
  paths: ClaudeCodePaths,
): Promise<MarketplaceRegistration> {
  const entries = native.marketplaces.filter(
    (entry) => entry.name === CLAUDE_CODE_MARKETPLACE,
  );
  if (entries.length === 0) return "absent";
  if (entries.length > 1) throw new Error("ambiguous Claude Code marketplace");
  const entry = entries[0]!;
  if (entry.source !== "directory" || entry.path === null) return "foreign";
  return (await canonicalizeProspectivePath(entry.path)) ===
    (await canonicalizeProspectivePath(paths.marketplaceRoot))
    ? "owned"
    : "foreign";
}

export function managerPlugin(
  native: ClaudeCodeNativeState,
): ClaudeCodePlugin | undefined {
  const entries = native.plugins.filter(
    (plugin) => plugin.id === CLAUDE_CODE_PLUGIN_ID && plugin.scope === "user",
  );
  if (entries.length > 1) throw new Error("ambiguous Claude Code plugin");
  return entries[0];
}

// An unregistered directory is removable only when every entry is part of
// the Manager's marketplace layout. Empty known directories are safe crash
// residue; a present snapshot must have a valid Manager receipt and digest.
export async function inspectClaudeCodeMarketplaceStorage(
  paths: ClaudeCodePaths,
): Promise<"absent" | "owned" | "recovery" | "unverified"> {
  const rootKind = await classifyPathNoFollow(paths.marketplaceRoot);
  if (rootKind === "missing") return "absent";
  if (rootKind !== "directory") return "unverified";
  try {
    await assertClaudeCodeStorageSafe(paths);
    // Probe must present recovery before judging a crash leftover's contents.
    // Mutation paths still refuse these siblings before any native call.
    if ((await leftoverPublicationMaterial(paths)).length > 0)
      return "recovery";
    const known = (entries: string[], allowed: readonly string[]) =>
      entries.every((entry) => allowed.includes(entry));
    if (
      !known(await readdir(paths.marketplaceRoot), [
        ".claude-plugin",
        "plugins",
      ])
    )
      return "unverified";
    const metadataRoot = join(paths.marketplaceRoot, ".claude-plugin");
    if ((await classifyPathNoFollow(metadataRoot)) !== "missing") {
      if (!known(await readdir(metadataRoot), ["marketplace.json"]))
        return "unverified";
    }
    const manifestKind = await classifyPathNoFollow(paths.marketplaceManifest);
    if (manifestKind !== "missing") {
      if (
        manifestKind !== "regular-file" ||
        !(
          await readArtifactFile(
            paths.marketplaceRoot,
            paths.marketplaceManifest,
            CLAUDE_CODE_MARKETPLACE_BYTES.length,
          )
        ).equals(CLAUDE_CODE_MARKETPLACE_BYTES)
      )
        return "unverified";
    }
    if ((await classifyPathNoFollow(paths.pluginsRoot)) !== "missing") {
      if (!known(await readdir(paths.pluginsRoot), ["superpowers"]))
        return "unverified";
      if ((await classifyPathNoFollow(paths.pluginRoot)) !== "missing") {
        const snapshot = await observeSnapshot<ClaudeCodeReceipt>(
          paths.pluginRoot,
          readClaudeCodeReceipt,
        );
        if (snapshot.kind !== "owned") return "unverified";
      }
    }
    return "owned";
  } catch {
    return "unverified";
  }
}

// A synced copy is reported as not loaded whenever another origin provides the
// same name, so it never duplicates the Manager plugin.
function conflicts(native: ClaudeCodeNativeState): string[] {
  return native.plugins
    .filter(
      (plugin) =>
        plugin.enabled &&
        plugin.id.startsWith("superpowers@") &&
        plugin.id !== CLAUDE_CODE_PLUGIN_ID &&
        plugin.id !== SYNCED_ID,
    )
    .map((plugin) =>
      DISPLAYABLE_ID.test(plugin.id)
        ? plugin.id
        : "a Claude Code plugin with a non-displayable Superpowers identity",
    );
}

async function observeFacts(
  ctx: AdapterContext,
  run: RunClaude,
): Promise<Facts> {
  const paths = pathsFor(ctx);
  await assertClaudeCodeStorageSafe(paths);
  const native = await readClaudeCodeState(ctx, run);
  const [registration, snapshot, marketplaceKind] = await Promise.all([
    marketplaceRegistration(native, paths),
    observeSnapshot<ClaudeCodeReceipt>(paths.pluginRoot, readClaudeCodeReceipt),
    classifyPathNoFollow(paths.marketplaceRoot),
  ]);
  if (
    registration === "absent" &&
    marketplaceKind !== "missing" &&
    (await inspectClaudeCodeMarketplaceStorage(paths)) === "unverified"
  )
    throw new Error("unverified Claude Code marketplace storage");
  return {
    paths,
    registration,
    marketplaceSource: native.marketplaces.find(
      (entry) => entry.name === CLAUDE_CODE_MARKETPLACE,
    ),
    plugin: managerPlugin(native),
    conflicts: conflicts(native),
    snapshot,
    published: marketplaceKind !== "missing",
  };
}

function installDecision(facts: Facts): Decision {
  if (facts.registration === "foreign")
    return blocked(
      `error: a Claude Code marketplace named ${CLAUDE_CODE_MARKETPLACE} is registered from another source; remove it manually, then retry:`,
      `  source: ${facts.marketplaceSource?.source ?? "unknown"}; path: ${facts.marketplaceSource?.path ?? "unknown"}`,
      `  claude plugin marketplace remove ${CLAUDE_CODE_MARKETPLACE}`,
    );
  if (facts.conflicts.length > 0)
    return blocked(
      "error: another Superpowers Claude Code plugin is enabled; disable it manually, then retry:",
      ...facts.conflicts.map((id) =>
        DISPLAYABLE_ID.test(id) ? `  claude plugin disable ${id}` : `  ${id}`,
      ),
    );
  return { kind: "allowed" };
}

export async function inspectClaudeCodeOwnership(
  ctx: AdapterContext,
  run: RunClaude = runClaude,
): Promise<AdapterResult<OwnershipInspection<ClaudeCodeRemovalInput>>> {
  const operation = "inspect-claude-code-ownership";
  try {
    const facts = await observeFacts(ctx, run);
    if (facts.snapshot.kind === "unverified")
      throw new Error("unverified Manager snapshot");
    const removalVerification: Decision =
      facts.registration === "owned" || facts.plugin !== undefined
        ? blocked(
            "error: Claude Code still lists the Manager marketplace or plugin after removal",
          )
        : facts.published
          ? blocked(
              `error: the Manager-owned Claude Code marketplace is still present at ${facts.paths.marketplaceRoot}`,
            )
          : { kind: "allowed" };
    const presentationValue =
      facts.registration === "foreign"
        ? "foreign marketplace registration"
        : facts.snapshot.kind === "owned"
          ? facts.registration === "owned"
            ? `managed ${facts.snapshot.digest}`
            : `managed snapshot ${facts.snapshot.digest}`
          : facts.registration === "owned"
            ? "managed registration without a snapshot"
            : "absent";
    return successResult(
      operation,
      {
        installEligibility: installDecision(facts),
        removalInput: {
          registration: facts.registration,
          pluginInstalled: facts.plugin !== undefined,
          published: facts.published,
        },
        removalVerification,
        postRemovalOutput: { stdout: [], stderr: [] },
        presentationValue,
        presentationConflicts: facts.conflicts,
      },
      [],
    );
  } catch {
    return inspectionFailure(operation, "Claude Code ownership");
  }
}

export async function inspectClaudeCodeInstalled(
  selection: EffectiveSelection,
  ctx: AdapterContext,
  run: RunClaude = runClaude,
): Promise<AdapterResult<InstalledState>> {
  const operation = "inspect-claude-code-installed";
  let facts: Facts;
  try {
    facts = await observeFacts(ctx, run);
  } catch {
    return inspectionFailure(operation, "Claude Code installed state");
  }
  const mismatch = (observedIdentity: string) =>
    successResult<InstalledState>(
      operation,
      { kind: "mismatch", observedIdentity },
      [],
    );
  if (facts.snapshot.kind === "absent")
    return facts.registration === "absent" &&
      facts.plugin === undefined &&
      !facts.published
      ? successResult<InstalledState>(
          operation,
          { kind: "absent", observedIdentity: "" },
          [],
        )
      : mismatch("registered without an installed snapshot");
  if (facts.snapshot.kind === "unverified")
    return mismatch("unverified installed snapshot");
  const observed = facts.snapshot.digest;
  const plugin = facts.plugin;
  if (
    facts.registration !== "owned" ||
    plugin === undefined ||
    !plugin.enabled ||
    plugin.errorCount > 0 ||
    facts.conflicts.length > 0
  )
    return mismatch(observed);
  try {
    const prepared = await readClaudeCodePackageAssessment(
      facts.paths.preparedRoot,
    );
    if (
      prepared.compatibility.kind !== "supported" ||
      prepared.receipt.commit !== selection.desiredCommit ||
      !sameSnapshotSource(prepared.receipt.source, selection.effectiveSource) ||
      facts.snapshot.receipt.commit !== prepared.receipt.commit ||
      facts.snapshot.digest !== prepared.receipt.digest ||
      plugin.version !== expectedClaudeCodeVersion(selection) ||
      (await readClaudeCodeManifestVersion(facts.paths.pluginRoot)) !==
        expectedClaudeCodeVersion(selection)
    )
      return mismatch(observed);
  } catch {
    return mismatch(observed);
  }
  return successResult<InstalledState>(
    operation,
    { kind: "current", observedIdentity: observed },
    [],
  );
}

// Filesystem-only: any `.superpowers.*` sibling is a publication backup or a
// staging directory left by an interrupted install.
export async function leftoverPublicationMaterial(
  paths: ClaudeCodePaths,
): Promise<string[]> {
  if ((await classifyPathNoFollow(paths.pluginsRoot)) === "missing") return [];
  return (await readdir(paths.pluginsRoot))
    .filter((name) => name.startsWith(".superpowers."))
    .sort()
    .map((name) => join(paths.pluginsRoot, name));
}

export async function inspectClaudeCodeControl(
  ctx: AdapterContext,
): Promise<AdapterResult<UpdateControlInspection>> {
  const operation = "inspect-claude-code-control";
  try {
    const paths = pathsFor(ctx);
    await assertClaudeCodeStorageSafe(paths);
    const leftovers = await leftoverPublicationMaterial(paths);
    if (leftovers.length === 0)
      return successResult(
        operation,
        {
          probeEligibility: { kind: "allowed" },
          mutationEligibility: { kind: "allowed" },
          presentationValue: "clear",
        },
        [],
      );
    // Shared probe requires both decisions blocked whenever recovery is
    // required (`src/commands/probe.ts::function coherentControl`).
    const decision = blocked(
      "error: Claude Code recovery required; inspect and remove leftover publication material manually:",
      ...leftovers.map((path) => `  ${path}`),
    );
    return successResult(
      operation,
      {
        probeEligibility: decision,
        mutationEligibility: decision,
        presentationValue: `recovery required at ${leftovers.join(", ")}`,
        recoveryState: "required",
      },
      [],
    );
  } catch {
    return inspectionFailure(operation, "Claude Code update control");
  }
}
