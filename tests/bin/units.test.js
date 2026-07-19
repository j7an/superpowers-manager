// @ts-check
// Unit tests for the bin's pure functions. Platform and env are injected so
// the Windows dispatch path is testable without Windows.
import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as bin from '../../bin/superpowers-manager.js';

// --- parseArgs ---
assert.deepStrictEqual(bin.parseArgs([]), { kind: 'run', cmd: 'update', args: [] });
assert.deepStrictEqual(
  bin.parseArgs(['probe', '--porcelain']),
  { kind: 'run', cmd: 'probe', args: ['--porcelain'] }
);
assert.deepStrictEqual(
  bin.parseArgs(['pin', 'v6.1.1']),
  { kind: 'run', cmd: 'pin', args: ['v6.1.1'] }
);
for (const ref of [
  'v0.0.0',
  'v1.2.3-0',
  'v1.2.3-alpha.1',
  '0123456789abcdef0123456789abcdef01234567',
  '0123456789ABCDEF0123456789ABCDEF01234567',
]) {
  assert.deepStrictEqual(
    bin.parseArgs(['pin', ref]),
    { kind: 'run', cmd: 'pin', args: [ref] }
  );
}
for (const ref of [
  'main',
  '1.2.3',
  'V1.2.3',
  'v01.2.3',
  'v1.02.3',
  'v1.2.03',
  'v1.2.3-01',
  'v1.2.3+build.1',
  '0123456789abcdef0123456789abcdef0123456',
  '0123456789abcdef0123456789abcdef012345678',
  'g123456789abcdef0123456789abcdef01234567',
  'v1.2.3\ninvalid',
]) {
  assert.strictEqual(bin.parseArgs(['pin', ref]).kind, 'usage-error');
}
for (const argv of [['pin'], ['pin', 'a', 'b'], ['track-latest', 'x'], ['unpin', 'x']]) {
  assert.strictEqual(bin.parseArgs(argv).kind, 'usage-error');
}
assert.strictEqual(bin.parseArgs(['track-latest']).kind, 'run');
assert.strictEqual(bin.parseArgs(['unpin']).kind, 'run');
for (const cmd of ['prepare', 'probe', 'install', 'update', 'uninstall']) {
  assert.strictEqual(bin.parseArgs([cmd]).kind, 'run');
}
assert.strictEqual(bin.parseArgs(['--help']).kind, 'help');
assert.strictEqual(bin.parseArgs(['-h']).kind, 'help');
assert.strictEqual(bin.parseArgs(['--version']).kind, 'version');
// Unknown subcommands and stray flags NEVER fall through to update.
assert.strictEqual(bin.parseArgs(['bogus']).kind, 'usage-error');
assert.strictEqual(bin.parseArgs(['--porcelain']).kind, 'usage-error');

const requirements = bin.commandRequirements();
assert.deepStrictEqual(requirements.pin, ['git', 'python3']);
assert.deepStrictEqual(requirements['track-latest'], ['python3']);
assert.deepStrictEqual(requirements.unpin, []);
assert.deepStrictEqual(requirements.uninstall, ['python3', 'codex']);

// --- usage separates saving selection intent from applying it ---
const help = bin.usage();
for (const text of ['pin REF', 'track-latest', 'unpin', 'save intent only', 'do not prepare or install']) {
  assert.ok(help.includes(text), `help must include ${text}`);
}
assert.ok(help.includes('SUPERPOWERS_CONFIG_DIR'));
assert.ok(help.includes('$XDG_CONFIG_HOME/superpowers-manager'));
assert.ok(help.includes('$HOME/.config/superpowers-manager'));

// --- buildSpawn: POSIX executes the script directly ---
const posix = bin.buildSpawn('probe', ['--porcelain'], '/root', '/bin/sh', 'linux');
assert.strictEqual(posix.file, path.join('/root', 'scripts', 'probe'));
assert.deepStrictEqual(posix.argv, ['--porcelain']);

// --- buildSpawn: Windows dispatches through the discovered shell:
// <shell> scripts/<cmd> [args...]. path.join is used on both sides so the
// assertion holds on any host separator.
const gitBash = 'C:\\Program Files\\Git\\bin\\bash.exe';
const win = bin.buildSpawn('update', ['-x'], 'C:\\pkg', gitBash, 'win32');
assert.strictEqual(win.file, gitBash);
assert.deepStrictEqual(win.argv, [path.join('C:\\pkg', 'scripts', 'update'), '-x']);

// --- resolvePackageRoot walks up to package.json from the bin's real path ---
const root = bin.resolvePackageRoot(path.join(import.meta.dirname, '..', '..', 'bin', 'superpowers-manager.js'));
assert.strictEqual(root, path.resolve(import.meta.dirname, '..', '..'));

// --- isMain supports all declared Node 24.x releases and resolves bin symlinks ---
const entryPath = fs.realpathSync(process.argv[1]);
assert.strictEqual(bin.isMain(entryPath, process.argv[1]), true);
assert.strictEqual(bin.isMain(entryPath, undefined), false);
assert.throws(() => bin.isMain(entryPath, path.join(import.meta.dirname, 'missing-entry.js')));

// --- preflight: codex required for every command that inspects or mutates Codex ---
const emptyEnv = { PATH: '/nonexistent-dir-for-test' };
const probePf = bin.preflight('probe', emptyEnv, 'linux');
assert.strictEqual(probePf.ok, false);
assert.ok(probePf.errors.join('\n').includes('codex'), 'probe must require codex');
const installPf = bin.preflight('install', emptyEnv, 'linux');
assert.strictEqual(installPf.ok, false);
assert.ok(installPf.errors.join('\n').includes('codex'), 'install must require codex');
assert.ok(installPf.errors.join('\n').includes('git'));

console.log('units.test.js: OK');
