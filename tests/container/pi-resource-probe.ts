import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

// This observer runs only inside the disposable acceptance container. It uses
// independent filesystem evidence before importing the real extension loader.
assert.equal(process.env.SPW_CONTAINER, "1");
assert.equal(process.getuid?.(), 10001);
assert.equal(process.env.PI_OFFLINE, "1");
assert.ok(process.env.SPW_PI_PROBE_ROOT);
const isolated = realpathSync(process.env.SPW_PI_PROBE_ROOT);
assert.match(isolated, /^\/tmp\/spw-pi-[^/]+\/home$/);
assert.equal(realpathSync(process.env.HOME!), isolated);
const [snapshotArgument, runtimeArgument, commit, phase, mode] =
  process.argv.slice(2);
assert.ok(snapshotArgument && runtimeArgument && commit && phase && mode);
assert.ok(["prepared", "installed", "events", "absent"].includes(mode));
const snapshot = resolve(snapshotArgument);
assert.ok(snapshot.startsWith(isolated + sep));
const agentDir = join(isolated, ".pi", "agent");
const survivor = join(isolated, "unrelated-provider");
const settings = JSON.parse(
  readFileSync(join(agentDir, "settings.json"), "utf8"),
);
assert.equal(settings.theme, "dark", "unrelated setting must survive");
assert.deepEqual(settings.spwProbeSetting, { retained: true });
const sourceOf = (entry: string | { source: string }): string =>
  resolve(agentDir, typeof entry === "string" ? entry : entry.source);
const sources: string[] = settings.packages.map(sourceOf);
assert.equal(sources.filter((source) => source === survivor).length, 1);
assert.equal(
  readFileSync(join(survivor, "preserved.txt"), "utf8"),
  "unrelated package bytes\n",
);
if (mode === "absent") {
  assert.deepEqual(sources, [survivor]);
  assert.equal(
    existsSync(snapshot),
    false,
    "installed snapshot must be absent",
  );
  console.log("pi snapshot absence: verified");
  process.exit(0);
}
assert.equal(realpathSync(snapshot), snapshot);
if (mode !== "prepared")
  assert.deepEqual(sources.sort(), [survivor, snapshot].sort());

const receipt = JSON.parse(
  readFileSync(join(snapshot, ".superpowers-manager.json"), "utf8"),
);
assert.equal(receipt.schema, 1);
assert.equal(receipt.manager, "superpowers-manager");
assert.equal(receipt.harness, "pi");
assert.equal(receipt.source, process.env.SUPERPOWERS_UPSTREAM_URL);
assert.equal(receipt.commit, commit);
assert.equal(receipt.compatibility.kind, "experimental");
assert.equal(receipt.compatibility.generation, "pi-native-bootstrap-v1");

// Hash the independent on-disk records, including directory names and execute
// bits. These controlled fixtures deliberately contain no symlinks.
const paths: string[] = [];
function visit(directory: string): void {
  for (const name of readdirSync(directory)) {
    const absolute = join(directory, name);
    const path = relative(snapshot, absolute);
    if (path === ".superpowers-manager.json") continue;
    paths.push(path);
    const info = lstatSync(absolute);
    assert.ok(
      info.isDirectory() || info.isFile(),
      "fixture must have only regular entries",
    );
    if (info.isDirectory()) visit(absolute);
  }
}
visit(snapshot);
const hash = createHash("sha256");
for (const path of paths.sort()) {
  const absolute = join(snapshot, path);
  const info = lstatSync(absolute);
  for (const bytes of [
    Buffer.from(info.isDirectory() ? "directory" : "file"),
    Buffer.from(path),
    Buffer.from(String(info.isFile() ? info.mode & 0o111 : 0)),
    info.isFile() ? readFileSync(absolute) : Buffer.alloc(0),
  ]) {
    const length = Buffer.alloc(8);
    length.writeBigUInt64BE(BigInt(bytes.length));
    hash.update(length).update(bytes);
  }
}
const digest = hash.digest("hex");
assert.equal(digest, receipt.digest, "snapshot bytes must match the receipt");
const binding = createHash("sha256");
for (const value of [
  String(receipt.schema),
  receipt.manager,
  receipt.harness,
  receipt.source,
  receipt.commit,
  receipt.digest,
]) {
  const bytes = Buffer.from(value);
  const length = Buffer.alloc(8);
  length.writeBigUInt64BE(BigInt(bytes.length));
  binding.update(length).update(bytes);
}
assert.equal(binding.digest("hex"), receipt.binding);
const pkg = JSON.parse(readFileSync(join(snapshot, "package.json"), "utf8"));
assert.equal(pkg.name, "superpowers");
assert.equal(pkg.type, "module");
assert.match(pkg.version, /^\d+\.\d+\.\d+$/);
assert.deepEqual(pkg.pi, {
  extensions: ["./.pi/extensions/superpowers.ts"],
  skills: ["./skills"],
});
for (const field of [
  "dependencies",
  "optionalDependencies",
  "peerDependencies",
  "bundleDependencies",
  "bundledDependencies",
]) {
  assert.ok(pkg[field] === undefined || Object.keys(pkg[field]).length === 0);
}
const bootstrapPath = join(snapshot, ".pi/extensions/superpowers.ts");
assert.equal(lstatSync(bootstrapPath).mode & 0o111, 0);
const bootstrap = readFileSync(bootstrapPath);
assert.equal(bootstrap.length, 4283);
assert.equal(
  createHash("sha256").update(bootstrap).digest("hex"),
  "39c27000c047f8a1399a76e032e4cd239d7bdb0be168a121f46a2ac719deaae0",
);
assert.match(
  readFileSync(join(snapshot, "skills/using-superpowers/SKILL.md"), "utf8"),
  /^---\nname: using-superpowers\n/,
);
assert.match(readFileSync(join(snapshot, "LICENSE"), "utf8"), /MIT License/);
const phaseSkill = join(snapshot, "skills/snapshot-probe/SKILL.md");
assert.ok(
  readFileSync(phaseSkill, "utf8").includes(`Snapshot phase ${phase}.`),
);
if (mode !== "events") {
  console.log(digest);
  process.exit(0);
}

