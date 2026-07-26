import { SEMVER_BASE_RE } from "./domain/refs.js";

export type ResolutionKind = "latest-release" | "tag" | "ref" | "raw-commit";

export interface ManifestVersionInput {
  readonly requestedRef: string;
  readonly resolutionKind: ResolutionKind;
  readonly resolvedRef: string;
  readonly commit: string;
}

export function shortCommit(commit: string): string {
  return commit.slice(0, 7);
}

function trimDashes(value: string): string {
  return value.replace(/^-+/, "").replace(/-+$/, "");
}

export function sanitizeRefForVersion(ref: string): string {
  const collapsed = trimDashes(ref.replace(/[^0-9A-Za-z-]+/g, "-"));
  const truncated = trimDashes(collapsed.slice(0, 48));
  return truncated === "" ? "unknown" : truncated;
}

export function manifestVersionForRef(input: ManifestVersionInput): string {
  const short = shortCommit(input.commit);
  switch (input.resolutionKind) {
    case "latest-release":
    case "tag": {
      if (input.resolvedRef.startsWith("v")) {
        const base = input.resolvedRef.slice(1);
        if (base !== "" && SEMVER_BASE_RE.test(base)) {
          return `${base}+manager.${short}`;
        }
      }
      break;
    }
    case "ref": {
      if (input.requestedRef === "main") {
        return `0.0.0-main+manager.${short}`;
      }
      return `0.0.0-ref-${sanitizeRefForVersion(input.requestedRef)}+manager.${short}`;
    }
    case "raw-commit":
      break;
    default: {
      const unreachable: never = input.resolutionKind;
      throw new Error(`unhandled resolution kind: ${String(unreachable)}`);
    }
  }
  return `0.0.0+manager.${short}`;
}
