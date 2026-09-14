#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  existsSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer, type Server } from "node:http";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parse, type ParseError } from "jsonc-parser";

const ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const FIXTURES = join(ROOT, "tests/fixtures");
const MAX_BODY = 1024 * 1024;
const MAX_OUTPUT = 256 * 1024;
const MAX_REQUESTS = 8;
const SKILL = "snapshot-probe";
const FIXTURE_PROMPT = "Complete the qualification.";
const TOOL_CALL_ID = "fixture-skill";
const CONFIG_SEED = "/opt/spw-opencode-config-seed";
const CACHE_SEED = "/opt/spw-opencode-cache-seed";
const markers = { A: "SNAPSHOT_A", B: "SNAPSHOT_B" } as const;
type Marker = keyof typeof markers | "absent";

function stripFrontmatter(content: string): string {
  const match = content.match(/^---\n[\s\S]*?\n---\n([\s\S]*)$/);
  return (match?.[1] ?? content).trim();
}

const BOOTSTRAP_SKILL_BODY = stripFrontmatter(
  readFileSync(join(FIXTURES, "pi-native/SKILL.md.txt"), "utf8"),
);

function check(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}

function cleanEnvironment(root: string): NodeJS.ProcessEnv {
  const bin = dirname(
    process.env.SUPERPOWERS_OPENCODE ??
      "/opt/spw-test-tools/node_modules/.bin/opencode",
  );
  return {
    HOME: join(root, "home"),
    PATH: `${bin}:/usr/local/bin:/usr/bin:/bin`,
    XDG_CONFIG_HOME: join(root, "config"),
    XDG_DATA_HOME: join(root, "data"),
    XDG_CACHE_HOME: join(root, "cache"),
    XDG_STATE_HOME: join(root, "state"),
    OPENCODE_DISABLE_AUTOUPDATE: "1",
    OPENCODE_DISABLE_MODELS_FETCH: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
  };
}

function provisionConfig(root: string): void {
  check(
    existsSync(join(CONFIG_SEED, "package-lock.json")),
    "native config dependency seed is missing",
  );
  check(
    existsSync(
      join(CONFIG_SEED, "node_modules/@opencode-ai/plugin/package.json"),
    ),
    "native config SDK seed is incomplete",
  );
  cpSync(CONFIG_SEED, join(root, "config/opencode"), { recursive: true });
  check(
    existsSync(join(CACHE_SEED, "opencode/bin/rg")),
    "native ripgrep seed is missing",
  );
  cpSync(CACHE_SEED, join(root, "cache"), { recursive: true });
}

async function runNative(
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv; abort?: () => boolean },
): Promise<string> {
  const executable = process.env.SUPERPOWERS_OPENCODE ?? "opencode";
  const child = spawn(executable, args, {
    cwd: options.cwd,
    env: options.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let bytes = 0;
  let timedOut = false;
  let stderr = "";
  let stdout = "";
  child.stdout.on("data", (chunk: Buffer) => {
    bytes += chunk.length;
    if (stdout.length < MAX_OUTPUT) stdout += chunk.toString("utf8");
    if (bytes > MAX_OUTPUT) child.kill("SIGKILL");
  });
  child.stderr.on("data", (chunk: Buffer) => {
    bytes += chunk.length;
    if (stderr.length < 32_768) stderr += chunk.toString("utf8");
    if (bytes > MAX_OUTPUT) child.kill("SIGKILL");
  });
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill("SIGKILL");
  }, 30_000);
  const abort = setInterval(() => {
    if (options.abort?.()) child.kill("SIGKILL");
  }, 25);
  const result = await new Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
  }>((done, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => done({ code, signal }));
  }).finally(() => {
    clearTimeout(timer);
    clearInterval(abort);
  });
  if (process.env.SPW_NATIVE_DIAGNOSTIC && stderr) {
    writeFileSync(
      process.env.SPW_NATIVE_DIAGNOSTIC,
      stderr.slice(0, MAX_OUTPUT),
    );
  }
  const diagnostic = stderr
    .replaceAll("inert-fixture-token", "<redacted>")
    .replaceAll(options.env.HOME ?? "", "<home>")
    .replace(/[\r\n]+/g, " ")
    .slice(-500);
  check(!timedOut, `native OpenCode timed out: ${diagnostic}`);
  check(bytes <= MAX_OUTPUT, "native OpenCode output exceeded limit");
  check(
    result.code === 0,
    `native OpenCode failed status=${result.code ?? result.signal ?? "unknown"}: ${diagnostic}`,
  );
  return stdout;
}

