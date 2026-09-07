import { createHash } from "node:crypto";
import { lstat } from "node:fs/promises";
import { join } from "node:path";
import type { EffectiveSelection } from "./effective-selection.ts";
import type { Compatibility } from "./harness-compatibility.ts";
import {
  readArtifactFile,
  readArtifactObject,
  validateNativeSkill,
} from "./artifact-tree.ts";
import { SEMVER_RE } from "./generated-plugin.ts";
import { validateSource } from "./selection.ts";

const OFFICIAL_SOURCES = new Set([
  "https://github.com/obra/superpowers",
  "https://github.com/obra/superpowers.git",
  "ssh://git@github.com/obra/superpowers.git",
  "git@github.com:obra/superpowers.git",
]);

export function samePiSource(left: string, right: string): boolean {
  validateSource(left);
  validateSource(right);
  return (
    left === right ||
    (OFFICIAL_SOURCES.has(left) && OFFICIAL_SOURCES.has(right))
  );
}

export async function assessPiCompatibility(
  root: string,
  selection: Pick<EffectiveSelection, "effectiveSource">,
): Promise<Compatibility> {
  try {
    validateSource(selection.effectiveSource);
    const official = OFFICIAL_SOURCES.has(selection.effectiveSource);
    const pkg = await readArtifactObject(root, join(root, "package.json"));
    if (
      pkg.name !== "superpowers" ||
      pkg.type !== "module" ||
      typeof pkg.version !== "string" ||
      !SEMVER_RE.test(pkg.version)
    )
      throw new Error("package metadata");
    const pi = pkg.pi;
    if (
      !pi ||
      typeof pi !== "object" ||
      Array.isArray(pi) ||
      Object.keys(pi).length !== 2 ||
      JSON.stringify(pi.extensions) !== '["./.pi/extensions/superpowers.ts"]' ||
      JSON.stringify(pi.skills) !== '["./skills"]'
    )
      throw new Error("resource declaration");
    for (const key of [
      "dependencies",
      "optionalDependencies",
      "peerDependencies",
      "bundleDependencies",
      "bundledDependencies",
    ]) {
      const value = pkg[key];
      if (
        value !== undefined &&
        (value === null ||
          typeof value !== "object" ||
          Object.keys(value).length !== 0)
      )
        throw new Error("runtime dependencies");
    }
    await validateNativeSkill(root);
    const bootstrap = join(root, ".pi/extensions/superpowers.ts");
    const bytes = await readArtifactFile(root, bootstrap, 4283);
    if (
      (await lstat(bootstrap)).mode & 0o111 ||
      bytes.length !== 4283 ||
      createHash("sha256").update(bytes).digest("hex") !==
        "39c27000c047f8a1399a76e032e4cd239d7bdb0be168a121f46a2ac719deaae0"
    )
      throw new Error("bootstrap implementation");
    return {
      kind: official ? "supported" : "experimental",
      generation: "pi-native-bootstrap-v1",
      reason: official
        ? "qualified upstream-native Pi bootstrap"
        : "qualified Pi mechanics from a custom source",
    };
  } catch {
    return {
      kind: "unsupported",
      reason: `Pi package does not match the qualified native bootstrap profile: ${root}`,
    };
  }
}
