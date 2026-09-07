import type { HarnessPresentation } from "./harness.ts";
import type { PiRemovalInput } from "./pi-state.ts";

export const piPresentation: HarnessPresentation<PiRemovalInput> = {
  installNotice:
    "Installed the frozen Superpowers Pi snapshot. Restart Pi to load it.",
  currentNotice: "The Superpowers Pi snapshot is current.",
  renderProbe(facts) {
    const fields = [
      ["harness", "pi"],
      ["desired_commit", facts.selection.desiredCommit],
      ["prepared_identity", facts.prepared.observedIdentity],
      ["installed_identity", facts.installed.observedIdentity],
      ["installation_state", facts.installed.kind],
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
          "error: Pi activation did not return a verified installation receipt",
        ],
      };
    if (inspection.status !== 0 || !inspection.outcome.ok)
      return receipt.outcome.result.missingVerificationOutput;
    if (inspection.outcome.result.kind === "current")
      return { stdout: [], stderr: [] };
    return inspection.outcome.result.kind === "absent"
      ? receipt.outcome.result.missingVerificationOutput
      : receipt.outcome.result.mismatchVerificationOutput;
  },
  renderRemovalCompletion(ownership) {
    return ownership.removalInput.receiptDigest === null &&
      ownership.removalInput.registrationIdentity === null
      ? {
          stdout: ["No managed Superpowers Pi installation is present."],
          stderr: [],
        }
      : {
          stdout: [
            "Removed the managed Superpowers Pi installation. Restart Pi to load the resulting state.",
          ],
          stderr: [],
        };
  },
  callFailure(site) {
    return {
      unexpected: `Pi ${site} did not complete`,
      invalidStatus: `Pi ${site} returned an invalid status`,
    };
  },
};