function parseConfig(file: string): Record<string, unknown> {
  const errors: ParseError[] = [];
  const value: unknown = parse(readFileSync(file, "utf8"), errors, {
    allowTrailingComma: true,
  });
  check(errors.length === 0, "native config is not valid JSONC");
  check(
    value !== null && typeof value === "object" && !Array.isArray(value),
    "native config root is not an object",
  );
  return value as Record<string, unknown>;
}

function globalConfig(env: NodeJS.ProcessEnv): string | undefined {
  const dir = join(env.XDG_CONFIG_HOME!, "opencode");
  return [join(dir, "opencode.jsonc"), join(dir, "opencode.json")].find(
    existsSync,
  );
}

function registrations(env: NodeJS.ProcessEnv): {
  file?: string;
  values: string[];
} {
  const file = globalConfig(env);
  if (!file) return { values: [] };
  const plugin = parseConfig(file).plugin;
  if (plugin === undefined) return { file, values: [] };
  check(Array.isArray(plugin), "native plugin config is not an array");
  const values = plugin.map((entry) => {
    if (typeof entry === "string") return entry;
    check(
      Array.isArray(entry) &&
        entry.length === 2 &&
        typeof entry[0] === "string" &&
        entry[1] !== null &&
        typeof entry[1] === "object" &&
        !Array.isArray(entry[1]),
      "unsupported native plugin entry",
    );
    return entry[0];
  });
  return { file, values };
}

function allText(value: unknown): string {
  return JSON.stringify(value);
}

function stringValues(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(stringValues);
  if (value && typeof value === "object")
    return Object.values(value).flatMap(stringValues);
  return [];
}

function responseChunk(delta: unknown, finish: string | null) {
  return {
    id: "fixture-completion",
    object: "chat.completion.chunk",
    created: 0,
    model: "probe",
    choices: [{ index: 0, delta, finish_reason: finish }],
  };
}

function frame(value: unknown): string {
  return `data: ${JSON.stringify(value)}\n\n`;
}

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const address = server.address();
  check(
    address && typeof address === "object",
    "fixture server has no address",
  );
  return address.port;
}

