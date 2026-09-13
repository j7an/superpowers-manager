import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  lstatSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, relative, sep } from "node:path";

const MANAGER_ID = "superpowers@superpowers-manager";
const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

function fail(message: string): never {
  throw new Error(message);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function jsonText(value: string, input: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return fail(`could not read JSON input: ${input}`);
  }
}

function readJson(path: string): unknown {
  try {
    return jsonText(decoder.decode(readFileSync(path)), path);
  } catch {
    return fail(`could not read JSON input: ${path}`);
  }
}

function installed(
  listingJson: string,
  message = "Codex plugin listing does not contain an installed array",
): Record<string, unknown>[] {
  const data = jsonText(listingJson, "plugin listing");
  if (!isObject(data) || !Array.isArray(data.installed)) fail(message);
  return data.installed.filter(isObject);
}

function managerPlugin(
  items: Record<string, unknown>[],
  message: string,
): Record<string, unknown> {
  const matches = items.filter((item) => item.pluginId === MANAGER_ID);
  if (matches.length !== 1) fail(message);
  return matches[0]!;
}

function strictRoot(path: string, input: string): string {
  try {
    return realpathSync(path);
  } catch {
    return fail(`could not resolve ${input}: ${path}`);
  }
}

function regularFiles(
  root: string,
  failure: string,
  includeFileSymlinks = false,
): string[] {
  let rootStat;
  try {
    rootStat = lstatSync(root);
  } catch {
    return fail(`${failure}: ${root}`);
  }
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink())
    fail(`${failure}: ${root}`);
  const found: string[] = [];
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        try {
          if (includeFileSymlinks && statSync(path).isFile())
            found.push(relative(root, path));
        } catch {
          // A dangling or uninspectable symlink is not a file.
        }
        continue;
      }
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile()) found.push(relative(root, path));
    }
  };
  visit(root);
  return found.sort();
}

function activeRoot(version: string): string {
  return strictRoot(
    join(
      homedir(),
      ".codex/plugins/cache/superpowers-manager/superpowers",
      version,
    ),
    "active plugin root",
  );
}

function assertMarketplaceRoot(
  listingJson: string,
  expectedRoot: string,
): void {
  const data = jsonText(listingJson, "marketplace listing");
  const marketplaces =
    isObject(data) && Array.isArray(data.marketplaces) ? data.marketplaces : [];
  const roots = marketplaces
    .filter(isObject)
    .filter((item) => item.name === "superpowers-manager")
    .map((item) => item.root);
  if (
    roots.length !== 1 ||
    typeof roots[0] !== "string" ||
    strictRoot(roots[0], "manager marketplace root") !==
      strictRoot(expectedRoot, "expected marketplace root")
  )
    fail("manager marketplace root mismatch");
}

function assertInstalledCommit(
  listingJson: string,
  root: string,
  version: string,
  commit: string,
  unexpected: string,
): void {
  const plugin = managerPlugin(
    installed(listingJson),
    "Codex listing must contain exactly one manager plugin",
  );
  if (plugin.version !== version)
    fail("Codex active manager version does not match the expected version");
  const active = strictRoot(root, "active installed root");
  const provenance = readJson(join(active, ".superpowers-upstream.json"));
  const manifest = readJson(join(active, ".codex-plugin/plugin.json"));
  if (!isObject(provenance) || provenance.commit !== commit)
    fail("active installed provenance does not match the expected commit");
  if (provenance.commit === unexpected)
    fail("active installed provenance resolved to the stale commit");
  if (!isObject(manifest) || manifest.version !== version)
    fail("active installed manifest version does not match its cache root");
}

function assertInstalledPayload(
  listingJson: string,
  marketplace: string,
  version: string,
  commit: string,
): void {
  const plugin = managerPlugin(
    installed(listingJson),
    "Codex active manager version changed during same-version refresh",
  );
  if (plugin.version !== version)
    fail("Codex active manager version changed during same-version refresh");
  if (plugin.enabled !== true)
    fail("Codex manager plugin is not enabled during same-version refresh");
  const active = activeRoot(version);
  const source = strictRoot(
    join(marketplace, "plugins/superpowers"),
    "marketplace plugin root",
  );
  for (const path of [
    ".codex-plugin/plugin.json",
    ".superpowers-upstream.json",
  ]) {
    if (
      !readFileSync(join(active, path)).equals(readFileSync(join(source, path)))
    )
      fail(`same-version refresh did not replace ${path}`);
  }
  const provenance = readJson(join(active, ".superpowers-upstream.json"));
  if (!isObject(provenance) || provenance.commit !== commit)
    fail("same-version refresh installed the wrong provenance commit");
  const activeSkills = join(active, "skills");
  const sourceSkills = join(source, "skills");
  const activeFiles = regularFiles(
    activeSkills,
    "same-version refresh skills root is not a directory",
  );
  const sourceFiles = regularFiles(
    sourceSkills,
    "same-version refresh skills root is not a directory",
  );
  assert.deepEqual(
    activeFiles,
    sourceFiles,
    "same-version refresh installed skill paths do not match the intact marketplace",
  );
  for (const path of sourceFiles) {
    if (
      !readFileSync(join(activeSkills, path)).equals(
        readFileSync(join(sourceSkills, path)),
      )
    )
      fail(`same-version refresh installed skill payload differs: ${path}`);
  }
}

