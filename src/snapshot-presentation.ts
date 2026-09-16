import type { HarnessPresentation } from "./harness.ts";

export function createSnapshotPresentation<R>(
  label: "Pi" | "OpenCode",
  renderProbe: HarnessPresentation<R>["renderProbe"],
  wasAbsent: (input: R) => boolean,
): HarnessPresentation<R> {
  return {
    installNotice: "",
    currentNotice: `The Superpowers ${label} snapshot is current.`,
    renderProbe,
    renderInstallVerification(_desired, receipt, inspection) {
      if (receipt.status !== 0 || !receipt.outcome.ok)
        return {
          stdout: [],
          stderr: [
            `error: ${label} activation did not return a verified installation receipt`,
          ],
        };
      if (inspection.status !== 0 || !inspection.outcome.ok)
        return receipt.outcome.result.missingVerificationOutput;
      if (inspection.outcome.result.kind === "current")
        return {
          stdout: [
            `Installed the frozen Superpowers ${label} snapshot. Restart ${label} to load it.`,
          ],
          stderr: [],
        };
      return inspection.outcome.result.kind === "absent"
        ? receipt.outcome.result.missingVerificationOutput
        : receipt.outcome.result.mismatchVerificationOutput;
    },
    renderRemovalCompletion(_ownership, input) {
      return {
        stdout: [
          wasAbsent(input)
            ? `No managed Superpowers ${label} installation is present.`
            : `Removed the managed Superpowers ${label} installation. Restart ${label} to load the resulting state.`,
        ],
        stderr: [],
      };
    },
    callFailure(site) {
      return {
        unexpected: `${label} ${site} did not complete`,
        invalidStatus: `${label} ${site} returned an invalid status`,
      };
    },
  };
}
