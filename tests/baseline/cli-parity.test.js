// @ts-check

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, delimiter, dirname, join, relative } from "node:path";
import test from "node:test";

import {
  COMMANDS,
  DISPATCH,
  IN_PROCESS_COMMANDS,
  PASSTHROUGH_VARIABLES,
  assertNoCodexContact,
  assertSeamRetired,
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
  writeAdapterState,
  writeCodexLogTool,
  writeNoopTool,
} from "./support.js";
import { createCase, UPSTREAM } from "../bin/lifecycle-fixture.js";
// From the NON-TEST helper, not from probe.test.js: importing a *.test.js
// module re-executes and re-registers its tests inside this suite
// (tests/run-node-suites.js:15).
import { caseEnv, seedCodex } from "./probe-fixture.js";
import { capture } from "../unit/helpers/command-harness.js";

/** @type {typeof import("../../src/commands/probe.js")} */
const { runProbe } = await import(
  new URL("../../dist/commands/probe.js", import.meta.url).href
);

/** @typedef {import('./support.js').Sandbox} Sandbox */

const USAGE = `usage: superpowers-manager [command] [args...]

Selection commands (save intent only; they do not prepare or install it):
  pin REF       save an exact upstream release tag or commit
  track-latest  save selection of the latest stable upstream release
  unpin         remove the saved selection and return to the packaged fallback

Apply and lifecycle commands:
  prepare    fetch the pinned upstream ref and generate the plugin tree
  probe      report upstream/generated/installed status (accepts --porcelain)
  install    register this package root as a Codex marketplace and install the plugin
  update     probe, then prepare/install only if needed (default when no subcommand)
  uninstall  remove the manager plugin and marketplace from Codex

Environment overrides (passed through to the scripts): SUPERPOWERS_REF,
SUPERPOWERS_UPSTREAM_URL, SUPERPOWERS_CODEX, SUPERPOWERS_CACHE_DIR,
SUPERPOWERS_CONFIG_DIR, XDG_CONFIG_HOME,
SUPERPOWERS_PLUGIN_ROOT, SUPERPOWERS_MANIFEST_TEMPLATE,
SUPERPOWERS_VALIDATOR,
SUPERPOWERS_INSTALLED_SEARCH_ROOT, SUPERPOWERS_INSTALL_REFRESH_MODE

Selection state uses SUPERPOWERS_CONFIG_DIR when set; otherwise it uses
$XDG_CONFIG_HOME/superpowers-manager, then $HOME/.config/superpowers-manager.
`;

/**
 * @template T
 * @param {{ stubScripts?: boolean }} options
 * @param {(sandbox: Sandbox) => T} callback
 * @returns {T}
 */
function withSandbox(options, callback) {
  const sandbox = createSandbox(options);
  try {
    return callback(sandbox);
  } finally {
    destroySandbox(sandbox);
  }
}

/**
 * @param {Sandbox} sandbox
 * @param {Record<string, string>} [overrides]
 */
function dispatchEnvironment(sandbox, overrides = {}) {
  return {
    SPW_ADAPTER: sandbox.adapter,
    SPW_BASELINE_DISPATCH_LOG: sandbox.dispatchLog,
    ...overrides,
  };
}

/**
 * @param {import('node:child_process').SpawnSyncReturns<string>} result
 * @param {number} [status]
 */
function assertCleanResult(result, status = 0) {
  assert.equal(result.error, undefined);
  assert.equal(result.signal, null);
  assert.equal(result.status, status);
}

/**
 * @param {Sandbox} sandbox
 * @param {string} command
 * @param {string[]} argv
 */
function assertOnlyDispatch(sandbox, command, argv) {
  assert.deepEqual(
    readDispatchLog(sandbox).map(({ command: name, argv: args }) => ({
      command: name,
      argv: args,
    })),
    [{ command, argv }],
  );
}

/**
 * @param {Sandbox} sandbox
 * @param {string[]} args
 * @param {string[]} unsetNames
 * @param {Record<string, string>} [overrides]
 */
function runCliWithoutEnvironment(sandbox, args, unsetNames, overrides = {}) {
  assertSeamRetired(args, overrides);
  const environment = baseEnvironment(sandbox, overrides);
  for (const name of unsetNames) delete environment[name];
  return spawnSync(
    join(sandbox.bin, "node"),
    [join(sandbox.pkg, "bin", "superpowers-manager.js"), ...args],
    {
      cwd: sandbox.work,
      env: environment,
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
    },
  );
}

/** @param {import('node:child_process').SpawnSyncReturns<string>} result */
function scenarioValues(result) {
  assertCleanResult(result);
  return Object.fromEntries(
    result.stdout
      .trimEnd()
      .split("\n")
      .map((line) => {
        const separator = line.indexOf("=");
        assert.notEqual(separator, -1, `scenario line lacks '=': ${line}`);
        return [line.slice(0, separator), line.slice(separator + 1)];
      }),
  );
}

/**
 * @param {Sandbox} sandbox
 * @param {string} [name]
 */
function createReleaseRepo(sandbox, name = "upstream") {
  const upstream = join(sandbox.root, name);
  return scenarioValues(runScenario(sandbox, "git-release-repo", upstream));
}

/**
 * A `codex` that answers the two listing commands the in-process probe's
 * adapter views issue (`src/adapter.ts:781`, `:855`, `:867` — the argument
 * arrays at the call sites, matching how `tests/bin/lifecycle-fakes.js` and
 * `tests/migration-inventory/probe.md` cite them) with empty inventories, and
 * rejects anything else. `writeNoopTool`'s `exit 0` stub is
 * enough for a preflight lookup but not for a command that actually reads
 * Codex state: probe fails closed on its unparseable empty output.
 * @param {Sandbox} sandbox
 */
function writeListingCodex(sandbox) {
  const tool = join(sandbox.bin, "codex");
  writeFileSync(
    tool,
    [
      "#!/bin/sh",
      'case "$*" in',
      "  'plugin list --json') printf '%s\\n' '{\"installed\":[]}' ;;",
      "  'plugin marketplace list --json')",
      "    printf '%s\\n' '{\"marketplaces\":[]}' ;;",
      "  *)",
      "    printf 'unexpected codex command: %s\\n' \"$*\" >&2",
      "    exit 99 ;;",
      "esac",
      "",
    ].join("\n"),
    "utf8",
  );
  chmodSync(tool, 0o755);
  return tool;
}

/**
 * @param {string} path
 * @param {[string, string][]} replacements
 */
function substitutedFixtureBytes(path, replacements) {
  let contents = readFileSync(path, "utf8");
  for (const [from, to] of replacements) {
    assert.notEqual(contents.indexOf(from), -1, `fixture lacks ${from}`);
    contents = contents.replaceAll(from, to);
  }
  return Buffer.from(contents, "utf8");
}

/** @param {Sandbox} sandbox */
function selectionPath(sandbox) {
  return join(sandbox.config, "selection.json");
}

/** @param {Sandbox} sandbox */
function generatedProvenance(sandbox) {
  return JSON.parse(
    readFileSync(join(sandbox.plugin, ".superpowers-upstream.json"), "utf8"),
  );
}

/** @param {string} root */
function snapshotTree(root) {
  /** @type {any[]} */
  const entries = [];
  /** @param {string} path */
  function visit(path) {
    const info = lstatSync(path);
    const name = relative(root, path) || ".";
    const mode = info.mode & 0o777;
    if (info.isSymbolicLink()) {
      entries.push({ name, type: "symlink", mode, target: readlinkSync(path) });
      return;
    }
    if (info.isDirectory()) {
      entries.push({ name, type: "directory", mode });
      for (const child of readdirSync(path).sort()) visit(join(path, child));
      return;
    }
    assert.equal(info.isFile(), true, `${path} must be a file`);
    entries.push({ name, type: "file", mode, contents: readFileSync(path) });
  }
  visit(root);
  return entries;
}

/** @param {string} root */
function lexicalTree(root) {
  /** @type {string[]} */
  const entries = [];
  /** @param {string} directory */
  function visit(directory) {
    for (const child of readdirSync(directory).sort()) {
      const path = join(directory, child);
      const name = relative(root, path);
      const info = lstatSync(path);
      if (info.isDirectory() && !info.isSymbolicLink()) {
        entries.push(`${name}/`);
        visit(path);
      } else {
        entries.push(name);
      }
    }
  }
  visit(root);
  return entries.sort();
}

/**
 * @param {Sandbox} sandbox
 * @param {string[]} args
 */
function runSandboxGit(sandbox, args) {
  const result = spawnSync(join(sandbox.bin, "git"), args, {
    cwd: sandbox.work,
    env: baseEnvironment(sandbox),
    encoding: "utf8",
  });
  assertCleanResult(result);
  return result;
}

/**
 * @param {Sandbox} sandbox
 * @param {string} [name]
 * @param {string | null} [candidateRecord]
 */
