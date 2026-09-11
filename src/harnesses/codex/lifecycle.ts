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

import type { AdapterResult } from "../../adapter-result.ts";

export { verifyInstalledFingerprint } from "./presentation.ts";

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

// scripts/core/lifecycle.sh drew a line the first port collapsed. The shell
// reaches "inspection failed" only when the inspect CALL failed (:91), and
// "cannot parse" when the call succeeded but its content is unusable (:95).
// Callers need both, because the two produce different operator text.
// Spec §6.2.3 item 3.
type ResultRead =
  | { readonly kind: "object"; readonly value: Record<string, unknown> }
  // The call itself failed: non-zero status, or an ok:false outcome.
  | { readonly kind: "call-failed" }
  // The call succeeded and the result is not a usable object.
  | { readonly kind: "unusable" };

function readResult(adapterResult: AdapterResult): ResultRead {
  if (adapterResult.status !== 0) return { kind: "call-failed" };
  const outcome = adapterResult.outcome;
  if (!outcome.ok) return { kind: "call-failed" };
  const value = outcome.result;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { kind: "unusable" };
  }
  return { kind: "object", value: value as Record<string, unknown> };
}

// Ported from
// `git show ad56569a4c161e7b122967442e2b026eeb6395f6:scripts/core/lifecycle.sh:126-141::spw_verify_uninstalled_resources`,
// with the Boolean coercion of
// `git show ad56569a4c161e7b122967442e2b026eeb6395f6:scripts/core/adapter.sh:58-73::spw_adapter_result_boolean`
// folded in: a non-Boolean is a hard failure, never a falsy "absent".
export function verifyUninstalledResources(
  inspectResult: AdapterResult,
): Check {
  const read = readResult(inspectResult);
  if (read.kind !== "object") {
    return {
      ok: false,
      message: "cannot read the adapter ownership inspection after removal",
    };
  }
  const inspected = read.value;
  // A missing or non-object `resources` falls THROUGH to the Boolean check
  // rather than getting its own message.
  // `git show ad56569a4c161e7b122967442e2b026eeb6395f6:scripts/core/adapter.sh:70::expected`
  // emits "expected Boolean adapter result at resources.plugin" for input {} —
  // the input tests/unit/harnesses/codex/lifecycle.test.ts's "a non-object resources falls
  // through to the Boolean message" exercises — so a distinct "not an object"
  // message here would be a port-only divergence. Parity, not divergence. Spec
  // §6.2.3 item 3.
  const resources = inspected.resources;
  const bag: Record<string, unknown> =
    typeof resources === "object" &&
    resources !== null &&
    !Array.isArray(resources)
      ? (resources as Record<string, unknown>)
      : {};
  for (const key of ["plugin", "marketplace"] as const) {
    if (typeof bag[key] !== "boolean") {
      return {
        ok: false,
        message: `expected a Boolean adapter result at resources.${key}`,
      };
    }
  }
  if (bag.plugin === true) {
    return {
      ok: false,
      message: "owned plugin resource is still installed after removal",
    };
  }
  if (bag.marketplace === true) {
    return {
      ok: false,
      message: "owned marketplace resource is still registered after removal",
    };
  }
  return { ok: true };
}