async function close(server: Server): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  const closed = new Promise<void>((done, reject) => {
    server.close((error) => (error ? reject(error) : done()));
    server.closeAllConnections();
  });
  const bounded = new Promise<never>((_done, reject) => {
    timer = setTimeout(
      () => reject(new Error("fixture server close timed out")),
      1_000,
    );
  });
  try {
    await Promise.race([closed, bounded]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function observe(installedRoot: string, expected: Marker): Promise<void> {
  check(isAbsolute(installedRoot), "installed root must be absolute");
  check(
    expected === "absent" || expected in markers,
    "expected marker must be A, B, or absent",
  );
  const root = process.env.SPW_OPENCODE_PROBE_ROOT;
  check(root && isAbsolute(root), "observer requires a disposable probe root");
  const env = cleanEnvironment(root);
  const registration = registrations(env);
  const canonical = existsSync(installedRoot)
    ? realpathSync(installedRoot)
    : resolve(installedRoot);
  const owned = registration.values.filter(
    (value) => resolve(value) === canonical,
  );
  if (expected === "absent")
    check(owned.length === 0, "installed root remains registered");
  else
    check(owned.length === 1, "installed root is not registered exactly once");

  const observations = {
    requests: 0,
    incidentalRequests: 0,
    mainInitialRequests: 0,
    mainResultRequests: 0,
    correlatedToolMessages: 0,
    resultAfterEmittedCall: false,
    bootstrap: false,
    advertisedSkillTool: false,
    advertisedSnapshot: false,
    toolResult: null as "A" | "B" | null,
  };
  let emittedToolCall = false;
  const server = createServer((request, response) => {
    observations.requests += 1;
    if (observations.requests > MAX_REQUESTS) {
      request.destroy();
      return;
    }
    let size = 0;
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY) request.destroy();
      else chunks.push(chunk);
    });
    request.on("end", () => {
      check(request.method === "POST", "unexpected fixture request method");
      check(
        request.url?.endsWith("/chat/completions"),
        "unexpected fixture request path",
      );
      const body: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      const tools =
        (body as { tools?: Array<{ function?: { name?: string } }> }).tools ??
        [];
      const messages =
        (
          body as {
            messages?: Array<{
              role?: string;
              content?: unknown;
              tool_call_id?: string;
            }>;
          }
        ).messages ?? [];
      const messageText = stringValues(messages).join("\n");
      const main = messages.some(
        (message) =>
          message.role === "user" &&
          stringValues(message.content).some((text) =>
            text.includes(FIXTURE_PROMPT),
          ),
      );
      const correlated = messages.filter(
        (message) =>
          message.role === "tool" && message.tool_call_id === TOOL_CALL_ID,
      );
      response.writeHead(200, { "content-type": "text/event-stream" });
      if (!main) {
        observations.incidentalRequests += 1;
        response.write(
          frame(responseChunk({ content: "fixture complete" }, null)),
        );
        response.write(frame(responseChunk({}, "stop")));
      } else if (correlated.length === 0) {
        observations.mainInitialRequests += 1;
        observations.bootstrap = messageText.includes(BOOTSTRAP_SKILL_BODY);
        observations.advertisedSnapshot = messageText.includes(SKILL);
        observations.advertisedSkillTool = tools.some(
          (tool) => tool.function?.name === "skill",
        );
        if (expected === "absent" || emittedToolCall) {
          response.write(
            frame(responseChunk({ content: "fixture complete" }, null)),
          );
          response.write(frame(responseChunk({}, "stop")));
        } else {
          emittedToolCall = true;
          const toolCall = {
            tool_calls: [
              {
                index: 0,
                id: TOOL_CALL_ID,
                type: "function",
                function: {
                  name: "skill",
                  arguments: JSON.stringify({ name: SKILL }),
                },
              },
            ],
          };
          response.write(frame(responseChunk(toolCall, null)));
          response.write(frame(responseChunk({}, "tool_calls")));
        }
      } else {
        observations.mainResultRequests += 1;
        observations.correlatedToolMessages = correlated.length;
        observations.resultAfterEmittedCall = emittedToolCall;
        const toolText = stringValues(
          correlated.map((message) => message.content),
        ).join("\n");
        if (toolText.includes(markers.A)) observations.toolResult = "A";
        if (toolText.includes(markers.B)) observations.toolResult = "B";
        response.write(
          frame(responseChunk({ content: "fixture complete" }, null)),
        );
        response.write(frame(responseChunk({}, "stop")));
      }
      response.end("data: [DONE]\n\n");
    });
  });
  const port = await listen(server);
  const config = {
    $schema: "https://opencode.ai/config.json",
    model: "fixture/probe",
    small_model: "fixture/probe",
    enabled_providers: ["fixture"],
    permission: { skill: "allow" },
    provider: {
      fixture: {
        npm: "@ai-sdk/openai-compatible",
        name: "Offline fixture",
        options: {
          baseURL: `http://127.0.0.1:${port}/v1`,
          apiKey: "inert-fixture-token",
        },
        models: {
          probe: { name: "Probe", limit: { context: 32768, output: 2048 } },
        },
      },
    },
  };
  env.OPENCODE_CONFIG_CONTENT = JSON.stringify(config);
  try {
    try {
      await runNative(
        [
          "--print-logs",
          "--log-level",
          "DEBUG",
          "run",
          "--model",
          "fixture/probe",
          "--title",
          "native qualification",
          FIXTURE_PROMPT,
        ],
        {
          cwd: join(root, "project"),
          env,
          abort: () => observations.requests > MAX_REQUESTS,
        },
      );
    } catch (error) {
      const cause =
        error instanceof Error ? error.message : "unknown native failure";
      throw new Error(
        `native run failed requests=${observations.requests} bootstrap=${observations.bootstrap} skillTool=${observations.advertisedSkillTool} snapshot=${observations.advertisedSnapshot} result=${observations.toolResult}: ${cause}`,
      );
    }
  } finally {
    await close(server);
  }
  check(
    observations.requests >= 1,
    "native OpenCode did not reach the fixture provider",
  );
  check(
    observations.mainInitialRequests === 1,
    "fixture did not observe exactly one initial main request",
  );
  if (expected === "absent") {
    check(!observations.bootstrap, "bootstrap loaded without registration");
    check(
      !observations.advertisedSnapshot,
      "snapshot skill loaded without registration",
    );
    check(
      observations.toolResult === null,
      "snapshot skill ran without registration",
    );
    check(
      observations.mainResultRequests === 0,
      "unregistered request returned a tool result",
    );
  } else {
    check(observations.bootstrap, "registered bootstrap was not loaded");
    check(
      observations.advertisedSkillTool,
      "native skill tool was not advertised",
    );
    check(
      observations.advertisedSnapshot,
      "registered snapshot skill was not advertised",
    );
    check(
      observations.toolResult === expected,
      "native skill result returned the wrong snapshot marker",
    );
    check(
      observations.mainResultRequests === 1,
      "fixture did not observe one correlated tool result request",
    );
    check(
      observations.correlatedToolMessages === 1 &&
        observations.resultAfterEmittedCall,
      "tool result did not correlate to the emitted call",
    );
    check(
      allText(observations).length < 1024,
      "observer report exceeded limit",
    );
  }
  console.log(
    JSON.stringify({
      mode: "observe",
      expected,
      registration: registration.file ?? null,
      ...observations,
    }),
  );
}

