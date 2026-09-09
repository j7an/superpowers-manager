import { lstat, readdir, readFile, readlink, stat } from "node:fs/promises";
import { pythonSplitlines, pythonStrip } from "./python-text.ts";

export interface GeneratedPluginFsDeps {
  readonly lstat: typeof lstat;
  readonly stat: typeof stat;
  readonly readdir: typeof readdir;
  readonly readlink: typeof readlink;
  readonly readFile: typeof readFile;
}

export const DEFAULT_FS_DEPS: GeneratedPluginFsDeps = {
  lstat,
  stat,
  readdir,
  readlink,
  readFile,
};

const STRICT_DECODER = new TextDecoder("utf-8", {
  fatal: true,
  ignoreBOM: true,
});

export async function validateSkillFrontmatter(
  skillMd: string,
  skillName: string,
  errors: string[],
  deps: GeneratedPluginFsDeps,
): Promise<void> {
  let contents: string;
  try {
    contents = STRICT_DECODER.decode(await deps.readFile(skillMd));
  } catch {
    errors.push(`skill \`${skillName}\` has unreadable UTF-8 \`SKILL.md\``);
    return;
  }
  if (contents === "") {
    errors.push(`skill \`${skillName}\` has empty \`SKILL.md\``);
    return;
  }
  const lines = pythonSplitlines(contents);
  if (lines.length === 0 || lines[0] !== "---") {
    errors.push(`skill \`${skillName}\` must start with \`---\``);
    return;
  }
  const closingIndex = lines.indexOf("---", 1);
  if (closingIndex === -1) {
    errors.push(`skill \`${skillName}\` frontmatter is not closed`);
    return;
  }
  const frontmatter = lines.slice(1, closingIndex);
  for (const key of ["name", "description"] as const) {
    const matches = frontmatter.filter((line) => line.startsWith(`${key}:`));
    if (matches.length !== 1) {
      errors.push(
        `skill \`${skillName}\` frontmatter must contain exactly one top-level \`${key}:\``,
      );
      continue;
    }
    const value = pythonStrip(matches[0]!.slice(matches[0]!.indexOf(":") + 1));
    if (
      value === "" ||
      value === "''" ||
      value === '""' ||
      value.startsWith("#")
    ) {
      errors.push(
        `skill \`${skillName}\` frontmatter field \`${key}\` must be non-empty`,
      );
    }
  }
}
