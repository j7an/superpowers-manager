#!/usr/bin/env node
// @ts-check

import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';

/**
 * @typedef {'pin' | 'track-latest' | 'unpin' | 'prepare' | 'probe' | 'install' | 'update' | 'uninstall'} Subcommand
 */

/**
 * @typedef {{ kind: 'run', cmd: Subcommand, args: string[] }} RunParseResult
 * @typedef {{ kind: 'help' }} HelpParseResult
 * @typedef {{ kind: 'version' }} VersionParseResult
 * @typedef {{ kind: 'usage-error', message: string }} UsageErrorParseResult
 * @typedef {RunParseResult | HelpParseResult | VersionParseResult | UsageErrorParseResult} ParseResult
 */

/**
 * @typedef {{ ok: true, shell: string }} PreflightOk
 * @typedef {{ ok: false, errors: string[] }} PreflightError
 * @typedef {PreflightOk | PreflightError} PreflightResult
 */

/**
 * @typedef {{ file: string, argv: string[] }} SpawnDescriptor
 */

const SUBCOMMANDS = [
  'pin', 'track-latest', 'unpin', 'prepare', 'probe', 'install', 'update', 'uninstall',
];
const PIN_TAG_RE = /^v(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:-(?:(?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*))*))?$/;
const PIN_COMMIT_RE = /^[0-9A-Fa-f]{40}$/;
/** @type {Record<Subcommand, string[]>} */
const COMMAND_REQUIREMENTS = {
  pin: ['git', 'python3'],
  'track-latest': ['python3'],
  unpin: [],
  prepare: ['git', 'python3'],
  probe: ['git', 'python3', 'codex'],
  install: ['git', 'python3', 'codex'],
  update: ['git', 'python3', 'codex'],
  uninstall: ['python3', 'codex'],
};
// Mirrors upstream Superpowers' hooks/run-hook.cmd discovery order.
const GIT_BASH_CANDIDATES = [
  'C:\\Program Files\\Git\\bin\\bash.exe',
  'C:\\Program Files (x86)\\Git\\bin\\bash.exe',
];

// Walk upward from the bin's physical location to the directory containing
// package.json. realpathSync first: npm/npx expose the bin through a symlink
// or shim outside the package root.
/**
 * @param {string} scriptPath
 * @returns {string | null}
 */
