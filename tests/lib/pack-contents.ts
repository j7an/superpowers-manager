import { globSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

export function expectedTarballPaths(
  sourceRoot: string,
  allowlistText: string,
): string[] {
  const src = join(sourceRoot, "src");
  if (!statSync(src).isDirectory())
    throw new Error("package source root is not a directory");
  const emitted = globSync("**/*.ts", { cwd: src, withFileTypes: true })
    .filter((entry) => entry.isFile() && !entry.name.endsWith(".d.ts"))
    .map(
      (entry) =>
        "dist/" +
        relative(src, join(entry.parentPath, entry.name))
          .split(sep)
          .join("/")
          .replace(/\.ts$/, ".js"),
    );
  const listed = allowlistText
    .split(/\r\n|\r|\n/)
    .filter((line) => !line.startsWith("#"))
    .map((line) => line.trim())
    .filter((line) => line !== "");
  return [...listed, ...emitted].sort();
}