function materialize(packageRoot: string, marker: "A" | "B"): void {
  mkdirSync(join(packageRoot, ".opencode/plugins"), { recursive: true });
  mkdirSync(join(packageRoot, "skills/using-superpowers"), { recursive: true });
  mkdirSync(join(packageRoot, "skills/snapshot-probe"), { recursive: true });
  for (const [source, target] of [
    ["opencode-native/bootstrap.js.txt", ".opencode/plugins/superpowers.js"],
    ["pi-native/package.json.txt", "package.json"],
    ["pi-native/SKILL.md.txt", "skills/using-superpowers/SKILL.md"],
    ["pi-native/LICENSE.txt", "LICENSE"],
  ] as const) {
    writeFileSync(
      join(packageRoot, target),
      readFileSync(join(FIXTURES, source)),
    );
  }
  writeFileSync(
    join(packageRoot, "skills/snapshot-probe/SKILL.md"),
    `---\nname: snapshot-probe\ndescription: Inert native qualification marker\n---\n\n${markers[marker]}\n`,
  );
}

function phaseB(skill: string): void {
  const original = readFileSync(skill, "utf8");
  check(original.includes(markers.A), "fixture phase A marker is missing");
  writeFileSync(skill, original.replaceAll(markers.A, markers.B));
}

async function resolvedConfig(
  root: string,
  cwd: string,
  label: string,
  extra: NodeJS.ProcessEnv = {},
): Promise<Record<string, unknown>> {
  let output: string;
  try {
    output = await runNative(["debug", "config"], {
      cwd,
      env: { ...cleanEnvironment(root), ...extra },
    });
  } catch (error) {
    throw new Error(
      `matrix ${label}: ${error instanceof Error ? error.message : "native debug failed"}`,
    );
  }
  const value: unknown = JSON.parse(output);
  check(
    value !== null && typeof value === "object" && !Array.isArray(value),
    "debug config did not return an object",
  );
  console.error(`opencode native matrix: ${label} observed`);
  return value as Record<string, unknown>;
}