function resolvePackageRoot(scriptPath) {
  let dir;
  try {
    dir = path.dirname(fs.realpathSync(scriptPath));
  } catch (err) {
    return null;
  }
  for (;;) {
    if (fs.existsSync(path.join(dir, 'package.json'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * @param {string} moduleFilename
 * @param {string | undefined} argvPath
 * @returns {boolean}
 */
function isMain(moduleFilename, argvPath) {
  if (!argvPath) return false;
  return moduleFilename === fs.realpathSync(argvPath);
}

/**
 * @param {string[]} argv
 * @returns {ParseResult}
 */
function parseArgs(argv) {
  /** @type {string | undefined} */
  const first = argv[0];
  if (argv.length === 0) return { kind: 'run', cmd: 'update', args: [] };
  if (first === '--help' || first === '-h') return { kind: 'help' };
  if (first === '--version') return { kind: 'version' };
  if (first && SUBCOMMANDS.includes(first)) {
    const args = argv.slice(1);
    if (first === 'pin' && args.length !== 1) {
      return { kind: 'usage-error', message: 'usage: superpowers-manager pin REF' };
    }
    if (first === 'pin' && !PIN_TAG_RE.test(args[0]) && !PIN_COMMIT_RE.test(args[0])) {
      return {
        kind: 'usage-error',
        message: 'pin REF must be an exact v-prefixed SemVer tag or full 40-hex commit',
      };
    }
    if ((first === 'track-latest' || first === 'unpin') && args.length !== 0) {
      return { kind: 'usage-error', message: `usage: superpowers-manager ${first}` };
    }
    return { kind: 'run', cmd: /** @type {Subcommand} */ (first), args };
  }
  return { kind: 'usage-error', message: `unknown subcommand: ${first}` };
}

// Search env.PATH for an executable named `name`; on win32 also try PATHEXT
// extensions. Returns the full path or null.
/**
 * @param {string} name
 * @param {NodeJS.ProcessEnv} env
 * @param {NodeJS.Platform} platform
 * @returns {string | null}
 */
function findTool(name, env, platform) {
  const pathVar = env.PATH || env.Path || '';
  const dirs = pathVar.split(path.delimiter).filter(Boolean);
  const exts = platform === 'win32'
    ? (env.PATHEXT || '.EXE;.CMD;.BAT;.COM').split(';')
    : [''];
  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = path.join(dir, name + ext.toLowerCase());
      try {
        fs.accessSync(candidate, fs.constants.X_OK);
        return candidate;
      } catch (err) { /* keep looking */ }
    }
  }
  return null;
}

// POSIX: `sh` on PATH. Windows: Git Bash at its standard install paths,
// then `bash` on PATH.
/**
 * @param {NodeJS.ProcessEnv} env
 * @param {NodeJS.Platform} platform
 * @returns {string | null}
 */
function discoverShell(env, platform) {
  if (platform !== 'win32') return findTool('sh', env, platform);
  for (const candidate of GIT_BASH_CANDIDATES) {
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch (err) { /* keep looking */ }
  }
  return findTool('bash', env, platform);
}

/**
 * @returns {Record<Subcommand, string[]>}
 */
function commandRequirements() {
  return COMMAND_REQUIREMENTS;
}

// Tool preflight; never touches Codex state. Requirements are specific to the
// selected command, while a POSIX shell remains mandatory for every command.
/**
 * @param {Subcommand} cmd
 * @param {NodeJS.ProcessEnv} env
 * @param {NodeJS.Platform} platform
 * @returns {PreflightResult}
 */
function preflight(cmd, env, platform) {
  const errors = [];
  for (const tool of COMMAND_REQUIREMENTS[cmd]) {
    if (tool === 'codex') {
      const codexBin = env.SUPERPOWERS_CODEX || 'codex';
      // An explicit override may be a path rather than a PATH-resolvable name.
      const found = codexBin.includes(path.sep)
        ? fs.existsSync(codexBin)
        : Boolean(findTool(codexBin, env, platform));
      if (!found) {
        errors.push(`required command not found: ${codexBin} — install the Codex CLI or set SUPERPOWERS_CODEX`);
      }
    } else if (!findTool(tool, env, platform)) {
      errors.push(`required command not found: ${tool} — install ${tool} and re-run`);
    }
  }
  const shell = discoverShell(env, platform);
  if (!shell) {
    errors.push(platform === 'win32'
      ? 'no POSIX shell found — install Git for Windows (provides bash) or use WSL2'
      : 'required command not found: sh');
  }
  if (errors.length) return { ok: false, errors };
  return { ok: true, shell: /** @type {string} */ (shell) };
}

// POSIX executes the script directly (#!/bin/sh shebang); Windows cannot
// spawn extensionless scripts, so the discovered shell runs the script as
// its first argument.
/**
 * @param {Subcommand} cmd
 * @param {string[]} args
 * @param {string} root
 * @param {string} shell
 * @param {NodeJS.Platform} platform
 * @returns {SpawnDescriptor}
 */
function buildSpawn(cmd, args, root, shell, platform) {
  const script = path.join(root, 'scripts', cmd);
  if (platform === 'win32') {
    return { file: shell, argv: [script, ...args] };
  }
  return { file: script, argv: args };
}

function usage() {
  return [
    'usage: superpowers-manager [command] [args...]',
    '',
    'Selection commands (save intent only; they do not prepare or install it):',
    '  pin REF       save an exact upstream release tag or commit',
    '  track-latest  save selection of the latest stable upstream release',
    '  unpin         remove the saved selection and return to the packaged fallback',
    '',
    'Apply and lifecycle commands:',
    '  prepare    fetch the pinned upstream ref and generate the plugin tree',
    '  probe      report upstream/generated/installed status (accepts --porcelain)',
    '  install    register this package root as a Codex marketplace and install the plugin',
    '  update     probe, then prepare/install only if needed (default when no subcommand)',
    '  uninstall  remove the manager plugin and marketplace from Codex',
    '',
    'Environment overrides (passed through to the scripts): SUPERPOWERS_REF,',
    'SUPERPOWERS_UPSTREAM_URL, SUPERPOWERS_CODEX, SUPERPOWERS_CACHE_DIR,',
    'SUPERPOWERS_CONFIG_DIR, XDG_CONFIG_HOME,',
    'SUPERPOWERS_PLUGIN_ROOT, SUPERPOWERS_MANIFEST_TEMPLATE,',
    'SUPERPOWERS_VALIDATOR,',
    'SUPERPOWERS_INSTALLED_SEARCH_ROOT, SUPERPOWERS_INSTALL_REFRESH_MODE',
    '',
    'Selection state uses SUPERPOWERS_CONFIG_DIR when set; otherwise it uses',
    '$XDG_CONFIG_HOME/superpowers-manager, then $HOME/.config/superpowers-manager.',
  ].join('\n');
}

function main() {
  const parsed = parseArgs(process.argv.slice(2));
  if (parsed.kind === 'help') {
    console.log(usage());
    process.exit(0);
  }
  const root = resolvePackageRoot(import.meta.filename);
  if (!root) {
    console.error('error: cannot resolve the superpowers-manager package root');
    process.exit(1);
  }
  if (parsed.kind === 'version') {
    console.log(JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version);
    process.exit(0);
  }
  if (parsed.kind === 'usage-error') {
    console.error(`error: ${parsed.message}`);
    console.error(usage());
    process.exit(2);
  }
  const pf = preflight(parsed.cmd, process.env, process.platform);
  if (!pf.ok) {
    for (const e of pf.errors) console.error(`error: ${e}`);
    process.exit(1);
  }
  const script = path.join(root, 'scripts', parsed.cmd);
  if (!fs.existsSync(script)) {
    console.error(`error: missing script: ${script}`);
    process.exit(1);
  }
  const spawn = buildSpawn(parsed.cmd, parsed.args, root, pf.shell, process.platform);
  // env is inherited wholesale, so every SUPERPOWERS_* override passes through.
  const res = spawnSync(spawn.file, spawn.argv, { stdio: 'inherit', env: process.env });
  if (res.error) {
    console.error(`error: cannot run ${spawn.file}: ${res.error.message}`);
    process.exit(1);
  }
  process.exit(res.status === null ? 1 : res.status);
}

export {
  resolvePackageRoot, isMain, parseArgs, findTool, discoverShell,
  commandRequirements, preflight, buildSpawn, usage,
};

if (isMain(import.meta.filename, process.argv[1])) main();
