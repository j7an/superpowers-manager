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
} from 'node:fs';
import { tmpdir } from 'node:os';
import {
  basename,
  delimiter,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const FIXTURES = join(ROOT, 'tests', 'fixtures', 'baseline');
const ADAPTER = join(FIXTURES, 'bin', 'stateful-adapter');
const REGISTERED_SANDBOXES = new WeakMap();
const SANDBOX_TOOLS = [
  'node',
  'sh',
  'git',
  'python3',
  'awk',
  'basename',
  'cat',
  'chmod',
  'cp',
  'cut',
  'dirname',
  'grep',
  'ln',
  'mkdir',
  'mktemp',
  'mv',
  'rm',
  'sed',
  'sort',
  'tail',
  'tr',
];
const COMMANDS = [
  'pin',
  'track-latest',
  'unpin',
  'prepare',
  'probe',
  'install',
  'update',
  'uninstall',
];
const PASSTHROUGH_VARIABLES = [
  'SUPERPOWERS_REF',
  'SUPERPOWERS_UPSTREAM_URL',
  'SUPERPOWERS_CODEX',
  'SUPERPOWERS_CACHE_DIR',
  'SUPERPOWERS_CONFIG_DIR',
  'SUPERPOWERS_PLUGIN_ROOT',
  'SUPERPOWERS_MANIFEST_TEMPLATE',
  'SUPERPOWERS_VALIDATOR',
  'SUPERPOWERS_INSTALLED_SEARCH_ROOT',
  'SUPERPOWERS_INSTALL_REFRESH_MODE',
];
const PATH_ENVIRONMENT_VARIABLES = new Set([
  'HOME',
  'TMPDIR',
  'GIT_CONFIG_GLOBAL',
  'XDG_CONFIG_HOME',
  'SUPERPOWERS_CODEX',
  'SUPERPOWERS_CACHE_DIR',
  'SUPERPOWERS_CONFIG_DIR',
  'SUPERPOWERS_PLUGIN_ROOT',
  'SUPERPOWERS_MANIFEST_TEMPLATE',
  'SUPERPOWERS_VALIDATOR',
  'SUPERPOWERS_INSTALLED_SEARCH_ROOT',
  'SPW_ADAPTER',
  'SPW_ADAPTER_RESPONSE_VALIDATOR',
  'SPW_PACKAGE_ROOT',
  'SPW_BASELINE_ADAPTER_STATE',
  'SPW_BASELINE_ADAPTER_LOG',
  'SPW_BASELINE_DISPATCH_LOG',
  'SPW_BASELINE_GIT_LOG',
  'SPW_BASELINE_RUNTIME_ADAPTER',
  'SPW_BASELINE_SANDBOX_ROOT',
  'SPW_BASELINE_VALIDATOR_MARKER',
]);

function hostExecutable(name) {
  if (name === 'node') return realpathSync(process.execPath);
  for (const directory of (process.env.PATH || '').split(delimiter)) {
    if (!directory) continue;
    const candidate = join(directory, name);
    try {
      accessSync(candidate, constants.X_OK);
    } catch {
      // Keep looking through the host PATH used only during sandbox setup.
      continue;
    }
    if (name === 'python3') {
      const result = spawnSync(
        candidate,
        ['-c', 'import os,sys; print(os.path.realpath(sys.executable))'],
        { env: process.env, encoding: 'utf8' },
      );
      const executable = result.status === 0 ? result.stdout.trim() : '';
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

function linkHostTool(bin, name) {
  symlinkSync(hostExecutable(name), join(bin, name));
}

function assertSandboxHostTool(bin, name) {
  const result = spawnSync(join(bin, name), ['--version'], {
    env: { PATH: bin },
    encoding: 'utf8',
  });
  if (result.error || result.status !== 0) {
    throw new Error(
      `sandbox tool setup failed for ${name} under controlled PATH; resolve its host shim to a runnable executable`,
    );
  }
}

function registeredRoot(sandbox) {
  const root = (
    sandbox
    && typeof sandbox === 'object'
    && REGISTERED_SANDBOXES.get(sandbox)
  );
  if (!root) throw new Error('unregistered sandbox');
  if (sandbox.root !== root) {
    throw new Error('invalid registered sandbox root');
  }
  return root;
}

function pathEntryExists(pathValue) {
  try {
    lstatSync(pathValue);
    return true;
  } catch (error) {
    if (error && error.code === 'ENOENT') return false;
    throw error;
  }
}

function physicalPath(pathValue, label) {
  let existing = resolve(pathValue);
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
    if (error && error.code === 'ENOENT') {
      throw new Error(`${label} contains an unresolvable symlink`);
    }
    throw error;
  }
}

function assertContainedPath(sandbox, pathValue, label) {
  const root = registeredRoot(sandbox);
  if (typeof pathValue !== 'string' || !isAbsolute(pathValue)) {
    throw new Error(`${label} must be an absolute path within sandbox root`);
  }
  const candidate = physicalPath(pathValue, label);
  const fromRoot = relative(root, candidate);
  if (
    fromRoot === '..'
    || fromRoot.startsWith(`..${sep}`)
    || isAbsolute(fromRoot)
  ) {
    throw new Error(`${label} resolves outside sandbox root`);
  }
  return pathValue;
}

function validateEnvironment(sandbox, environment, cwd) {
  if (environment.PATH !== sandbox.bin) {
    throw new Error('PATH must equal the controlled sandbox tool directory');
  }
  if (environment.SPW_BASELINE_SANDBOX_ROOT !== sandbox.root) {
    throw new Error('SPW_BASELINE_SANDBOX_ROOT must equal sandbox root');
  }
  for (const [name, value] of Object.entries(environment)) {
    if (!PATH_ENVIRONMENT_VARIABLES.has(name) || value === '') continue;
    if (
      name === 'SUPERPOWERS_CODEX'
      && !value.includes('/')
      && !value.includes('\\')
    ) {
      continue;
    }
    assertContainedPath(sandbox, value, name);
  }

  const source = environment.SUPERPOWERS_UPSTREAM_URL;
  if (!source) return;
  if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(source)) {
    if (source.startsWith('file://')) {
      assertContainedPath(
        sandbox,
        fileURLToPath(source),
        'SUPERPOWERS_UPSTREAM_URL',
      );
    }
    return;
  }
  if (/^[^/]+@[^:]+:.+/.test(source)) return;
  assertContainedPath(
    sandbox,
    resolve(cwd, source),
    'SUPERPOWERS_UPSTREAM_URL',
  );
}

function copyRuntimePackage(pkg) {
  mkdirSync(pkg, { recursive: true });
  cpSync(join(ROOT, 'bin'), join(pkg, 'bin'), { recursive: true });
  cpSync(join(ROOT, 'scripts'), join(pkg, 'scripts'), { recursive: true });
  cpSync(join(ROOT, 'config'), join(pkg, 'config'), { recursive: true });
  copyFileSync(join(ROOT, 'package.json'), join(pkg, 'package.json'));

  const manifestDirectory = join(pkg, 'plugins', 'superpowers', '.codex-plugin');
  mkdirSync(manifestDirectory, { recursive: true });
  copyFileSync(
    join(
      ROOT,
      'plugins',
      'superpowers',
      '.codex-plugin',
      'plugin.template.json',
    ),
    join(manifestDirectory, 'plugin.template.json'),
  );
}

function dispatchStub(command) {
  return `#!/bin/sh
set -eu

python3 - ${JSON.stringify(command)} "$@" <<'PY'
import json
import os
import sys

command, *arguments = sys.argv[1:]
log_path = os.environ["SPW_BASELINE_DISPATCH_LOG"]
passthrough = ${JSON.stringify(PASSTHROUGH_VARIABLES)}
record = {
    "command": command,
    "argv": arguments,
    "passthrough": {name: os.environ.get(name) for name in passthrough},
    "superpowers_env": {
        name: value
        for name, value in os.environ.items()
        if name.startswith("SUPERPOWERS_")
    },
    "xdg_env": {
        name: value
        for name, value in os.environ.items()
        if name.startswith("XDG_")
    },
    "npm_env": {
        name: value
        for name, value in os.environ.items()
        if name.upper().startswith("NPM_CONFIG_")
    },
    "codex_env": {
        name: value
        for name, value in os.environ.items()
        if name.startswith("CODEX_")
    },
}
with open(log_path, "a", encoding="utf-8") as handle:
    json.dump(record, handle, allow_nan=False, separators=(",", ":"))
    handle.write("\\n")
raise SystemExit(int(os.environ.get("SPW_BASELINE_DELEGATE_EXIT", "0")))
PY
`;
}

function installDispatchStubs(sandbox) {
  registeredRoot(sandbox);
  for (const command of COMMANDS) {
    const script = join(sandbox.pkg, 'scripts', command);
    writeFileSync(script, dispatchStub(command), 'utf8');
    chmodSync(script, 0o755);
  }
}

function writeNoopTool(sandbox, name = 'codex') {
  registeredRoot(sandbox);
  if (basename(name) !== name) throw new Error('tool name must be a basename');
  const tool = join(sandbox.bin, name);
  assertContainedPath(sandbox, tool, 'sandbox tool');
  writeFileSync(tool, '#!/bin/sh\nexit 0\n', 'utf8');
  chmodSync(tool, 0o755);
  return tool;
}

function createSandbox({ stubScripts = false } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'spw-baseline-')));
  const sandbox = {
    root,
    pkg: join(root, 'pkg'),
    bin: join(root, 'bin'),
    home: join(root, 'home'),
    tmp: join(root, 'tmp'),
    config: join(root, 'config'),
    cache: join(root, 'cache'),
    plugin: join(root, 'pkg', 'plugins', 'superpowers'),
    codex: join(root, 'codex'),
    git: join(root, 'git'),
    gitConfig: join(root, 'git', 'config'),
    work: join(root, 'work'),
    adapter: join(root, 'bin', 'stateful-adapter'),
    runtimeAdapter: join(
      root,
      'pkg',
      'scripts',
      'adapters',
      'codex',
      'adapter',
    ),
    adapterState: join(root, 'adapter-state'),
    adapterLog: join(root, 'adapter.log'),
    dispatchLog: join(root, 'dispatch.log'),
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
    sandbox.adapterState,
  ]) {
    mkdirSync(directory, { recursive: true });
  }
  copyRuntimePackage(sandbox.pkg);
  copyFileSync(ADAPTER, sandbox.adapter);
  chmodSync(sandbox.adapter, 0o755);
  for (const tool of SANDBOX_TOOLS) {
    linkHostTool(sandbox.bin, tool);
  }
  for (const tool of ['node', 'python3', 'git']) {
    assertSandboxHostTool(sandbox.bin, tool);
  }
  REGISTERED_SANDBOXES.set(sandbox, root);
  if (stubScripts) installDispatchStubs(sandbox);
  return sandbox;
}

