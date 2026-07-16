#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const SUBCOMMANDS = ['prepare', 'probe', 'install', 'update', 'uninstall'];
const CODEX_SUBCOMMANDS = ['probe', 'install', 'update', 'uninstall'];
// Mirrors upstream Superpowers' hooks/run-hook.cmd discovery order.
const GIT_BASH_CANDIDATES = [
  'C:\\Program Files\\Git\\bin\\bash.exe',
  'C:\\Program Files (x86)\\Git\\bin\\bash.exe',
];

// Walk upward from the bin's physical location to the directory containing
// package.json. realpathSync first: npm/npx expose the bin through a symlink
// or shim outside the package root.
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

function parseArgs(argv) {
  if (argv.length === 0) return { kind: 'run', cmd: 'update', args: [] };
  const first = argv[0];
  if (first === '--help' || first === '-h') return { kind: 'help' };
  if (first === '--version') return { kind: 'version' };
  if (SUBCOMMANDS.includes(first)) {
    return { kind: 'run', cmd: first, args: argv.slice(1) };
  }
  return { kind: 'usage-error', message: `unknown subcommand: ${first}` };
}

// Search env.PATH for an executable named `name`; on win32 also try PATHEXT
// extensions. Returns the full path or null.
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

// Tool preflight; never touches Codex state. codex is required for subcommands
// whose scripts read or mutate Codex state.
function preflight(cmd, env, platform) {
  const errors = [];
  for (const tool of ['git', 'python3']) {
    if (!findTool(tool, env, platform)) {
      errors.push(`required command not found: ${tool} — install ${tool} and re-run`);
    }
  }
  const shell = discoverShell(env, platform);
  if (!shell) {
    errors.push(platform === 'win32'
      ? 'no POSIX shell found — install Git for Windows (provides bash) or use WSL2'
      : 'required command not found: sh');
  }
  if (CODEX_SUBCOMMANDS.includes(cmd)) {
    const codexBin = env.SUPERPOWERS_CODEX || 'codex';
    // An explicit override may be a path rather than a PATH-resolvable name.
    const found = codexBin.includes(path.sep)
      ? fs.existsSync(codexBin)
      : Boolean(findTool(codexBin, env, platform));
    if (!found) {
      errors.push(`required command not found: ${codexBin} — install the Codex CLI or set SUPERPOWERS_CODEX`);
    }
  }
  return errors.length ? { ok: false, errors } : { ok: true, shell };
}

// POSIX executes the script directly (#!/bin/sh shebang); Windows cannot
// spawn extensionless scripts, so the discovered shell runs the script as
// its first argument.
function buildSpawn(cmd, args, root, shell, platform) {
  const script = path.join(root, 'scripts', cmd);
  if (platform === 'win32') {
    return { file: shell, argv: [script, ...args] };
  }
  return { file: script, argv: args };
}

function usage() {
  return [
    'usage: superpowers-manager [prepare|probe|install|update|uninstall] [args...]',
    '',
    '  prepare    fetch the pinned upstream ref and generate the plugin tree',
    '  probe      report upstream/generated/installed status (accepts --porcelain)',
    '  install    register this package root as a Codex marketplace and install the plugin',
    '  update     probe, then prepare/install only if needed (default when no subcommand)',
    '  uninstall  remove the manager plugin and marketplace from Codex',
    '',
    'Environment overrides (passed through to the scripts): SUPERPOWERS_REF,',
    'SUPERPOWERS_UPSTREAM_URL, SUPERPOWERS_CODEX, SUPERPOWERS_CACHE_DIR,',
    'SUPERPOWERS_PLUGIN_ROOT, SUPERPOWERS_MANIFEST_TEMPLATE,',
    'SUPERPOWERS_VALIDATOR,',
    'SUPERPOWERS_INSTALLED_SEARCH_ROOT, SUPERPOWERS_INSTALL_REFRESH_MODE',
  ].join('\n');
}

function main() {
  const parsed = parseArgs(process.argv.slice(2));
  if (parsed.kind === 'help') {
    console.log(usage());
    process.exit(0);
  }
  const root = resolvePackageRoot(__filename);
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

module.exports = { resolvePackageRoot, parseArgs, findTool, discoverShell, preflight, buildSpawn, usage };

if (require.main === module) main();
