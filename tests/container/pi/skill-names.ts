import {
  lstatSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { dirname, join, sep } from "node:path";
import { pathToFileURL } from "node:url";

async function main(): Promise<void> {
  if (
    process.env.SPW_CONTAINER !== "1" ||
    process.getuid?.() !== 10001 ||
    process.env.PI_OFFLINE !== "1"
  )
    throw new Error("Pi skill discovery requires the isolated container");
  const [agentDir, piRoot, installedRoot] = process.argv.slice(2);
  if (!agentDir || !piRoot || !installedRoot)
    throw new Error(
      "Pi skill discovery requires agent, runtime and installed paths",
    );
  try {
    lstatSync(installedRoot);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw new Error("Cannot inspect the Pi installed root");
  }
  const installed = realpathSync(installedRoot);
  const settings = JSON.parse(
    readFileSync(join(agentDir, "settings.json"), "utf8"),
  );
  if (!settings || typeof settings !== "object" || Array.isArray(settings))
    throw new Error("Cannot parse Pi settings");
  const { DefaultResourceLoader, SettingsManager } = await import(
    pathToFileURL(join(piRoot, "dist/index.js")).href
  );
  const scratch = mkdtempSync(join(dirname(agentDir), "observer-"));
  try {
    const loader = new DefaultResourceLoader({
      cwd: scratch,
      agentDir,
      settingsManager: SettingsManager.inMemory(settings, {
        projectTrusted: false,
      }),
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
    });
    await loader.reload();
    if (loader.getExtensions().errors.length !== 0) {
      console.error("Pi resource loader reported errors");
      process.exitCode = 1;
      return;
    }
    const skills: { name: string; filePath: string }[] =
      loader.getSkills().skills;
    const names = new Set(
      skills
        .filter((skill) =>
          realpathSync(skill.filePath).startsWith(installed + sep),
        )
        .map((skill) => skill.name),
    );
    if ([...names].some((name) => !/^[a-z0-9][a-z0-9-]*$/.test(name)))
      throw new Error("Cannot parse Pi skill names");
    if (names.size) process.stdout.write([...names].sort().join("\n") + "\n");
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

try {
  await main();
} catch {
  console.error(
    "error: real-upstream pi: cannot inspect Pi settings or installed skills",
  );
  process.exitCode = 1;
}
