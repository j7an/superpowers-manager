import type { HarnessPresentation } from "../../harness.ts";
import type { OpenCodeRemovalInput } from "./state.ts";

export const openCodePresentation: HarnessPresentation<OpenCodeRemovalInput> = {
  installNotice: "",
  currentNotice: "The Superpowers OpenCode snapshot is current.",
  renderProbe(facts) {
    const fields = [
      ["harness", "opencode"],
      ["desired_commit", facts.selection.desiredCommit],
      ["prepared_identity", facts.prepared.observedIdentity],
      ["installed_identity", facts.installed.observedIdentity],
      ["installation_state", facts.installed.kind],
      ["resource_state", facts.resourceState ?? "idle"],
      ["ownership", facts.ownership.presentationValue],
      ["conflicts", (facts.ownership.presentationConflicts ?? []).join("; ")],
      ["update_control", facts.control.presentationValue],
      ["compatibility", facts.compatibility.kind],
      ["compatibility_reason", facts.compatibility.reason],
      ["status", facts.status],
    ] as const;
    return {
      human: fields
        .map(
          ([key, value]) =>
            `${key.replaceAll("_", " ")}: ${value || "not present"}\n`,
        )
        .join(""),
      porcelain: fields.map(([key, value]) => `${key}=${value}\n`).join(""),
    };
  },
  renderInstallVerification(_desiredCommit, receipt, inspection) {
    if (receipt.status !== 0 || !receipt.outcome.ok)
      return {
        stdout: [],
        stderr: [
          "error: OpenCode activation did not return a verified installation receipt",
        ],
      };
    if (inspection.status !== 0 || !inspection.outcome.ok)
      return receipt.outcome.result.missingVerificationOutput;
    if (inspection.outcome.result.kind === "current")
      return {
        stdout: [
          "Installed the frozen Superpowers OpenCode snapshot. Restart OpenCode to load it.",
        ],
        stderr: [],
      };
    return inspection.outcome.result.kind === "absent"
      ? receipt.outcome.result.missingVerificationOutput
      : receipt.outcome.result.mismatchVerificationOutput;
  },
  renderRemovalCompletion(_ownership, removalInput) {
    return removalInput.receiptDigest === null &&
      removalInput.registration === null
      ? {
          stdout: ["No managed Superpowers OpenCode installation is present."],
          stderr: [],
        }
      : {
          stdout: [
            "Removed the managed Superpowers OpenCode installation. Restart OpenCode to load the resulting state.",
          ],
          stderr: [],
        };
  },
  callFailure(site) {
    return {
      unexpected: `OpenCode ${site} did not complete`,
      invalidStatus: `OpenCode ${site} returned an invalid status`,
    };
  },
};
