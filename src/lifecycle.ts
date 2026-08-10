// Ported from scripts/core/lifecycle.sh. Every function here is PURE: it
// returns its verdict as data and writes nothing. The command modules do the
// writing.
//
// That shape is not stylistic. src/commands/probe.ts's gatherProbe established
// it because a write inside a try can raise EPIPE, be caught by that try, and
// be relabelled as a domain failure. Keeping the predicates write-free means
// the hazard cannot exist here at all.

// A three-way verdict rather than a boolean, because the shell has two
// distinct failure paths and collapsing them changes operator-visible text:
//
//   legacy | both  -> scripts/core/lifecycle.sh:50-53 prints three bare lines
//                     to stderr and returns 1. No `error: ` prefix.
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

// Frozen text. scripts/core/lifecycle.sh:50-53. The version in the second line
// is a historical package coordinate an operator must type verbatim, not a
// reference to this package's current version — do not derive it.
const BLOCKED_LINES: readonly string[] = [
  "Legacy superpowers-wrapper Codex state is installed.",
  "Run: npx superpowers-wrapper@0.1.1 uninstall",
  "Then run: npx superpowers-manager install",
];

// Frozen text. scripts/core/lifecycle.sh:75-77. Two lines, not three: the
// report path does not tell the operator to re-install.
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

// scripts/core/lifecycle.sh:43-60.
export function requireNoLegacyState(identityState: string): LegacyVerdict {
  if (identityState === "neither" || identityState === "manager") {
    return { kind: "ok" };
  }
  if (identityState === "legacy" || identityState === "both") {
    return { kind: "blocked", lines: BLOCKED_LINES };
  }
  return unknownState(identityState);
}

// scripts/core/lifecycle.sh:72-85. Same enumeration, different disposition:
// this one reports and continues rather than blocking, so its clean arm and
// its legacy arm are both non-fatal.
export function reportLegacyState(identityState: string): LegacyVerdict {
  if (identityState === "neither" || identityState === "manager") {
    return { kind: "ok" };
  }
  if (identityState === "legacy" || identityState === "both") {
    return { kind: "report", lines: REPORT_LINES };
  }
  return unknownState(identityState);
}