async function configurationMatrix(
  parent: string,
): Promise<Record<string, unknown>> {
  const root = join(parent, "matrix");
  const installed = join(root, "installed");
  const prepared = join(root, "prepared");
  const project = join(root, "project");
  materialize(installed, "A");
  materialize(prepared, "B");
  mkdirSync(project, { recursive: true });
  provisionConfig(root);
  const dir = join(root, "config/opencode");
  const installedUrl = pathToFileURL(installed).href;
  const json = join(dir, "opencode.json");
  const jsonc = join(dir, "opencode.jsonc");
  const write = (file: string, value: string) => writeFileSync(file, value);

  write(json, `${JSON.stringify({ username: "json" }, null, 2)}\n`);
  await runNative(["plugin", installed, "--global"], {
    cwd: project,
    env: cleanEnvironment(root),
  });
  assert.deepEqual(parseConfig(json).plugin, [installed]);
  assert.equal(existsSync(jsonc), false);
  let config = await resolvedConfig(root, project, "fresh-json");
  assert.equal(config.username, "json");
  assert.deepEqual(config.plugin, [installedUrl]);

  rmSync(json);
  write(jsonc, `{// retained fixture comment\n  "username": "jsonc",\n}\n`);
  await runNative(["plugin", installed, "--global"], {
    cwd: project,
    env: cleanEnvironment(root),
  });
  const installedJsonc = readFileSync(jsonc, "utf8");
  check(
    installedJsonc.includes("// retained fixture comment"),
    "native install removed an unrelated JSONC comment",
  );
  check(
    installedJsonc.includes('"username": "jsonc"'),
    "native install removed an unrelated JSONC field",
  );
  check(
    installedJsonc.includes(JSON.stringify(installed)),
    "native install omitted the JSONC registration",
  );
  await runNative(["plugin", installed, "--global"], {
    cwd: project,
    env: cleanEnvironment(root),
  });
  assert.equal(
    readFileSync(jsonc, "utf8"),
    installedJsonc,
    "unchanged native registration rewrote JSONC",
  );
  config = await resolvedConfig(root, project, "jsonc");
  assert.equal(config.username, "jsonc");
  assert.deepEqual(config.plugin, [installedUrl]);

  write(
    json,
    `${JSON.stringify({ username: "json", plugin: [prepared] }, null, 2)}\n`,
  );
  config = await resolvedConfig(root, project, "both-global-files");
  assert.equal(config.username, "jsonc");
  check(
    Array.isArray(config.plugin) && config.plugin.length === 1,
    "global plugin identity was not deduplicated",
  );

  const explicit = join(root, "explicit.jsonc");
  write(explicit, `{"username":"explicit",}\n`);
  config = await resolvedConfig(root, project, "explicit", {
    OPENCODE_CONFIG: explicit,
  });
  assert.equal(config.username, "explicit");

  const projectConfig = join(project, "opencode.json");
  write(projectConfig, `${JSON.stringify({ username: "project" })}\n`);
  config = await resolvedConfig(root, project, "project", {
    OPENCODE_CONFIG: explicit,
  });
  assert.equal(config.username, "project");

  config = await resolvedConfig(root, project, "inline", {
    OPENCODE_CONFIG: explicit,
    OPENCODE_CONFIG_CONTENT: JSON.stringify({ username: "inline" }),
  });
  assert.equal(config.username, "inline");

  const override = join(root, "override");
  cpSync(CONFIG_SEED, override, { recursive: true });
  write(join(override, "opencode.jsonc"), `{"username":"directory",}\n`);
  config = await resolvedConfig(root, project, "config-dir", {
    OPENCODE_CONFIG_DIR: override,
  });
  assert.equal(config.username, "directory");

  const configDirWriteRoot = join(root, "config-dir-write");
  const configDirWriteProject = join(configDirWriteRoot, "project");
  const configDirWriteOverride = join(configDirWriteRoot, "override");
  mkdirSync(configDirWriteProject, { recursive: true });
  provisionConfig(configDirWriteRoot);
  cpSync(CONFIG_SEED, configDirWriteOverride, { recursive: true });
  write(
    join(configDirWriteOverride, "opencode.jsonc"),
    `{"username":"directory-write",}\n`,
  );
  const configDirWriteEnv = {
    ...cleanEnvironment(configDirWriteRoot),
    OPENCODE_CONFIG_DIR: configDirWriteOverride,
  };
  await runNative(["plugin", installed, "--global"], {
    cwd: configDirWriteProject,
    env: configDirWriteEnv,
  });
  const writtenGlobal = globalConfig(configDirWriteEnv);
  check(
    writtenGlobal,
    "OPENCODE_CONFIG_DIR write case did not create global config",
  );
  check(
    writtenGlobal.startsWith(join(configDirWriteRoot, "config/opencode")),
    "native global writer followed OPENCODE_CONFIG_DIR",
  );
  assert.deepEqual(parseConfig(writtenGlobal).plugin, [installed]);
  assert.equal(
    parseConfig(join(configDirWriteOverride, "opencode.jsonc")).plugin,
    undefined,
  );

  rmSync(json);
  rmSync(jsonc);
  rmSync(projectConfig);
  write(
    json,
    `${JSON.stringify({ plugin: [installed, pathToFileURL(installed).href] })}\n`,
  );
  config = await resolvedConfig(root, project, "aliases");
  check(
    Array.isArray(config.plugin) && config.plugin.length === 1,
    "path and file URL aliases were not deduplicated",
  );

  rmSync(json);
  const projectOpencode = join(project, ".opencode");
  cpSync(CONFIG_SEED, projectOpencode, { recursive: true });
  const legacyDir = join(projectOpencode, "plugins");
  mkdirSync(legacyDir, { recursive: true });
  const legacy = join(legacyDir, "superpowers.js");
  symlinkSync(join(installed, ".opencode/plugins/superpowers.js"), legacy);
  config = await resolvedConfig(root, project, "legacy-symlink");
  check(
    Array.isArray(config.plugin) &&
      config.plugin.some((entry) => allText(entry).includes("superpowers.js")),
    "legacy plugin symlink was not discovered",
  );

  return {
    freshJson: true,
    jsonc: true,
    bothGlobalFiles: true,
    xdg: true,
    explicit: true,
    configDir: true,
    configDirWriteTarget: true,
    inline: true,
    project: true,
    aliases: true,
    legacySymlink: true,
  };
}