function writeFailingValidator(
  sandbox,
  name = "reject-candidate.py",
  candidateRecord = null,
) {
  const validator = join(sandbox.work, name);
  const recordCandidate =
    candidateRecord === null
      ? ""
      : `Path(${JSON.stringify(candidateRecord)}).write_text(str(candidate) + "\\n", encoding="utf-8")\n`;
  writeFileSync(
    validator,
    `from pathlib import Path
import sys

candidate = Path(sys.argv[1])
${recordCandidate}if not (candidate / ".codex-plugin" / "plugin.template.json").is_file():
    print("candidate template missing before additional validation", file=sys.stderr)
    raise SystemExit(9)
print("baseline additional validator rejection", file=sys.stderr)
raise SystemExit(7)
`,
    "utf8",
  );
  return validator;
}

/**
 * @param {string} parent
 * @param {string[]} [retained]
 */
function assertNoInvocationPrepareWorkspace(parent, retained = []) {
  const retainedNames = new Set(retained);
  assert.deepEqual(
    readdirSync(parent)
      .filter((name) => name.startsWith(".superpowers.prepare."))
      .filter((name) => !retainedNames.has(name))
      .sort(),
    [],
  );
}

/**
 * @param {Sandbox} sandbox
 * @param {string} repo
 */
function commitUnknownManifestField(sandbox, repo) {
  runSandboxGit(sandbox, ["-C", repo, "checkout", "--detach", "v1.0.0"]);
  const manifestPath = join(repo, ".codex-plugin", "plugin.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  manifest.x_future_manifest = { nested: [true, null, "preserve-me"] };
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  mkdirSync(join(repo, "assets"));
  writeFileSync(
    join(repo, "assets", "superpowers-small.svg"),
    '<svg xmlns="http://www.w3.org/2000/svg"/>\n',
    "utf8",
  );
  runSandboxGit(sandbox, ["-C", repo, "add", "-A"]);
  runSandboxGit(sandbox, [
    "-C",
    repo,
    "commit",
    "-m",
    "add future manifest field",
  ]);
  return runSandboxGit(sandbox, [
    "-C",
    repo,
    "rev-parse",
    "HEAD",
  ]).stdout.trim();
}

/**
 * @param {Sandbox} sandbox
 * @param {string} repo
 * @param {string} scenarioName
 */
function commitUnsafeHookScenario(sandbox, repo, scenarioName) {
  const scenarioRoot = join(sandbox.root, `${scenarioName}-fixture`);
  const scenario = scenarioValues(
    runScenario(sandbox, scenarioName, scenarioRoot),
  );
  runSandboxGit(sandbox, ["-C", repo, "checkout", "--detach", "v1.0.0"]);
  const manifestPath = join(repo, ".codex-plugin", "plugin.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  manifest.hooks = [];
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  const hooks = join(repo, "hooks");
  mkdirSync(hooks);
  writeFileSync(join(hooks, "hooks.json"), "{}\n", "utf8");
  const target =
    scenarioName === "broken-symlink"
      ? readlinkSync(scenario.TARGET)
      : relative(hooks, join(scenario.OUTSIDE, "target"));
  symlinkSync(target, join(hooks, "unsafe-target"));
  runSandboxGit(sandbox, ["-C", repo, "add", "-A"]);
  runSandboxGit(sandbox, [
    "-C",
    repo,
    "commit",
    "-m",
    `add ${scenarioName} hook`,
  ]);
  return runSandboxGit(sandbox, [
    "-C",
    repo,
    "rev-parse",
    "HEAD",
  ]).stdout.trim();
}

/** @param {Sandbox} sandbox */
function assertMalformedSelectionFailsBeforeTools(sandbox) {
  const savedState = selectionPath(sandbox);
  const gitLog = join(sandbox.root, "git-access.log");
  writeCodexLogTool(sandbox);
  writeFileSync(savedState, "{\n", "utf8");
  removeTool(sandbox, "git");
  writeFileSync(
    join(sandbox.bin, "git"),
    '#!/bin/sh\nprintf "git access\\n" >> "$SPW_BASELINE_GIT_LOG"\nexit 99\n',
    "utf8",
  );
  chmodSync(join(sandbox.bin, "git"), 0o755);

  const result = runCli(sandbox, ["prepare"], {
    SPW_BASELINE_GIT_LOG: gitLog,
    SUPERPOWERS_REF: "v1.1.0",
    SUPERPOWERS_UPSTREAM_URL: join(sandbox.root, "unused-upstream"),
  });
  assertCleanResult(result, 1);
  assert.equal(result.stdout, "");
  assert.equal(
    result.stderr,
    `error: invalid JSON in ${savedState}: line 2 column 1: ` +
      "Expecting property name enclosed in double quotes\n",
  );
  assert.equal(existsSync(gitLog), false);
  assertNoCodexContact(sandbox);
}

/**
 * @param {Sandbox} sandbox
 * @param {Record<string, string>} upstream
 * @param {Record<string, string>} [overrides]
 */
function lifecycleEnvironment(sandbox, upstream, overrides = {}) {
  return {
    SPW_ADAPTER: sandbox.adapter,
    SPW_BASELINE_ADAPTER_STATE: sandbox.adapterState,
    SPW_BASELINE_ADAPTER_LOG: sandbox.adapterLog,
    SPW_BASELINE_FINGERPRINT: upstream.STABLE_COMMIT,
    SUPERPOWERS_REF: "v1.1.0",
    SUPERPOWERS_UPSTREAM_URL: upstream.REPO,
    ...overrides,
  };
}

/** @param {Sandbox} sandbox */
function adapterOperations(sandbox) {
  if (!existsSync(sandbox.adapterLog)) return [];
  return readFileSync(sandbox.adapterLog, "utf8")
    .trimEnd()
    .split("\n")
    .filter(Boolean);
}

void test("CLI-MODE-HELP-01 help modes", () => {
  withSandbox({ stubScripts: true }, (sandbox) => {
    for (const tool of ["git", "python3", "codex", "sh"]) {
      removeTool(sandbox, tool);
    }
    for (const mode of ["--help", "-h"]) {
      const result = runCli(sandbox, [mode], {
        SUPERPOWERS_CODEX: join(sandbox.root, "missing-custom-codex"),
      });
      assertCleanResult(result);
      assert.equal(result.stdout, USAGE);
      assert.equal(result.stderr, "");
      assert.deepEqual(readDispatchLog(sandbox), []);
    }
  });
});

void test("CLI-HOST-TOOLS-01 resolves a pyenv-style Python shim before sandboxing", () => {
  const originalPath = process.env.PATH;
  const hostPython = spawnSync(
    "python3",
    ["-c", "import os,sys; print(os.path.realpath(sys.executable))"],
    {
      env: { ...process.env, PATH: originalPath },
      encoding: "utf8",
    },
  );
  assertCleanResult(hostPython);
  const resolvedPython = hostPython.stdout.trim();
  assert.ok(resolvedPython.startsWith("/"));

  const hostSandbox = createSandbox();
  let sandbox;
  try {
    const shimDirectory = join(hostSandbox.root, "pyenv-shims");
    mkdirSync(shimDirectory);
    const shim = join(shimDirectory, "python3");
    writeFileSync(
      shim,
      `#!/usr/bin/env bash\nexec ${JSON.stringify(resolvedPython)} "$@"\n`,
      "utf8",
    );
    chmodSync(shim, 0o755);
    process.env.PATH = `${shimDirectory}${delimiter}${originalPath || ""}`;

    sandbox = createSandbox();
    const result = runCli(sandbox, ["track-latest"]);
    assertCleanResult(result);
    assert.equal(
      result.stdout,
      "saved upstream selection: latest stable release\n",
    );
    assert.equal(result.stderr, "");
  } finally {
    if (sandbox) destroySandbox(sandbox);
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
    destroySandbox(hostSandbox);
  }
});

void test("CLI-HOST-TOOLS-02 removes an unregistered root after a smoke-check failure", () => {
  const originalPath = process.env.PATH;
  const originalTmpdir = process.env.TMPDIR;
  const hostSandbox = createSandbox();
  try {
    const shimDirectory = join(hostSandbox.root, "broken-git-shim");
    const temporaryParent = join(hostSandbox.root, "smoke-check-tmp");
    mkdirSync(shimDirectory);
    mkdirSync(temporaryParent);
    const shim = join(shimDirectory, "git");
    writeFileSync(shim, "#!/usr/bin/env bash\nexit 0\n", "utf8");
    chmodSync(shim, 0o755);
    process.env.PATH = `${shimDirectory}${delimiter}${originalPath || ""}`;
    process.env.TMPDIR = temporaryParent;

    assert.throws(
      () => createSandbox(),
      /sandbox tool setup failed for git under controlled PATH/,
    );
    assert.deepEqual(readdirSync(temporaryParent), []);
  } finally {
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
    if (originalTmpdir === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = originalTmpdir;
    destroySandbox(hostSandbox);
  }
});

void test("CLI-MODE-VERSION-01 version mode routes through dist", () => {
  withSandbox({ stubScripts: true }, (sandbox) => {
    const { version } = JSON.parse(
      readFileSync(join(sandbox.pkg, "package.json"), "utf8"),
    );
    const result = runCli(sandbox, ["--version"]);
    assertCleanResult(result);
    assert.equal(result.stdout, `${version}\n`);
    assert.equal(result.stderr, "");
  });
});

void test("CLI-MODE-DEFAULT-01 no arguments dispatch update", () => {
  withSandbox({ stubScripts: true }, (sandbox) => {
    const result = runCli(sandbox, [], dispatchEnvironment(sandbox));
    assertCleanResult(result);
    assert.equal(result.stdout, "");
    assert.equal(result.stderr, "");
    assertOnlyDispatch(sandbox, "update", []);
  });
});

void test("CLI-COMMANDS-01 eight named commands dispatch", () => {
  const cases = new Map([
    ["pin", ["v1.0.0"]],
    ["track-latest", []],
    ["unpin", []],
    ["prepare", ["--candidate", "arbitrary value"]],
    ["probe", ["--porcelain"]],
    ["install", ["--dry-run", "arbitrary value"]],
    ["update", ["--force", "arbitrary value"]],
    ["uninstall", ["--purge", "arbitrary value"]],
  ]);
  assert.deepEqual([...cases.keys()], COMMANDS);
  // The production DISPATCH keys and the test-side COMMANDS list must agree
  // as sets in both directions. COMMANDS is hand-maintained while DISPATCH is
  // keyed by the production Subcommand union, so either one can gain or lose
  // an entry the other doesn't have; a one-directional `includes` check
  // cannot catch that because IN_PROCESS_COMMANDS is filtered from COMMANDS
  // by construction and is therefore always a subset of it.
  assert.deepEqual(Object.keys(DISPATCH).sort(), [...COMMANDS].sort());

  withSandbox({ stubScripts: true }, (sandbox) => {
    // `pin` is the first in-process command whose success genuinely depends
    // on resolving against its source (track-latest/unpin never touch git):
    // it needs a real, reachable upstream, so this test grows a local one
    // rather than resolving against the package default and touching the
    // network. `v1.0.0` replaces the arbitrary `v6.1.1` used for pin's argv
    // elsewhere in this suite, since it is the tag this scenario actually
    // has.
    const upstream = createReleaseRepo(sandbox);
    // `probe` is the first in-process command that reads Codex state, so the
    // `exit 0` codex runCli would otherwise install cannot carry it: probe
    // fails closed on that stub's unparseable output. It is also the first
    // one that would resolve the package-default ref against the public
    // upstream URL, so it is pinned to the same local repository `pin` uses —
    // a 40-hex RAW_COMMIT, which resolves without reaching Git at all
    // (src/upstream.ts:160-162). Both are hermeticity requirements, not
    // conveniences.
    writeListingCodex(sandbox);
    for (const [command, argv] of cases) {
      clearDispatchLog(sandbox);
      const overrides =
        command === "pin"
          ? {
              ...dispatchEnvironment(sandbox),
              SUPERPOWERS_UPSTREAM_URL: upstream.REPO,
            }
          : command === "probe"
            ? {
                ...dispatchEnvironment(sandbox),
                SUPERPOWERS_UPSTREAM_URL: upstream.REPO,
                SUPERPOWERS_REF: upstream.RAW_COMMIT,
              }
            : command === "prepare"
              ? (() => {
                  // `prepare` really runs here now, so this row needs a local
                  // upstream: without one it resolves the packaged default and
                  // the sandbox git shim turns that into `exit 128` rather
                  // than a readable failure.
                  //
                  // SPW_ADAPTER is stripped rather than never added, because
                  // `dispatchEnvironment` carries it for every other row in
                  // this Map. It is the only one of `assertSeamRetired`'s
                  // three keys that helper supplies, so stripping the other
                  // two would not typecheck. `assertSeamRetired` reads the
                  // command out of `args`, so it catches this site even though
                  // no grep for "prepare" would attribute the override to it.
                  const { SPW_ADAPTER: _adapter, ...rest } =
                    dispatchEnvironment(sandbox);
                  return {
                    ...rest,
                    SUPERPOWERS_UPSTREAM_URL: upstream.REPO,
                    SUPERPOWERS_REF: upstream.RAW_COMMIT,
                  };
                })()
              : dispatchEnvironment(sandbox);
      const result = runCli(sandbox, [command, ...argv], overrides);
      if (IN_PROCESS_COMMANDS.includes(command)) {
        // An in-process command must reach its module and dispatch NOTHING.
        // Every command's scripts/<command> is stubbed with a regression
        // detector (support.js's regressionStub): it logs the invocation and
        // exits non-zero, so a regression that re-spawns the script fails
        // both assertCleanResult below and this empty-dispatch-log check.
        assertCleanResult(result);
        const dispatched = readDispatchLog(sandbox).map((e) => e.command);
        assert.deepEqual(dispatched, [], `${command} must not spawn a script`);
      } else {
        assertCleanResult(result);
        assert.equal(result.stdout, "");
        assert.equal(result.stderr, "");
        assertOnlyDispatch(sandbox, command, argv);
      }
    }
  });
});

void test("CLI-USAGE-01 invalid command and stray flag fail with exit 2", () => {
  const cases = [
    { args: ["bogus"], diagnostic: "unknown subcommand: bogus" },
    { args: ["--porcelain"], diagnostic: "unknown subcommand: --porcelain" },
    { args: ["pin"], diagnostic: "usage: superpowers-manager pin REF" },
    {
      args: ["pin", "v1.2.3", "extra"],
      diagnostic: "usage: superpowers-manager pin REF",
    },
    {
      args: ["pin", "main"],
      diagnostic:
        "pin REF must be an exact v-prefixed SemVer tag or full 40-hex commit",
    },
    {
      args: ["track-latest", "extra"],
      diagnostic: "usage: superpowers-manager track-latest",
    },
    {
      args: ["unpin", "extra"],
      diagnostic: "usage: superpowers-manager unpin",
    },
    // PR 11.5 slice 2. `probe`'s arity is decided in parseArgs, so a typo'd
    // flag gets the usage block and exit 2 like every other CLI usage error.
    // The separate block below proves it is decided before preflight.
    {
      args: ["probe", "--porcelaine"],
      diagnostic: "usage: superpowers-manager probe [--porcelain]",
    },
    {
      args: ["probe", "--porcelain", "extra"],
      diagnostic: "usage: superpowers-manager probe [--porcelain]",
    },
  ];

  withSandbox({ stubScripts: true }, (sandbox) => {
    for (const { args, diagnostic } of cases) {
      clearDispatchLog(sandbox);
      const result = runCli(sandbox, args, dispatchEnvironment(sandbox));
      assertCleanResult(result, 2);
      assert.equal(result.stdout, "");
      assert.equal(result.stderr, `error: ${diagnostic}\n${USAGE}`);
      assert.deepEqual(readDispatchLog(sandbox), []);
    }
  });

  // A `probe` usage error is decided before preflight. No SPW_ADAPTER override
  // here, so runCli's lazy writeNoopTool never fires and `codex` — which
  // COMMAND_REQUIREMENTS.probe still requires — is genuinely absent. If the
  // arity check lived only in runProbe, preflight would reach it first and
  // this would be exit 1 with the missing-codex diagnostic.
  withSandbox({ stubScripts: true }, (sandbox) => {
    assert.equal(existsSync(join(sandbox.bin, "codex")), false);
    const result = runCli(sandbox, ["probe", "--porcelaine"], {
      SPW_BASELINE_DISPATCH_LOG: sandbox.dispatchLog,
    });
    assertCleanResult(result, 2);
    assert.equal(result.stdout, "");
    assert.equal(
      result.stderr,
      `error: usage: superpowers-manager probe [--porcelain]\n${USAGE}`,
    );
    assert.deepEqual(readDispatchLog(sandbox), []);
  });
});

void test("CLI-PIN-REF-01 pin accepts exact tag or 40-hex commit only", () => {
  const accepted = [
    "v0.0.0",
    "v1.2.3",
    "v1.2.3-alpha",
    "v1.2.3-alpha.1",
    "v1.2.3-0",
    "v1.2.3-x-y.z9",
    "0123456789abcdef0123456789abcdef01234567",
    "ABCDEF0123456789ABCDEF0123456789ABCDEF01",
  ];
  const refused = [
    "1.2.3",
    "v01.2.3",
    "v1.02.3",
    "v1.2.03",
    "v1.2.3-",
    "v1.2.3-01",
    "v1.2.3+build",
    "main",
    "latest-release",
    "HEAD",
    "refs/heads/main",
    "0123456789abcdef0123456789abcdef0123456",
    "g123456789abcdef0123456789abcdef01234567",
  ];

  withSandbox({ stubScripts: true }, (sandbox) => {
    // `pin` is in-process now (PR 11.5, Task 7): an accepted ref never
    // reaches scripts/pin, and its resolution genuinely runs rather than
    // hitting the trivial dispatch stub every other command in this suite
    // still gets. This loop can therefore no longer assert a clean dispatch
    // for every accepted value — two of them
    // (`0123456789abcdef0123456789abcdef01234567` and its uppercase
    // sibling) are arbitrary 40-hex literals not constructible in any
    // fixture (no buildable repository can contain a commit with that exact
    // SHA), so genuine resolution success is not just unbuilt here, it is
    // impossible to assert honestly. What this loop still proves, and the
    // only thing it ever proved before the flip (the shell-era dispatch
    // stub short-circuited real resolution too), is the syntax boundary
    // itself: `src/cli.ts`'s TAG_RE/COMMIT_INPUT_RE gate lets these argv
    // shapes reach real work, in contrast to every entry in `refused` below,
    // which is rejected before any tool lookup or dispatch.
    // `SUPERPOWERS_UPSTREAM_URL` is pinned to a definitely-absent local path
    // so that real work fails fast — never touching the network — no
    // matter which accepted value is tried. With that source, resolution is
    // deterministic for every accepted value: tags fail inside
    // resolveExactTag (src/upstream.ts's `runGit(["ls-remote", ...])`
    // against a nonexistent path), 40-hex values fail inside
    // verifyRawCommit's fetch, and runPin's catch (src/commands/pin.ts)
    // returns 1 unconditionally either way — so `status === 1` is provable
    // and strictly stronger than merely "not a usage error": it also catches
    // a signal-killed child, which `spawnSync` reports as `status: null`
    // (`notEqual(null, 2)` would have passed that silently).
    const noSuchUpstream = join(sandbox.root, "no-such-upstream");
    for (const ref of accepted) {
      clearDispatchLog(sandbox);
      const result = runCli(sandbox, ["pin", ref], {
        ...dispatchEnvironment(sandbox),
        SUPERPOWERS_UPSTREAM_URL: noSuchUpstream,
      });
      assertCleanResult(result, 1);
      assert.ok(
        !result.stderr.includes(
          "pin REF must be an exact v-prefixed SemVer tag or full 40-hex commit",
        ),
      );
      assert.deepEqual(readDispatchLog(sandbox), []);
    }
    for (const ref of refused) {
      clearDispatchLog(sandbox);
      const result = runCli(
        sandbox,
        ["pin", ref],
        dispatchEnvironment(sandbox),
      );
      assertCleanResult(result, 2);
      assert.equal(result.stdout, "");
      assert.equal(
        result.stderr,
        "error: pin REF must be an exact v-prefixed SemVer tag or full 40-hex commit\n" +
          USAGE,
      );
      assert.deepEqual(readDispatchLog(sandbox), []);
    }
  });
});

void test("CLI-PREFLIGHT-01 missing tools fail before dispatch", () => {
  // Derived, never restated. The hand-written map this replaces encoded
  // DISPATCH a second time through the presence of "sh", forty lines below
  // this same file's correct derived usage.
  //
  // commandRequirements(env) (src/cli.ts:244) takes the environment — `prepare`
  // requires python3 only when SUPERPOWERS_VALIDATOR names one — and returns
  // the whole Record<Subcommand, string[]>; index it per command. These cases
  // configure no validator, so the empty env is the right derivation for them.
  const declared = commandRequirements({});
  const requirements = new Map(
    COMMANDS.map((command) => {
      // COMMANDS is a plain string[]; CLI-COMMANDS-01 above asserts it agrees
      // with Object.keys(DISPATCH) as a set in both directions, which is what
      // makes this narrowing sound rather than assumed.
      const key = /** @type {keyof typeof DISPATCH} */ (command);
      return [
        command,
        DISPATCH[key] === "spawn"
          ? [...declared[key], "sh"]
          : [...declared[key]],
      ];
    }),
  );
  // Every tool any command in `requirements` can require. Used below to give
  // the empty-requirements rows (`track-latest`, `unpin`) a real assertion
  // instead of a `for` loop over `[]` that runs zero iterations.
  const ALL_REQUIRED_TOOLS = [...new Set([...requirements.values()].flat())];
  /** @type {Record<string, string[]>} */
  const argsFor = { pin: ["v1.2.3"] };

  for (const [command, tools] of requirements) {
    if (tools.length === 0) {
      // No preflight requirement to violate individually: assert the
      // positive instead — this command still succeeds once every tool any
      // *other* command needs is removed from PATH, proving its own
      // requirement list is genuinely empty rather than merely undeclared.
      withSandbox({ stubScripts: true }, (sandbox) => {
        for (const tool of ALL_REQUIRED_TOOLS) removeTool(sandbox, tool);
        const result = runCli(sandbox, [command, ...(argsFor[command] || [])], {
          SPW_BASELINE_DISPATCH_LOG: sandbox.dispatchLog,
        });
        assertCleanResult(result);
        assert.equal(result.stderr, "");
        assert.deepEqual(readDispatchLog(sandbox), []);
      });
      continue;
    }
    for (const tool of tools) {
      withSandbox({ stubScripts: true }, (sandbox) => {
        if (tools.includes("codex") && tool !== "codex") writeNoopTool(sandbox);
        removeTool(sandbox, tool);
        const result = runCli(sandbox, [command, ...(argsFor[command] || [])], {
          SPW_BASELINE_DISPATCH_LOG: sandbox.dispatchLog,
        });
        assertCleanResult(result, 1);
        assert.equal(result.stdout, "");
        const diagnostic =
          tool === "codex"
            ? "error: required command not found: codex — install the Codex CLI or set SUPERPOWERS_CODEX\n"
            : tool === "sh"
              ? "error: required command not found: sh\n"
              : `error: required command not found: ${tool} — install ${tool} and re-run\n`;
        assert.equal(result.stderr, diagnostic);
        assert.deepEqual(readDispatchLog(sandbox), []);
      });
    }
  }
});

// Vehicle only. These five cases test buildSpawn — inherited stdio, child
// exit status, child signal death, and the ENOENT diagnostic — not anything
// specific to `install`. They moved off `probe` when slice 2 flipped it
// in-process, and they die with buildSpawn in slice 4. Do not read the
// choice of `install` as a contract.
void test("CLI-ENV-CODEX-PREFLIGHT-01 custom Codex command satisfies launcher preflight", () => {
  withSandbox({ stubScripts: true }, (sandbox) => {
    const customCodex = writeNoopTool(sandbox, "baseline-custom-codex");
    removeTool(sandbox, "codex");
    const result = runCli(
      sandbox,
      ["install"],
      dispatchEnvironment(sandbox, {
        SUPERPOWERS_CODEX: customCodex,
      }),
    );
    assertCleanResult(result);
    assert.equal(result.stdout, "");
    assert.equal(result.stderr, "");
    assertOnlyDispatch(sandbox, "install", []);
  });
});

void test("CLI-CHILD-STATUS-01 delegated child status is preserved", () => {
  withSandbox({ stubScripts: true }, (sandbox) => {
    const result = runCli(
      sandbox,
      ["install"],
      dispatchEnvironment(sandbox, { SPW_BASELINE_DELEGATE_EXIT: "42" }),
    );
    assertCleanResult(result, 42);
    assertOnlyDispatch(sandbox, "install", []);
  });

  withSandbox({ stubScripts: true }, (sandbox) => {
    const script = join(sandbox.pkg, "scripts", "install");
    writeFileSync(
      script,
      '#!/bin/sh\nprintf "child stdout: %s\\n" "$SPW_CHILD_SENTINEL"\n' +
        'printf "child stderr\\n" >&2\nexit 7\n',
      "utf8",
    );
    chmodSync(script, 0o755);
    const result = runCli(sandbox, ["install"], {
      SPW_ADAPTER: sandbox.adapter,
      SPW_CHILD_SENTINEL: "inherited",
    });
    assertCleanResult(result, 7);
    assert.equal(result.stdout, "child stdout: inherited\n");
    assert.equal(result.stderr, "child stderr\n");
  });

  withSandbox({ stubScripts: true }, (sandbox) => {
    const script = join(sandbox.pkg, "scripts", "install");
    writeFileSync(script, "#!/bin/sh\nkill -TERM $$\n", "utf8");
    chmodSync(script, 0o755);
    const result = runCli(sandbox, ["install"], {
      SPW_ADAPTER: sandbox.adapter,
    });
    assertCleanResult(result, 1);
  });

  withSandbox({ stubScripts: true }, (sandbox) => {
    const script = join(sandbox.pkg, "scripts", "install");
    writeFileSync(script, "#!/no/such/interpreter\n", "utf8");
    chmodSync(script, 0o755);
    const result = runCli(sandbox, ["install"], {
      SPW_ADAPTER: sandbox.adapter,
    });
    assertCleanResult(result, 1);
    assert.match(
      result.stderr,
      /^error: cannot run .*\/scripts\/install: spawnSync .* ENOENT\n$/,
    );
  });
});

void test("CLI-ENV-01 ten SUPERPOWERS variables pass through", () => {
  withSandbox({ stubScripts: true }, (sandbox) => {
    const customCodex = writeNoopTool(sandbox, "custom-codex");
    const values = {
      SUPERPOWERS_REF: "v9.8.7-rc.1",
      SUPERPOWERS_UPSTREAM_URL: join(sandbox.root, "upstream source"),
      SUPERPOWERS_CODEX: customCodex,
      SUPERPOWERS_CACHE_DIR: join(sandbox.root, "custom cache"),
      SUPERPOWERS_CONFIG_DIR: join(sandbox.root, "custom config"),
      SUPERPOWERS_PLUGIN_ROOT: join(sandbox.root, "custom plugin"),
      SUPERPOWERS_MANIFEST_TEMPLATE: join(sandbox.root, "custom template.json"),
      SUPERPOWERS_VALIDATOR: join(sandbox.root, "custom validator.py"),
      SUPERPOWERS_INSTALLED_SEARCH_ROOT: join(sandbox.root, "custom codex"),
      SUPERPOWERS_INSTALL_REFRESH_MODE: "force-refresh",
    };
    assert.deepEqual(Object.keys(values), PASSTHROUGH_VARIABLES);

    const previousLeak = process.env.SUPERPOWERS_BASELINE_LEAK;
    process.env.SUPERPOWERS_BASELINE_LEAK = "must-not-pass";
    let result;
    try {
      result = runCli(
        sandbox,
        ["update"],
        dispatchEnvironment(sandbox, values),
      );
    } finally {
      if (previousLeak === undefined) {
        delete process.env.SUPERPOWERS_BASELINE_LEAK;
      } else {
        process.env.SUPERPOWERS_BASELINE_LEAK = previousLeak;
      }
    }

    assertCleanResult(result);
    const [record] = readDispatchLog(sandbox);
    assert.deepEqual(record.passthrough, values);
    assert.deepEqual(record.superpowers_env, values);
    assert.deepEqual(record.xdg_env, {});
    assert.deepEqual(record.npm_env, {});
    assert.deepEqual(record.codex_env, {});
  });
});

void test("CLI-ENV-LOCATION-01 public selection location chain", () => {
  withSandbox({}, (sandbox) => {
    const upstream = createReleaseRepo(sandbox);
    const xdg = join(sandbox.root, "xdg");
    let result = runCliWithoutEnvironment(
      sandbox,
      ["pin", "v1.0.0"],
      ["SUPERPOWERS_CONFIG_DIR"],
      {
        XDG_CONFIG_HOME: xdg,
        SUPERPOWERS_UPSTREAM_URL: upstream.REPO,
      },
    );
    assertCleanResult(result);
    assert.equal(
      existsSync(join(xdg, "superpowers-manager", "selection.json")),
      true,
    );

    const fallbackHome = join(sandbox.root, "fallback-home");
    mkdirSync(fallbackHome);
    result = runCliWithoutEnvironment(
      sandbox,
      ["pin", "v1.0.0"],
      ["SUPERPOWERS_CONFIG_DIR", "XDG_CONFIG_HOME"],
      {
        HOME: fallbackHome,
        SUPERPOWERS_UPSTREAM_URL: upstream.REPO,
      },
    );
    assertCleanResult(result);
    assert.equal(
      existsSync(
        join(fallbackHome, ".config", "superpowers-manager", "selection.json"),
      ),
      true,
    );

    result = runCli(sandbox, ["track-latest"], {
      SUPERPOWERS_CONFIG_DIR: "",
    });
    assertCleanResult(result, 1);
    assert.match(result.stderr, /SUPERPOWERS_CONFIG_DIR must be absolute/);
  });
});

void test("CLI-ENV-PREPARE-01 public prepare path defaults and overrides", () => {
  withSandbox({}, (sandbox) => {
    const upstream = createReleaseRepo(sandbox);
    writeCodexLogTool(sandbox);
    const result = runCliWithoutEnvironment(
      sandbox,
      ["prepare"],
      [
        "SUPERPOWERS_CACHE_DIR",
        "SUPERPOWERS_PLUGIN_ROOT",
        "SUPERPOWERS_MANIFEST_TEMPLATE",
        "SUPERPOWERS_VALIDATOR",
      ],
      {
        SUPERPOWERS_REF: "v1.1.0",
        SUPERPOWERS_UPSTREAM_URL: upstream.REPO,
      },
    );
    assertCleanResult(result);
    assert.equal(
      existsSync(
        join(sandbox.pkg, ".cache", "upstream", "superpowers", ".git"),
      ),
      true,
    );
    assert.equal(
      existsSync(join(sandbox.plugin, ".codex-plugin", "plugin.json")),
      true,
    );
    assert.equal(
      existsSync(join(sandbox.plugin, ".codex-plugin", "plugin.template.json")),
      true,
    );
    assertNoCodexContact(sandbox);
  });

  withSandbox({}, (sandbox) => {
    const upstream = createReleaseRepo(sandbox);
    writeCodexLogTool(sandbox);
    const customCache = join(sandbox.root, "custom-cache");
    const customPlugin = join(sandbox.root, "custom-plugin");
    const customValidator = join(sandbox.root, "custom-validator.py");
    const validatorMarker = join(sandbox.root, "validator-ran");
    writeFileSync(
      customValidator,
      "from pathlib import Path\nimport os\n" +
        'Path(os.environ["SPW_BASELINE_VALIDATOR_MARKER"]).write_text("ran\\n")\n',
      "utf8",
    );
    const result = runCli(sandbox, ["prepare"], {
      SPW_BASELINE_VALIDATOR_MARKER: validatorMarker,
      SUPERPOWERS_CACHE_DIR: customCache,
      SUPERPOWERS_PLUGIN_ROOT: customPlugin,
      SUPERPOWERS_VALIDATOR: customValidator,
      SUPERPOWERS_REF: "v1.1.0",
      SUPERPOWERS_UPSTREAM_URL: upstream.REPO,
    });
    assertCleanResult(result);
    assert.equal(existsSync(join(customCache, "superpowers", ".git")), true);
    assert.equal(
      existsSync(join(customPlugin, ".codex-plugin", "plugin.json")),
      true,
    );
    assert.equal(readFileSync(validatorMarker, "utf8"), "ran\n");
    assertNoCodexContact(sandbox);
  });
});

void test("CLI-ENV-MANIFEST-TEMPLATE-01 fallback template bytes and non-file rejection", () => {
  withSandbox({}, (sandbox) => {
    const upstream = createReleaseRepo(sandbox);
    const defaultTemplate = join(
      sandbox.pkg,
      "plugins",
      "superpowers",
      ".codex-plugin",
      "plugin.template.json",
    );
    const defaultTemplateBytes = readFileSync(defaultTemplate);
    writeCodexLogTool(sandbox);
    const result = runCliWithoutEnvironment(
      sandbox,
      ["prepare"],
      ["SUPERPOWERS_MANIFEST_TEMPLATE"],
      {
        SUPERPOWERS_REF: "v1.1.0",
        SUPERPOWERS_UPSTREAM_URL: upstream.REPO,
      },
    );
    assertCleanResult(result);
    assert.deepEqual(
      readFileSync(
        join(sandbox.plugin, ".codex-plugin", "plugin.template.json"),
      ),
      defaultTemplateBytes,
    );
    assertNoCodexContact(sandbox);
  });

  withSandbox({}, (sandbox) => {
    const upstream = createReleaseRepo(sandbox);
    writeCodexLogTool(sandbox);
    const defaultTemplate = join(
      sandbox.pkg,
      "plugins",
      "superpowers",
      ".codex-plugin",
      "plugin.template.json",
    );
    const customTemplate = join(sandbox.root, "custom-template.json");
    const customManifest = JSON.parse(readFileSync(defaultTemplate, "utf8"));
    const defaultTemplateBytes = readFileSync(defaultTemplate);
    customManifest.description = "behavioral baseline custom fallback";
    customManifest.x_baseline_template = {
      sentinel: "custom-template-consumed",
    };
    const customTemplateBytes = Buffer.from(
      `${JSON.stringify(customManifest, null, 2)}\n`,
      "utf8",
    );
    writeFileSync(customTemplate, customTemplateBytes);

    const result = runCli(sandbox, ["prepare"], {
      SUPERPOWERS_MANIFEST_TEMPLATE: customTemplate,
      SUPERPOWERS_REF: "v1.1.0",
      SUPERPOWERS_UPSTREAM_URL: upstream.REPO,
    });
    assertCleanResult(result);
    assert.notDeepEqual(customTemplateBytes, defaultTemplateBytes);
    assert.deepEqual(
      readFileSync(
        join(sandbox.plugin, ".codex-plugin", "plugin.template.json"),
      ),
      customTemplateBytes,
    );
    assertNoCodexContact(sandbox);
  });

  withSandbox({}, (sandbox) => {
    const upstream = createReleaseRepo(sandbox);
    writeCodexLogTool(sandbox);
    const nonFileTemplate = join(sandbox.root, "non-file-template");
    mkdirSync(nonFileTemplate);
    const previous = snapshotTree(sandbox.plugin);
    const result = runCli(sandbox, ["prepare"], {
      SUPERPOWERS_MANIFEST_TEMPLATE: nonFileTemplate,
      SUPERPOWERS_REF: "v1.1.0",
      SUPERPOWERS_UPSTREAM_URL: upstream.REPO,
    });
    assertCleanResult(result, 1);
    assert.equal(result.stdout, "");
    assert.equal(
      result.stderr,
      `error: missing fallback manifest template: ${nonFileTemplate}\n`,
    );
    assert.deepEqual(snapshotTree(sandbox.plugin), previous);
    assertNoInvocationPrepareWorkspace(dirname(sandbox.plugin));
    assertNoCodexContact(sandbox);
  });
});

void test("SEL-REF-GENERIC-01 public prepare resolves arbitrary environment refs", () => {
  withSandbox({}, (sandbox) => {
    const upstream = createReleaseRepo(sandbox);
    writeCodexLogTool(sandbox);
    const result = runCli(sandbox, ["prepare"], {
      SUPERPOWERS_REF: "main",
      SUPERPOWERS_UPSTREAM_URL: upstream.REPO,
    });
    assertCleanResult(result);
    const provenance = generatedProvenance(sandbox);
    assert.equal(provenance.requested_ref, "main");
    assert.equal(provenance.resolved_ref, "main");
    assert.match(provenance.commit, /^[0-9a-f]{40}$/);
    assertNoCodexContact(sandbox);
  });
});

void test("SEL-PRECEDENCE-REF-01 ref precedence and validate-first ordering", () => {
  withSandbox({}, (sandbox) => {
    const upstream = createReleaseRepo(sandbox);
    writeCodexLogTool(sandbox);
    const pin = runCli(sandbox, ["pin", "v1.0.0"], {
      SUPERPOWERS_UPSTREAM_URL: upstream.REPO,
    });
    assertCleanResult(pin);

    const prepare = runCli(sandbox, ["prepare"], {
      SUPERPOWERS_REF: "v1.1.0",
    });
    assertCleanResult(prepare);
    assert.deepEqual(generatedProvenance(sandbox), {
      source: upstream.REPO,
      requested_ref: "v1.1.0",
      resolved_ref: "v1.1.0",
      commit: upstream.STABLE_COMMIT,
      upstream_manifest_version: "1.0.0",
    });
    assertNoCodexContact(sandbox);
  });
});

void test("SEL-PRECEDENCE-SOURCE-01 source precedence is independent", () => {
  withSandbox({}, (sandbox) => {
    const official = runCli(sandbox, ["track-latest"]);
    assertCleanResult(official);
    assert.deepEqual(
      readFileSync(selectionPath(sandbox)),
      readFileSync(fixturePath("selection", "track-latest.json")),
    );

    const upstream = createReleaseRepo(sandbox);
    writeCodexLogTool(sandbox);
    const alternate = join(sandbox.root, "alternate-upstream");
    symlinkSync(upstream.REPO, alternate, "dir");
    const pin = runCli(sandbox, ["pin", "v1.0.0"], {
      SUPERPOWERS_UPSTREAM_URL: upstream.REPO,
    });
    assertCleanResult(pin);

    let prepare = runCli(sandbox, ["prepare"], {
      SUPERPOWERS_REF: "v1.1.0",
    });
    assertCleanResult(prepare);
    assert.equal(generatedProvenance(sandbox).source, upstream.REPO);
    assert.equal(generatedProvenance(sandbox).requested_ref, "v1.1.0");

    prepare = runCli(sandbox, ["prepare"], {
      SUPERPOWERS_UPSTREAM_URL: alternate,
    });
    assertCleanResult(prepare);
    assert.equal(generatedProvenance(sandbox).source, alternate);
    assert.equal(generatedProvenance(sandbox).requested_ref, "v1.0.0");
    assert.equal(generatedProvenance(sandbox).commit, upstream.BASE_COMMIT);
    assertNoCodexContact(sandbox);
  });
});

void test("SEL-BYTES-PINNED-01 pin writes canonical selection bytes", () => {
  withSandbox({}, (sandbox) => {
    const upstream = createReleaseRepo(sandbox);
    let result = runCli(sandbox, ["pin", "v1.1.0"], {
      SUPERPOWERS_UPSTREAM_URL: upstream.REPO,
    });
    assertCleanResult(result);
    assert.equal(
      result.stdout,
      `pinned upstream selection to v1.1.0 at ${upstream.STABLE_COMMIT}\n`,
    );
    assert.equal(result.stderr, "");
    assert.deepEqual(
      readFileSync(selectionPath(sandbox)),
      substitutedFixtureBytes(fixturePath("selection", "pinned-tag.json"), [
        ["https://github.com/obra/superpowers", upstream.REPO],
        ["v6.1.1", "v1.1.0"],
        ["0123456789abcdef0123456789abcdef01234567", upstream.STABLE_COMMIT],
      ]),
    );
    assert.equal(statSync(selectionPath(sandbox)).mode & 0o777, 0o600);

    result = runCli(sandbox, ["pin", upstream.RAW_COMMIT.toUpperCase()], {
      SUPERPOWERS_UPSTREAM_URL: upstream.REPO,
    });
    assertCleanResult(result);
    assert.deepEqual(
      readFileSync(selectionPath(sandbox)),
      substitutedFixtureBytes(fixturePath("selection", "pinned-commit.json"), [
        ["https://github.com/obra/superpowers", upstream.REPO],
        ["0123456789abcdef0123456789abcdef01234567", upstream.RAW_COMMIT],
      ]),
    );
    assert.equal(statSync(selectionPath(sandbox)).mode & 0o777, 0o600);
  });
});

void test("SEL-BYTES-TRACK-01 track-latest writes canonical selection bytes", () => {
  withSandbox({}, (sandbox) => {
    const upstream = createReleaseRepo(sandbox);
    const pin = runCli(sandbox, ["pin", "v1.0.0"], {
      SUPERPOWERS_UPSTREAM_URL: upstream.REPO,
    });
    assertCleanResult(pin);
    const result = runCli(sandbox, ["track-latest"], {
      SUPERPOWERS_UPSTREAM_URL: upstream.REPO,
    });
    assertCleanResult(result);
    assert.equal(
      result.stdout,
      "saved upstream selection: latest stable release\n",
    );
    assert.equal(result.stderr, "");
    assert.deepEqual(
      readFileSync(selectionPath(sandbox)),
      substitutedFixtureBytes(fixturePath("selection", "track-latest.json"), [
        ["https://github.com/obra/superpowers", upstream.REPO],
      ]),
    );
    assert.equal(statSync(selectionPath(sandbox)).mode & 0o777, 0o600);
  });
});

void test("SEL-UNPIN-01 unpin removes saved intent without applying changes", () => {
  withSandbox({}, (sandbox) => {
    const source = join(sandbox.root, "unused-source");
    const saved = runCli(sandbox, ["track-latest"], {
      SUPERPOWERS_UPSTREAM_URL: source,
    });
    assertCleanResult(saved);
    mkdirSync(join(sandbox.plugin, "sentinel"), { recursive: true });
    writeFileSync(join(sandbox.plugin, "sentinel", "keep"), "plugin\n");
    writeFileSync(join(sandbox.codex, "keep"), "codex\n");
    const pluginBefore = snapshotTree(sandbox.plugin);
    const codexBefore = snapshotTree(sandbox.codex);
    const fallback = readFileSync(
      join(sandbox.pkg, "config", "upstream-ref"),
      "utf8",
    ).trim();

    const result = runCli(sandbox, ["unpin"], {
      SUPERPOWERS_REF: "v9.8.7",
      SUPERPOWERS_UPSTREAM_URL: source,
    });
    assertCleanResult(result);
    assert.equal(
      result.stdout,
      `removed saved upstream selection; packaged fallback is ${fallback}\n` +
        "note: active SUPERPOWERS_REF override remains effective\n" +
        "note: active SUPERPOWERS_UPSTREAM_URL override remains effective\n",
    );
    assert.equal(result.stderr, "");
    assert.equal(existsSync(selectionPath(sandbox)), false);
    assert.deepEqual(snapshotTree(sandbox.plugin), pluginBefore);
    assert.deepEqual(snapshotTree(sandbox.codex), codexBefore);
  });
});

void test("SEL-INVALID-01 malformed saved state fails before Git or adapter access", () => {
  withSandbox({}, (sandbox) => {
    assertMalformedSelectionFailsBeforeTools(sandbox);
  });
});

void test("PREPARE-TREE-01 prepare creates the canonical generated tree", () => {
  withSandbox({}, (sandbox) => {
    const upstream = createReleaseRepo(sandbox);
    writeCodexLogTool(sandbox);
    const commit = commitUnknownManifestField(sandbox, upstream.REPO);
    const result = runCli(sandbox, ["prepare"], {
      SUPERPOWERS_REF: commit,
      SUPERPOWERS_UPSTREAM_URL: upstream.REPO,
    });
    assertCleanResult(result);
    assert.deepEqual(
      lexicalTree(sandbox.plugin),
      readFileSync(fixturePath("generated-tree", "no-hooks.txt"), "utf8")
        .trimEnd()
        .split("\n"),
    );
    const manifest = JSON.parse(
      readFileSync(
        join(sandbox.plugin, ".codex-plugin", "plugin.json"),
        "utf8",
      ),
    );
    assert.deepEqual(manifest.x_future_manifest, {
      nested: [true, null, "preserve-me"],
    });
    assert.equal(manifest.name, "superpowers");
    assert.equal(manifest.skills, "./skills/");
    assert.match(manifest.version, /^0\.0\.0\+manager\.[0-9a-f]{7}$/);

    const firstTree = snapshotTree(sandbox.plugin);
    const repeated = runCli(sandbox, ["prepare"], {
      SUPERPOWERS_REF: commit,
      SUPERPOWERS_UPSTREAM_URL: upstream.REPO,
    });
    assertCleanResult(repeated);
    assert.deepEqual(snapshotTree(sandbox.plugin), firstTree);
    assertNoCodexContact(sandbox);
  });
});

void test("PROVENANCE-BYTES-01 prepare writes canonical provenance bytes", () => {
  withSandbox({}, (sandbox) => {
    const upstream = createReleaseRepo(sandbox, 'upstream "quoted"');
    writeCodexLogTool(sandbox);
    const result = runCli(sandbox, ["prepare"], {
      SUPERPOWERS_REF: "v1.1.0",
      SUPERPOWERS_UPSTREAM_URL: upstream.REPO,
    });
    assertCleanResult(result);
    const escapedSource = JSON.stringify(upstream.REPO).slice(1, -1);
    assert.deepEqual(
      readFileSync(join(sandbox.plugin, ".superpowers-upstream.json")),
      substitutedFixtureBytes(fixturePath("provenance", "valid-tag.json"), [
        ["https://example.invalid/superpowers.git", escapedSource],
        ["latest-release", "v1.1.0"],
        ["v6.1.1", "v1.1.0"],
        ["d884ae04edebef577e82ff7c4e143debd0bbec99", upstream.STABLE_COMMIT],
        ['"6.1.1"', '"1.0.0"'],
      ]),
    );
    assertNoCodexContact(sandbox);
  });

  withSandbox({}, (sandbox) => {
    const upstream = createReleaseRepo(sandbox, 'raw upstream "quoted"');
    writeCodexLogTool(sandbox);
    const result = runCli(sandbox, ["prepare"], {
      SUPERPOWERS_REF: upstream.RAW_COMMIT,
      SUPERPOWERS_UPSTREAM_URL: upstream.REPO,
    });
    assertCleanResult(result);
    const escapedSource = JSON.stringify(upstream.REPO).slice(1, -1);
    assert.deepEqual(
      readFileSync(join(sandbox.plugin, ".superpowers-upstream.json")),
      substitutedFixtureBytes(fixturePath("provenance", "valid-commit.json"), [
        ["https://example.invalid/superpowers.git", escapedSource],
        ["d884ae04edebef577e82ff7c4e143debd0bbec99", upstream.RAW_COMMIT],
        ['"6.1.1"', '"1.0.0"'],
      ]),
    );
    assertNoCodexContact(sandbox);
  });
});

void test("PREPARE-VALIDATE-01 validation completes before activation", () => {
  withSandbox({}, (sandbox) => {
    const upstream = createReleaseRepo(sandbox);
    writeCodexLogTool(sandbox);
    let result = runCli(sandbox, ["prepare"], {
      SUPERPOWERS_REF: "v1.1.0",
      SUPERPOWERS_UPSTREAM_URL: upstream.REPO,
    });
    assertCleanResult(result);
    const accepted = snapshotTree(sandbox.plugin);

    result = runCli(sandbox, ["prepare"], {
      SUPERPOWERS_REF: "v1.1.0",
      SUPERPOWERS_UPSTREAM_URL: upstream.REPO,
      SUPERPOWERS_VALIDATOR: writeFailingValidator(sandbox),
    });
    assertCleanResult(result, 1);
    assert.match(
      result.stdout,
      /^generated plugin validation passed: .*\/superpowers\n$/,
    );
    assert.doesNotMatch(result.stdout, /^prepared /m);
    assert.match(result.stderr, /baseline additional validator rejection/);
    assert.match(result.stderr, /error: additional plugin validation failed/);
    assert.deepEqual(snapshotTree(sandbox.plugin), accepted);
    assertNoInvocationPrepareWorkspace(join(sandbox.pkg, "plugins"));
    assertNoCodexContact(sandbox);
  });
});

void test("FS-ATOMIC-01 failed prepare preserves the previous generated tree", () => {
  withSandbox({}, (sandbox) => {
    const upstream = createReleaseRepo(sandbox);
    writeCodexLogTool(sandbox);
    writeFileSync(
      join(sandbox.plugin, "preexisting-sentinel"),
      "preserve me\n",
    );
    const candidateRecord = join(sandbox.work, "atomic-candidate-path");
    const previous = snapshotTree(sandbox.plugin);
    const result = runCli(sandbox, ["prepare"], {
      SUPERPOWERS_REF: "v1.0.0",
      SUPERPOWERS_UPSTREAM_URL: upstream.REPO,
      SUPERPOWERS_VALIDATOR: writeFailingValidator(
        sandbox,
        "reject-atomic-candidate.py",
        candidateRecord,
      ),
    });
    assertCleanResult(result, 1);
    assert.match(result.stderr, /error: additional plugin validation failed/);
    const candidate = readFileSync(candidateRecord, "utf8").trimEnd();
    const candidateWorkspace = dirname(candidate);
    assert.equal(basename(candidate), basename(sandbox.plugin));
    assert.equal(dirname(candidateWorkspace), dirname(sandbox.plugin));
    assert.match(
      basename(candidateWorkspace),
      /^\.superpowers\.prepare\.[A-Za-z0-9]{6}$/,
    );
    assert.deepEqual(snapshotTree(sandbox.plugin), previous);
    assertNoInvocationPrepareWorkspace(join(sandbox.pkg, "plugins"));
    assertNoCodexContact(sandbox);
  });
});

void test("FS-CLEANUP-01 interrupted state cleanup is invocation-scoped", () => {
  withSandbox({}, (sandbox) => {
    const topology = scenarioValues(
      runScenario(
        sandbox,
        "interrupted-prepare-state",
        join(sandbox.root, "interrupted-prepare"),
      ),
    );
    const upstream = createReleaseRepo(sandbox);
    writeCodexLogTool(sandbox);
    const previous = snapshotTree(topology.PREVIOUS_TREE);
    const interrupted = snapshotTree(topology.PREPARE_STAGING);
    const sibling = snapshotTree(topology.SIBLING);
    const result = runCli(sandbox, ["prepare"], {
      SUPERPOWERS_PLUGIN_ROOT: topology.PREVIOUS_TREE,
      SUPERPOWERS_REF: "v1.0.0",
      SUPERPOWERS_UPSTREAM_URL: upstream.REPO,
      SUPERPOWERS_VALIDATOR: writeFailingValidator(
        sandbox,
        "reject-interrupted-candidate.py",
      ),
    });
    assertCleanResult(result, 1);
    assert.match(result.stderr, /error: additional plugin validation failed/);
    assert.deepEqual(snapshotTree(topology.PREVIOUS_TREE), previous);
    assert.deepEqual(snapshotTree(topology.PREPARE_STAGING), interrupted);
    assert.deepEqual(snapshotTree(topology.SIBLING), sibling);
    assertNoInvocationPrepareWorkspace(join(topology.ROOT, "plugins"), [
      ".superpowers.prepare.interrupted",
    ]);
    assertNoCodexContact(sandbox);
  });
});

void test("FS-SYMLINK-01 escaping and broken symlinks fail closed", () => {
  for (const scenarioName of ["broken-symlink", "escaping-symlink"]) {
    withSandbox({}, (sandbox) => {
      const upstream = createReleaseRepo(sandbox);
      writeCodexLogTool(sandbox);
      const commit = commitUnsafeHookScenario(
        sandbox,
        upstream.REPO,
        scenarioName,
      );
      const previous = snapshotTree(sandbox.plugin);
      const result = runCli(sandbox, ["prepare"], {
        SUPERPOWERS_REF: commit,
        SUPERPOWERS_UPSTREAM_URL: upstream.REPO,
      });
      assertCleanResult(result, 1);
      assert.equal(result.stdout, "");
      assert.match(
        result.stderr,
        /hook materialization failed: symlink escapes or is broken/,
      );
      assert.doesNotMatch(result.stderr, /Traceback/);
      assert.deepEqual(snapshotTree(sandbox.plugin), previous);
      assertNoCodexContact(sandbox);
    });
  }
});

// Rewritten, not re-pointed (PR 11.5 slice 2): the previous version ran the
// real `scripts/probe` with an SPW_ADAPTER stub, a seam only
// scripts/core/adapter.sh honours. Once probe dispatches in-process the stub
// stops taking effect, so this drives `runProbe` against the probe fake
// instead. The ID and the contract — probe mutates nothing — are unchanged.
void test("PROBE-READONLY-01 probe is read-only", async () => {
  const c = createCase({ fakes: "probe" });
  // Two empty listings: probe issues `plugin list --json` once per inspection
  // and the fake fails closed if the sequence runs out.
  seedCodex(c, {});
  // No generated tree is seeded, so the expected status is "needs prepare" —
  // the same state the shell version asserted after a fresh `pin`.
  //
  // BOTH roots, not just the package. The contract names five state kinds —
  // selection, generated, cache, adapter, Codex — and only *generated* lives
  // under c.pkg. caseEnv puts SUPERPOWERS_CONFIG_DIR (selection) and
  // SUPERPOWERS_INSTALLED_SEARCH_ROOT (Codex) under c.home, so a probe that
  // wrote selection state or a cache there would have passed a c.pkg-only
  // snapshot. tests/baseline/probe.test.js:358-359 pairs the same two roots,
  // narrowed to c.home/.codex; c.home is used whole here so selection and any
  // stray cache are covered too.
  const pkgBefore = snapshotTree(c.pkg);
  const homeBefore = snapshotTree(c.home);
  const out = capture();
  const err = capture();
  const status = await runProbe(["--porcelain"], {
    root: c.pkg,
    // `v1.0.0` is the annotated tag lifecycle-fixture.js:118-127 creates on
    // UPSTREAM; both values come from the fixture, neither is invented.
    env: caseEnv(c, {
      SUPERPOWERS_REF: "v1.0.0",
      SUPERPOWERS_UPSTREAM_URL: UPSTREAM,
    }),
    stdout: out.stream,
    stderr: err.stream,
  });
  assert.equal(status, 0, err.text());
  assert.match(out.text(), /^desired_commit=[0-9a-f]{40}$/m);
  assert.match(out.text(), /^status=needs prepare$/m);
  assert.equal(err.text(), "");
  assert.deepEqual(snapshotTree(c.pkg), pkgBefore, "package root");
  assert.deepEqual(snapshotTree(c.home), homeBefore, "case HOME");
});

void test("INSTALL-ORDER-01 install prepares and validates before adapter mutation", () => {
  withSandbox({}, (sandbox) => {
    const upstream = createReleaseRepo(sandbox);
    const result = runCli(
      sandbox,
      ["install"],
      lifecycleEnvironment(sandbox, upstream, {
        SUPERPOWERS_VALIDATOR: writeFailingValidator(
          sandbox,
          "reject-install-candidate.py",
        ),
      }),
    );
    assertCleanResult(result, 1);
    assert.match(result.stderr, /error: additional plugin validation failed/);
    assert.deepEqual(adapterOperations(sandbox), [
      "inspect fingerprint",
      "inspect ownership",
      "inspect update-control",
      "build",
    ]);
  });

  withSandbox({}, (sandbox) => {
    const upstream = createReleaseRepo(sandbox);
    const result = runCli(
      sandbox,
      ["install"],
      lifecycleEnvironment(sandbox, upstream),
    );
    assertCleanResult(result);
    assert.deepEqual(adapterOperations(sandbox), [
      "inspect fingerprint",
      "inspect ownership",
      "inspect update-control",
      "build",
      "inspect ownership",
      "inspect update-control",
      "install",
      "inspect fingerprint",
    ]);
    assert.match(result.stdout, /generated plugin validation passed:/);
    assert.match(result.stdout, /prepared v1\.1\.0 at [0-9a-f]{40}/);
    assert.match(result.stdout, /manager updated/);
  });
});

void test("UPDATE-CONTROL-01 update requires current managed control evidence", () => {
  withSandbox({}, (sandbox) => {
    const upstream = createReleaseRepo(sandbox);
    writeAdapterState(sandbox, {
      plugin: false,
      marketplace: false,
      legacy_plugin: false,
      legacy_marketplace: false,
      update_control: "unsupported",
      fingerprint: null,
    });
    const result = runCli(
      sandbox,
      ["update"],
      lifecycleEnvironment(sandbox, upstream),
    );
    assertCleanResult(result, 1);
    assert.match(
      result.stderr,
      /adapter cannot guarantee manager-controlled updates/,
    );
    assert.equal(adapterOperations(sandbox).includes("install"), false);
    assert.equal(adapterOperations(sandbox).includes("uninstall"), false);
  });

  withSandbox({}, (sandbox) => {
    const upstream = createReleaseRepo(sandbox);
    const result = runCli(
      sandbox,
      ["update"],
      lifecycleEnvironment(sandbox, upstream, {
        SPW_BASELINE_UPDATE_CONTROL_RESPONSE: "malformed",
      }),
    );
    assertCleanResult(result, 1);
    assert.match(result.stderr, /invalid adapter response/);
    assert.equal(adapterOperations(sandbox).includes("install"), false);
    assert.equal(adapterOperations(sandbox).includes("uninstall"), false);
  });

  withSandbox({}, (sandbox) => {
    const upstream = createReleaseRepo(sandbox);
    const result = runCli(
      sandbox,
      ["update"],
      lifecycleEnvironment(sandbox, upstream),
    );
    assertCleanResult(result);
    assert.equal(adapterOperations(sandbox).includes("install"), true);
    assert.equal(adapterOperations(sandbox).includes("uninstall"), false);
    assert.equal(
      JSON.parse(readFileSync(join(sandbox.adapterState, "state.json"), "utf8"))
        .fingerprint,
      upstream.STABLE_COMMIT,
    );
  });
});

void test("UNINSTALL-OWNERSHIP-01 uninstall removes only manager-owned resources", () => {
  for (const managerPresent of [true, false]) {
    withSandbox({}, (sandbox) => {
      const generatedBefore = snapshotTree(sandbox.plugin);
      const cacheBefore = snapshotTree(sandbox.cache);
      writeAdapterState(sandbox, {
        plugin: managerPresent,
        marketplace: managerPresent,
        legacy_plugin: true,
        legacy_marketplace: true,
        update_control: "managed",
        fingerprint: managerPresent ? "0123456" : null,
      });
      const result = runCli(sandbox, ["uninstall"], {
        SPW_ADAPTER: sandbox.adapter,
        SPW_BASELINE_ADAPTER_STATE: sandbox.adapterState,
        SPW_BASELINE_ADAPTER_LOG: sandbox.adapterLog,
      });
      assertCleanResult(result);
      assert.match(
        result.stdout,
        /Legacy superpowers-wrapper Codex state remains installed\./,
      );
      assert.match(result.stdout, /uninstall complete/);
      assert.doesNotMatch(
        readFileSync(sandbox.adapterLog, "utf8"),
        /superpowers-wrapper|other@/,
      );
      assert.deepEqual(adapterOperations(sandbox), [
        "inspect ownership",
        "uninstall",
        "inspect ownership",
      ]);
      assert.deepEqual(
        JSON.parse(
          readFileSync(join(sandbox.adapterState, "state.json"), "utf8"),
        ),
        {
          plugin: false,
          marketplace: false,
          legacy_plugin: true,
          legacy_marketplace: true,
          update_control: "managed",
          fingerprint: null,
        },
      );
      assert.deepEqual(snapshotTree(sandbox.plugin), generatedBefore);
      assert.deepEqual(snapshotTree(sandbox.cache), cacheBefore);
    });
  }
});

void test("LIFECYCLE-VERIFY-01 install and uninstall verify resulting state", () => {
  withSandbox({}, (sandbox) => {
    const upstream = createReleaseRepo(sandbox);
    const result = runCli(
      sandbox,
      ["install"],
      lifecycleEnvironment(sandbox, upstream, {
        SPW_BASELINE_INSTALLED_FINGERPRINT: upstream.BASE_COMMIT,
      }),
    );
    assertCleanResult(result, 1);
    assert.match(
      result.stderr,
      /installed manager fingerprint does not match .* after install/,
    );
    assert.deepEqual(adapterOperations(sandbox).slice(-2), [
      "install",
      "inspect fingerprint",
    ]);
  });

  withSandbox({}, (sandbox) => {
    writeAdapterState(sandbox, {
      plugin: true,
      marketplace: true,
      legacy_plugin: false,
      legacy_marketplace: false,
      update_control: "managed",
      fingerprint: "0123456",
    });
    const result = runCli(sandbox, ["uninstall"], {
      SPW_ADAPTER: sandbox.adapter,
      SPW_BASELINE_ADAPTER_STATE: sandbox.adapterState,
      SPW_BASELINE_ADAPTER_LOG: sandbox.adapterLog,
      SPW_BASELINE_UNINSTALL_NOOP: "1",
    });
    assertCleanResult(result, 1);
    assert.match(
      result.stderr,
      /owned plugin resource is still installed after removal/,
    );
    assert.deepEqual(adapterOperations(sandbox), [
      "inspect ownership",
      "uninstall",
      "inspect ownership",
    ]);
  });
});

void test("LIFECYCLE-INTERRUPT-01 interrupted installation state fails closed", () => {
  withSandbox({}, (sandbox) => {
    const topology = scenarioValues(
      runScenario(
        sandbox,
        "interrupted-install-state",
        join(sandbox.root, "interrupted-install"),
      ),
    );
    const upstream = createReleaseRepo(sandbox);
    writeFileSync(
      join(topology.ROOT, "state.json"),
      `${JSON.stringify({
        plugin: true,
        marketplace: true,
        legacy_plugin: true,
        legacy_marketplace: true,
        update_control: "managed",
        fingerprint: upstream.STABLE_COMMIT,
      })}\n`,
      { encoding: "utf8", mode: 0o600 },
    );
    const before = snapshotTree(topology.ROOT);
    const result = runCli(
      sandbox,
      ["install"],
      lifecycleEnvironment(sandbox, upstream, {
        SPW_BASELINE_ADAPTER_STATE: topology.ROOT,
      }),
    );
    assertCleanResult(result, 1);
    assert.match(
      result.stderr,
      /Legacy superpowers-wrapper Codex state is installed\./,
    );
    assert.doesNotMatch(result.stdout, /manager updated|uninstall complete/);
    assert.deepEqual(adapterOperations(sandbox), [
      "inspect fingerprint",
      "inspect ownership",
      "inspect update-control",
    ]);
    assert.deepEqual(snapshotTree(topology.ROOT), before);
    assert.equal(
      readFileSync(topology.OPERATION_MARKER, "utf8"),
      "install interrupted before verification\n",
    );
  });
});
