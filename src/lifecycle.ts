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

import type { AdapterResult } from "./adapter-protocol.js";
import { commitMatches } from "./status.js";

export interface Refusal {
  readonly ok: false;
  readonly message: string;
}
export type Check = { readonly ok: true } | Refusal;

// scripts/core/lifecycle.sh:62-70. Both refusals reached spw_die in the shell,
// so both carry the `error: ` prefix at the call site and neither is special.
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

// A successful envelope's result object, or null when the call failed or the
// result is not an object. Callers distinguish "failed" from "absent field"
// themselves, because the two produce different operator text.
function resultObject(
  adapterResult: AdapterResult,
): Record<string, unknown> | null {
  if (adapterResult.status !== 0) return null;
  const envelope = adapterResult.envelope;
  if (!envelope.ok) return null;
  const value = envelope.result;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

export interface FingerprintVerdict {
  readonly ok: boolean;
  readonly stdout: readonly string[];
  readonly stderr: readonly string[];
}

// scripts/core/lifecycle.sh:87-124. The shell performed the inspection itself
// at :91; a pure function cannot, so the caller performs it and a failure
// arrives here as an AdapterResult with a non-zero status.
export function verifyInstalledFingerprint(
  desiredCommit: string,
  installResult: AdapterResult,
  inspectResult: AdapterResult,
): FingerprintVerdict {
  const inspected = resultObject(inspectResult);
  if (inspected === null) {
    return {
      ok: false,
      stdout: [],
      stderr: [
        "error: installed manager fingerprint inspection failed after install.",
      ],
    };
  }
  const raw = inspected.fingerprint;
  // The Python reader printed the empty string for a JSON null, and
  // `fingerprint` is null whenever no plugin version is active
  // (src/adapter.ts:802). Anything non-string and non-null is unparseable.
  if (raw !== null && raw !== undefined && typeof raw !== "string") {
    return {
      ok: false,
      stdout: [],
      stderr: [
        "error: cannot parse installed manager fingerprint inspection result after install.",
      ],
    };
  }
  const installedCommit = typeof raw === "string" ? raw : "";

  // :99-100 printed both lines BEFORE deciding, on every path that got this
  // far. Moving them into the success branch would silently drop them from the
  // failure output an operator reads to diagnose the mismatch.
  const stdout = [
    `desired_commit=${desiredCommit}`,
    `installed_commit=${installedCommit}`,
  ];

  if (
    installedCommit.length > 0 &&
    commitMatches(desiredCommit, installedCommit)
  ) {
    return { ok: true, stdout: [...stdout, "manager updated"], stderr: [] };
  }

  // :106-113 — which hint key is read depends on whether a commit was
  // detected at all, and the hint is optional in both directions.
  const installed = resultObject(installResult);
  const hints = installed === null ? null : installed.verification_hints;
  let hint = "";
  if (typeof hints === "object" && hints !== null && !Array.isArray(hints)) {
    const key = installedCommit.length > 0 ? "mismatch" : "missing";
    const value = (hints as Record<string, unknown>)[key];
    if (typeof value === "string") hint = value;
  }

  const stderr = [
    installedCommit.length > 0
      ? "error: installed manager fingerprint does not match the prepared plugin after install."
      : "error: installed manager fingerprint is not detectable after install.",
  ];
  if (hint.length > 0) stderr.push(`hint: ${hint}`);
  return { ok: false, stdout, stderr };
}

// scripts/core/lifecycle.sh:126-141, with the Boolean coercion of
// scripts/core/adapter.sh:58-73 folded in: a non-Boolean is a hard failure,
// never a falsy "absent".
export function verifyUninstalledResources(
  inspectResult: AdapterResult,
): Check {
  const inspected = resultObject(inspectResult);
  if (inspected === null) {
    return {
      ok: false,
      message: "cannot read the adapter ownership inspection after removal",
    };
  }
  const resources = inspected.resources;
  if (
    typeof resources !== "object" ||
    resources === null ||
    Array.isArray(resources)
  ) {
    return {
      ok: false,
      message: "expected an object adapter result at resources",
    };
  }
  const bag = resources as Record<string, unknown>;
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