async function runObserver(
  script: string,
  root: string,
  installed: string,
  expected: Marker,
  expectedFailure?: string,
) {
  const child = spawn(
    process.execPath,
    [script, "observe", installed, expected],
    {
      cwd: join(root, "project"),
      env: {
        ...cleanEnvironment(root),
        SPW_CONTAINER: "1",
        SPW_OPENCODE_PROBE_ROOT: root,
        ...(process.env.SPW_NATIVE_DIAGNOSTIC
          ? { SPW_NATIVE_DIAGNOSTIC: process.env.SPW_NATIVE_DIAGNOSTIC }
          : {}),
      },
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
    },
  );
  let bytes = 0;
  let stderr = "";
  let termination: "timeout" | "overflow" | undefined;
  const terminate = () => {
    if (!child.pid) return;
    try {
      if (process.platform !== "win32") process.kill(-child.pid, "SIGKILL");
      else child.kill("SIGKILL");
    } catch {
      child.kill("SIGKILL");
    }
  };
  const account = (chunk: Buffer) => {
    bytes += chunk.length;
    if (bytes <= MAX_OUTPUT || termination) return;
    termination = "overflow";
    terminate();
  };
  child.stdout.on("data", account);
  child.stderr.on("data", (chunk: Buffer) => {
    account(chunk);
    if (stderr.length < 500) stderr += chunk.toString("utf8");
  });
  const timer = setTimeout(() => {
    if (termination) return;
    termination = "timeout";
    terminate();
  }, 35_000);
  const code = await new Promise<number | null>((done, reject) => {
    child.once("error", reject);
    child.once("exit", done);
  }).finally(() => clearTimeout(timer));
  check(termination !== "timeout", "observer timed out");
  check(termination !== "overflow", "observer output exceeded limit");
  const diagnostic = stderr.replace(/[\r\n]/g, " ").slice(0, 300);
  if (expectedFailure) {
    check(code !== 0, "negative control passed");
    check(
      stderr.includes(expectedFailure),
      `negative control failed unexpectedly: ${diagnostic}`,
    );
    return;
  }
  check(code === 0, `observer unexpectedly failed: ${diagnostic}`);
}

