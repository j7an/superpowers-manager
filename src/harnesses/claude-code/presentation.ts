import type { HarnessPresentation } from "../../harness.ts";
import { displaySource } from "../../selection.ts";
import { createSnapshotPresentation } from "../../snapshot-presentation.ts";
import { displayPath } from "../../validator.ts";
import type { ClaudeCodeRemovalInput } from "./state.ts";

const renderProbe: HarnessPresentation<ClaudeCodeRemovalInput>["renderProbe"] =
  (facts) => {
    const fields = [
      ["harness", "claude-code"],
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
    return {
      human: fields
        .map(
          ([key, value]) =>
            `${key.replaceAll("_", " ")}: ${value || "not present"}\n`,
        )
        .join(""),
      porcelain: fields.map(([key, value]) => `${key}=${value}\n`).join(""),
    };
  };

export const claudeCodePresentation = createSnapshotPresentation(
  "Claude Code",
  renderProbe,
  (input) =>
    input.registration === "absent" &&
    !input.pluginInstalled &&
    !input.published,
);
