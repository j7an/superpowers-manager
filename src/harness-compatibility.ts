export type HarnessId = "codex" | "pi";

export type Compatibility =
  | { readonly kind: "unknown"; readonly reason: string }
  | {
      readonly kind: "supported";
      readonly generation: string;
      readonly reason: string;
    }
  | {
      readonly kind: "experimental";
      readonly generation: string;
      readonly reason: string;
    }
  | { readonly kind: "unsupported"; readonly reason: string };

export interface InvocationOptions {
  readonly harness: HarnessId;
  readonly allowExperimental: boolean;
}

export function activationBlock(
  value: Compatibility,
  allowExperimental: boolean,
): string | null {
  switch (value.kind) {
    case "supported":
      return null;
    case "experimental":
      return allowExperimental
        ? null
        : "experimental integration requires --allow-experimental";
    case "unknown":
    case "unsupported":
      return value.reason;
  }
}