async function qualification(): Promise<void> {
  check(
    process.env.SPW_CONTAINER === "1" && process.getuid?.() === 10001,
    "qualification requires container UID 10001",
  );
  const root = mkdtempSync("/tmp/spw-opencode-");
  const script = fileURLToPath(import.meta.url);
  const installed = join(root, "installed");
  const prepared = join(root, "prepared");
  mkdirSync(join(root, "project"), { recursive: true });
  mkdirSync(join(root, "home"), { recursive: true });
  const env = cleanEnvironment(root);
  try {
    materialize(installed, "A");
    materialize(prepared, "A");
    provisionConfig(root);
    await runObserver(script, root, installed, "absent");
    await runObserver(
      script,
      root,
      installed,
      "A",
      "installed root is not registered exactly once",
    );
    await runNative(["plugin", installed, "--global"], {
      cwd: join(root, "project"),
      env,
    });
    const registration = registrations(env);
    check(registration.file, "native installer did not write a global config");
    assert.deepEqual(registration.values, [installed]);
    await runObserver(script, root, installed, "A");
    const stringRegistration = readFileSync(registration.file, "utf8");
    const tupleRegistration = parseConfig(registration.file);
    tupleRegistration.plugin = [[installed, { qualification: "tuple" }]];
    writeFileSync(
      registration.file,
      `${JSON.stringify(tupleRegistration, null, 2)}\n`,
    );
    assert.deepEqual(registrations(env).values, [installed]);
    await runObserver(script, root, installed, "A");
    tupleRegistration.plugin = [[installed, {}, "extra"]];
    writeFileSync(
      registration.file,
      `${JSON.stringify(tupleRegistration, null, 2)}\n`,
    );
    await runObserver(
      script,
      root,
      installed,
      "A",
      "unsupported native plugin entry",
    );
    writeFileSync(registration.file, stringRegistration);
    await runObserver(
      script,
      root,
      installed,
      "B",
      "native skill result returned the wrong snapshot marker",
    );

    const original = readFileSync(registration.file, "utf8");
    writeFileSync(registration.file, original.replace(installed, prepared));
    await runObserver(
      script,
      root,
      installed,
      "A",
      "installed root is not registered exactly once",
    );
    writeFileSync(registration.file, original);

    const skill = join(installed, "skills/snapshot-probe/SKILL.md");
    writeFileSync(
      skill,
      readFileSync(skill, "utf8").replace(markers.A, markers.B),
    );
    await runObserver(script, root, installed, "B");

    const config = parseConfig(registration.file);
    check(Array.isArray(config.plugin), "native plugin config disappeared");
    config.plugin = config.plugin.filter((entry) => entry !== installed);
    writeFileSync(registration.file, `${JSON.stringify(config, null, 2)}\n`);
    await runObserver(script, root, installed, "absent");
    await runObserver(
      script,
      root,
      installed,
      "B",
      "installed root is not registered exactly once",
    );
    const matrix = await configurationMatrix(root);
    console.log(
      JSON.stringify({
        mode: "qualification",
        status: "passed",
        registration: registration.file,
        value: installed,
        matrix,
      }),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

try {
  const [mode, installed, expected] = process.argv.slice(2);
  if (mode === "qualification") await qualification();
  else if (mode === "fixture-create" && installed && expected === undefined)
    materialize(installed, "A");
  else if (mode === "fixture-phase-b" && installed && expected === undefined)
    phaseB(installed);
  else if (mode === "observe" && installed && expected)
    await observe(installed, expected as Marker);
  else
    throw new Error(
      "usage: native-probe.ts qualification | fixture-create <root> | fixture-phase-b <skill> | observe <absolute-root> <A|B|absent>",
    );
} catch (error) {
  const message =
    error instanceof Error ? error.message : "unknown qualification failure";
  console.error(
    `opencode native qualification: ${message.replace(/[\r\n]/g, " ").slice(0, 300)}`,
  );
  process.exitCode = 1;
}