function damageSkill(
  listingJson: string,
  marketplace: string,
  version: string,
  commit: string,
): void {
  const plugin = managerPlugin(
    installed(listingJson),
    "Codex active manager version changed before same-version repair",
  );
  if (plugin.version !== version)
    fail("Codex active manager version changed before same-version repair");
  if (plugin.enabled !== true)
    fail("Codex manager plugin is not enabled before same-version repair");
  const active = activeRoot(version);
  const source = strictRoot(
    join(marketplace, "plugins/superpowers"),
    "marketplace plugin root",
  );
  const provenance = readJson(join(active, ".superpowers-upstream.json"));
  if (!isObject(provenance) || provenance.commit !== commit)
    fail("same-version repair started with the wrong provenance commit");
  const damaged = join(active, "skills/probe/SKILL.md");
  const expected = join(source, "skills/probe/SKILL.md");
  if (!readFileSync(damaged).equals(readFileSync(expected)))
    fail("same-version repair fixture is not intact before damage");
  writeFileSync(damaged, "damaged same-version payload\n");
  if (readFileSync(damaged).equals(readFileSync(expected)))
    fail(
      "same-version repair fixture did not damage the installed skill payload",
    );
}

function hookState(path: string): void {
  let stat: ReturnType<typeof lstatSync>;
  try {
    stat = lstatSync(path);
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      process.stdout.write("absent\n");
      return;
    }
    fail(`could not inspect Codex hooks.state: ${path}`);
  }
  if (stat.isSymbolicLink() || !stat.isFile())
    fail("Codex hooks.state must remain absent or a regular file");
  try {
    process.stdout.write(
      `file:${createHash("sha256").update(readFileSync(path)).digest("hex")}\n`,
    );
  } catch {
    fail(`could not read Codex hooks.state: ${path}`);
  }
}

function assertRequirements(path: string, digest: string): void {
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink())
      fail("manager mutation changed requirements.toml presence or type");
    if (
      createHash("sha256").update(readFileSync(path)).digest("hex") !== digest
    )
      fail("manager mutation changed requirements.toml contents");
  } catch (error) {
    if (
      error instanceof Error &&
      error.message.startsWith("manager mutation changed requirements.toml")
    )
      throw error;
    fail("manager mutation changed requirements.toml presence or type");
  }
}

function assertEmptyHooks(listingJson: string, root: string): void {
  managerPlugin(
    installed(listingJson),
    "Codex listing must contain exactly one manager plugin",
  );
  const active = strictRoot(root, "active plugin root");
  const manifest = readJson(join(active, ".codex-plugin/plugin.json"));
  if (
    !isObject(manifest) ||
    !isObject(manifest.hooks) ||
    Object.keys(manifest.hooks).length !== 0
  )
    fail("installed exact-empty hooks value is not {}");
  try {
    lstatSync(join(active, "hooks"));
    fail("exact-empty hook fixture installed a hooks subtree");
  } catch (error) {
    if (
      error instanceof Error &&
      error.message === "exact-empty hook fixture installed a hooks subtree"
    )
      throw error;
  }
}

function assertActiveHooks(listingJson: string, root: string): void {
  managerPlugin(
    installed(listingJson),
    "Codex listing must contain exactly one manager plugin",
  );
  const active = strictRoot(root, "active plugin root");
  const manifest = readJson(join(active, ".codex-plugin/plugin.json"));
  if (!isObject(manifest) || manifest.hooks !== "./hooks/hooks-codex.json")
    fail("installed active hook manifest has the wrong hooks path");
  const hooks = join(active, "hooks");
  const files = regularFiles(
    hooks,
    "installed active hook subtree mismatch",
    true,
  );
  assert.deepEqual(
    files,
    ["hooks-codex.json", "session-start-codex", "support/helper.txt"],
    `installed active hook subtree mismatch: ${JSON.stringify(files)}`,
  );
  const config = readJson(join(hooks, "hooks-codex.json"));
  assert.deepEqual(
    config,
    {
      hooks: {
        SessionStart: [
          {
            hooks: [
              {
                type: "command",
                command: 'sh "${PLUGIN_ROOT}/hooks/session-start-codex"',
              },
            ],
          },
        ],
      },
    },
    "installed active hook config does not match upstream",
  );
  if (
    !decoder
      .decode(readFileSync(join(hooks, "session-start-codex")))
      .includes("/tmp/superpowers-manager-hook-sentinel")
  )
    fail("installed active hook script lost the sentinel payload");
  if (
    decoder.decode(readFileSync(join(hooks, "support/helper.txt"))) !==
    "support\n"
  )
    fail("installed active hook support subtree changed");
}

