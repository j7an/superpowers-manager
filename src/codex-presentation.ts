import type { AdapterResult } from "./adapter-result.ts";
import {
  normalizeCodexInstall,
  normalizeCodexInstalled,
} from "./codex-harness.ts";
import { displaySource } from "./selection.ts";
import type {
  FailureSite,
  HarnessPresentation,
  InstallReceipt,
  Output,
  ProbeSnapshot,
} from "./harness.ts";
import type { AdapterContext } from "./adapter-result.ts";
import type { CodexRemovalInput } from "./adapter.ts";

export interface ProbeFacts {
  readonly requestedRef: string;
  readonly resolvedRef: string;
  readonly desiredCommit: string;
  readonly generatedCommit: string;
  readonly installedCommit: string;
  readonly identityState: string;
  readonly status: string;
  readonly selectionOrigin: string;
  readonly selectionMode: string;
  readonly upstreamSourceOrigin: string;
  readonly effectiveSource: string;
  readonly savedMode: string;
  readonly savedSource: string;
  readonly savedRequestedRef: string;
  readonly savedResolvedRef: string;
  readonly savedCommit: string;
  readonly updateControl: string;
}

interface Field {
  readonly key: string;
  readonly label: string;
  readonly value: string;
  readonly absent?: string;
}

// One ordered table drives both formats, preserving the public human and
// porcelain field order exposed through the harness presentation.
export function fields(f: ProbeFacts): readonly Field[] {
  return [
    { key: "requested_ref", label: "requested ref", value: f.requestedRef },
    { key: "resolved_ref", label: "resolved ref", value: f.resolvedRef },
    { key: "desired_commit", label: "desired commit", value: f.desiredCommit },
    {
      key: "generated_commit",
      label: "generated plugin commit",
      value: f.generatedCommit,
      absent: "not present",
    },
    {
      key: "installed_commit",
      label: "installed manager commit or fingerprint",
      value: f.installedCommit,
      absent: "not detected",
    },
    {
      key: "identity_state",
      label: "Codex identity state",
      value: f.identityState,
    },
    { key: "status", label: "status", value: f.status },
    {
      key: "selection_origin",
      label: "selection origin",
      value: f.selectionOrigin,
    },
    { key: "selection_mode", label: "selection mode", value: f.selectionMode },
    {
      key: "upstream_source_origin",
      label: "upstream source origin",
      value: f.upstreamSourceOrigin,
    },
    {
      key: "effective_source",
      label: "effective source",
      value: f.effectiveSource,
    },
    { key: "saved_mode", label: "saved mode", value: f.savedMode },
    { key: "saved_source", label: "saved source", value: f.savedSource },
    {
      key: "saved_requested_ref",
      label: "saved requested ref",
      value: f.savedRequestedRef,
    },
    {
      key: "saved_resolved_ref",
      label: "saved resolved ref",
      value: f.savedResolvedRef,
    },
    { key: "saved_commit", label: "saved commit", value: f.savedCommit },
    { key: "update_control", label: "update control", value: f.updateControl },
  ];
}

const NO_FACTS: ProbeFacts = {
  requestedRef: "",
  resolvedRef: "",
  desiredCommit: "",
  generatedCommit: "",
  installedCommit: "",
  identityState: "",
  status: "",
  selectionOrigin: "",
  selectionMode: "",
  upstreamSourceOrigin: "",
  effectiveSource: "",
  savedMode: "",
  savedSource: "",
  savedRequestedRef: "",
  savedResolvedRef: "",
  savedCommit: "",
  updateControl: "",
};

export const PROBE_PORCELAIN_KEYS: readonly string[] = fields(NO_FACTS).map(
  (field) => field.key,
);

export function formatPorcelain(f: ProbeFacts): string {
  return fields(f)
    .map((field) => `${field.key}=${field.value}\n`)
    .join("");
}

export function formatHuman(f: ProbeFacts): string {
  let text = fields(f)
    .map((field) => {
      const shown =
        field.value.length === 0 && field.absent !== undefined
          ? field.absent
          : field.value;
      return `${field.label}: ${shown}\n`;
    })
    .join("");
  if (f.selectionOrigin !== f.upstreamSourceOrigin) {
    text +=
      "warning: effective ref and source have mixed origins " +
      `(ref: ${f.selectionOrigin}, source: ${f.upstreamSourceOrigin})\n`;
  }
  return text;
}

export type FingerprintVerdict =
  | {
      readonly ok: true;
      readonly stdout: readonly string[];
      readonly stderr: readonly string[];
    }
  | {
      readonly ok: false;
      readonly stdout: readonly string[];
      readonly stderr: readonly string[];
    };

function verificationOutput(
  kind: "missing" | "mismatch",
  hint: string,
): Output {
  const stderr = [
    kind === "mismatch"
      ? "error: installed manager fingerprint does not match the prepared plugin after install."
      : "error: installed manager fingerprint is not detectable after install.",
  ];
  if (hint.length > 0) stderr.push(`hint: ${hint}`);
  return { stdout: [], stderr };
}

export function codexInstallReceipt(
  missingHint: string,
  mismatchHint: string,
): InstallReceipt {
  return {
    missingVerificationOutput: verificationOutput("missing", missingHint),
    mismatchVerificationOutput: verificationOutput("mismatch", mismatchHint),
  };
}

// Compatibility export target for src/lifecycle.ts. Delegate to the production
// normalizers and renderer so the retained verdict cannot drift from commands.
export function verifyInstalledFingerprint(
  desiredCommit: string,
  installResult: AdapterResult,
  inspectResult: AdapterResult,
): FingerprintVerdict {
  const receipt = normalizeCodexInstall(installResult);
  const inspection = normalizeCodexInstalled(inspectResult, desiredCommit);
  const output = codexPresentation.renderInstallVerification(
    desiredCommit,
    receipt,
    inspection,
  );
  const ok =
    inspection.status === 0 &&
    inspection.outcome.ok &&
    inspection.outcome.result.kind === "current";
  return { ok, stdout: output.stdout, stderr: output.stderr };
}

