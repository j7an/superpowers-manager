// Ported from scripts/core/lifecycle.sh. Every function here is PURE: it
// returns its verdict as data and writes nothing. The command modules do the
// writing.
//
// That shape is not stylistic. src/commands/probe.ts's gatherProbe established
// it because a write inside a try can raise EPIPE, be caught by that try, and
// be relabelled as a domain failure. Keeping the predicates write-free means
// the hazard cannot exist here at all.

import type { Decision, OwnershipInspection } from "../../harness.ts";
import type { CodexRemovalInput } from "./adapter.ts";

// The four states the adapter derives from native plugin and marketplace
// presence (src/harnesses/codex/adapter.ts, ownershipFromResources).
export type CodexIdentityState = "neither" | "manager" | "legacy" | "both";

// Frozen text, from
// `git show ad56569a4c161e7b122967442e2b026eeb6395f6:scripts/core/lifecycle.sh:50-53::'Legacy superpowers-wrapper Codex state is`.
// The version in the second line is a historical package coordinate an operator
// must type verbatim, not a reference to this package's current version — do not
// derive it.
const BLOCKED_LINES: readonly string[] = [
  "Legacy superpowers-wrapper Codex state is installed.",
  "Run: npx superpowers-wrapper@0.1.1 uninstall",
  "Then run: npx superpowers-manager install",
];

// Frozen text, from
// `git show ad56569a4c161e7b122967442e2b026eeb6395f6:scripts/core/lifecycle.sh:75-77::remains`.
// Two lines, not three: the report path does not tell the operator to re-install.
const REPORT_LINES: readonly string[] = [
  "Legacy superpowers-wrapper Codex state remains installed.",
  "Run: npx superpowers-wrapper@0.1.1 uninstall",
];

function blocked(stderr: readonly string[]): Decision {
  return { kind: "blocked", output: { stdout: [], stderr } };
}

export function codexOwnershipInspection(
  identityState: CodexIdentityState,
  removalInput: CodexRemovalInput,
  conflicts: readonly string[],
): OwnershipInspection<CodexRemovalInput> {
  const legacy = identityState === "legacy" || identityState === "both";
  const { pluginPresent, marketplacePresent } = removalInput;
  const installEligibility: Decision = legacy
    ? blocked(BLOCKED_LINES)
    : conflicts.length > 0
      ? blocked([
          "Conflicting unmanaged Superpowers Codex resources require manual resolution:",
          ...conflicts.map((conflict) => `- ${conflict}`),
          "Remove or disable each resource manually, then retry.",
        ])
      : { kind: "allowed" };
  const removalVerification: Decision =
    pluginPresent || marketplacePresent
      ? blocked([
          pluginPresent
            ? "error: owned plugin resource is still installed after removal"
            : "error: owned marketplace resource is still registered after removal",
        ])
      : { kind: "allowed" };
  return {
    installEligibility,
    removalInput,
    removalVerification,
    postRemovalOutput: legacy
      ? { stdout: REPORT_LINES, stderr: [] }
      : { stdout: [], stderr: [] },
    presentationValue: identityState,
    presentationConflicts: conflicts,
  };
}