function readHooks(path: string): Record<string, unknown>[] {
  const response = readJson(path);
  if (!isObject(response) || response.id !== 1)
    fail("hooks/list response is missing id 1");
  if (Object.hasOwn(response, "error"))
    fail("hooks/list returned an RPC error");
  if (!isObject(response.result))
    fail("hooks/list response has no result object");
  if (!Array.isArray(response.result.data))
    fail("hooks/list result has no data array");
  const hooks: Record<string, unknown>[] = [];
  for (const item of response.result.data) {
    if (!isObject(item) || !Array.isArray(item.hooks))
      fail("hooks/list data entry is malformed");
    if (!item.hooks.every(isObject))
      fail("hooks/list hook metadata is malformed");
    hooks.push(...item.hooks);
  }
  return hooks;
}

function assertSkills(
  responsePath: string,
  listingJson: string,
  upstreamPath: string,
  requestedCwd: string,
): void {
  const response = readJson(responsePath);
  if (!isObject(response) || response.id !== 1)
    fail("skills/list response is missing id 1");
  if (!isObject(response.result) || !Array.isArray(response.result.data))
    fail("skills/list response has no data array");
  const entries = response.result.data
    .filter(isObject)
    .filter((entry) => entry.cwd === requestedCwd);
  if (entries.length !== 1)
    fail("skills/list must contain exactly one requested cwd entry");
  const entry = entries[0]!;
  if (
    !Array.isArray(entry.errors) ||
    entry.errors.length !== 0 ||
    !Array.isArray(entry.skills)
  )
    fail("skills/list reports errors or malformed skills");
  const plugin = managerPlugin(
    installed(listingJson),
    "Codex listing must contain exactly one manager plugin",
  );
  if (typeof plugin.version !== "string" || plugin.version.length === 0)
    fail("Codex active manager version is missing or malformed");
  if (plugin.enabled !== true) fail("Codex manager plugin is not enabled");
  const active = activeRoot(plugin.version);
  const upstream = strictRoot(upstreamPath, "upstream root");
  const expected: Record<string, string> = {
    "superpowers:probe": join(upstream, "skills/probe/SKILL.md"),
    "superpowers:using-superpowers": join(
      upstream,
      "skills/using-superpowers/SKILL.md",
    ),
  };
  const found: Record<string, string[]> = Object.fromEntries(
    Object.keys(expected).map((name) => [name, []]),
  );
  for (const skill of entry.skills) {
    if (
      !isObject(skill) ||
      typeof skill.name !== "string" ||
      !Object.hasOwn(expected, skill.name)
    )
      continue;
    if (skill.enabled !== true || typeof skill.path !== "string")
      fail("manager skill metadata is malformed or disabled");
    if (Object.hasOwn(skill, "pluginId") && skill.pluginId !== MANAGER_ID)
      fail("manager skill pluginId does not match the manager identity");
    const resolved = strictRoot(skill.path, "manager skill path");
    const contained = relative(active, resolved);
    if (
      contained === ".." ||
      contained.startsWith(`..${sep}`) ||
      isAbsolute(contained)
    )
      fail("manager skill is outside active plugin root");
    if (!readFileSync(resolved).equals(readFileSync(expected[skill.name])))
      fail(`manager skill fixture bytes mismatch: ${skill.name}`);
    found[skill.name]!.push(resolved);
  }
  if (Object.values(found).some((paths) => paths.length !== 1))
    fail("each expected manager fixture skill must occur exactly once");
}

function assertHooksAbsent(path: string): void {
  if (readHooks(path).some((hook) => hook.pluginId === MANAGER_ID))
    fail("exact-empty manager plugin unexpectedly exposes a hook");
}

function assertHookActive(path: string): void {
  const hooks = readHooks(path).filter((hook) => hook.pluginId === MANAGER_ID);
  if (hooks.length !== 1)
    fail("active manager plugin must expose exactly one hook");
  const hook = hooks[0]!;
  for (const [key, value] of Object.entries({
    source: "plugin",
    pluginId: MANAGER_ID,
    trustStatus: "untrusted",
  }))
    if (hook[key] !== value)
      fail(
        `active manager hook metadata mismatch for ${key}: ${JSON.stringify(hook[key])}`,
      );
  if (hook.enabled !== true)
    fail(
      `active manager hook enabled is not true: ${JSON.stringify(hook.enabled)}`,
    );
  if (hook.isManaged !== false)
    fail(
      `active manager hook isManaged is not false: ${JSON.stringify(hook.isManaged)}`,
    );
}

