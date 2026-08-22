// @ts-check

import {
  accessSync,
  chmodSync,
  constants,
  copyFileSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import {
  basename,
  delimiter,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { writeGitEgressShim } from "../lib/git-egress.js";

/**
 * @typedef {{
 *   root: string,
 *   pkg: string,
 *   bin: string,
 *   home: string,
 *   tmp: string,
 *   config: string,
 *   cache: string,
 *   plugin: string,
 *   codex: string,
 *   git: string,
 *   gitConfig: string,
 *   work: string,
 *   codexLog: string,
 *   dispatchLog: string,
 * }} Sandbox
 */

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const FIXTURES = join(ROOT, "tests", "fixtures", "baseline");
/** @type {WeakMap<Sandbox, string>} */
const REGISTERED_SANDBOXES = new WeakMap();
const SANDBOX_TOOLS = [
  "node",
  "sh",
  "git",
  "python3",
  "awk",
  "basename",
  "cat",
  "chmod",
  "cp",
  "cut",
  "dirname",
  "grep",
  "ln",
  "mkdir",
  "mktemp",
  "mv",
  "rm",
  "sed",
  "sort",
  "tail",
  "tr",
];
const COMMANDS = [
  "pin",
  "track-latest",
  "unpin",
  "prepare",
  "probe",
  "install",
  "update",
  "uninstall",
];
// Derived, never restated. A second hand-maintained list can agree with itself
// while disagreeing with the code it describes.
/** @type {typeof import("../../src/cli.js")} */
const { commandRequirements } = await import(
  new URL("../../dist/cli.js", import.meta.url).href
);
const PASSTHROUGH_VARIABLES = [
  "SUPERPOWERS_REF",
  "SUPERPOWERS_UPSTREAM_URL",
  "SUPERPOWERS_CODEX",
  "SUPERPOWERS_CACHE_DIR",
  "SUPERPOWERS_CONFIG_DIR",
  "SUPERPOWERS_PLUGIN_ROOT",
  "SUPERPOWERS_MANIFEST_TEMPLATE",
  "SUPERPOWERS_VALIDATOR",
  "SUPERPOWERS_INSTALLED_SEARCH_ROOT",
  "SUPERPOWERS_INSTALL_REFRESH_MODE",
];
const PATH_ENVIRONMENT_VARIABLES = new Set([
  "HOME",
  "TMPDIR",
  "GIT_CONFIG_GLOBAL",
  "XDG_CONFIG_HOME",
  "SUPERPOWERS_CODEX",
  "SUPERPOWERS_CACHE_DIR",
  "SUPERPOWERS_CONFIG_DIR",
  "SUPERPOWERS_PLUGIN_ROOT",
  "SUPERPOWERS_MANIFEST_TEMPLATE",
  "SUPERPOWERS_VALIDATOR",
  "SUPERPOWERS_INSTALLED_SEARCH_ROOT",
  "SPW_PACKAGE_ROOT",
  "SPW_BASELINE_DISPATCH_LOG",
  "SPW_BASELINE_GIT_LOG",
  "SPW_BASELINE_SANDBOX_ROOT",
  "SPW_BASELINE_VALIDATOR_MARKER",
]);

/**
 * POSIX single-quotes `value` for interpolation into a generated shell
 * script, escaping any embedded single quote as `'\''`. Unlike
 * `JSON.stringify`, the result is inert inside single quotes: `$`, backticks,
 * and literal control characters cannot trigger expansion or re-encode into a
 * different byte sequence.
 * @param {string} value
 */
function shQuote(value) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

/** @param {string} name */
function hostExecutable(name) {
  if (name === "node") return realpathSync(process.execPath);
  for (const directory of (process.env.PATH || "").split(delimiter)) {
    if (!directory) continue;
    const candidate = join(directory, name);
    try {
      accessSync(candidate, constants.X_OK);
    } catch {
      // Keep looking through the host PATH used only during sandbox setup.
      continue;
    }
    if (name === "python3") {
      const result = spawnSync(
        candidate,
        ["-c", "import os,sys; print(os.path.realpath(sys.executable))"],
        { env: process.env, encoding: "utf8" },
      );
      const executable = result.status === 0 ? result.stdout.trim() : "";
      if (!isAbsolute(executable)) {
        throw new Error(
          `unable to resolve an absolute Python executable from host command: ${candidate}`,
        );
      }
      try {
        accessSync(executable, constants.X_OK);
        return realpathSync(executable);
      } catch {
        throw new Error(
          `resolved Python executable is not runnable: ${executable}`,
        );
      }
    }
    try {
      return realpathSync(candidate);
    } catch {
      // Keep looking through the host PATH used only during sandbox setup.
    }
  }
  throw new Error(`required host command not found: ${name}`);
}

/**
 * @param {string} bin
 * @param {string} name
 */
function linkHostTool(bin, name) {
  symlinkSync(hostExecutable(name), join(bin, name));
}

/**
 * @param {string} bin
 * @param {string} name
 */
function assertSandboxHostTool(bin, name) {
  const result = spawnSync(join(bin, name), ["--version"], {
    env: { PATH: bin },
    encoding: "utf8",
  });
  if (result.error || result.status !== 0) {
    throw new Error(
      `sandbox tool setup failed for ${name} under controlled PATH; resolve its host shim to a runnable executable`,
    );
  }
}

/**
 * @param {Sandbox} sandbox
 * @returns {string}
 */
function registeredRoot(sandbox) {
  const root =
    sandbox && typeof sandbox === "object" && REGISTERED_SANDBOXES.get(sandbox);
  if (!root) throw new Error("unregistered sandbox");
  if (sandbox.root !== root) {
    throw new Error("invalid registered sandbox root");
  }
  return root;
}

/**
 * @param {unknown} value
 * @param {string} code
 */
function isErrno(value, code) {
  return (
    value instanceof Error &&
    "code" in value &&
    /** @type {NodeJS.ErrnoException} */ (value).code === code
  );
}

/** @param {string} pathValue */
function pathEntryExists(pathValue) {
  try {
    lstatSync(pathValue);
    return true;
  } catch (error) {
    if (isErrno(error, "ENOENT")) return false;
    throw error;
  }
}

/**
 * @param {string} pathValue
 * @param {string} label
 */
function physicalPath(pathValue, label) {
  let existing = resolve(pathValue);
  /** @type {string[]} */
  const missing = [];
  while (!pathEntryExists(existing)) {
    const parent = dirname(existing);
    if (parent === existing) break;
    missing.unshift(basename(existing));
    existing = parent;
  }
  try {
    return resolve(realpathSync(existing), ...missing);
  } catch (error) {
    if (isErrno(error, "ENOENT")) {
      throw new Error(`${label} contains an unresolvable symlink`);
    }
    throw error;
  }
}

/**
 * @param {Sandbox} sandbox
 * @param {string} pathValue
 * @param {string} label
 * @returns {string}
 */
function assertContainedPath(sandbox, pathValue, label) {
  const root = registeredRoot(sandbox);
  if (typeof pathValue !== "string" || !isAbsolute(pathValue)) {
    throw new Error(`${label} must be an absolute path within sandbox root`);
  }
  const candidate = physicalPath(pathValue, label);
  const fromRoot = relative(root, candidate);
  if (
    fromRoot === ".." ||
    fromRoot.startsWith(`..${sep}`) ||
    isAbsolute(fromRoot)
  ) {
    throw new Error(`${label} resolves outside sandbox root`);
  }
  return pathValue;
}

/**
 * @param {Sandbox} sandbox
 * @param {Record<string, string>} environment
 * @param {string} cwd
 */
function validateEnvironment(sandbox, environment, cwd) {
  if (environment.PATH !== sandbox.bin) {
    throw new Error("PATH must equal the controlled sandbox tool directory");
  }
  if (environment.SPW_BASELINE_SANDBOX_ROOT !== sandbox.root) {
    throw new Error("SPW_BASELINE_SANDBOX_ROOT must equal sandbox root");
  }
  for (const [name, value] of Object.entries(environment)) {
    if (!PATH_ENVIRONMENT_VARIABLES.has(name) || value === "") continue;
    if (
      name === "SUPERPOWERS_CODEX" &&
      !value.includes("/") &&
      !value.includes("\\")
    ) {
      continue;
    }
    assertContainedPath(sandbox, value, name);
  }

  const source = environment.SUPERPOWERS_UPSTREAM_URL;
  if (!source) return;
  if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(source)) {
    if (source.startsWith("file://")) {
      assertContainedPath(
        sandbox,
        fileURLToPath(source),
        "SUPERPOWERS_UPSTREAM_URL",
      );
    }
    return;
  }
  if (/^[^/]+@[^:]+:.+/.test(source)) return;
  assertContainedPath(
    sandbox,
    resolve(cwd, source),
    "SUPERPOWERS_UPSTREAM_URL",
  );
}

/** @param {string} pkg */
function copyRuntimePackage(pkg) {
  mkdirSync(pkg, { recursive: true });
  cpSync(join(ROOT, "bin"), join(pkg, "bin"), { recursive: true });
  cpSync(join(ROOT, "dist"), join(pkg, "dist"), { recursive: true });
  cpSync(join(ROOT, "config"), join(pkg, "config"), { recursive: true });
  copyFileSync(join(ROOT, "package.json"), join(pkg, "package.json"));

  const manifestDirectory = join(
    pkg,
    "plugins",
    "superpowers",
    ".codex-plugin",
  );
  mkdirSync(manifestDirectory, { recursive: true });
  copyFileSync(
    join(
      ROOT,
      "plugins",
      "superpowers",
      ".codex-plugin",
      "plugin.template.json",
    ),
    join(manifestDirectory, "plugin.template.json"),
  );
}

/**
 * @param {Sandbox} sandbox
 * @param {string} [name]
 */
function writeNoopTool(sandbox, name = "codex") {
  registeredRoot(sandbox);
  if (basename(name) !== name) throw new Error("tool name must be a basename");
  const tool = join(sandbox.bin, name);
  assertContainedPath(sandbox, tool, "sandbox tool");
  writeFileSync(tool, "#!/bin/sh\nexit 0\n", "utf8");
  chmodSync(tool, 0o755);
  return tool;
}

// The logging `codex` carries this marker so assertNoCodexContact can prove it
// is the shim on PATH before reading its log. Without that check, "the log is
// empty" and "nothing ever wired a log" are the same observation -- which is
// precisely how the SPW_ADAPTER assertions this replaces became vacuous.
const CODEX_LOG_MARKER = "spw-baseline-codex-log";

/**
 * A `codex` that records every invocation instead of swallowing it.
 *
 * POSIX sh rather than python3 on purpose: PR 11.5 slice 3.4 is the slice that
 * stops requiring Python for `prepare`. Emptiness is the assertion; the
 * recorded argv is for diagnosis when it is not empty.
 *
 * @param {Sandbox} sandbox
 * @returns {string}
 */
function writeCodexLogTool(sandbox) {
  registeredRoot(sandbox);
  const tool = join(sandbox.bin, "codex");
  assertContainedPath(sandbox, tool, "sandbox tool");
  assertContainedPath(sandbox, sandbox.codexLog, "sandbox codex log");
  writeFileSync(
    tool,
    [
      "#!/bin/sh",
      `# ${CODEX_LOG_MARKER}`,
      `printf '%s\\n' "$*" >> ${shQuote(sandbox.codexLog)}`,
      "exit 0",
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
  writeFileSync(sandbox.codexLog, "", "utf8");
  return tool;
}

/**
 * Three ordered checks. The first two are the point: they establish that the
 * channel is live, so an empty log means "wired and never called" rather than
 * "never wired".
 *
 * @param {Sandbox} sandbox
 */
function assertNoCodexContact(sandbox) {
  registeredRoot(sandbox);
  const tool = join(sandbox.bin, "codex");
  if (!existsSync(tool)) {
    throw new Error(
      "assertNoCodexContact: no `codex` on the sandbox PATH; the guard is not wired",
    );
  }
  if (!readFileSync(tool, "utf8").includes(CODEX_LOG_MARKER)) {
    throw new Error(
      "assertNoCodexContact: the sandbox `codex` is not the logging shim; an empty log would prove nothing",
    );
  }
  if (!existsSync(sandbox.codexLog)) {
    throw new Error(
      "assertNoCodexContact: the codex log is missing; the guard is not wired",
    );
  }
  const contacted = readFileSync(sandbox.codexLog, "utf8");
  if (contacted !== "") {
    throw new Error(`assertNoCodexContact: codex was invoked:\n${contacted}`);
  }
}

// The sandbox's `git` refuses any remote with a URL scheme and passes
// everything else through to the real binary — see tests/lib/git-egress.js
// for the shim itself and its design rationale, including its known gaps.

/**
 * @param {{ stubScripts?: boolean }} [_options]
 * @returns {Sandbox}
 */
function createSandbox(_options = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "spw-baseline-")));
  /** @type {Sandbox} */
  let sandbox;
  try {
    sandbox = {
      root,
      pkg: join(root, "pkg"),
      bin: join(root, "bin"),
      home: join(root, "home"),
      tmp: join(root, "tmp"),
      config: join(root, "config"),
      cache: join(root, "cache"),
      plugin: join(root, "pkg", "plugins", "superpowers"),
      codex: join(root, "codex"),
      git: join(root, "git"),
      gitConfig: join(root, "git", "config"),
      work: join(root, "work"),
      codexLog: join(root, "codex.log"),
      dispatchLog: join(root, "dispatch.log"),
    };

    for (const directory of [
      sandbox.bin,
      sandbox.home,
      sandbox.tmp,
      sandbox.config,
      sandbox.cache,
      sandbox.codex,
      sandbox.git,
      sandbox.work,
    ]) {
      mkdirSync(directory, { recursive: true });
    }
    copyRuntimePackage(sandbox.pkg);
    for (const tool of SANDBOX_TOOLS) {
      if (tool === "git") {
        writeGitEgressShim(sandbox.bin, hostExecutable("git"));
        continue;
      }
      linkHostTool(sandbox.bin, tool);
    }
    for (const tool of ["node", "python3", "git"]) {
      assertSandboxHostTool(sandbox.bin, tool);
    }
  } catch (error) {
    try {
      rmSync(root, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors; the original creation error takes priority.
    }
    throw error;
  }
  REGISTERED_SANDBOXES.set(sandbox, root);
  return sandbox;
}

/**
 * @param {Sandbox} sandbox
 * @param {Record<string, string>} [overrides]
 * @param {string} [cwd]
 * @returns {Record<string, string>}
 */
function baseEnvironment(sandbox, overrides = {}, cwd = sandbox.work) {
  assertContainedPath(sandbox, cwd, "working directory");
  const environment = {
    PATH: sandbox.bin,
    HOME: sandbox.home,
    TMPDIR: sandbox.tmp,
    GIT_CONFIG_GLOBAL: sandbox.gitConfig,
    GIT_CONFIG_NOSYSTEM: "1",
    SUPERPOWERS_CONFIG_DIR: sandbox.config,
    SUPERPOWERS_CACHE_DIR: sandbox.cache,
    SUPERPOWERS_PLUGIN_ROOT: sandbox.plugin,
    SUPERPOWERS_MANIFEST_TEMPLATE: join(
      sandbox.pkg,
      "plugins/superpowers/.codex-plugin/plugin.template.json",
    ),
    SUPERPOWERS_INSTALLED_SEARCH_ROOT: sandbox.codex,
    SPW_BASELINE_SANDBOX_ROOT: sandbox.root,
    ...overrides,
  };
  validateEnvironment(sandbox, environment, cwd);
  return environment;
}

/**
 * @param {Sandbox} sandbox
 * @param {string[]} [args]
 * @param {Record<string, string>} [overrides]
 * @param {{ cwd?: string }} [options]
 */
function runCli(sandbox, args = [], overrides = {}, options = {}) {
  const cwd = options.cwd || sandbox.work;
  assertContainedPath(sandbox, cwd, "working directory");
  return spawnSync(
    join(sandbox.bin, "node"),
    [join(sandbox.pkg, "bin", "superpowers-manager.js"), ...args],
    {
      cwd,
      env: baseEnvironment(sandbox, overrides, cwd),
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
    },
  );
}

/**
 * @param {Sandbox} sandbox
 * @param {string} command
 * @param {string} destination
 * @param {Record<string, string>} [overrides]
 */
function runScenario(sandbox, command, destination, overrides = {}) {
  assertContainedPath(sandbox, destination, "scenario destination");
  return spawnSync(
    join(sandbox.bin, "sh"),
    [
      join(ROOT, "tests", "builders", "baseline-scenario.sh"),
      command,
      destination,
    ],
    {
      cwd: sandbox.work,
      env: baseEnvironment(sandbox, overrides),
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
    },
  );
}

/** @param {Sandbox} sandbox */
function readDispatchLog(sandbox) {
  registeredRoot(sandbox);
  if (!existsSync(sandbox.dispatchLog)) return [];
  const text = readFileSync(sandbox.dispatchLog, "utf8");
  return text
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

/** @param {Sandbox} sandbox */
function clearDispatchLog(sandbox) {
  registeredRoot(sandbox);
  writeFileSync(sandbox.dispatchLog, "", "utf8");
}

/**
 * @param {Sandbox} sandbox
 * @param {string} name
 */
function removeTool(sandbox, name) {
  registeredRoot(sandbox);
  if (basename(name) !== name) throw new Error("tool name must be a basename");
  const tool = join(sandbox.bin, name);
  if (existsSync(tool)) unlinkSync(tool);
}

/** @param {Sandbox} sandbox */
function destroySandbox(sandbox) {
  const root = registeredRoot(sandbox);
  assertContainedPath(sandbox, root, "sandbox deletion target");
  REGISTERED_SANDBOXES.delete(sandbox);
  rmSync(root, { recursive: true, force: true });
}

/** @param {...string} parts */
function fixturePath(...parts) {
  return join(FIXTURES, ...parts);
}

export {
  COMMANDS,
  PASSTHROUGH_VARIABLES,
  assertNoCodexContact,
  baseEnvironment,
  clearDispatchLog,
  commandRequirements,
  createSandbox,
  destroySandbox,
  fixturePath,
  readDispatchLog,
  removeTool,
  runCli,
  runScenario,
  writeCodexLogTool,
  writeNoopTool,
};
