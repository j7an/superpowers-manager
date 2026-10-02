import type { HarnessPresentation } from "../../harness.ts";
import { displaySource } from "../../selection.ts";
import {
  createSnapshotPresentation,
  probeOutput,
} from "../../snapshot-presentation.ts";
import { displayPath } from "../../validator.ts";
import type { HermesRemovalInput } from "./state.ts";

const renderProbe: HarnessPresentation<HermesRemovalInput>["renderProbe"] = (
  facts,
) => {
  const fields = [
    ["harness", "hermes"],
    ["desired_commit", facts.selection.desiredCommit],
    ["upstream_source_origin", facts.selection.upstreamSourceOrigin],
    ["effective_source", displaySource(facts.selection.effectiveSource)],
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
  ].map(([key, value]) => [key, displayPath(value)] as const);
  return probeOutput(fields);
};

export const hermesPresentation = createSnapshotPresentation(
  "Hermes",
  renderProbe,
  (input) => input.ownership === "absent",
);