function digest(path: string): void {
  try {
    process.stdout.write(
      `${createHash("sha256").update(readFileSync(path)).digest("hex")}\n`,
    );
  } catch {
    fail(`could not read digest input: ${path}`);
  }
}

function marketplaceNames(data: unknown): string[] {
  if (
    !isObject(data) ||
    !Array.isArray(data.marketplaces) ||
    !data.marketplaces.every(isObject)
  )
    fail("Codex marketplace listing has an invalid shape");
  const names = data.marketplaces.map((item) => item.name);
  if (!names.every((name) => typeof name === "string" && name.length > 0))
    fail("Codex marketplace listing contains an invalid name");
  return names as string[];
}

function assertManagerAbsent(plugins: string, pluginMessage: string): void {
  if (
    installed(plugins, pluginMessage).some(
      (item) => item.pluginId === MANAGER_ID,
    )
  )
    fail(pluginMessage);
}

function uninstallLegacy(plugins: string, marketplaces: string): void {
  assertManagerAbsent(
    plugins,
    "legacy uninstall left the manager plugin registered",
  );
  const data = jsonText(marketplaces, "marketplace listing");
  if (
    isObject(data) &&
    Array.isArray(data.marketplaces) &&
    data.marketplaces
      .filter(isObject)
      .some((item) => item.name === "superpowers-manager")
  )
    fail("legacy uninstall left the manager marketplace registered");
}

function uninstallMissingSource(plugins: string, marketplaces: string): void {
  assertManagerAbsent(
    plugins,
    "missing-source uninstall left the manager plugin registered",
  );
  const data = jsonText(marketplaces, "marketplace listing");
  const names =
    isObject(data) && Array.isArray(data.marketplaces)
      ? data.marketplaces.filter(isObject).map((item) => item.name)
      : [];
  if (names.includes("superpowers-manager"))
    fail("missing-source uninstall left the manager marketplace registered");
  if (!names.includes("unrelated-provider"))
    fail("missing-source uninstall removed the unrelated provider");
}

function uninstallFinal(plugins: string, before: string, after: string): void {
  assertManagerAbsent(
    plugins,
    "manager plugin remains installed after uninstall",
  );
  const beforeNames = marketplaceNames(
    jsonText(before, "before marketplace listing"),
  );
  const afterNames = marketplaceNames(
    jsonText(after, "after marketplace listing"),
  );
  if (afterNames.includes("superpowers-manager"))
    fail("manager marketplace remains registered after uninstall");
  assert.deepEqual(
    beforeNames.filter((name) => name !== "superpowers-manager").sort(),
    [...afterNames].sort(),
    "manager uninstall changed an unrelated provider",
  );
  if (!afterNames.includes("unrelated-provider"))
    fail("unrelated provider was removed by manager uninstall");
}

const [verb, ...args] = process.argv.slice(2);
try {
  switch (verb) {
    case "marketplace-root":
      assertMarketplaceRoot(args[0]!, args[1]!);
      break;
    case "installed-commit":
      assertInstalledCommit(args[0]!, args[1]!, args[2]!, args[3]!, args[4]!);
      break;
    case "installed-payload":
      assertInstalledPayload(args[0]!, args[1]!, args[2]!, args[3]!);
      break;
    case "damage-skill":
      damageSkill(args[0]!, args[1]!, args[2]!, args[3]!);
      break;
    case "hook-state":
      hookState(args[0]!);
      break;
    case "requirements-unchanged":
      assertRequirements(args[0]!, args[1]!);
      break;
    case "empty-hooks":
      assertEmptyHooks(args[0]!, args[1]!);
      break;
    case "active-hooks":
      assertActiveHooks(args[0]!, args[1]!);
      break;
    case "skills":
      assertSkills(args[0]!, args[1]!, args[2]!, args[3]!);
      break;
    case "hooks-absent":
      assertHooksAbsent(args[0]!);
      break;
    case "hook-active":
      assertHookActive(args[0]!);
      break;
    case "digest":
      digest(args[0]!);
      break;
    case "legacy-uninstall":
      uninstallLegacy(args[0]!, args[1]!);
      break;
    case "missing-source-uninstall":
      uninstallMissingSource(args[0]!, args[1]!);
      break;
    case "final-uninstall":
      uninstallFinal(args[0]!, args[1]!, args[2]!);
      break;
    default:
      fail(`unknown assertion verb: ${verb ?? ""}`);
  }
} catch (error) {
  process.stderr.write(
    `${error instanceof Error ? error.message : "assertion failed"}\n`,
  );
  process.exitCode = 1;
}
