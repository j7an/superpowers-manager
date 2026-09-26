import type { HarnessPresentation } from "../../harness.ts";
import {
  createSnapshotPresentation,
  probeOutput,
} from "../../snapshot-presentation.ts";
import type { PiRemovalInput } from "./state.ts";

const renderProbe: HarnessPresentation<PiRemovalInput>["renderProbe"] = (
  facts,
) => {
  const fields = [
    ["harness", "pi"],
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
  return probeOutput(fields);
};

export const piPresentation = createSnapshotPresentation(
  "Pi",
  renderProbe,
  (input) =>
    input.receiptDigest === null && input.registrationIdentity === null,
);
