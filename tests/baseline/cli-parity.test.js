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
  writeCodexLogTool,
  writeNoopTool,
} from "./support.js";
import {
  createCase,
  readLog,
  runScript,
  UPSTREAM,
} from "../bin/lifecycle-fixture.js";
// From the NON-TEST helper, not from probe.test.js: importing a *.test.js
// module re-executes and re-registers its tests inside this suite
// (tests/run-node-suites.js:15).
import { caseEnv, seedCodex } from "./probe-fixture.js";
import { capture } from "../unit/helpers/command-harness.js";
import { caseContext } from "../bin/command-context.js";
import { shQuote } from "../lib/git-egress.js";

/** @type {typeof import("../../src/commands/probe.js")} */
const { runProbe } = await import(
  new URL("../../dist/commands/probe.js", import.meta.url).href
);
/** @type {typeof import("../../src/adapter.js")} */
const { runAdapter } = await import(
  new URL("../../dist/adapter.js", import.meta.url).href
);
/** @type {typeof import("../../src/commands/update.js")} */
const { runUpdate } = await import(
  new URL("../../dist/commands/update.js", import.meta.url).href
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

Environment overrides (used by in-process commands): SUPERPOWERS_REF,
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
 * adapter views issue (`src/adapter.ts:797`, `:871`, `:883` — the argument
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
      // Recording came in at PR 11.5 slice 4b (Task 8). Before the flip, the
      // lifecycle commands were observed through the dispatch stub's own JSON
      // record; in-process they reach Codex through runAdapter instead, so the
      // `codex` invocation sequence is what is left to observe them by. Every
      // invocation is recorded, including the rejected ones, so a case can
      // pin the exact sequence rather than only its accepted prefix.
      `printf '%s\\n' "$*" >> ${shQuote(sandbox.codexLog)}`,
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
  writeFileSync(sandbox.codexLog, "", "utf8");
  return tool;
}

/**
 * The `codex` invocations writeListingCodex recorded, in order.
 * @param {Sandbox} sandbox
 * @returns {string[]}
 */
function listingCodexCalls(sandbox) {
  return readFileSync(sandbox.codexLog, "utf8").split("\n").filter(Boolean);
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

// Rewritten for PR 11.5 slice 4b Task 7 (D5). The five lifecycle behaviour
// IDs below no longer drive the baseline sandbox's `stateful-adapter` (the
// `SPW_ADAPTER` seam `scripts/core/adapter.sh` honours) through
// `withSandbox`/`runCli`: `tests/baseline/support.js`'s own
// `validateEnvironment` (`:309-346`) refuses a `SUPERPOWERS_CODEX` override
// that resolves outside the sandbox root, and the lifecycle fixture's fake
// `codex` lives under its own scratch tree
// (`tests/bin/lifecycle-fixture.js`'s `SCRATCH`), never under a baseline
// sandbox. The two fixtures are siloed on purpose, so these five move onto
// `createCase`/`runScript` instead — the same machinery
// `tests/bin/install-commands.test.js` and
// `tests/bin/uninstall-commands.test.js` already drive
// `scripts/install`/`update`/`uninstall` through, still via `/bin/sh`, still
// the shell subject Task 8 has not yet flipped.

/**
 * The fixture's own `codex` log, in place of `adapterOperations(sandbox)`.
 * Every mutation the real adapter performs reaches Codex through `codexBin`
 * (src/adapter.ts:559-700, `runInstall`'s marketplace/plugin `listingCommand`/
 * `mutationCommand` calls), so this is the channel that survives Task 8's
 * flip. `readLog` itself (tests/bin/lifecycle-fixture.js:354-360) does NOT
 * fail closed and never throws: it wraps the `readFileSync` in a bare
 * try/catch and returns `[]` for ANY read error, a missing log included. The
 * presence-form assertions below are what turn that `[]` into a loud failure
 * rather than a silent pass, because each one requires specific lines to be
 * present, not merely absent.
 * @param {import("../bin/lifecycle-fixture.js").CaseEnv} c
 * @returns {string[]}
 */
function codexOperations(c) {
  return readLog(c.codexLog);
}

// Verbatim from tests/bin/install-commands.test.js's own CODEX_MUTATION:
// anchored so "plugin marketplace add" is not also a "plugin add" hit.
const CODEX_MUTATION =
  /^plugin (add|remove) |^plugin marketplace (add|remove) /;

/**
 * Port of tests/bin/install-commands.test.js's `assertNoCodexMutation`. The
 * length check is the non-vacuity guard: an empty log means the fake never
 * ran at all, which would make "no mutation line" trivially true.
 * @param {string[]} log
 */
function assertNoCodexMutation(log) {
  assert.ok(
    log.length > 0,
    "codex log is empty — the fake never ran, so 'no mutation' would pass vacuously",
  );
  const offenders = log.filter((line) => CODEX_MUTATION.test(line));
  assert.deepEqual(
    offenders,
    [],
    `expected no Codex mutation:\n${log.join("\n")}`,
  );
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

// Rewritten, not re-pointed (PR 11.5 slice 4b, Task 8): `update` dispatches
// in-process now, so the dispatch record this used to read
// (`assertOnlyDispatch(sandbox, "update", [])`) can never be written. The ID,
// the test name and the traceability row are unchanged, and so is the contract
// — docs/baseline/behavioral-inventory.md states it as "No arguments is the
// third distinct mode and is exactly equivalent to dispatching `update` with no
// arguments", which is what the equivalence below asserts literally.
//
// Two halves, because no single observable carries both directions of it.
//
// Half A — equivalence. Both invocations run in the SAME sandbox so their
// diagnostics name the same paths; the bare run goes first and the `update` run
// second, so a bare invocation that somehow mutated state could only make the
// two differ, never agree. Half A on its own does NOT name the command: under
// `writeNoopTool`'s silent `exit 0` codex a bare invocation that fell through
// to `probe` produces status 1, empty stdout and the identical
// `error: cannot parse output of 'codex plugin list --json'`, so the two runs
// still agree. That is not a hypothesis — a mutant flipping `parseArgs`' bare
// default from `update` to `probe` was verified to survive an earlier form of
// this case that had only half A.
//
// Half B — identification. The recorded `codex` invocation sequence, the same
// discriminator CLI-COMMANDS-01 uses to tell the three lifecycle commands
// apart, and the only observable left that NAMES the command a bare invocation
// ran: `update` produces exactly the ten calls below, `probe` three, `install`
// seven, `uninstall` four, and `--help`, `--version` and a usage error none.
// It needs `writeListingCodex` — a `codex` that answers, so the run reaches the
// end of its command — and therefore a fresh sandbox of its own: a `codex` that
// answers lets `update` complete its prepare, and a second `update` over the
// already-prepared tree prints less on stdout than the first, which is exactly
// the equality half A asserts. Half A stays cheap and unpolluted; half B pays
// for one real run.
void test("CLI-MODE-DEFAULT-01 no arguments dispatch update", () => {
  // A local upstream and a 40-hex ref in both halves, for the reason
  // CLI-COMMANDS-01's `probe` row states: `update` resolves its effective
  // selection before it ever reaches Codex, and without these it stops at the
  // sandbox git shim's egress refusal against the packaged default URL rather
  // than at the adapter.
  withSandbox({ stubScripts: true }, (sandbox) => {
    writeNoopTool(sandbox);
    const upstream = createReleaseRepo(sandbox);
    const overrides = {
      SPW_BASELINE_DISPATCH_LOG: sandbox.dispatchLog,
      SUPERPOWERS_UPSTREAM_URL: upstream.REPO,
      SUPERPOWERS_REF: upstream.RAW_COMMIT,
    };
    const bare = runCli(sandbox, [], overrides);
    assert.deepEqual(readDispatchLog(sandbox), []);
    clearDispatchLog(sandbox);
    const explicit = runCli(sandbox, ["update"], overrides);
    assert.deepEqual(readDispatchLog(sandbox), []);
    assert.equal(bare.error, undefined);
    assert.equal(bare.signal, null);
    assert.deepEqual(
      { status: bare.status, stdout: bare.stdout, stderr: bare.stderr },
      {
        status: explicit.status,
        stdout: explicit.stdout,
        stderr: explicit.stderr,
      },
    );
    // Non-vacuity: two runs that both produced nothing at all would satisfy
    // the equality above. Both reach a probe and fail closed on the noop
    // `codex`'s unparseable output, so the shared result is a specific,
    // non-empty one.
    assert.equal(bare.status, 1);
    assert.equal(bare.stdout, "");
    assert.equal(
      bare.stderr,
      "error: cannot parse output of 'codex plugin list --json'\n",
    );
  });

  withSandbox({ stubScripts: true }, (sandbox) => {
    const upstream = createReleaseRepo(sandbox);
    writeListingCodex(sandbox);
    // Restated here rather than shared with CLI-COMMANDS-01's `expectedCodex`.
    // This case's whole claim is that a bare invocation produces `update`'s
    // sequence; reading that sequence out of a constant the other case can edit
    // would let the two drift into agreement on a wrong one.
    const updateCodex = [
      "plugin list --json", // update's own probe: fingerprint
      "plugin list --json", // update's own probe: ownership
      "plugin marketplace list --json", // update's own probe: ownership
      "plugin list --json", // install's own probe: fingerprint
      "plugin list --json", // install's own probe: ownership
      "plugin marketplace list --json", // install's own probe: ownership
      "plugin list --json", // install's fresh gate: ownership
      "plugin marketplace list --json", // install's fresh gate: ownership
      "plugin marketplace list --json", // adapter install's marketplace lookup
      "plugin marketplace add",
    ];
    const bare = runCli(sandbox, [], {
      SPW_BASELINE_DISPATCH_LOG: sandbox.dispatchLog,
      SUPERPOWERS_UPSTREAM_URL: upstream.REPO,
      SUPERPOWERS_REF: upstream.RAW_COMMIT,
    });
    assert.equal(bare.error, undefined);
    assert.equal(bare.signal, null);
    assert.deepEqual(readDispatchLog(sandbox), []);
    // The marketplace-add argv carries the sandbox package root, so the
    // recorded line is trimmed back to its operation, as CLI-COMMANDS-01 does.
    assert.deepEqual(
      listingCodexCalls(sandbox).map((line) =>
        line.startsWith("plugin marketplace add ")
          ? "plugin marketplace add"
          : line,
      ),
      updateCodex,
    );
    // Where the run stopped is the fixture's boundary — the sandbox `codex`
    // refuses the marketplace mutation — not a claim of this ID. Asserted only
    // so the sequence above cannot have been produced by some other path.
    assert.equal(bare.status, 1);
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

  // PR 11.5 slice 4b, Task 8. Every command is in-process now, so
  // IN_PROCESS_COMMANDS covers all eight and the loop below would take its
  // in-process branch for these three as well — but they cannot reach
  // `assertCleanResult` in a shared sandbox: each one runs a real probe, a real
  // prepare and a real Codex mutation, and the shared sandbox's state carries
  // between iterations. They are handled after the loop instead, one fresh
  // sandbox each, and pinned by the exact `codex` invocation sequence they
  // produce. That sequence is what replaces the dispatch record's `command`
  // field as the per-command discriminator: it differs for all three, so a
  // routing regression that ran the wrong module is still caught.
  //
  // Restated here rather than derived, because no production table records
  // "needs its own sandbox". Staleness is loud, not silent: a name that stopped
  // belonging here would be skipped by the loop and asserted nowhere, which the
  // `assert.deepEqual` over `handled` below turns into a failure.
  const OWN_SANDBOX = ["install", "update", "uninstall"];
  /** @type {string[]} */
  const handled = [];

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
      if (OWN_SANDBOX.includes(command)) continue;
      handled.push(command);
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
        // Task 3 removed every scripts/<command> regression stub, so a
        // regression that re-spawns a script fails with ENOENT before this
        // weaker empty-dispatch-log check; the log assertion remains real.
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

  // The three lifecycle commands, one fresh sandbox each. Each is pinned by the
  // exact `codex` invocation sequence its module produces against an empty
  // Codex: `install` probes, prepares, re-gates and mutates (7 calls);
  // `update` does its own probe first and then everything `install` does (10);
  // `uninstall` inspects ownership, finds nothing owned to remove, and
  // re-inspects (4). Nothing else in the tree makes those three sequences
  // interchangeable, so this is a genuine per-command discriminator and not
  // merely "the module reached Codex".
  //
  // `install` and `update` stop where the sandbox's `codex` refuses the
  // marketplace mutation; that failure is the fixture's boundary, not a claim
  // of this ID, so only the sequence and the absence of a dispatch are
  // asserted. `uninstall` completes, and its exit status IS asserted.
  /** @type {Record<string, string[]>} */
  const expectedCodex = {
    install: [
      "plugin list --json", // probe: fingerprint
      "plugin list --json", // probe: ownership
      "plugin marketplace list --json", // probe: ownership
      "plugin list --json", // install's fresh gate: ownership
      "plugin marketplace list --json", // install's fresh gate: ownership
      "plugin marketplace list --json", // adapter install's marketplace lookup
      "plugin marketplace add",
    ],
    update: [
      "plugin list --json", // update's own probe: fingerprint
      "plugin list --json", // update's own probe: ownership
      "plugin marketplace list --json", // update's own probe: ownership
      "plugin list --json", // install's own probe: fingerprint
      "plugin list --json", // install's own probe: ownership
      "plugin marketplace list --json", // install's own probe: ownership
      "plugin list --json", // install's fresh gate: ownership
      "plugin marketplace list --json", // install's fresh gate: ownership
      "plugin marketplace list --json", // adapter install's marketplace lookup
      "plugin marketplace add",
    ],
    uninstall: [
      "plugin list --json", // ownership
      "plugin marketplace list --json", // ownership
      "plugin list --json", // post-removal ownership re-inspect
      "plugin marketplace list --json", // post-removal ownership re-inspect
    ],
  };
  for (const command of OWN_SANDBOX) {
    handled.push(command);
    withSandbox({ stubScripts: true }, (sandbox) => {
      const upstream = createReleaseRepo(sandbox);
      writeListingCodex(sandbox);
      const result = runCli(
        sandbox,
        [command, .../** @type {string[]} */ (cases.get(command))],
        {
          SPW_BASELINE_DISPATCH_LOG: sandbox.dispatchLog,
          SUPERPOWERS_UPSTREAM_URL: upstream.REPO,
          SUPERPOWERS_REF: upstream.RAW_COMMIT,
        },
      );
      assert.equal(result.error, undefined);
      assert.equal(result.signal, null);
      assert.deepEqual(
        readDispatchLog(sandbox).map((e) => e.command),
        [],
        `${command} must not spawn a script`,
      );
      // The marketplace-add argv carries the sandbox package root, so the
      // recorded line is trimmed back to its operation before comparison.
      assert.deepEqual(
        listingCodexCalls(sandbox).map((line) =>
          line.startsWith("plugin marketplace add ")
            ? "plugin marketplace add"
            : line,
        ),
        expectedCodex[command],
      );
      if (command === "uninstall") assertCleanResult(result);
    });
  }

  // Every one of the eight is asserted somewhere above: the loop skips exactly
  // the names OWN_SANDBOX claims, and this proves the two halves partition
  // COMMANDS rather than overlapping or leaving a gap.
  assert.deepEqual([...handled].sort(), [...COMMANDS].sort());
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
  // commandRequirements(env) (src/cli.ts:227) takes the environment — `prepare`
  // requires python3 only when SUPERPOWERS_VALIDATOR names one — and returns
  // the whole Record<Subcommand, string[]>; index it per command. These cases
  // configure no validator, so the empty env is the right derivation for them.
  const declared = commandRequirements({});
  // DISPATCH is declared `as const` in production, so its value types are
  // literals; at 8/8 "in-process" (PR 11.5 slice 4b) a direct `=== "spawn"` is
  // TS2367 under `pnpm run typecheck:js`. The derivation is kept rather than
  // collapsed to `[...declared[key]]`, for the same reason
  // tests/bin/readme-requirements.test.js keeps its copy: it is what would put
  // `sh` back into a command's requirement list if an entry ever went back to
  // "spawn", with no edit here.
  /** @type {Record<string, import("../../src/cli.js").DispatchMode>} */
  const dispatch = DISPATCH;
  const requirements = new Map(
    COMMANDS.map((command) => {
      // COMMANDS is a plain string[]; CLI-COMMANDS-01 above asserts it agrees
      // with Object.keys(DISPATCH) as a set in both directions, which is what
      // makes this narrowing sound rather than assumed.
      const key = /** @type {keyof typeof DISPATCH} */ (command);
      return [
        command,
        dispatch[key] === "spawn"
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

// PR 11.5 slice 4b, Task 8, §6.2.2. Two `void test(` blocks stood here and the
// comment above them said of their five scenarios, "Vehicle only … they die
// with buildSpawn in slice 4." That obligation is discharged as follows.
//
// `CLI-ENV-CODEX-PREFLIGHT-01` — ID, test name, contract and traceability row
// all RETAINED. It is not a child-handling property: a custom
// `SUPERPOWERS_CODEX` satisfying launcher preflight with `codex` absent from
// PATH is a requirement-checking contract the flip does not touch. Only the
// body changed, because it ended in `assertOnlyDispatch(sandbox, "install",
// [])` and there is no dispatch record to read any more. See the case below.
//
// `CLI-CHILD-STATUS-01` and all FOUR of its scenarios — RETIRED at the gap,
// with its rows removed from docs/baseline/traceability.md and
// docs/baseline/behavioral-inventory.md in this same commit. The subject is
// gone, not relocated: after the flip the CLI spawns no delegated child, so
// inherited stdio, a propagated raw child status (the ID drove
// `SPW_BASELINE_DELEGATE_EXIT: "42"`), signal-death normalisation, and the
// `spawnSync … ENOENT` diagnostic have no referent at all. Post-flip a Codex
// failure arrives through `runAdapter` and lifecycle handling, which is a
// DIFFERENT observable contract, so the ID may not be reused for it. No
// successor ID is minted here: one would need a fully specified contract of its
// own, and the exit-status half is already covered per command by
// tests/unit/commands-{install,update,uninstall}.test.js, which assert the
// status each handler returns, and by src/cli.ts's single
// `process.exit(status)`.
void test("CLI-ENV-CODEX-PREFLIGHT-01 custom Codex command satisfies launcher preflight", () => {
  withSandbox({ stubScripts: true }, (sandbox) => {
    // A RECORDING custom codex, not `writeNoopTool`'s silent `exit 0`. The
    // dispatch record used to be the positive evidence that preflight admitted
    // the command; in-process the equivalent positive evidence is that the
    // command got far enough to invoke the override. An absence check
    // ("stderr carries no `required command not found`") would pass just as
    // well if the run died for some unrelated reason before preflight.
    const contacted = join(sandbox.root, "custom-codex.log");
    const customCodex = join(sandbox.bin, "baseline-custom-codex");
    writeFileSync(
      customCodex,
      [
        "#!/bin/sh",
        `printf '%s\\n' "$*" >> ${shQuote(contacted)}`,
        "exit 0",
        "",
      ].join("\n"),
      "utf8",
    );
    chmodSync(customCodex, 0o755);
    writeFileSync(contacted, "", "utf8");
    removeTool(sandbox, "codex");
    // A local upstream and a 40-hex ref: `install` resolves its effective
    // selection before its first adapter call, so without these it stops at
    // the sandbox git shim's egress refusal and never contacts the override at
    // all — which would make the recording below vacuous.
    const upstream = createReleaseRepo(sandbox);
    const result = runCli(sandbox, ["install"], {
      SPW_BASELINE_DISPATCH_LOG: sandbox.dispatchLog,
      SUPERPOWERS_CODEX: customCodex,
      SUPERPOWERS_UPSTREAM_URL: upstream.REPO,
      SUPERPOWERS_REF: upstream.RAW_COMMIT,
    });
    assert.equal(result.error, undefined);
    assert.equal(result.signal, null);
    // Preflight admitted the command and `install` reached its first adapter
    // view through the override — exactly, not merely "was contacted".
    assert.deepEqual(
      readFileSync(contacted, "utf8").split("\n").filter(Boolean),
      ["plugin list --json"],
    );
    // The override is an `exit 0` recorder, so its empty output is unparseable
    // and install fails closed at that first inspection. That failure belongs
    // to the fixture's boundary, not to this ID; what this ID owns is that the
    // failure is NOT the preflight one.
    assert.equal(result.status, 1);
    assert.equal(
      result.stdout,
      "Note: remove or disable conflicting Superpowers providers yourself before relying on manager skills.\n",
    );
    // The diagnostic names the OVERRIDE, not `codex` — a second, independent
    // witness that preflight resolved SUPERPOWERS_CODEX rather than a PATH
    // lookup, and the reason this literal is built from `customCodex`.
    assert.equal(
      result.stderr,
      `error: cannot parse output of '${customCodex} plugin list --json'\n`,
    );
    assert.deepEqual(readDispatchLog(sandbox), []);
  });
});

void test("CLI-ENV-01 ten SUPERPOWERS variables pass through", () => {
  withSandbox({ stubScripts: true }, (sandbox) => {
    // Re-anchored, not retired (PR 11.5 slice 4b, Task 8). `update` no longer
    // spawns `scripts/update`, so the dispatch stub that used to record the
    // child's environment is never invoked. The ID, the test name, the
    // traceability row and the contract are unchanged —
    // docs/baseline/behavioral-inventory.md states it as "The CLI inherits its
    // controlled invocation environment wholesale, including the ten public
    // SUPERPOWERS_* overrides; it does not synthesize unrelated XDG_*, npm, or
    // Codex variables" — and there is still exactly one child to observe it on:
    // the `codex` process runAdapter spawns (src/adapter.ts's runCommand). The
    // recording shim below is that child, so the claim is asserted against a
    // real child environment the CLI actually constructs, not against the
    // manager's own inherited process.env.
    //
    // "Wholesale" is true of the manager's own process but NOT of this witness:
    // runAdapter's runCommand deletes NODE_OPTIONS and NODE_PATH from the child
    // environment before execFile (src/adapter.ts:120-122, landed by this
    // slice's Task 1). The dump below therefore covers those two names as well
    // and asserts they are ABSENT, so the row's word is qualified by the test
    // that certifies it rather than quietly contradicted by it. It is also the
    // only place in the tree where that scrub is observable end to end at the
    // CLI level — tests/unit/adapter.test.js pins it at the unit level, and the
    // two surviving shell pins (tests/baseline/ref-resolution.test.js and
    // tests/baseline/selection-location.test.js) drive scripts/ directly.
    const dumped = join(sandbox.root, "codex-env.json");
    const customCodex = join(sandbox.bin, "custom-codex");
    writeFileSync(
      customCodex,
      [
        "#!/bin/sh",
        // python3 is a SANDBOX_TOOLS member (tests/baseline/support.js) and is
        // how support.js's own dispatchStub produced this same JSON shape.
        `exec python3 -c 'import json,os,sys; json.dump({"passthrough": {n: os.environ.get(n) for n in json.loads(sys.argv[1])}, "superpowers_env": {n: v for n, v in os.environ.items() if n.startswith("SUPERPOWERS_")}, "xdg_env": {n: v for n, v in os.environ.items() if n.startswith("XDG_")}, "npm_env": {n: v for n, v in os.environ.items() if n.upper().startswith("NPM_CONFIG_")}, "codex_env": {n: v for n, v in os.environ.items() if n.startswith("CODEX_")}, "node_env": {n: v for n, v in os.environ.items() if n in ("NODE_OPTIONS", "NODE_PATH")}}, open(sys.argv[2], "w"))' ${shQuote(JSON.stringify(PASSTHROUGH_VARIABLES))} ${shQuote(dumped)}`,
        "",
      ].join("\n"),
      "utf8",
    );
    chmodSync(customCodex, 0o755);
    // Non-vacuity for the two scrubbed names, which is the whole difficulty
    // with asserting an absence: "absent from the child" says nothing unless
    // the manager itself had them. NODE_OPTIONS is witnessed by node honouring
    // it — the preload runs in the manager process and leaves a marker — and
    // NODE_PATH arrives through the same `overrides` channel as the ten values
    // whose arrival at the child is asserted below, so the channel is proven to
    // deliver and the deletion is attributable to runCommand.
    const preload = join(sandbox.root, "node-preload.cjs");
    const preloadMarker = join(sandbox.root, "node-preload-marker");
    // NODE_OPTIONS is split on whitespace by node, so a preload path containing
    // any would silently become two unusable tokens rather than failing here.
    assert.equal(/\s/.test(preload), false, "preload path must have no spaces");
    writeFileSync(
      preload,
      `require("node:fs").writeFileSync(${JSON.stringify(preloadMarker)}, "loaded\\n");\n`,
      "utf8",
    );
    // SUPERPOWERS_REF and SUPERPOWERS_UPSTREAM_URL are the two values that
    // stopped being free placeholders at slice 4b's flip: `update` resolves its
    // effective selection before its first adapter call, so a non-resolvable
    // pair stops the run at the sandbox git shim and the child never runs. A
    // real local repository and its 40-hex commit are just as distinctive as
    // the `v9.8.7-rc.1` / `upstream source` placeholders they replace — the
    // assertions below still pin the exact values the child saw.
    const upstream = createReleaseRepo(sandbox, "upstream source");
    const values = {
      SUPERPOWERS_REF: upstream.RAW_COMMIT,
      SUPERPOWERS_UPSTREAM_URL: upstream.REPO,
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
      result = runCli(sandbox, ["update"], {
        SPW_BASELINE_DISPATCH_LOG: sandbox.dispatchLog,
        NODE_OPTIONS: `--require ${preload}`,
        NODE_PATH: join(sandbox.root, "custom-node-path"),
        ...values,
      });
    } finally {
      if (previousLeak === undefined) {
        delete process.env.SUPERPOWERS_BASELINE_LEAK;
      } else {
        process.env.SUPERPOWERS_BASELINE_LEAK = previousLeak;
      }
    }

    assert.equal(result.error, undefined);
    assert.equal(result.signal, null);
    // No script was spawned: the environment reached a child, but not that one.
    assert.deepEqual(readDispatchLog(sandbox), []);
    // Non-vacuity: the record exists only because the CLI actually spawned the
    // child and handed it an environment.
    assert.equal(existsSync(dumped), true, "the codex child never ran");
    // `assertCleanResult` was dropped when this ID moved onto the codex child —
    // the child is an env recorder whose empty output `update` cannot parse, so
    // a zero status is simply false now. It is re-derived rather than deleted:
    // where the run stops is the fixture's boundary and not this ID's contract,
    // but pinning it exactly is what proves the dump above came from the first
    // adapter view and not from some later, differently-built invocation. The
    // diagnostic naming SUPERPOWERS_CODEX is a second witness that the override
    // is the child whose environment was recorded.
    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    assert.equal(
      result.stderr,
      `error: cannot parse output of '${customCodex} plugin list --json'\n`,
    );
    const record = JSON.parse(readFileSync(dumped, "utf8"));
    assert.deepEqual(record.passthrough, values);
    assert.deepEqual(record.superpowers_env, values);
    assert.deepEqual(record.xdg_env, {});
    assert.deepEqual(record.npm_env, {});
    assert.deepEqual(record.codex_env, {});
    // The manager honoured NODE_OPTIONS, so both names were genuinely present
    // in the environment the child inherited from...
    assert.equal(
      existsSync(preloadMarker),
      true,
      "NODE_OPTIONS never reached the manager process",
    );
    // ...and neither survived runCommand's scrub into the child itself.
    assert.deepEqual(record.node_env, {});
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
    // `v1.0.0` is the annotated tag lifecycle-fixture.js:120-129 creates on
    // UPSTREAM; both values come from the fixture, neither is invented.
    env: caseEnv(c, {
      SUPERPOWERS_REF: "v1.0.0",
      SUPERPOWERS_UPSTREAM_URL: UPSTREAM,
    }),
    stdout: out.stream,
    stderr: err.stream,
    // Real, not a double: this case's fake `codex` is on PATH via caseEnv,
    // and runProbe must reach it exactly as it did before ctx.adapter
    // existed.
    adapter: runAdapter,
  });
  assert.equal(status, 0, err.text());
  assert.match(out.text(), /^desired_commit=[0-9a-f]{40}$/m);
  assert.match(out.text(), /^status=needs prepare$/m);
  assert.equal(err.text(), "");
  assert.deepEqual(snapshotTree(c.pkg), pkgBefore, "package root");
  assert.deepEqual(snapshotTree(c.home), homeBefore, "case HOME");
});

// Fixture JSON for the lifecycle fixture's fake `codex`, kept verbatim from
// the shapes tests/bin/uninstall-commands.test.js already exercises against
// the real adapter's ownership parser (installedListingHas), plus a
// "version" field on the manager entry: unlike uninstall, `install`'s own
// fingerprint inspect calls activePluginVersionFromJson (src/codex-json.ts:103),
// which fails closed ("active plugin version is invalid") without one.
const FIXTURE_PLUGIN_LIST_EMPTY = '{"installed":[],"available":[]}';
const FIXTURE_MARKETPLACE_ABSENT = '{"marketplaces":[]}';
const FIXTURE_MANAGER_PLUGIN_PRESENT =
  '{"installed":[{"pluginId":"superpowers@superpowers-manager","version":"1.0.0","name":"superpowers","marketplaceName":"superpowers-manager"}],"available":[]}';
const FIXTURE_MANAGER_MARKETPLACE_PRESENT =
  '{"marketplaces":[{"name":"superpowers-manager","root":"/y"}]}';
const FIXTURE_LEGACY_PLUGIN_PRESENT =
  '{"installed":[{"pluginId":"superpowers@superpowers-wrapper","version":"0.1.1","name":"superpowers","marketplaceName":"superpowers-wrapper"}],"available":[]}';
const FIXTURE_LEGACY_MARKETPLACE_PRESENT =
  '{"marketplaces":[{"name":"superpowers-wrapper","root":"/legacy"}]}';
const FIXTURE_BOTH_PLUGINS_PRESENT =
  '{"installed":[{"pluginId":"superpowers@superpowers-manager","version":"1.0.0","name":"superpowers","marketplaceName":"superpowers-manager"},{"pluginId":"superpowers@superpowers-wrapper","version":"0.1.1","name":"superpowers","marketplaceName":"superpowers-wrapper"}],"available":[]}';
const FIXTURE_BOTH_MARKETPLACES_PRESENT =
  '{"marketplaces":[{"name":"superpowers-manager","root":"/manager"},{"name":"superpowers-wrapper","root":"/legacy"}]}';

/**
 * Builds a lifecycle-fixture case and seeds its fake `codex`'s two listing
 * answers. `createCase` itself only builds the fake executables and the
 * state directory; the listings are the case's own precondition, exactly as
 * `installCase`/`uninstallCase` in tests/bin/{install,uninstall}-commands.test.js
 * seed them for the same fakes.
 *
 * `adapterSeam`/`seamDependency` are deliberately NOT accepted here.
 * `createCase`'s "intercept" mode requires a `seamDependency` declaration
 * (createCase's own eager validation), and
 * `tests/bin/adapter-seam.test.js`'s "every file declaring a seamDependency
 * is in SEAM_SOURCE_FILES" gate scans the whole `tests/` tree for that exact
 * literal and fails any file outside the declared set — verified: adding one
 * here failed that gate. `writeUpdateControlOverride` below is how
 * UPDATE-CONTROL-01 answers `inspect --view update-control` without going
 * through that machinery at all.
 *
 * Recorded deviation (PR 11.5 slice 4b Task 7): the sequence-exhaustion
 * discipline — `nextPluginList` (tests/bin/lifecycle-fakes.js:148), which
 * fails closed when a fixture makes more listing calls than it configured —
 * is NOT in force for these five IDs, and is deliberately not simulated.
 * `respondToListing` consults `nextPluginList` only when its caller passes
 * `sequencePluginList` (tests/bin/lifecycle-fakes.js:89-91), and only
 * tests/bin/probe-fakes.js:33 passes it; the install and uninstall fakes read
 * the flat `plugin_list.json` this helper writes. Adopting it here would mean
 * setting that flag in both lifecycle fakes, which every existing case in
 * tests/bin/install-commands.test.js and tests/bin/uninstall-commands.test.js
 * would then have to be reworked for — a fixture change well outside this
 * slice. What supplies the same guarantee instead: every subcase of the five
 * IDs is guarded either by an exact `deepEqual` on `codexOperations(c)`
 * (which an empty log fails immediately) or by `assertNoCodexMutation`, whose
 * own `log.length > 0` check above rejects an empty log by name. A fake that
 * never ran is therefore a failure here too — by a different mechanism, not
 * by the one the sequence counter provides.
 * @param {object} options
 * @param {"install" | "uninstall"} options.fakes
 * @param {Record<string, unknown>} [options.config]
 * @param {string} [options.plugins]
 * @param {string} [options.marketplaces]
 * @returns {import("../bin/lifecycle-fixture.js").CaseEnv}
 */
function lifecycleCodexCase(options) {
  const c = createCase({ fakes: options.fakes, config: options.config ?? {} });
  writeFileSync(
    join(c.state, "plugin_list.json"),
    `${options.plugins ?? FIXTURE_PLUGIN_LIST_EMPTY}\n`,
  );
  writeFileSync(
    join(c.state, "marketplace_list.json"),
    `${options.marketplaces ?? FIXTURE_MARKETPLACE_ABSENT}\n`,
  );
  return c;
}

/**
 * Answers `inspect --view update-control` with evidence the real adapter
 * cannot produce, and DELEGATES every other operation to the real in-process
 * `runAdapter` — the exact role the `exec "$realAdapter"` tail of the old
 * `SPW_ADAPTER` shell override played before PR 11.5 slice 4b's flip.
 *
 * Converted, not retired (Task 8, Step 5b). The lever this replaces was a
 * hand-written `SPW_ADAPTER` script that became inert the moment `update`
 * began dispatching in-process; both subcases would silently become the third
 * subcase below with the opposite assertion. Injection is not a
 * `seamDependency`, so no gate widens and this file still must not join
 * `SEAM_SOURCE_FILES`
 * (tests/bin/adapter-seam.js).
 *
 * The real adapter's update-control view is hardcoded to "managed"
 * (src/adapter.ts:782), which is why interception is needed at all and why the
 * third subcase needs none.
 *
 * `"malformed"` re-anchors onto the port's own reader rather than the shell's.
 * The shell fixture printed a bare `{`, which `validate-adapter-response.py`
 * rejected with `invalid adapter response` — a diagnostic that exists nowhere
 * under `src/`. An injected double returns a structured `AdapterResult`, so
 * the analogue at the same decision point is evidence the reader cannot
 * interpret: a well-formed envelope whose `update_control` is not a string,
 * which `src/commands/probe.ts`'s `inspect()` fails closed on. The ID's
 * contract — "Unsupported, unknown, or malformed evidence fails without
 * mutation" — is unchanged; only the wording of the diagnostic is the port's.
 *
 * Carries a `calls` array so it satisfies the same shape `caseContext` takes
 * from `recordingAdapter` (tests/bin/command-context.js).
 * @param {"unsupported" | "malformed"} response
 */
function updateControlAdapter(response) {
  /** @type {string[][]} */
  const calls = [];
  /**
   * @param {readonly string[]} argv
   * @param {import("../../src/adapter-protocol.js").AdapterContext} adapterCtx
   * @returns {Promise<import("../../src/adapter-protocol.js").AdapterResult>}
   */
  const adapter = async (argv, adapterCtx) => {
    calls.push([...argv]);
    if (argv.join(" ") === "inspect --view update-control") {
      return {
        status: 0,
        envelope: {
          protocol: 1,
          operation: "inspect",
          ok: true,
          messages: [],
          result: {
            view: "update-control",
            update_control: response === "malformed" ? 42 : response,
          },
          error: null,
        },
      };
    }
    return await runAdapter(argv, adapterCtx);
  };
  adapter.calls = calls;
  return adapter;
}

void test("INSTALL-ORDER-01 install prepares and validates before adapter mutation", async () => {
  {
    const c = lifecycleCodexCase({ fakes: "install" });
    const validator = join(c.dir, "reject-install-candidate.py");
    writeFileSync(validator, "import sys\nsys.exit(1)\n");
    const result = await runScript(c, "install", {
      env: { SUPERPOWERS_VALIDATOR: validator },
    });
    const out = result.stdout + result.stderr;
    assert.notEqual(result.status, 0, `expected install to fail:\n${out}`);
    assert.match(out, /additional plugin validation failed/);
    // The probe triple (fingerprint: one listing; ownership: two listings)
    // runs before prepare's `build` step rejects the candidate — build issues
    // no Codex command of its own (src/adapter.ts:303-557, `runBuild`), so a
    // mutation line appearing here would prove the reject happened too late.
    assert.deepEqual(codexOperations(c), [
      "plugin list --json",
      "plugin list --json",
      "plugin marketplace list --json",
    ]);
  }

  {
    const c = lifecycleCodexCase({ fakes: "install" });
    const result = await runScript(c, "install");
    const out = result.stdout + result.stderr;
    assert.equal(result.status, 0, out);
    assert.ok(
      existsSync(join(c.pkg, "plugins/superpowers/.superpowers-upstream.json")),
    );
    assert.match(result.stdout, /generated plugin validation passed:/);
    assert.match(result.stdout, /prepared v1\.0\.0 at [0-9a-f]{40}/);
    assert.match(result.stdout, /manager updated/);
    // Exact, not merely ordered: an assertOrder-style check over these same
    // needles passed even after a mutation trial moved the FRESH ownership
    // and update-control re-inspect (scripts/install's own gate immediately
    // before `spw_adapter_install`) to AFTER the mutation — the first
    // occurrence of each needle is still the one the initial probe produces,
    // so relative-order checks over repeated needles cannot see a dropped
    // repeat. The exact 9-line array can, and did: with the reorder in
    // place, line 5 below would be missing, and every following list would
    // fail closed to a deepEqual mismatch instead of passing.
    assert.deepEqual(codexOperations(c), [
      "plugin list --json", // fingerprint (initial probe)
      "plugin list --json", // ownership (initial probe)
      "plugin marketplace list --json", // ownership (initial probe)
      "plugin list --json", // ownership (install's fresh gate, before mutation)
      "plugin marketplace list --json", // ownership (install's fresh gate, before mutation)
      "plugin marketplace list --json", // adapter install's own marketplace lookup
      `plugin marketplace add ${c.pkg}`,
      "plugin add superpowers@superpowers-manager",
      "plugin list --json", // fingerprint verification, after mutation
    ]);
  }
});

void test("UPDATE-CONTROL-01 update requires current managed control evidence", async () => {
  {
    const c = lifecycleCodexCase({ fakes: "install" });
    const { ctx, stdout, stderr } = caseContext(c, {
      adapter: updateControlAdapter("unsupported"),
    });
    const status = await runUpdate([], ctx);
    const out = stdout() + stderr();
    assert.notEqual(status, 0, `expected update to fail:\n${out}`);
    assert.match(
      stderr(),
      /adapter cannot guarantee manager-controlled updates/,
    );
    // Still read through the case's fake `codex`, not the double: every
    // operation other than the intercepted view goes to the real runAdapter,
    // which execs that fake, so the mutation claim is made against the same
    // channel the third subcase below uses.
    assertNoCodexMutation(codexOperations(c));
  }

  {
    const c = lifecycleCodexCase({ fakes: "install" });
    const { ctx, stdout, stderr } = caseContext(c, {
      adapter: updateControlAdapter("malformed"),
    });
    const status = await runUpdate([], ctx);
    const out = stdout() + stderr();
    assert.notEqual(status, 0, `expected update to fail:\n${out}`);
    assert.match(
      stderr(),
      /adapter returned a non-string update_control for inspect --view update-control/,
    );
    assertNoCodexMutation(codexOperations(c));
  }

  {
    // Delegate mode (the default): the real adapter's update-control view
    // always answers "managed" (src/adapter.ts:782), which is exactly what
    // this branch needs, so no interception is wired at all.
    const c = lifecycleCodexCase({ fakes: "install" });
    const result = await runScript(c, "update");
    const out = result.stdout + result.stderr;
    assert.equal(result.status, 0, out);
    assert.match(result.stdout, /manager updated/);
    // Exact, matching INSTALL-ORDER-01's own reasoning: `update`'s needs-prepare
    // branch runs its OWN probe (fingerprint, ownership), then prepare's
    // `build`, then `scripts/install` in full — which repeats the same
    // sequence INSTALL-ORDER-01 pins (its own probe, its own fresh gate,
    // then the mutation triple, then the final fingerprint verify).
    assert.deepEqual(codexOperations(c), [
      "plugin list --json", // update's own probe: fingerprint
      "plugin list --json", // update's own probe: ownership
      "plugin marketplace list --json", // update's own probe: ownership
      "plugin list --json", // install's own probe: fingerprint
      "plugin list --json", // install's own probe: ownership
      "plugin marketplace list --json", // install's own probe: ownership
      "plugin list --json", // install's fresh gate: ownership
      "plugin marketplace list --json", // install's fresh gate: ownership
      "plugin marketplace list --json", // adapter install's own marketplace lookup
      `plugin marketplace add ${c.pkg}`,
      "plugin add superpowers@superpowers-manager",
      "plugin list --json", // fingerprint verification, after mutation
    ]);
    // The desired commit update just prepared, and the commit the fake
    // codex's cache now reports installed, must be the SAME value — a
    // stronger, fixture-independent replacement for asserting a specific
    // upstream commit literal that this shared, single-tag fixture does not
    // have two of.
    const generated = JSON.parse(
      readFileSync(
        join(c.pkg, "plugins/superpowers/.superpowers-upstream.json"),
        "utf8",
      ),
    );
    const installed = JSON.parse(
      readFileSync(
        join(
          c.state,
          "codex-home/plugins/cache/superpowers-manager/superpowers/1.0.0/.superpowers-upstream.json",
        ),
        "utf8",
      ),
    );
    assert.equal(installed.commit, generated.commit);
  }
});

void test("UNINSTALL-OWNERSHIP-01 uninstall removes only manager-owned resources", async () => {
  for (const managerPresent of [true, false]) {
    const c = lifecycleCodexCase({
      fakes: "uninstall",
      plugins: managerPresent
        ? FIXTURE_BOTH_PLUGINS_PRESENT
        : FIXTURE_LEGACY_PLUGIN_PRESENT,
      marketplaces: managerPresent
        ? FIXTURE_BOTH_MARKETPLACES_PRESENT
        : FIXTURE_LEGACY_MARKETPLACE_PRESENT,
    });
    // Deep and content-bearing, restoring both claims the pre-rewrite version
    // made with `snapshotTree(sandbox.plugin)` and `snapshotTree(sandbox.cache)`.
    // The WHOLE package root is snapshotted rather than just
    // `plugins/superpowers`, because under this fixture that single snapshot
    // carries both: the generated tree is at `c.pkg/plugins/superpowers`, and
    // the manager's upstream cache — its own directory in the baseline, via
    // SUPERPOWERS_CACHE_DIR — defaults to `$root/.cache/upstream`
    // (scripts/prepare:12, src/commands/prepare.ts:255), which is inside
    // `c.pkg` here because `runScript` sets no SUPERPOWERS_CACHE_DIR
    // (tests/bin/lifecycle-fixture.js:296-312). A readdirSync of top-level
    // names would see neither a change inside `.codex-plugin/` nor a cache
    // appearing. Same form as PROBE-READONLY-01's own `snapshotTree(c.pkg)`.
    const pkgBefore = snapshotTree(c.pkg);
    const result = await runScript(c, "uninstall");
    const out = result.stdout + result.stderr;
    assert.equal(result.status, 0, out);
    assert.match(
      result.stdout,
      /Legacy superpowers-wrapper Codex state remains installed\./,
    );
    assert.match(result.stdout, /uninstall complete/);
    const codex = codexOperations(c);
    // "Never touches the legacy plugin or marketplace" is not asserted
    // separately: the exact `deepEqual` below is a superset of it — no line
    // naming `superpowers@superpowers-wrapper` or `superpowers-wrapper` can
    // appear in a log pinned to these exact entries.
    // Exact: ownership inspect (list + marketplace list), then the mutation
    // uninstall issues ONLY for what ownership reported present (both, when
    // managerPresent; neither, when not — src/adapter.ts:702-772,
    // `runUninstall`), then the post-removal ownership re-inspect.
    assert.deepEqual(
      codex,
      managerPresent
        ? [
            "plugin list --json",
            "plugin marketplace list --json",
            "plugin remove superpowers@superpowers-manager",
            "plugin marketplace remove superpowers-manager",
            "plugin list --json",
            "plugin marketplace list --json",
          ]
        : [
            "plugin list --json",
            "plugin marketplace list --json",
            "plugin list --json",
            "plugin marketplace list --json",
          ],
    );
    // Uninstall never touches the generated tree or the cache
    // (scripts/uninstall's own closing note: "local generated artifacts ...
    // were left in place").
    assert.deepEqual(snapshotTree(c.pkg), pkgBefore, "package root");
  }
});

void test("LIFECYCLE-VERIFY-01 install and uninstall verify resulting state", async () => {
  {
    // `pluginAdd: "stale"` makes the fake Codex's install branch write a
    // deliberately wrong cached commit (install-fakes.js:145-150), so the
    // post-install fingerprint verification finds a real, installed, but
    // MISMATCHED commit — install's own verification failure, not a fixture
    // fault.
    const c = lifecycleCodexCase({
      fakes: "install",
      config: { pluginAdd: "stale" },
    });
    const result = await runScript(c, "install");
    const out = result.stdout + result.stderr;
    assert.notEqual(result.status, 0, `expected install to fail:\n${out}`);
    assert.match(
      result.stderr,
      /installed manager fingerprint does not match .* after install/,
    );
    assert.ok(!out.includes("manager updated"), out);
    assert.deepEqual(codexOperations(c).slice(-2), [
      "plugin add superpowers@superpowers-manager",
      "plugin list --json",
    ]);
  }

  {
    // `removesMutateState: false` ports the shell driver's `remove_noop`
    // marker (tests/bin/lifecycle-config.js:17-24): the adapter's uninstall
    // op runs and reports success, but the fake Codex's listings never
    // change, so the post-removal ownership re-inspect still finds the
    // manager plugin installed.
    const c = lifecycleCodexCase({
      fakes: "uninstall",
      plugins: FIXTURE_MANAGER_PLUGIN_PRESENT,
      marketplaces: FIXTURE_MANAGER_MARKETPLACE_PRESENT,
      config: { removesMutateState: false },
    });
    const result = await runScript(c, "uninstall");
    const out = result.stdout + result.stderr;
    assert.notEqual(result.status, 0, `expected uninstall to fail:\n${out}`);
    assert.match(
      result.stderr,
      /owned plugin resource is still installed after removal/,
    );
    assert.deepEqual(codexOperations(c), [
      "plugin list --json",
      "plugin marketplace list --json",
      "plugin remove superpowers@superpowers-manager",
      "plugin marketplace remove superpowers-manager",
      "plugin list --json",
      "plugin marketplace list --json",
    ]);
  }
});

void test("LIFECYCLE-INTERRUPT-01 interrupted installation state fails closed", async () => {
  const c = lifecycleCodexCase({
    fakes: "install",
    plugins: FIXTURE_BOTH_PLUGINS_PRESENT,
    marketplaces: FIXTURE_BOTH_MARKETPLACES_PRESENT,
  });
  // The manager plugin listing claims version 1.0.0 is installed, so the
  // fingerprint inspect that runs before the legacy-state check
  // (src/adapter.ts:784-855, the "fingerprint" view) needs a matching cached
  // tree to read, or it fails on a DIFFERENT diagnostic ("cannot inspect
  // active Codex plugin fingerprint") than this ID's own contract. The
  // commit value itself is irrelevant: the legacy check runs on
  // identity_state alone and never reads it.
  const cache = join(
    c.state,
    "codex-home/plugins/cache/superpowers-manager/superpowers/1.0.0",
  );
  mkdirSync(cache, { recursive: true });
  writeFileSync(
    join(cache, ".superpowers-upstream.json"),
    `${JSON.stringify({ commit: "0".repeat(40) })}\n`,
  );
  const result = await runScript(c, "install");
  const out = result.stdout + result.stderr;
  assert.notEqual(result.status, 0, `expected install to fail:\n${out}`);
  assert.match(
    result.stderr,
    /Legacy superpowers-wrapper Codex state is installed\./,
  );
  assert.doesNotMatch(result.stdout, /manager updated|uninstall complete/);
  // The legacy-state check (scripts/install's own
  // `spw_require_no_legacy_state`) runs immediately after the initial probe
  // triple and before the status-based prepare branch, so the generated tree
  // must never come to exist and no mutation can have reached Codex — a
  // structural replacement for the old fixture-only "ROOT is untouched"
  // check, which asserted something the STATEFUL adapter owned, not
  // something this subject's real side effects ever touched.
  assert.equal(
    existsSync(join(c.pkg, "plugins/superpowers/.superpowers-upstream.json")),
    false,
  );
  assertNoCodexMutation(codexOperations(c));
  assert.deepEqual(codexOperations(c), [
    "plugin list --json",
    "plugin list --json",
    "plugin marketplace list --json",
  ]);
});

/**
 * A recording `codex` that reports a specific active manager version, written
 * to an arbitrary path so a case can point SUPERPOWERS_CODEX at it. Close in
 * shape to writeListingCodex (:202), but NOT a parameterised copy of it: this
 * one takes a path and a version that helper hardcodes, and it also answers
 * `plugin marketplace add` / `plugin add` with exit 0, which that helper
 * rejects with exit 99. The install cases below drive a mutation, so the
 * mutating commands have to succeed here; the listing-only cases must keep
 * failing closed on them. Do not consolidate the two on the strength of the
 * shared listing branches.
 * @param {Sandbox} sandbox
 * @param {string} toolPath
 * @param {string} version empty string reports no active plugin
 * @param {string} log
 */
function writeVersionCodex(sandbox, toolPath, version, log) {
  const installed = version
    ? `{"installed":[{"pluginId":"superpowers@superpowers-manager","version":"${version}"}]}`
    : '{"installed":[]}';
  writeFileSync(
    toolPath,
    [
      "#!/bin/sh",
      `printf '%s\\n' "$*" >> ${shQuote(log)}`,
      'case "$*" in',
      `  'plugin list --json') printf '%s\\n' '${installed}' ;;`,
      "  'plugin marketplace list --json')",
      "    printf '%s\\n' '{\"marketplaces\":[]}' ;;",
      "  'plugin marketplace add '*|'plugin add '*) exit 0 ;;",
      "  *)",
      "    printf 'unexpected codex command: %s\\n' \"$*\" >&2",
      "    exit 99 ;;",
      "esac",
      "",
    ].join("\n"),
    "utf8",
  );
  chmodSync(toolPath, 0o755);
  writeFileSync(log, "", "utf8");
  return toolPath;
}

/**
 * Seed the installed plugin cache the fingerprint view reads.
 * `installedRootForVersion` (src/codex-state.ts:43-50) builds
 * `<searchRoot>/plugins/cache/<marketplace>/<plugin>/<version>`.
 * @param {string} searchRoot
 * @param {string} version
 * @param {string} commit
 */
function seedInstalledCache(searchRoot, version, commit) {
  const root = join(
    searchRoot,
    "plugins",
    "cache",
    "superpowers-manager",
    "superpowers",
    version,
  );
  mkdirSync(root, { recursive: true });
  writeFileSync(
    join(root, ".superpowers-upstream.json"),
    `${JSON.stringify({ commit })}\n`,
    "utf8",
  );
  return root;
}

// The five CLI-ENV-* rows below were owned by tests/test_adapter_protocol.sh
// until PR 11.5 slice 5. Each is an environment-resolution rule, not a
// property of the transport, so each is asserted here against the real CLI.

const CACHE_COMMIT = "d884ae0f2f6e5c4b3a29187e6d5c4b3a29187e6d";
const OTHER_COMMIT = "1111111222222233333334444444555555566666";

/**
 * The selection half of a probe environment. Without it the run fails in
 * computeEffectiveSelection, before any Codex call -- see the note above.
 * @param {ReturnType<typeof createReleaseRepo>} upstream
 */
function localSelection(upstream) {
  return {
    SUPERPOWERS_UPSTREAM_URL: upstream.REPO,
    SUPERPOWERS_REF: upstream.RAW_COMMIT,
  };
}

void test("CLI-ENV-CODEX-LISTING-01 the fingerprint listing uses the SUPERPOWERS_CODEX override, and resolves codex from PATH when it is unset", () => {
  // Half one: the override is used. `codex` is removed from PATH entirely, so
  // a run that reaches a listing at all can only have reached it through the
  // override -- an assertion on the override's log alone would still pass if
  // a PATH `codex` had served the call.
  withSandbox({ stubScripts: true }, (sandbox) => {
    const log = join(sandbox.root, "override-codex.log");
    const override = join(sandbox.bin, "baseline-override-codex");
    writeVersionCodex(sandbox, override, "", log);
    removeTool(sandbox, "codex");
    const upstream = createReleaseRepo(sandbox);
    const result = runCli(sandbox, ["probe", "--porcelain"], {
      ...localSelection(upstream),
      SUPERPOWERS_CODEX: override,
    });
    assert.equal(result.error, undefined);
    assert.deepEqual(
      readFileSync(log, "utf8").split("\n").filter(Boolean)[0],
      "plugin list --json",
    );
  });

  // Half two: with the override unset, the same run resolves `codex` from
  // PATH. writeListingCodex installs its recorder AT `sandbox.bin/codex`, so
  // a recorded call is proof of PATH resolution.
  withSandbox({ stubScripts: true }, (sandbox) => {
    writeListingCodex(sandbox);
    const upstream = createReleaseRepo(sandbox);
    const result = runCli(
      sandbox,
      ["probe", "--porcelain"],
      localSelection(upstream),
    );
    assert.equal(result.error, undefined);
    assert.equal(listingCodexCalls(sandbox)[0], "plugin list --json");
  });
});

void test("CLI-ENV-CODEX-MUTATION-01 the install mutation uses the SUPERPOWERS_CODEX override", () => {
  withSandbox({ stubScripts: true }, (sandbox) => {
    const log = join(sandbox.root, "override-codex.log");
    const override = join(sandbox.bin, "baseline-override-codex");
    writeVersionCodex(sandbox, override, "", log);
    // Again: no `codex` on PATH, so the mutation below cannot have been served
    // by anything except the override.
    removeTool(sandbox, "codex");
    const upstream = createReleaseRepo(sandbox);
    const result = runCli(sandbox, ["install"], {
      SUPERPOWERS_CODEX: override,
      SUPERPOWERS_UPSTREAM_URL: upstream.REPO,
      SUPERPOWERS_REF: upstream.RAW_COMMIT,
    });
    assert.equal(result.error, undefined);
    const calls = readFileSync(log, "utf8").split("\n").filter(Boolean);
    // The MUTATING call specifically. Listing calls alone would satisfy
    // CLI-ENV-CODEX-LISTING-01 and say nothing about this row, whose contract
    // names the mutation path (src/adapter.ts:577).
    assert.ok(
      calls.some((line) => line.startsWith("plugin marketplace add ")),
      calls.join(" | "),
    );
  });
});

// The contract is "without explicit overrides", so the variable must be
// ABSENT, not empty. `runCli` cannot express that -- tests/baseline/support.js
// puts SUPERPOWERS_INSTALLED_SEARCH_ROOT into every environment it builds and
// runCli passes that object to spawnSync as the complete env -- but
// `runCliWithoutEnvironment` (tests/baseline/cli-parity.test.js:152) exists
// for exactly this: it takes a list of names and deletes each from the
// environment after baseEnvironment builds it. CLI-ENV-LOCATION-01 (`:1408`)
// and CLI-ENV-PREPARE-01 (`:1454`) already use it for the same reason.
//
// An earlier draft of this plan asserted the default through the EMPTY STRING
// instead, on the false premise that the harness could not unset. Empty is
// kept below as its own half, because empty-equals-absent is a real property
// of two lines and worth pinning -- but it is the secondary case, not the
// contract's subject.
void test("CLI-ENV-INSTALLED-DEFAULTS-01 with no codex override and no search root the listing resolves codex from PATH and the installed fingerprint is read under $HOME/.codex", () => {
  // Half one: the override is genuinely ABSENT from the environment.
  withSandbox({ stubScripts: true }, (sandbox) => {
    const version = "6.1.1+manager.d884ae0";
    // Both defaults in one run: the recorder is at `sandbox.bin/codex` (PATH),
    // and the cache is seeded ONLY under $HOME/.codex. If either default were
    // resolved differently the fingerprint below would be absent.
    writeVersionCodex(
      sandbox,
      join(sandbox.bin, "codex"),
      version,
      sandbox.codexLog,
    );
    seedInstalledCache(join(sandbox.home, ".codex"), version, CACHE_COMMIT);
    // Deliberately NOT seeded at sandbox.codex, the harness default: a run
    // that read the harness value would find no cache and fail closed at
    // src/adapter.ts:843-847 rather than reporting CACHE_COMMIT.
    const upstream = createReleaseRepo(sandbox);
    const result = runCliWithoutEnvironment(
      sandbox,
      ["probe", "--porcelain"],
      ["SUPERPOWERS_INSTALLED_SEARCH_ROOT"],
      localSelection(upstream),
    );
    assert.equal(result.error, undefined);
    assert.equal(listingCodexCalls(sandbox)[0], "plugin list --json");
    assert.match(
      result.stdout,
      new RegExp(`^installed_commit=${CACHE_COMMIT}$`, "m"),
    );
  });

  // Half two: the empty string reaches the same default. This is not a
  // restatement of half one -- it asserts that two specific lines agree.
  // validateEnvironment skips path checking when `value === ""`
  // (tests/baseline/support.js:312), so the empty value survives to the
  // manager; src/adapter.ts:827 tests `if (!searchRoot)`, which is true for
  // absent and empty alike. Step 5's second mutation makes that equality an
  // asserted property rather than a reading of the source.
  withSandbox({ stubScripts: true }, (sandbox) => {
    const version = "6.1.1+manager.d884ae0";
    writeVersionCodex(
      sandbox,
      join(sandbox.bin, "codex"),
      version,
      sandbox.codexLog,
    );
    seedInstalledCache(join(sandbox.home, ".codex"), version, CACHE_COMMIT);
    const upstream = createReleaseRepo(sandbox);
    const result = runCli(sandbox, ["probe", "--porcelain"], {
      ...localSelection(upstream),
      SUPERPOWERS_INSTALLED_SEARCH_ROOT: "",
    });
    assert.equal(result.error, undefined);
    assert.match(
      result.stdout,
      new RegExp(`^installed_commit=${CACHE_COMMIT}$`, "m"),
    );
  });

  // Half three: an EMPTY HOME composes the root as `/.codex`, not as a
  // cwd-relative `.codex`. Replaces tests/test_adapter_protocol.sh:526-548,
  // which drove the same fixture through `inspect --view fingerprint` and
  // asserted the resolved root by name.
  //
  // Not a restatement of halves one and two: those pin which VARIABLE supplies
  // the root when both defaults hold. This one pins the `|| "/"` composition in
  // `join(env.HOME || "/", ".codex")` (src/adapter.ts:834) -- the arm reached
  // only once HOME is present but empty, where shell expansion of `$HOME/.codex`
  // yielded `/.codex` and this port must agree.
  //
  // The cwd decoy is what makes the assertion specific. sandbox.work is the
  // working directory runCliWithoutEnvironment spawns in, and it is seeded with
  // a cache for the SAME active version, so an implementation that resolved the
  // relative `.codex` against the process cwd would report
  // `installed_commit=${CACHE_COMMIT}` and exit 0. Asserting only "the run
  // failed" would pass on that implementation, and also on one that rejected an
  // empty HOME outright before composing anything.
  withSandbox({ stubScripts: true }, (sandbox) => {
    const version = "6.1.1+manager.d884ae0";
    writeVersionCodex(
      sandbox,
      join(sandbox.bin, "codex"),
      version,
      sandbox.codexLog,
    );
    seedInstalledCache(join(sandbox.work, ".codex"), version, CACHE_COMMIT);
    const upstream = createReleaseRepo(sandbox);
    const result = runCliWithoutEnvironment(
      sandbox,
      ["probe", "--porcelain"],
      ["SUPERPOWERS_INSTALLED_SEARCH_ROOT"],
      { ...localSelection(upstream), HOME: "" },
    );
    assert.equal(result.error, undefined);
    assert.equal(result.status, 1);
    // Exact, because the resolved root inside this text IS the contract: it is
    // the only observable that separates `/.codex` from the decoy. probe
    // replays the adapter envelope's own failure (src/commands/probe.ts:459),
    // so the adapter's fail() text (src/adapter.ts:843-847) arrives verbatim.
    // Whole-stream equality also carries the retiring case's second guard --
    // that this is a CONTROLLED failure -- since a protocol violation would
    // have added an `error: invalid adapter response:` line here.
    //
    // This is the one assertion in the file whose outcome depends on state
    // outside the sandbox: it presumes the host has no readable cache at
    // /.codex/plugins/cache/superpowers-manager/superpowers/<version>. Nothing
    // is written there -- the run only reads -- but were such a cache to exist,
    // the probe would succeed and this equality would fail. The property is
    // inherited from the retiring shell case, which composed the same absolute
    // root, and it is left as-is rather than parameterised because `/.codex` is
    // the literal the `|| "/"` arm produces and substituting a sandbox-relative
    // path would stop testing that arm. On a POSIX host creating /.codex needs
    // root, so the precondition holds wherever this suite is meant to run; if
    // this assertion ever fails with an `installed_commit=` line in stdout,
    // check for /.codex before suspecting the manager.
    assert.equal(
      result.stderr,
      "error: cannot inspect active Codex plugin fingerprint under " +
        `/.codex/plugins/cache/superpowers-manager/superpowers/${version}\n`,
    );
    // Fail-closed: no porcelain block at all, so the decoy's commit was never
    // reported. The retiring case asserted the same by requiring no adapter
    // result file.
    assert.equal(result.stdout, "");
  });

  // Half four: an ABSENT HOME fails closed BEFORE any composition, with its own
  // diagnostic. Replaces tests/test_adapter_protocol.sh:563-579.
  //
  // A separate code path from half three, and the two must not be merged into
  // one "no usable HOME" case: src/adapter.ts:828-832 tests
  // `env.HOME === undefined` and returns early, so an absent HOME never reaches
  // the `|| "/"` fallback half three pins. The messages differ, and asserting
  // each exactly is what keeps either branch from being deleted in favour of
  // the other.
  //
  // Same cwd decoy, for the same reason: absent HOME must not degrade into
  // reading a cwd-relative `.codex`, which would exit 0 with the decoy's
  // commit instead of failing.
  withSandbox({ stubScripts: true }, (sandbox) => {
    const version = "6.1.1+manager.d884ae0";
    writeVersionCodex(
      sandbox,
      join(sandbox.bin, "codex"),
      version,
      sandbox.codexLog,
    );
    seedInstalledCache(join(sandbox.work, ".codex"), version, CACHE_COMMIT);
    const upstream = createReleaseRepo(sandbox);
    // BOTH names deleted. Unsetting only HOME would leave
    // SUPERPOWERS_INSTALLED_SEARCH_ROOT -- which baseEnvironment always sets
    // (tests/baseline/support.js:538) -- winning at src/adapter.ts:826, and the
    // HOME branch would never be reached at all.
    const result = runCliWithoutEnvironment(
      sandbox,
      ["probe", "--porcelain"],
      ["SUPERPOWERS_INSTALLED_SEARCH_ROOT", "HOME"],
      localSelection(upstream),
    );
    assert.equal(result.error, undefined);
    assert.equal(result.status, 1);
    assert.equal(
      result.stderr,
      "error: cannot inspect active Codex plugin fingerprint without HOME\n",
    );
    assert.equal(result.stdout, "");
  });
});

void test("CLI-ENV-INSTALLED-ROOT-01 the active version selects its exact plugin cache path below SUPERPOWERS_INSTALLED_SEARCH_ROOT", () => {
  withSandbox({ stubScripts: true }, (sandbox) => {
    const activeVersion = "6.1.1+manager.d884ae0";
    const staleVersion = "6.0.0+manager.aaaaaaa";
    const searchRoot = join(sandbox.root, "custom-codex-root");
    // TWO versions seeded under the same root with different commits, and the
    // listing reports the active one. Asserting a single seeded version would
    // pass on any implementation that read the root at all; this fails unless
    // the exact per-version path is selected.
    seedInstalledCache(searchRoot, activeVersion, CACHE_COMMIT);
    seedInstalledCache(searchRoot, staleVersion, OTHER_COMMIT);
    // $HOME/.codex is seeded with the WRONG commit for the same version, so a
    // run that ignored the override and fell back to the default would report
    // OTHER_COMMIT and fail here rather than passing silently.
    seedInstalledCache(
      join(sandbox.home, ".codex"),
      activeVersion,
      OTHER_COMMIT,
    );
    writeVersionCodex(
      sandbox,
      join(sandbox.bin, "codex"),
      activeVersion,
      sandbox.codexLog,
    );
    const upstream = createReleaseRepo(sandbox);
    const result = runCli(sandbox, ["probe", "--porcelain"], {
      ...localSelection(upstream),
      SUPERPOWERS_INSTALLED_SEARCH_ROOT: searchRoot,
    });
    assert.equal(result.error, undefined);
    assert.match(
      result.stdout,
      new RegExp(`^installed_commit=${CACHE_COMMIT}$`, "m"),
    );
  });
});

void test("CLI-ENV-REFRESH-MODE-01 install refuses a refresh mode outside add-only and remove-add, before any Codex mutation", () => {
  // Half one: a third value is refused, and the refusal happens BEFORE the
  // mutation. src/adapter.ts:580-585 validates the enumeration three
  // statements after requireCodex and before the marketplace lookup.
  withSandbox({ stubScripts: true }, (sandbox) => {
    writeListingCodex(sandbox);
    const upstream = createReleaseRepo(sandbox);
    const result = runCli(sandbox, ["install"], {
      SUPERPOWERS_UPSTREAM_URL: upstream.REPO,
      SUPERPOWERS_REF: upstream.RAW_COMMIT,
      SUPERPOWERS_INSTALL_REFRESH_MODE: "replace",
    });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 1);
    assert.match(
      result.stderr,
      /^error: unsupported SUPERPOWERS_INSTALL_REFRESH_MODE: replace$/m,
    );
    // The refusal is fail-closed: nothing was mutated. This filters EVERY
    // mutation verb the install path can reach -- `plugin marketplace add`
    // (:619), `plugin marketplace remove` (:636), `plugin remove` (:665) and
    // `plugin add` (:672) -- not just the first one. An earlier draft named
    // `plugin marketplace add` alone, which is the last of the four an early
    // mutation would reach: a defect that removed the plugin, or removed the
    // marketplace, before the enumeration check would have left this
    // assertion green while the comment above it claimed otherwise.
    assert.deepEqual(
      listingCodexCalls(sandbox).filter((line) =>
        /^plugin (marketplace )?(add|remove) /.test(line),
      ),
      [],
    );
  });

  // Half two: an accepted value gets PAST that point on an otherwise
  // identical fixture. This is what makes half one specific to the value
  // rather than to the fixture.
  withSandbox({ stubScripts: true }, (sandbox) => {
    writeListingCodex(sandbox);
    const upstream = createReleaseRepo(sandbox);
    const result = runCli(sandbox, ["install"], {
      SUPERPOWERS_UPSTREAM_URL: upstream.REPO,
      SUPERPOWERS_REF: upstream.RAW_COMMIT,
      SUPERPOWERS_INSTALL_REFRESH_MODE: "add-only",
    });
    assert.equal(result.error, undefined);
    assert.doesNotMatch(
      result.stderr,
      /unsupported SUPERPOWERS_INSTALL_REFRESH_MODE/,
    );
    assert.ok(
      listingCodexCalls(sandbox).some((line) =>
        line.startsWith("plugin marketplace add "),
      ),
      listingCodexCalls(sandbox).join(" | "),
    );
  });

  // Half three: the OTHER accepted value. The contract names a closed
  // enumeration of two, and halves one and two together only establish that
  // `add-only` is in it and `replace` is not -- an implementation that
  // rejected `remove-add` would leave both of them green. The retiring
  // witness (tests/test_adapter_protocol.sh:301-311) drove `remove-add`
  // explicitly and asserted the removal and the addition both reached Codex;
  // dropping that half here would have narrowed the contract without saying
  // so.
  //
  // This half needs a fixture the other two do not. writeListingCodex exits
  // 99 on `plugin marketplace add`, so the run fails closed at
  // src/adapter.ts:626 and never reaches the refresh-mode branch at :665.
  // writeVersionCodex accepts the marketplace add, so the run gets as far as
  // the plugin mutations. `plugin remove` is deliberately NOT accepted by it
  // and does not need to be: src/adapter.ts:666-671 issues that command
  // without checking its status, so the run continues to `plugin add`
  // regardless -- and the stub records every invocation before dispatching on
  // it, so the attempt is observable either way.
  withSandbox({ stubScripts: true }, (sandbox) => {
    writeVersionCodex(
      sandbox,
      join(sandbox.bin, "codex"),
      "",
      sandbox.codexLog,
    );
    const upstream = createReleaseRepo(sandbox);
    const result = runCli(sandbox, ["install"], {
      SUPERPOWERS_UPSTREAM_URL: upstream.REPO,
      SUPERPOWERS_REF: upstream.RAW_COMMIT,
      SUPERPOWERS_INSTALL_REFRESH_MODE: "remove-add",
    });
    assert.equal(result.error, undefined);
    assert.doesNotMatch(
      result.stderr,
      /unsupported SUPERPOWERS_INSTALL_REFRESH_MODE/,
    );
    const calls = listingCodexCalls(sandbox);
    const removedAt = calls.findIndex((line) =>
      line.startsWith("plugin remove "),
    );
    const addedAt = calls.findIndex((line) => line.startsWith("plugin add "));
    // Presence AND order. `remove-add` is the mode's whole meaning: asserting
    // only that both commands appear would pass on an implementation that
    // added first and removed afterwards, which uninstalls what it just
    // installed.
    assert.notEqual(removedAt, -1, calls.join(" | "));
    assert.notEqual(addedAt, -1, calls.join(" | "));
    assert.ok(removedAt < addedAt, calls.join(" | "));
  });
});