function baseEnvironment(sandbox, overrides = {}, cwd = sandbox.work) {
  assertContainedPath(sandbox, cwd, 'working directory');
  const environment = {
    PATH: sandbox.bin,
    HOME: sandbox.home,
    TMPDIR: sandbox.tmp,
    GIT_CONFIG_GLOBAL: sandbox.gitConfig,
    GIT_CONFIG_NOSYSTEM: '1',
    SUPERPOWERS_CONFIG_DIR: sandbox.config,
    SUPERPOWERS_CACHE_DIR: sandbox.cache,
    SUPERPOWERS_PLUGIN_ROOT: sandbox.plugin,
    SUPERPOWERS_MANIFEST_TEMPLATE: join(
      sandbox.pkg,
      'plugins/superpowers/.codex-plugin/plugin.template.json',
    ),
    SUPERPOWERS_INSTALLED_SEARCH_ROOT: sandbox.codex,
    SPW_BASELINE_RUNTIME_ADAPTER: sandbox.runtimeAdapter,
    SPW_BASELINE_SANDBOX_ROOT: sandbox.root,
    ...overrides,
  };
  validateEnvironment(sandbox, environment, cwd);
  return environment;
}

function runCli(sandbox, args = [], overrides = {}, options = {}) {
  const cwd = options.cwd || sandbox.work;
  assertContainedPath(sandbox, cwd, 'working directory');
  if (
    Object.hasOwn(overrides, 'SPW_ADAPTER')
    && !Object.hasOwn(overrides, 'SUPERPOWERS_CODEX')
    && !existsSync(join(sandbox.bin, 'codex'))
  ) {
    writeNoopTool(sandbox);
  }
  return spawnSync(
    join(sandbox.bin, 'node'),
    [join(sandbox.pkg, 'bin', 'superpowers-manager.js'), ...args],
    {
      cwd,
      env: baseEnvironment(sandbox, overrides, cwd),
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
    },
  );
}

