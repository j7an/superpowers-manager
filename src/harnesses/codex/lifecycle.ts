// Ported from scripts/core/lifecycle.sh. Every function here is PURE: it
// returns its verdict as data and writes nothing. The command modules do the
// writing.
//
// That shape is not stylistic. src/commands/probe.ts's gatherProbe established
// it because a write inside a try can raise EPIPE, be caught by that try, and
// be relabelled as a domain failure. Keeping the predicates write-free means
// the hazard cannot exist here at all.

import type {
  Decision,
  OwnershipInspection,
  UpdateControlInspection,
} from "../../harness.ts";
import type { CodexRemovalInput } from "./adapter.ts";

// A three-way verdict rather than a boolean, because the shell has two
// distinct failure paths and collapsing them changes operator-visible text:
//
//   legacy | both  ->
//     `git show ad56569a4c161e7b122967442e2b026eeb6395f6:scripts/core/lifecycle.sh:50-53::'Legacy superpowers-wrapper Codex state is`
//     prints three bare lines to stderr and returns 1. No `error: ` prefix.
//   anything else  -> :57 calls spw_die, which DOES add `error: ` and exits 1.
//
// `LegacyVerdict` needs a fourth arm for `reportLegacyState`'s non-fatal
// report. The union is extended rather than reusing `blocked`, because a
// caller must not treat a report as a stop.
export type LegacyVerdict =
  | { readonly kind: "ok" }
  | { readonly kind: "blocked"; readonly lines: readonly string[] }
  | { readonly kind: "report"; readonly lines: readonly string[] }
  | { readonly kind: "unknown"; readonly message: string };

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

function unknownState(identityState: string): LegacyVerdict {
  return {
    kind: "unknown",
    message: `unknown adapter identity state: ${identityState}`,
  };
}

// `git show ad56569a4c161e7b122967442e2b026eeb6395f6:scripts/core/lifecycle.sh:43-60::spw_require_no_legacy_state`
export function requireNoLegacyState(identityState: string): LegacyVerdict {
  if (identityState === "neither" || identityState === "manager") {
    return { kind: "ok" };
  }
  if (identityState === "legacy" || identityState === "both") {
    return { kind: "blocked", lines: BLOCKED_LINES };
  }
  return unknownState(identityState);
}

// Ported from
// `git show ad56569a4c161e7b122967442e2b026eeb6395f6:scripts/core/lifecycle.sh:72-85::spw_report_legacy_state`.
// Same enumeration, different disposition: this one reports and continues
// rather than blocking, so its clean arm and its legacy arm are both non-fatal.
export function reportLegacyState(identityState: string): LegacyVerdict {
  if (identityState === "neither" || identityState === "manager") {
    return { kind: "ok" };
  }
  if (identityState === "legacy" || identityState === "both") {
    return { kind: "report", lines: REPORT_LINES };
  }
  return unknownState(identityState);
}

interface Refusal {
  readonly ok: false;
  readonly message: string;
}
export type Check = { readonly ok: true } | Refusal;

// Ported from
// `git show ad56569a4c161e7b122967442e2b026eeb6395f6:scripts/core/lifecycle.sh:62-70::spw_require_managed_update_control`.
// Both refusals reached spw_die in the shell, so both carry the `error: ` prefix
// at the call site and neither is special.
export function requireManagedUpdateControl(value: string): Check {
  if (value === "managed") return { ok: true };
  if (value === "unsupported") {
    return {
      ok: false,
      message: "adapter cannot guarantee manager-controlled updates",
    };
  }
  return {
    ok: false,
    message: `unknown adapter update-control capability: ${value}`,
  };
}

function installDecision(legacy: LegacyVerdict): Decision {
  switch (legacy.kind) {
    case "ok":
      return { kind: "allowed" };
    case "blocked":
      return {
        kind: "blocked",
        output: { stdout: [], stderr: legacy.lines },
      };
    case "unknown":
      return {
        kind: "blocked",
        output: { stdout: [], stderr: [`error: ${legacy.message}`] },
      };
    case "report":
      return {
        kind: "blocked",
        output: {
          stdout: [],
          stderr: ["error: unexpected legacy report during installation"],
        },
      };
  }
}

export function codexOwnershipInspection(
  identityState: string,
  removalInput: CodexRemovalInput,
  conflicts: readonly string[],
): OwnershipInspection<CodexRemovalInput> {
  const { pluginPresent, marketplacePresent } = removalInput;
  const legacyEligibility: Decision =
    identityState.length === 0
      ? {
          kind: "blocked",
          output: {
            stdout: [],
            stderr: ["error: probe did not report adapter identity state"],
          },
        }
      : installDecision(requireNoLegacyState(identityState));
  const installEligibility: Decision =
    legacyEligibility.kind === "blocked" || conflicts.length === 0
      ? legacyEligibility
      : {
          kind: "blocked",
          output: {
            stdout: [],
            stderr: [
              "Conflicting unmanaged Superpowers Codex resources require manual resolution:",
              ...conflicts.map((conflict) => `- ${conflict}`),
              "Remove or disable each resource manually, then retry.",
            ],
          },
        };

  const legacyReport = reportLegacyState(identityState);
  let removalVerification: Decision;
  if (pluginPresent || marketplacePresent) {
    const message = pluginPresent
      ? "owned plugin resource is still installed after removal"
      : "owned marketplace resource is still registered after removal";
    removalVerification = {
      kind: "blocked",
      output: { stdout: [], stderr: ["error: " + message] },
    };
  } else if (legacyReport.kind === "unknown") {
    removalVerification = {
      kind: "blocked",
      output: { stdout: [], stderr: [`error: ${legacyReport.message}`] },
    };
  } else if (legacyReport.kind === "blocked") {
    removalVerification = {
      kind: "blocked",
      output: {
        stdout: [],
        stderr: ["error: unexpected legacy block after removal"],
      },
    };
  } else {
    removalVerification = { kind: "allowed" };
  }

  const postRemovalOutput =
    legacyReport.kind === "report"
      ? { stdout: legacyReport.lines, stderr: [] }
      : { stdout: [], stderr: [] };

  return {
    installEligibility,
    removalInput,
    removalVerification,
    postRemovalOutput,
    presentationValue: identityState,
    presentationConflicts: conflicts,
  };
}

export function codexControlInspection(
  updateControl: string,
): UpdateControlInspection {
  const probeEligibility: Decision =
    updateControl.length === 0
      ? {
          kind: "blocked",
          output: {
            stdout: [],
            stderr: [
              "error: probe did not report adapter update-control capability",
            ],
          },
        }
      : { kind: "allowed" };
  const managed = requireManagedUpdateControl(updateControl);
  const mutationEligibility: Decision =
    probeEligibility.kind === "blocked"
      ? probeEligibility
      : managed.ok
        ? { kind: "allowed" }
        : {
            kind: "blocked",
            output: {
              stdout: [],
              stderr: [`error: ${managed.message}`],
            },
          };
  return {
    probeEligibility,
    mutationEligibility,
    presentationValue: updateControl,
  };
}