function probeFacts(facts: ProbeSnapshot<CodexRemovalInput>): ProbeFacts {
  const selection = facts.selection;
  const saved = selection.saved;
  return {
    requestedRef: selection.requestedRef,
    resolvedRef: selection.resolvedRef,
    desiredCommit: selection.desiredCommit,
    generatedCommit: facts.prepared.observedIdentity,
    installedCommit: facts.installed.observedIdentity,
    identityState: facts.ownership.presentationValue,
    status: facts.status,
    selectionOrigin: selection.selectionOrigin,
    selectionMode: selection.selectionMode,
    upstreamSourceOrigin: selection.upstreamSourceOrigin,
    effectiveSource: displaySource(selection.effectiveSource),
    savedMode: saved.saved_mode,
    savedSource:
      saved.saved_source.length > 0 ? displaySource(saved.saved_source) : "",
    savedRequestedRef: saved.saved_requested_ref,
    savedResolvedRef: saved.saved_resolved_ref,
    savedCommit: saved.saved_commit,
    updateControl: facts.control.presentationValue,
  };
}

function invocationFailure(argv: string) {
  return {
    unexpected: `cannot invoke Codex adapter for ${argv}`,
    invalidStatus: `adapter reported a failure status for ${argv}`,
  };
}

function callFailure(
  site: FailureSite,
  ctx: AdapterContext,
  removalInput?: CodexRemovalInput,
): { unexpected: string; invalidStatus: string } {
  switch (site) {
    case "prepare":
      return {
        unexpected: "cannot build the generated plugin candidate",
        invalidStatus: "adapter reported failure without an error outcome",
      };
    case "probe-installed":
      return {
        unexpected: "cannot inspect Codex adapter state for view fingerprint",
        invalidStatus:
          "adapter reported a failure status for inspect --view fingerprint",
      };
    case "probe-ownership":
      return {
        unexpected: "cannot inspect Codex adapter state for view ownership",
        invalidStatus:
          "adapter reported a failure status for inspect --view ownership",
      };
    case "probe-control":
      return {
        unexpected:
          "cannot inspect Codex adapter state for view update-control",
        invalidStatus:
          "adapter reported a failure status for inspect --view update-control",
      };
    case "install-ownership":
    case "remove-ownership":
    case "post-remove":
      return invocationFailure("inspect --view ownership");
    case "install-control":
      return invocationFailure("inspect --view update-control");
    case "install":
      return invocationFailure(`install --package-root ${ctx.root}`);
    case "post-install":
      return {
        unexpected:
          "cannot invoke Codex adapter for inspect --view fingerprint",
        invalidStatus:
          "installed manager fingerprint inspection failed after install.",
      };
    case "remove": {
      const input = removalInput ?? {
        pluginPresent: false,
        marketplacePresent: false,
      };
      return invocationFailure(
        `uninstall --plugin-present ${String(input.pluginPresent)}` +
          ` --marketplace-present ${String(input.marketplacePresent)}`,
      );
    }
  }
}

export const codexPresentation: HarnessPresentation<CodexRemovalInput> = {
  installNotice:
    "Note: remove or disable conflicting Superpowers providers yourself before" +
    " relying on manager skills.",
  currentNotice: "manager is current",
  renderProbe(snapshot) {
    const facts = probeFacts(snapshot);
    const conflicts = snapshot.ownership.presentationConflicts ?? [];
    return {
      human:
        formatHuman(facts) +
        conflicts
          .map((conflict) => `ownership conflict: ${conflict}\n`)
          .join(""),
      porcelain:
        formatPorcelain(facts) +
        conflicts
          .map((conflict) => `ownership_conflict=${conflict}\n`)
          .join(""),
    };
  },
  renderInstallVerification(desiredCommit, receipt, inspection) {
    if (inspection.status !== 0 || !inspection.outcome.ok) {
      const malformed =
        !inspection.outcome.ok &&
        inspection.outcome.error.code === "malformed-result";
      return {
        stdout: [],
        stderr: [
          malformed
            ? "error: cannot parse installed manager fingerprint inspection result after install."
            : "error: installed manager fingerprint inspection failed after install.",
        ],
      };
    }
    const observed = inspection.outcome.result.observedIdentity;
    const stdout = [
      `desired_commit=${desiredCommit}`,
      `installed_commit=${observed}`,
    ];
    if (inspection.outcome.result.kind === "current") {
      return { stdout: [...stdout, "manager updated"], stderr: [] };
    }
    if (receipt.status !== 0 || !receipt.outcome.ok) {
      return {
        stdout,
        stderr: [
          inspection.outcome.result.kind === "absent"
            ? "error: installed manager fingerprint is not detectable after install."
            : "error: installed manager fingerprint does not match the prepared plugin after install.",
        ],
      };
    }
    const output =
      inspection.outcome.result.kind === "absent"
        ? receipt.outcome.result.missingVerificationOutput
        : receipt.outcome.result.mismatchVerificationOutput;
    return { stdout, stderr: output.stderr };
  },
  renderRemovalCompletion(ownership) {
    return {
      stdout: [
        ...ownership.postRemovalOutput.stdout,
        "uninstall complete",
        "note: local generated artifacts under plugins/superpowers/ and " +
          ".cache/upstream/ were left in place; remove them manually or " +
          "regenerate with npx superpowers-manager prepare.",
      ],
      stderr: ownership.postRemovalOutput.stderr,
    };
  },
  callFailure,
};