function runScenario(sandbox, command, destination, overrides = {}) {
  assertContainedPath(sandbox, destination, 'scenario destination');
  return spawnSync(
    join(sandbox.bin, 'sh'),
    [
      join(ROOT, 'tests', 'builders', 'baseline-scenario.sh'),
      command,
      destination,
    ],
    {
      cwd: sandbox.work,
      env: baseEnvironment(sandbox, overrides),
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
    },
  );
}

function readDispatchLog(sandbox) {
  registeredRoot(sandbox);
  if (!existsSync(sandbox.dispatchLog)) return [];
  const text = readFileSync(sandbox.dispatchLog, 'utf8');
  return text
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function clearDispatchLog(sandbox) {
  registeredRoot(sandbox);
  writeFileSync(sandbox.dispatchLog, '', 'utf8');
}

function removeTool(sandbox, name) {
  registeredRoot(sandbox);
  if (basename(name) !== name) throw new Error('tool name must be a basename');
  const tool = join(sandbox.bin, name);
  if (existsSync(tool)) unlinkSync(tool);
}

function writeAdapterState(sandbox, state) {
  registeredRoot(sandbox);
  const stateFile = join(sandbox.adapterState, 'state.json');
  writeFileSync(stateFile, `${JSON.stringify(state)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  });
  return stateFile;
}

function destroySandbox(sandbox) {
  const root = registeredRoot(sandbox);
  assertContainedPath(sandbox, root, 'sandbox deletion target');
  REGISTERED_SANDBOXES.delete(sandbox);
  rmSync(root, { recursive: true, force: true });
}

function fixturePath(...parts) {
  return join(FIXTURES, ...parts);
}

export {
  COMMANDS,
  PASSTHROUGH_VARIABLES,
  baseEnvironment,
  clearDispatchLog,
  createSandbox,
  destroySandbox,
  fixturePath,
  readDispatchLog,
  removeTool,
  runCli,
  runScenario,
  writeAdapterState,
  writeNoopTool,
};