const piRoot = realpathSync(runtimeArgument);
assert.equal(
  piRoot,
  "/opt/spw-test-tools/node_modules/@earendil-works/pi-coding-agent",
);
const runtime = JSON.parse(readFileSync(join(piRoot, "package.json"), "utf8"));
const tools = JSON.parse(
  readFileSync("/opt/spw-test-tools/package.json", "utf8"),
);
assert.equal(
  runtime.version,
  tools.dependencies["@earendil-works/pi-coding-agent"],
);
const api = await import(pathToFileURL(join(piRoot, "dist/index.js")).href);
assert.equal(api.VERSION, runtime.version);
const {
  DefaultResourceLoader,
  SettingsManager,
  SessionManager,
  ModelRuntime,
  ModelRegistry,
  ExtensionRunner,
} = api;
const scratch = mkdtempSync(join(isolated, "observer-"));
try {
  // Persisted local registrations resolve against their actual disposable
  // agentDir. The observer keeps only cwd, auth and session state in scratch.
  const settingsManager = SettingsManager.inMemory(settings, {
    projectTrusted: false,
  });
  const loader = new DefaultResourceLoader({
    cwd: scratch,
    agentDir,
    settingsManager,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
  });
  await loader.reload();
  const loaded = loader.getExtensions();
  assert.deepEqual(loaded.errors, []);
  assert.equal(loaded.extensions.length, 1);
  type Skill = { name: string; filePath: string };
  const skills: Skill[] = loader.getSkills().skills;
  for (const name of ["using-superpowers", "snapshot-probe"]) {
    const matches = skills.filter((skill) => skill.name === name);
    assert.equal(matches.length, 1, `registered skill ${name}`);
    assert.equal(
      realpathSync(matches[0]!.filePath),
      join(snapshot, "skills", name, "SKILL.md"),
    );
  }
  assert.ok(
    readFileSync(
      skills.find((skill) => skill.name === "snapshot-probe")!.filePath,
      "utf8",
    ).includes(`Snapshot phase ${phase}.`),
  );
  const models = await ModelRuntime.create({
    authPath: join(scratch, "auth.json"),
    modelsPath: null,
    refreshOnCreate: false,
  });
  const runner = new ExtensionRunner(
    loaded.extensions,
    loaded.runtime,
    scratch,
    SessionManager.inMemory(scratch),
    new ModelRegistry(models),
  );
  const errors: unknown[] = [];
  runner.onError((error: unknown) => errors.push(error));
  const marker = "superpowers:using-superpowers bootstrap for pi";
  type ProbeMessage = { role?: string; content?: string | { text?: string }[] };
  const text = (message: ProbeMessage): string =>
    typeof message.content === "string"
      ? message.content
      : (message.content ?? []).map((part) => part.text ?? "").join("");
  const count = (messages: ProbeMessage[]): number =>
    messages.filter((message) => text(message).includes(marker)).length;
  const user = {
    role: "user",
    content: [{ type: "text", text: "Continue" }],
    timestamp: 1,
  };
  await runner.emit({ type: "session_start", reason: "startup" });
  let output: ProbeMessage[] = await runner.emitContext([user]);
  assert.equal(count(output), 1);
  assert.equal(count(await runner.emitContext(output)), 1);
  await runner.emit({ type: "agent_end", messages: [] });
  assert.equal(count(await runner.emitContext([user])), 0);
  await runner.emit({
    type: "session_compact",
    fromExtension: false,
    reason: "manual",
    willRetry: false,
    compactionEntry: {
      type: "compaction",
      id: "c",
      parentId: null,
      timestamp: new Date(0).toISOString(),
      summary: "prior",
      firstKeptEntryId: "u",
      tokensBefore: 1,
    },
  });
  const summary = {
    role: "compactionSummary",
    summary: "prior",
    tokensBefore: 1,
    timestamp: 1,
  };
  output = await runner.emitContext([summary, user]);
  assert.equal(output[0]!.role, "compactionSummary");
  assert.equal(count(output), 1);
  assert.ok(text(output[1]!).includes(marker));
  assert.deepEqual(errors, []);
  console.log(
    `pi resource qualification: complete runtime=${runtime.version} phase=${phase} digest=${digest}`,
  );
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
