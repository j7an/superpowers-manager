import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const [, , command, ...arguments_] = process.argv;

if (command === "create") {
  const [upstream, home, fixtures] = arguments_;
  if (!upstream || !home || !fixtures || arguments_.length !== 3) {
    throw new Error(
      "usage: fixture.ts create <upstream-root> <home> <fixture-source-root>",
    );
  }
  const copies = [
    ["bootstrap.ts.txt", ".pi/extensions/superpowers.ts"],
    ["package.json.txt", "package.json"],
    ["SKILL.md.txt", "skills/using-superpowers/SKILL.md"],
    ["LICENSE.txt", "LICENSE"],
  ] as const;
  for (const [source, destination] of copies) {
    const target = join(upstream, destination);
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(join(fixtures, source), target);
  }
  const skill = join(upstream, "skills/snapshot-probe/SKILL.md");
  mkdirSync(dirname(skill), { recursive: true });
  writeFileSync(
    skill,
    "---\nname: snapshot-probe\ndescription: Observe snapshot lifecycle\n---\nSnapshot phase A.\n",
  );
  const survivor = join(home, "unrelated-provider");
  mkdirSync(survivor, { recursive: true });
  writeFileSync(
    join(survivor, "package.json"),
    JSON.stringify({
      name: "unrelated-provider",
      version: "1.0.0",
      pi: { skills: [] },
    }),
  );
  writeFileSync(join(survivor, "preserved.txt"), "unrelated package bytes\n");
  const settings = join(home, ".pi/agent/settings.json");
  mkdirSync(dirname(settings), { recursive: true });
  writeFileSync(
    settings,
    JSON.stringify({
      packages: [survivor],
      theme: "dark",
      spwProbeSetting: { retained: true },
    }),
  );
} else if (command === "phase-b") {
  const [skill] = arguments_;
  if (!skill || arguments_.length !== 1) {
    throw new Error("usage: fixture.ts phase-b <skill-path>");
  }
  try {
    const text = new TextDecoder("utf-8", {
      fatal: true,
      ignoreBOM: true,
    }).decode(readFileSync(skill));
    writeFileSync(
      skill,
      text.replaceAll("Snapshot phase A.", "Snapshot phase B."),
    );
  } catch {
    console.error(`error: could not read fixture skill ${skill}`);
    process.exitCode = 1;
  }
} else {
  throw new Error("usage: fixture.ts <create|phase-b> ...");
}
