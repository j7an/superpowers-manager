// @ts-check
// Unit tests for the bin's pure functions. Platform and env are injected so
// the Windows dispatch path is testable without Windows.
import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as bin from '../../bin/superpowers-wrapper.js';

// --- parseArgs ---
assert.deepStrictEqual(bin.parseArgs([]), { kind: 'run', cmd: 'update', args: [] });
assert.deepStrictEqual(
  bin.parseArgs(['probe', '--porcelain']),
  { kind: 'run', cmd: 'probe', args: ['--porcelain'] }
);
for (const cmd of ['prepare', 'probe', 'install', 'update', 'uninstall']) {
  assert.strictEqual(bin.parseArgs([cmd]).kind, 'run');
}
assert.strictEqual(bin.parseArgs(['--help']).kind, 'help');
assert.strictEqual(bin.parseArgs(['-h']).kind, 'help');
assert.strictEqual(bin.parseArgs(['--version']).kind, 'version');
// Unknown subcommands and stray flags NEVER fall through to update.
assert.strictEqual(bin.parseArgs(['bogus']).kind, 'usage-error');
assert.strictEqual(bin.parseArgs(['--porcelain']).kind, 'usage-error');

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
const root = bin.resolvePackageRoot(path.join(import.meta.dirname, '..', '..', 'bin', 'superpowers-wrapper.js'));
assert.strictEqual(root, path.resolve(import.meta.dirname, '..', '..'));

// --- isMain supports all declared Node 24.x releases and resolves bin symlinks ---
const entryPath = fs.realpathSync(process.argv[1]);
assert.strictEqual(bin.isMain(entryPath, process.argv[1]), true);
assert.strictEqual(bin.isMain(entryPath, undefined), false);
assert.throws(() => bin.isMain(entryPath, path.join(import.meta.dirname, 'missing-entry.js')));

// --- preflight: codex required only for install/update/uninstall ---
const emptyEnv = { PATH: '/nonexistent-dir-for-test' };
const probePf = bin.preflight('probe', emptyEnv, 'linux');
assert.strictEqual(probePf.ok, false);
assert.ok(!probePf.errors.join('\n').includes('codex'), 'probe must not require codex');
const installPf = bin.preflight('install', emptyEnv, 'linux');
assert.strictEqual(installPf.ok, false);
assert.ok(installPf.errors.join('\n').includes('codex'), 'install must require codex');
assert.ok(installPf.errors.join('\n').includes('git'));

console.log('units.test.js: OK');
