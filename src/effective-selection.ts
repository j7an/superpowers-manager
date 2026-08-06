// `selectionError` already exists at src/selection.ts:41 and tags errors with
// module "selection". Import it rather than defining a second one.
import { selectionError } from "./selection.js";

function requireAbsolute(value: string, variable: string): string {
  if (!value.startsWith("/")) {
    throw selectionError(`${variable} must be absolute`);
  }
  return value;
}

// Precedence mirrors scripts/core/selection.sh:4-29. SUPERPOWERS_CONFIG_DIR is
// selected on *presence*, matching the shell's ${SUPERPOWERS_CONFIG_DIR+x}: an
// empty value takes this branch and then fails the absolute check, rather than
// falling through to XDG.
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
