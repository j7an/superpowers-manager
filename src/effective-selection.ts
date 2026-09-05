// `selectionError` already exists at
// `src/selection.ts:41::export function selectionError` and tags errors with
// module "selection". Import it rather than defining a second one.
import {
  normalizeSaved,
  selectionError,
  validateSource,
  type NormalizedSavedSelection,
} from "./selection.ts";
import { readSelectionState } from "./selection-store.ts";
import { readConfigRef, resolveRef } from "./upstream.ts";
import { COMMIT_RE } from "./domain/refs.ts";

function requireAbsolute(value: string, variable: string): string {
  if (!value.startsWith("/")) {
    throw selectionError(`${variable} must be absolute`);
  }
  return value;
}

// Precedence mirrors
// `git show ad56569a4c161e7b122967442e2b026eeb6395f6:scripts/core/selection.sh:4-29::spw_selection_config_dir(`.
// SUPERPOWERS_CONFIG_DIR is selected on *presence*, matching the shell's
// ${SUPERPOWERS_CONFIG_DIR+x}: an empty value takes this branch and then fails
// the absolute check, rather than falling through to XDG.
export function selectionConfigDir(env: NodeJS.ProcessEnv): string {
  const explicit = env.SUPERPOWERS_CONFIG_DIR;
  if (explicit !== undefined) {
    return requireAbsolute(explicit, "SUPERPOWERS_CONFIG_DIR");
  }
  const xdg = env.XDG_CONFIG_HOME;
  if (xdg !== undefined && xdg.length > 0) {
    return `${requireAbsolute(xdg, "XDG_CONFIG_HOME")}/superpowers-manager`;
  }
  const home = env.HOME;
  if (home === undefined || home.length === 0) {
    throw selectionError("HOME is required to locate selection state");
  }
  return `${requireAbsolute(home, "HOME")}/.config/superpowers-manager`;
}

export function selectionStatePath(env: NodeJS.ProcessEnv): string {
  return `${selectionConfigDir(env)}/selection.json`;
}

// Composes exactly what `src/selection-state-cli.ts:39::const normalized`
// composes. The shell wrote a normalized document to a mktemp file and read
// five fields back with five python3 invocations; in-process this is one call.
export async function loadSavedSelection(
  env: NodeJS.ProcessEnv,
): Promise<NormalizedSavedSelection> {
  return normalizeSaved(await readSelectionState(selectionStatePath(env)));
}

export interface EffectiveSelection {
  readonly selectionOrigin: "environment" | "user-config" | "package-default";
  readonly selectionMode: "override" | "pinned" | "track-latest" | "default";
  readonly upstreamSourceOrigin:
    "environment" | "user-config" | "package-default";
  readonly effectiveSource: string;
  readonly requestedRef: string;
  readonly resolvedRef: string;
  readonly desiredCommit: string;
  readonly resolutionKind: string;
  readonly saved: NormalizedSavedSelection;
}

export const UPSTREAM_URL_DEFAULT = "https://github.com/obra/superpowers";

// Ports the env > saved > package-default precedence ladder from
// `git show ad56569a4c161e7b122967442e2b026eeb6395f6:scripts/core/selection.sh:88-162::spw_compute_effective_selection`.
// validateSource runs before any ref resolution -- pinned by
// tests/unit/effective-selection.test.js's "source validation precedes ref
// resolution": a credential-bearing source must fail before Git is ever
// invoked.
export async function computeEffectiveSelection(
  root: string,
  env: NodeJS.ProcessEnv,
): Promise<EffectiveSelection> {
  const saved = await loadSavedSelection(env);

  let upstreamSourceOrigin: EffectiveSelection["upstreamSourceOrigin"];
  let effectiveSource: string;
  if (env.SUPERPOWERS_UPSTREAM_URL) {
    upstreamSourceOrigin = "environment";
    effectiveSource = env.SUPERPOWERS_UPSTREAM_URL;
  } else if (saved.saved_mode !== "none") {
    upstreamSourceOrigin = "user-config";
    effectiveSource = saved.saved_source;
  } else {
    upstreamSourceOrigin = "package-default";
    effectiveSource = UPSTREAM_URL_DEFAULT;
  }

  // Before any Git access. Pinned by tests/unit/effective-selection.test.js's
  // "source validation precedes ref resolution".
  validateSource(effectiveSource);

  let selectionOrigin: EffectiveSelection["selectionOrigin"];
  let selectionMode: EffectiveSelection["selectionMode"];
  let requestedRef: string;
  let usesSavedPin = false;
  if (env.SUPERPOWERS_REF) {
    selectionOrigin = "environment";
    selectionMode = "override";
    requestedRef = env.SUPERPOWERS_REF;
  } else if (saved.saved_mode === "pinned") {
    selectionOrigin = "user-config";
    selectionMode = "pinned";
    requestedRef = saved.saved_requested_ref;
    usesSavedPin = true;
  } else if (saved.saved_mode === "track-latest") {
    selectionOrigin = "user-config";
    selectionMode = "track-latest";
    requestedRef = "latest-release";
  } else {
    selectionOrigin = "package-default";
    selectionMode = "default";
    requestedRef = await readConfigRef(root, env);
  }

  if (usesSavedPin) {
    return {
      selectionOrigin,
      selectionMode,
      upstreamSourceOrigin,
      effectiveSource,
      requestedRef,
      resolvedRef: saved.saved_resolved_ref,
      desiredCommit: saved.saved_commit,
      resolutionKind: COMMIT_RE.test(saved.saved_requested_ref)
        ? "raw-commit"
        : "tag",
      saved,
    };
  }

  const resolution = await resolveRef(effectiveSource, requestedRef);
  // `Resolution` (src/upstream.ts) is { kind, ref, commit } — the
  // resolved ref field is named `ref`, not `resolvedRef`.
  return {
    selectionOrigin,
    selectionMode,
    upstreamSourceOrigin,
    effectiveSource,
    requestedRef,
    resolvedRef: resolution.ref,
    desiredCommit: resolution.commit,
    resolutionKind: resolution.kind,
    saved,
  };
}
