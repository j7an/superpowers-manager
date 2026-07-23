import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
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
} from 'node:fs';
import { join, relative } from 'node:path';
import test from 'node:test';

import {
  COMMANDS,
  PASSTHROUGH_VARIABLES,
  ROOT,
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
} from './support.js';

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

function withSandbox(options, callback) {
  const sandbox = createSandbox(options);
  try {
    return callback(sandbox);
  } finally {
    destroySandbox(sandbox);
  }
}

function dispatchEnvironment(sandbox, overrides = {}) {
  return {
    SPW_ADAPTER: sandbox.adapter,
    SPW_BASELINE_DISPATCH_LOG: sandbox.dispatchLog,
    ...overrides,
  };
}

function assertCleanResult(result, status = 0) {
  assert.equal(result.error, undefined);
  assert.equal(result.signal, null);
  assert.equal(result.status, status);
}

function assertOnlyDispatch(sandbox, command, argv) {
  assert.deepEqual(
    readDispatchLog(sandbox).map(({ command: name, argv: args }) => ({
      command: name,
      argv: args,
    })),
    [{ command, argv }],
  );
}

function scenarioValues(result) {
  assertCleanResult(result);
  return Object.fromEntries(
    result.stdout
      .trimEnd()
      .split('\n')
      .map((line) => {
        const separator = line.indexOf('=');
        assert.notEqual(separator, -1, `scenario line lacks '=': ${line}`);
        return [line.slice(0, separator), line.slice(separator + 1)];
      }),
  );
}

function createReleaseRepo(sandbox, name = 'upstream') {
  const upstream = join(sandbox.root, name);
  return scenarioValues(
    runScenario(sandbox, 'git-release-repo', upstream),
  );
}

function substitutedFixtureBytes(path, replacements) {
  let contents = readFileSync(path, 'utf8');
  for (const [from, to] of replacements) {
    assert.notEqual(contents.indexOf(from), -1, `fixture lacks ${from}`);
    contents = contents.replaceAll(from, to);
  }
  return Buffer.from(contents, 'utf8');
}

function selectionPath(sandbox) {
  return join(sandbox.config, 'selection.json');
}

function generatedProvenance(sandbox) {
  return JSON.parse(readFileSync(
    join(sandbox.plugin, '.superpowers-upstream.json'),
    'utf8',
  ));
}

function snapshotTree(root) {
  const entries = [];
  function visit(path) {
    const info = lstatSync(path);
    const name = relative(root, path) || '.';
    const mode = info.mode & 0o777;
    if (info.isSymbolicLink()) {
      entries.push({ name, type: 'symlink', mode, target: readlinkSync(path) });
      return;
    }
    if (info.isDirectory()) {
      entries.push({ name, type: 'directory', mode });
      for (const child of readdirSync(path).sort()) visit(join(path, child));
      return;
    }
    assert.equal(info.isFile(), true, `${path} must be a file`);
    entries.push({ name, type: 'file', mode, contents: readFileSync(path) });
  }
  visit(root);
  return entries;
}

function lexicalTree(root) {
  const entries = [];
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

function runSandboxGit(sandbox, args) {
  const result = spawnSync(
    join(sandbox.bin, 'git'),
    args,
    {
      cwd: sandbox.work,
      env: baseEnvironment(sandbox),
      encoding: 'utf8',
    },
  );
  assertCleanResult(result);
  return result;
}

function writeFailingValidator(sandbox, name = 'reject-candidate.py') {
  const validator = join(sandbox.work, name);
  writeFileSync(
    validator,
    `from pathlib import Path
import sys

candidate = Path(sys.argv[1])
if not (candidate / ".codex-plugin" / "plugin.template.json").is_file():
    print("candidate template missing before additional validation", file=sys.stderr)
    raise SystemExit(9)
print("baseline additional validator rejection", file=sys.stderr)
raise SystemExit(7)
`,
    'utf8',
  );
  return validator;
}

function assertNoInvocationPrepareWorkspace(parent, retained = []) {
  const retainedNames = new Set(retained);
  assert.deepEqual(
    readdirSync(parent)
      .filter((name) => name.startsWith('.superpowers.prepare.'))
      .filter((name) => !retainedNames.has(name))
      .sort(),
    [],
  );
}

function commitUnknownManifestField(sandbox, repo) {
  runSandboxGit(sandbox, ['-C', repo, 'checkout', '--detach', 'v1.0.0']);
  const manifestPath = join(repo, '.codex-plugin', 'plugin.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  manifest.x_future_manifest = { nested: [true, null, 'preserve-me'] };
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  mkdirSync(join(repo, 'assets'));
  writeFileSync(
    join(repo, 'assets', 'superpowers-small.svg'),
    '<svg xmlns="http://www.w3.org/2000/svg"/>\n',
    'utf8',
  );
  runSandboxGit(sandbox, ['-C', repo, 'add', '-A']);
  runSandboxGit(sandbox, ['-C', repo, 'commit', '-m', 'add future manifest field']);
  return runSandboxGit(sandbox, ['-C', repo, 'rev-parse', 'HEAD'])
    .stdout
    .trim();
}

function commitUnsafeHookScenario(sandbox, repo, scenarioName) {
  const scenarioRoot = join(sandbox.root, `${scenarioName}-fixture`);
  const scenario = scenarioValues(
    runScenario(sandbox, scenarioName, scenarioRoot),
  );
  runSandboxGit(sandbox, ['-C', repo, 'checkout', '--detach', 'v1.0.0']);
  const manifestPath = join(repo, '.codex-plugin', 'plugin.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  manifest.hooks = [];
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  const hooks = join(repo, 'hooks');
  mkdirSync(hooks);
  writeFileSync(join(hooks, 'hooks.json'), '{}\n', 'utf8');
  const target = scenarioName === 'broken-symlink'
    ? readlinkSync(scenario.TARGET)
    : relative(hooks, join(scenario.OUTSIDE, 'target'));
  symlinkSync(target, join(hooks, 'unsafe-target'));
  runSandboxGit(sandbox, ['-C', repo, 'add', '-A']);
  runSandboxGit(sandbox, [
    '-C',
    repo,
    'commit',
    '-m',
    `add ${scenarioName} hook`,
  ]);
  return runSandboxGit(sandbox, ['-C', repo, 'rev-parse', 'HEAD'])
    .stdout
    .trim();
}

function assertMalformedSelectionFailsBeforeTools(sandbox) {
  const savedState = selectionPath(sandbox);
  const gitLog = join(sandbox.root, 'git-access.log');
  writeFileSync(savedState, '{\n', 'utf8');
  removeTool(sandbox, 'git');
  writeFileSync(
    join(sandbox.bin, 'git'),
    '#!/bin/sh\nprintf "git access\\n" >> "$SPW_BASELINE_GIT_LOG"\nexit 99\n',
    'utf8',
  );
  chmodSync(join(sandbox.bin, 'git'), 0o755);

  const result = runCli(
    sandbox,
    ['prepare'],
    {
      SPW_ADAPTER: sandbox.adapter,
      SPW_BASELINE_ADAPTER_STATE: sandbox.adapterState,
      SPW_BASELINE_ADAPTER_LOG: sandbox.adapterLog,
      SPW_BASELINE_GIT_LOG: gitLog,
      SUPERPOWERS_REF: 'v1.1.0',
      SUPERPOWERS_UPSTREAM_URL: join(sandbox.root, 'unused-upstream'),
    },
  );
  assertCleanResult(result, 1);
  assert.equal(result.stdout, '');
  assert.equal(
    result.stderr,
    `error: invalid JSON in ${savedState}: line 2 column 1: `
      + 'Expecting property name enclosed in double quotes\n',
  );
  assert.equal(existsSync(gitLog), false);
  assert.equal(existsSync(sandbox.adapterLog), false);
}

function lifecycleEnvironment(sandbox, upstream, overrides = {}) {
  return {
    SPW_ADAPTER: sandbox.adapter,
    SPW_BASELINE_ADAPTER_STATE: sandbox.adapterState,
    SPW_BASELINE_ADAPTER_LOG: sandbox.adapterLog,
    SPW_BASELINE_FINGERPRINT: upstream.STABLE_COMMIT,
    SUPERPOWERS_REF: 'v1.1.0',
    SUPERPOWERS_UPSTREAM_URL: upstream.REPO,
    ...overrides,
  };
}

function adapterOperations(sandbox) {
  if (!existsSync(sandbox.adapterLog)) return [];
  return readFileSync(sandbox.adapterLog, 'utf8')
    .trimEnd()
    .split('\n')
    .filter(Boolean);
}

test('CLI-MODE-HELP-01 help modes', () => {
  withSandbox({ stubScripts: true }, (sandbox) => {
    for (const mode of ['--help', '-h']) {
      const result = runCli(sandbox, [mode]);
      assertCleanResult(result);
      assert.equal(result.stdout, USAGE);
      assert.equal(result.stderr, '');
    }
  });
});

test('CLI-MODE-VERSION-01 version mode', () => {
  withSandbox({ stubScripts: true }, (sandbox) => {
    const { version } = JSON.parse(
      readFileSync(join(sandbox.pkg, 'package.json'), 'utf8'),
    );
    const result = runCli(sandbox, ['--version']);
    assertCleanResult(result);
    assert.equal(result.stdout, `${version}\n`);
    assert.equal(result.stderr, '');
  });
});

test('CLI-MODE-DEFAULT-01 no arguments dispatch update', () => {
  withSandbox({ stubScripts: true }, (sandbox) => {
    const result = runCli(sandbox, [], dispatchEnvironment(sandbox));
    assertCleanResult(result);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, '');
    assertOnlyDispatch(sandbox, 'update', []);
  });
});

test('CLI-COMMANDS-01 eight named commands dispatch', () => {
  const cases = new Map([
    ['pin', ['v6.1.1']],
    ['track-latest', []],
    ['unpin', []],
    ['prepare', ['--candidate', 'arbitrary value']],
    ['probe', ['--porcelain']],
    ['install', ['--dry-run', 'arbitrary value']],
    ['update', ['--force', 'arbitrary value']],
    ['uninstall', ['--purge', 'arbitrary value']],
  ]);
  assert.deepEqual([...cases.keys()], COMMANDS);

  withSandbox({ stubScripts: true }, (sandbox) => {
    for (const [command, argv] of cases) {
      clearDispatchLog(sandbox);
      const result = runCli(
        sandbox,
        [command, ...argv],
        dispatchEnvironment(sandbox),
      );
      assertCleanResult(result);
      assert.equal(result.stdout, '');
      assert.equal(result.stderr, '');
      assertOnlyDispatch(sandbox, command, argv);
    }
  });
});

test('CLI-USAGE-01 invalid command and stray flag fail with exit 2', () => {
  const cases = [
    { args: ['bogus'], diagnostic: 'unknown subcommand: bogus' },
    { args: ['--porcelain'], diagnostic: 'unknown subcommand: --porcelain' },
    { args: ['pin'], diagnostic: 'usage: superpowers-manager pin REF' },
    {
      args: ['pin', 'v1.2.3', 'extra'],
      diagnostic: 'usage: superpowers-manager pin REF',
    },
    {
      args: ['pin', 'main'],
      diagnostic:
        'pin REF must be an exact v-prefixed SemVer tag or full 40-hex commit',
    },
    {
      args: ['track-latest', 'extra'],
      diagnostic: 'usage: superpowers-manager track-latest',
    },
    {
      args: ['unpin', 'extra'],
      diagnostic: 'usage: superpowers-manager unpin',
    },
  ];

  withSandbox({ stubScripts: true }, (sandbox) => {
    for (const { args, diagnostic } of cases) {
      clearDispatchLog(sandbox);
      const result = runCli(
        sandbox,
        args,
        dispatchEnvironment(sandbox),
      );
      assertCleanResult(result, 2);
      assert.equal(result.stdout, '');
      assert.equal(result.stderr, `error: ${diagnostic}\n${USAGE}`);
      assert.deepEqual(readDispatchLog(sandbox), []);
    }
  });
});

test('CLI-PIN-REF-01 pin accepts exact tag or 40-hex commit only', () => {
  const accepted = [
    'v0.0.0',
    'v1.2.3',
    'v1.2.3-alpha',
    'v1.2.3-alpha.1',
    'v1.2.3-0',
    'v1.2.3-x-y.z9',
    '0123456789abcdef0123456789abcdef01234567',
    'ABCDEF0123456789ABCDEF0123456789ABCDEF01',
  ];
  const refused = [
    '1.2.3',
    'v01.2.3',
    'v1.02.3',
    'v1.2.03',
    'v1.2.3-',
    'v1.2.3-01',
    'v1.2.3+build',
    '0123456789abcdef0123456789abcdef0123456',
    'g123456789abcdef0123456789abcdef01234567',
  ];

  withSandbox({ stubScripts: true }, (sandbox) => {
    for (const ref of accepted) {
      clearDispatchLog(sandbox);
      const result = runCli(
        sandbox,
        ['pin', ref],
        dispatchEnvironment(sandbox),
      );
      assertCleanResult(result);
      assertOnlyDispatch(sandbox, 'pin', [ref]);
    }
    for (const ref of refused) {
      clearDispatchLog(sandbox);
      const result = runCli(
        sandbox,
        ['pin', ref],
        dispatchEnvironment(sandbox),
      );
      assertCleanResult(result, 2);
      assert.equal(result.stdout, '');
      assert.equal(
        result.stderr,
        'error: pin REF must be an exact v-prefixed SemVer tag or full 40-hex commit\n'
          + USAGE,
      );
      assert.deepEqual(readDispatchLog(sandbox), []);
    }
  });
});

test('CLI-PREFLIGHT-01 missing tools fail before dispatch', () => {
  const requirements = new Map([
    ['pin', ['git', 'python3', 'sh']],
    ['track-latest', ['python3', 'sh']],
    ['unpin', ['sh']],
    ['prepare', ['git', 'python3', 'sh']],
    ['probe', ['git', 'python3', 'codex', 'sh']],
    ['install', ['git', 'python3', 'codex', 'sh']],
    ['update', ['git', 'python3', 'codex', 'sh']],
    ['uninstall', ['python3', 'codex', 'sh']],
  ]);
  const argsFor = { pin: ['v1.2.3'] };

  for (const [command, tools] of requirements) {
    for (const tool of tools) {
      withSandbox({ stubScripts: true }, (sandbox) => {
        if (tools.includes('codex') && tool !== 'codex') writeNoopTool(sandbox);
        removeTool(sandbox, tool);
        const result = runCli(
          sandbox,
          [command, ...(argsFor[command] || [])],
          { SPW_BASELINE_DISPATCH_LOG: sandbox.dispatchLog },
        );
        assertCleanResult(result, 1);
        assert.equal(result.stdout, '');
        const diagnostic = tool === 'codex'
          ? 'error: required command not found: codex — install the Codex CLI or set SUPERPOWERS_CODEX\n'
          : tool === 'sh'
            ? 'error: required command not found: sh\n'
            : `error: required command not found: ${tool} — install ${tool} and re-run\n`;
        assert.equal(result.stderr, diagnostic);
        assert.deepEqual(readDispatchLog(sandbox), []);
      });
    }
  }
});

test('CLI-CHILD-STATUS-01 delegated child status is preserved', () => {
  withSandbox({ stubScripts: true }, (sandbox) => {
    const result = runCli(
      sandbox,
      ['probe'],
      dispatchEnvironment(sandbox, { SPW_BASELINE_DELEGATE_EXIT: '42' }),
    );
    assertCleanResult(result, 42);
    assertOnlyDispatch(sandbox, 'probe', []);
  });
});

test('CLI-ENV-01 ten SUPERPOWERS variables pass through', () => {
  withSandbox({ stubScripts: true }, (sandbox) => {
    const customCodex = writeNoopTool(sandbox, 'custom-codex');
    const values = {
      SUPERPOWERS_REF: 'v9.8.7-rc.1',
      SUPERPOWERS_UPSTREAM_URL: join(sandbox.root, 'upstream source'),
      SUPERPOWERS_CODEX: customCodex,
      SUPERPOWERS_CACHE_DIR: join(sandbox.root, 'custom cache'),
      SUPERPOWERS_CONFIG_DIR: join(sandbox.root, 'custom config'),
      SUPERPOWERS_PLUGIN_ROOT: join(sandbox.root, 'custom plugin'),
      SUPERPOWERS_MANIFEST_TEMPLATE: join(sandbox.root, 'custom template.json'),
      SUPERPOWERS_VALIDATOR: join(sandbox.root, 'custom validator.py'),
      SUPERPOWERS_INSTALLED_SEARCH_ROOT: join(sandbox.root, 'custom codex'),
      SUPERPOWERS_INSTALL_REFRESH_MODE: 'force-refresh',
    };
    assert.deepEqual(Object.keys(values), PASSTHROUGH_VARIABLES);

    const previousLeak = process.env.SUPERPOWERS_BASELINE_LEAK;
    process.env.SUPERPOWERS_BASELINE_LEAK = 'must-not-pass';
    let result;
    try {
      result = runCli(
        sandbox,
        ['update'],
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

test('sandbox tool allowlist runs a real command and scenario builder', () => {
  withSandbox({}, (sandbox) => {
    const cli = runCli(sandbox, ['unpin']);
    assertCleanResult(cli);
    const fallback = readFileSync(
      join(sandbox.pkg, 'config', 'upstream-ref'),
      'utf8',
    ).trim();
    assert.equal(
      cli.stdout,
      `no saved upstream selection; packaged fallback is ${fallback}\n`,
    );
    assert.equal(cli.stderr, '');

    const destination = join(sandbox.root, 'scenario');
    const scenario = runScenario(sandbox, 'git-release-repo', destination);
    assertCleanResult(scenario);
    assert.match(scenario.stdout, new RegExp(`^REPO=${destination}\\n`));
    assert.equal(existsSync(join(destination, '.git')), true);
  });
});

test('stateful build delegates to the copied runtime adapter', () => {
  withSandbox({}, (sandbox) => {
    const upstream = join(sandbox.root, 'upstream');
    const scenario = runScenario(
      sandbox,
      'git-release-repo',
      upstream,
    );
    assertCleanResult(scenario);

    const result = runCli(
      sandbox,
      ['prepare'],
      {
        SPW_ADAPTER: sandbox.adapter,
        SPW_BASELINE_ADAPTER_STATE: sandbox.adapterState,
        SPW_BASELINE_ADAPTER_LOG: sandbox.adapterLog,
        SUPERPOWERS_REF: 'v1.1.0',
        SUPERPOWERS_UPSTREAM_URL: upstream,
      },
    );
    assertCleanResult(result);
    assert.equal(
      existsSync(join(sandbox.plugin, '.codex-plugin', 'plugin.json')),
      true,
    );
    assert.equal(
      existsSync(join(
        sandbox.plugin,
        '.codex-plugin',
        'plugin.template.json',
      )),
      true,
    );
    assert.equal(
      existsSync(join(sandbox.adapterState, 'state.json')),
      false,
    );
    assert.equal(readFileSync(sandbox.adapterLog, 'utf8'), 'build\n');
  });
});

test('public install shares generated provenance with the copied package', () => {
  withSandbox({}, (sandbox) => {
    const upstream = join(sandbox.root, 'install-upstream');
    const scenario = runScenario(
      sandbox,
      'git-release-repo',
      upstream,
    );
    assertCleanResult(scenario);
    const stableMatch = /^STABLE_COMMIT=([0-9a-f]{40})$/m.exec(
      scenario.stdout,
    );
    assert.ok(stableMatch, 'scenario must report its stable commit');
    const expectedFingerprint = stableMatch[1];

    const result = runCli(
      sandbox,
      ['install'],
      {
        SPW_ADAPTER: sandbox.adapter,
        SPW_BASELINE_ADAPTER_STATE: sandbox.adapterState,
        SPW_BASELINE_ADAPTER_LOG: sandbox.adapterLog,
        SPW_BASELINE_FINGERPRINT: expectedFingerprint,
        SUPERPOWERS_REF: 'v1.1.0',
        SUPERPOWERS_UPSTREAM_URL: upstream,
      },
    );
    assertCleanResult(result);
    assert.equal(
      existsSync(join(
        sandbox.pkg,
        'plugins',
        'superpowers',
        '.superpowers-upstream.json',
      )),
      true,
    );
    assert.deepEqual(
      JSON.parse(readFileSync(
        join(sandbox.adapterState, 'state.json'),
        'utf8',
      )),
      {
        plugin: true,
        marketplace: true,
        legacy_plugin: false,
        legacy_marketplace: false,
        update_control: 'managed',
        fingerprint: expectedFingerprint,
      },
    );
    assert.match(readFileSync(sandbox.adapterLog, 'utf8'), /^build$/m);
    assert.match(readFileSync(sandbox.adapterLog, 'utf8'), /^install$/m);
  });
});

test('SEL-PRECEDENCE-REF-01 ref precedence and validate-first ordering', () => {
  withSandbox({}, (sandbox) => {
    const upstream = createReleaseRepo(sandbox);
    const pin = runCli(sandbox, ['pin', 'v1.0.0'], {
      SUPERPOWERS_UPSTREAM_URL: upstream.REPO,
    });
    assertCleanResult(pin);

    const prepare = runCli(sandbox, ['prepare'], {
      SPW_ADAPTER: sandbox.adapter,
      SPW_BASELINE_ADAPTER_STATE: sandbox.adapterState,
      SPW_BASELINE_ADAPTER_LOG: sandbox.adapterLog,
      SUPERPOWERS_REF: 'v1.1.0',
    });
    assertCleanResult(prepare);
    assert.deepEqual(generatedProvenance(sandbox), {
      source: upstream.REPO,
      requested_ref: 'v1.1.0',
      resolved_ref: 'v1.1.0',
      commit: upstream.STABLE_COMMIT,
      upstream_manifest_version: '1.0.0',
    });
  });

  withSandbox({}, (sandbox) => {
    assertMalformedSelectionFailsBeforeTools(sandbox);
  });
});

test('SEL-PRECEDENCE-SOURCE-01 source precedence is independent', () => {
  withSandbox({}, (sandbox) => {
    const official = runCli(sandbox, ['track-latest']);
    assertCleanResult(official);
    assert.deepEqual(
      readFileSync(selectionPath(sandbox)),
      readFileSync(fixturePath('selection', 'track-latest.json')),
    );

    const upstream = createReleaseRepo(sandbox);
    const alternate = join(sandbox.root, 'alternate-upstream');
    symlinkSync(upstream.REPO, alternate, 'dir');
    const pin = runCli(sandbox, ['pin', 'v1.0.0'], {
      SUPERPOWERS_UPSTREAM_URL: upstream.REPO,
    });
    assertCleanResult(pin);

    let prepare = runCli(sandbox, ['prepare'], {
      SPW_ADAPTER: sandbox.adapter,
      SPW_BASELINE_ADAPTER_STATE: sandbox.adapterState,
      SPW_BASELINE_ADAPTER_LOG: sandbox.adapterLog,
      SUPERPOWERS_REF: 'v1.1.0',
    });
    assertCleanResult(prepare);
    assert.equal(generatedProvenance(sandbox).source, upstream.REPO);
    assert.equal(generatedProvenance(sandbox).requested_ref, 'v1.1.0');

    prepare = runCli(sandbox, ['prepare'], {
      SPW_ADAPTER: sandbox.adapter,
      SPW_BASELINE_ADAPTER_STATE: sandbox.adapterState,
      SPW_BASELINE_ADAPTER_LOG: sandbox.adapterLog,
      SUPERPOWERS_UPSTREAM_URL: alternate,
    });
    assertCleanResult(prepare);
    assert.equal(generatedProvenance(sandbox).source, alternate);
    assert.equal(generatedProvenance(sandbox).requested_ref, 'v1.0.0');
    assert.equal(generatedProvenance(sandbox).commit, upstream.BASE_COMMIT);
  });
});

test('SEL-BYTES-PINNED-01 pin writes canonical selection bytes', () => {
  withSandbox({}, (sandbox) => {
    const upstream = createReleaseRepo(sandbox);
    let result = runCli(sandbox, ['pin', 'v1.1.0'], {
      SUPERPOWERS_UPSTREAM_URL: upstream.REPO,
    });
    assertCleanResult(result);
    assert.deepEqual(
      readFileSync(selectionPath(sandbox)),
      substitutedFixtureBytes(
        fixturePath('selection', 'pinned-tag.json'),
        [
          ['https://github.com/obra/superpowers', upstream.REPO],
          ['v6.1.1', 'v1.1.0'],
          ['0123456789abcdef0123456789abcdef01234567', upstream.STABLE_COMMIT],
        ],
      ),
    );
    assert.equal(statSync(selectionPath(sandbox)).mode & 0o777, 0o600);

    result = runCli(sandbox, ['pin', upstream.RAW_COMMIT.toUpperCase()], {
      SUPERPOWERS_UPSTREAM_URL: upstream.REPO,
    });
    assertCleanResult(result);
    assert.deepEqual(
      readFileSync(selectionPath(sandbox)),
      substitutedFixtureBytes(
        fixturePath('selection', 'pinned-commit.json'),
        [
          ['https://github.com/obra/superpowers', upstream.REPO],
          ['0123456789abcdef0123456789abcdef01234567', upstream.RAW_COMMIT],
        ],
      ),
    );
    assert.equal(statSync(selectionPath(sandbox)).mode & 0o777, 0o600);
  });
});

test('SEL-BYTES-TRACK-01 track-latest writes canonical selection bytes', () => {
  withSandbox({}, (sandbox) => {
    const upstream = createReleaseRepo(sandbox);
    const pin = runCli(sandbox, ['pin', 'v1.0.0'], {
      SUPERPOWERS_UPSTREAM_URL: upstream.REPO,
    });
    assertCleanResult(pin);
    const result = runCli(sandbox, ['track-latest'], {
      SUPERPOWERS_UPSTREAM_URL: upstream.REPO,
    });
    assertCleanResult(result);
    assert.equal(
      result.stdout,
      'saved upstream selection: latest stable release\n',
    );
    assert.equal(result.stderr, '');
    assert.deepEqual(
      readFileSync(selectionPath(sandbox)),
      substitutedFixtureBytes(
        fixturePath('selection', 'track-latest.json'),
        [['https://github.com/obra/superpowers', upstream.REPO]],
      ),
    );
    assert.equal(statSync(selectionPath(sandbox)).mode & 0o777, 0o600);
  });
});

test('SEL-UNPIN-01 unpin removes saved intent without applying changes', () => {
  withSandbox({}, (sandbox) => {
    const source = join(sandbox.root, 'unused-source');
    const saved = runCli(sandbox, ['track-latest'], {
      SUPERPOWERS_UPSTREAM_URL: source,
    });
    assertCleanResult(saved);
    mkdirSync(join(sandbox.plugin, 'sentinel'), { recursive: true });
    writeFileSync(join(sandbox.plugin, 'sentinel', 'keep'), 'plugin\n');
    writeFileSync(join(sandbox.codex, 'keep'), 'codex\n');
    const pluginBefore = snapshotTree(sandbox.plugin);
    const codexBefore = snapshotTree(sandbox.codex);
    const fallback = readFileSync(
      join(sandbox.pkg, 'config', 'upstream-ref'),
      'utf8',
    ).trim();

    const result = runCli(sandbox, ['unpin'], {
      SUPERPOWERS_REF: 'v9.8.7',
      SUPERPOWERS_UPSTREAM_URL: source,
    });
    assertCleanResult(result);
    assert.equal(
      result.stdout,
      `removed saved upstream selection; packaged fallback is ${fallback}\n`
        + 'note: active SUPERPOWERS_REF override remains effective\n'
        + 'note: active SUPERPOWERS_UPSTREAM_URL override remains effective\n',
    );
    assert.equal(result.stderr, '');
    assert.equal(existsSync(selectionPath(sandbox)), false);
    assert.deepEqual(snapshotTree(sandbox.plugin), pluginBefore);
    assert.deepEqual(snapshotTree(sandbox.codex), codexBefore);
  });
});

test('SEL-INVALID-01 malformed saved state fails before Git or adapter access', () => {
  withSandbox({}, (sandbox) => {
    assertMalformedSelectionFailsBeforeTools(sandbox);
  });
});

test('PREPARE-TREE-01 prepare creates the canonical generated tree', () => {
  withSandbox({}, (sandbox) => {
    const upstream = createReleaseRepo(sandbox);
    const commit = commitUnknownManifestField(sandbox, upstream.REPO);
    const result = runCli(sandbox, ['prepare'], {
      SPW_ADAPTER: sandbox.adapter,
      SPW_BASELINE_ADAPTER_STATE: sandbox.adapterState,
      SPW_BASELINE_ADAPTER_LOG: sandbox.adapterLog,
      SUPERPOWERS_REF: commit,
      SUPERPOWERS_UPSTREAM_URL: upstream.REPO,
    });
    assertCleanResult(result);
    assert.deepEqual(
      lexicalTree(sandbox.plugin),
      readFileSync(
        fixturePath('generated-tree', 'no-hooks.txt'),
        'utf8',
      ).trimEnd().split('\n'),
    );
    const manifest = JSON.parse(readFileSync(
      join(sandbox.plugin, '.codex-plugin', 'plugin.json'),
      'utf8',
    ));
    assert.deepEqual(
      manifest.x_future_manifest,
      { nested: [true, null, 'preserve-me'] },
    );
    assert.equal(manifest.name, 'superpowers');
    assert.equal(manifest.skills, './skills/');
    assert.match(manifest.version, /^0\.0\.0\+manager\.[0-9a-f]{7}$/);
  });
});

test('PROVENANCE-BYTES-01 prepare writes canonical provenance bytes', () => {
  withSandbox({}, (sandbox) => {
    const upstream = createReleaseRepo(sandbox, 'upstream "quoted"');
    const result = runCli(sandbox, ['prepare'], {
      SPW_ADAPTER: sandbox.adapter,
      SPW_BASELINE_ADAPTER_STATE: sandbox.adapterState,
      SPW_BASELINE_ADAPTER_LOG: sandbox.adapterLog,
      SUPERPOWERS_REF: 'v1.1.0',
      SUPERPOWERS_UPSTREAM_URL: upstream.REPO,
    });
    assertCleanResult(result);
    const escapedSource = JSON.stringify(upstream.REPO).slice(1, -1);
    assert.deepEqual(
      readFileSync(join(sandbox.plugin, '.superpowers-upstream.json')),
      substitutedFixtureBytes(
        fixturePath('provenance', 'valid-tag.json'),
        [
          ['https://example.invalid/superpowers.git', escapedSource],
          ['latest-release', 'v1.1.0'],
          ['v6.1.1', 'v1.1.0'],
          ['d884ae04edebef577e82ff7c4e143debd0bbec99', upstream.STABLE_COMMIT],
          ['"6.1.1"', '"1.0.0"'],
        ],
      ),
    );
  });
});

test('PREPARE-VALIDATE-01 validation completes before activation', () => {
  withSandbox({}, (sandbox) => {
    const upstream = createReleaseRepo(sandbox);
    let result = runCli(sandbox, ['prepare'], {
      SPW_ADAPTER: sandbox.adapter,
      SPW_BASELINE_ADAPTER_STATE: sandbox.adapterState,
      SPW_BASELINE_ADAPTER_LOG: sandbox.adapterLog,
      SUPERPOWERS_REF: 'v1.1.0',
      SUPERPOWERS_UPSTREAM_URL: upstream.REPO,
    });
    assertCleanResult(result);
    const accepted = snapshotTree(sandbox.plugin);
    writeFileSync(sandbox.adapterLog, '', 'utf8');

    result = runCli(sandbox, ['prepare'], {
      SPW_ADAPTER: sandbox.adapter,
      SPW_BASELINE_ADAPTER_STATE: sandbox.adapterState,
      SPW_BASELINE_ADAPTER_LOG: sandbox.adapterLog,
      SUPERPOWERS_REF: 'v1.1.0',
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
    assert.equal(readFileSync(sandbox.adapterLog, 'utf8'), 'build\n');
    assertNoInvocationPrepareWorkspace(join(sandbox.pkg, 'plugins'));
  });
});

test('FS-ATOMIC-01 failed prepare preserves the previous generated tree', () => {
  withSandbox({}, (sandbox) => {
    const upstream = createReleaseRepo(sandbox);
    writeFileSync(join(sandbox.plugin, 'preexisting-sentinel'), 'preserve me\n');
    const previous = snapshotTree(sandbox.plugin);
    const result = runCli(sandbox, ['prepare'], {
      SPW_ADAPTER: sandbox.adapter,
      SPW_BASELINE_ADAPTER_STATE: sandbox.adapterState,
      SPW_BASELINE_ADAPTER_LOG: sandbox.adapterLog,
      SUPERPOWERS_REF: 'v1.0.0',
      SUPERPOWERS_UPSTREAM_URL: upstream.REPO,
      SUPERPOWERS_VALIDATOR: writeFailingValidator(
        sandbox,
        'reject-atomic-candidate.py',
      ),
    });
    assertCleanResult(result, 1);
    assert.match(result.stderr, /error: additional plugin validation failed/);
    assert.deepEqual(snapshotTree(sandbox.plugin), previous);
    assertNoInvocationPrepareWorkspace(join(sandbox.pkg, 'plugins'));
  });
});

test('FS-CLEANUP-01 interrupted state cleanup is invocation-scoped', () => {
  withSandbox({}, (sandbox) => {
    const topology = scenarioValues(runScenario(
      sandbox,
      'interrupted-prepare-state',
      join(sandbox.root, 'interrupted-prepare'),
    ));
    const upstream = createReleaseRepo(sandbox);
    const previous = snapshotTree(topology.PREVIOUS_TREE);
    const interrupted = snapshotTree(topology.PREPARE_STAGING);
    const sibling = snapshotTree(topology.SIBLING);
    const result = runCli(sandbox, ['prepare'], {
      SPW_ADAPTER: sandbox.adapter,
      SPW_BASELINE_ADAPTER_STATE: sandbox.adapterState,
      SPW_BASELINE_ADAPTER_LOG: sandbox.adapterLog,
      SUPERPOWERS_PLUGIN_ROOT: topology.PREVIOUS_TREE,
      SUPERPOWERS_REF: 'v1.0.0',
      SUPERPOWERS_UPSTREAM_URL: upstream.REPO,
      SUPERPOWERS_VALIDATOR: writeFailingValidator(
        sandbox,
        'reject-interrupted-candidate.py',
      ),
    });
    assertCleanResult(result, 1);
    assert.match(result.stderr, /error: additional plugin validation failed/);
    assert.deepEqual(snapshotTree(topology.PREVIOUS_TREE), previous);
    assert.deepEqual(snapshotTree(topology.PREPARE_STAGING), interrupted);
    assert.deepEqual(snapshotTree(topology.SIBLING), sibling);
    assertNoInvocationPrepareWorkspace(
      join(topology.ROOT, 'plugins'),
      ['.superpowers.prepare.interrupted'],
    );
  });
});

test('FS-SYMLINK-01 escaping and broken symlinks fail closed', () => {
  for (const scenarioName of ['broken-symlink', 'escaping-symlink']) {
    withSandbox({}, (sandbox) => {
      const upstream = createReleaseRepo(sandbox);
      const commit = commitUnsafeHookScenario(
        sandbox,
        upstream.REPO,
        scenarioName,
      );
      const previous = snapshotTree(sandbox.plugin);
      const result = runCli(sandbox, ['prepare'], {
        SPW_ADAPTER: sandbox.adapter,
        SPW_BASELINE_ADAPTER_STATE: sandbox.adapterState,
        SPW_BASELINE_ADAPTER_LOG: sandbox.adapterLog,
        SUPERPOWERS_REF: commit,
        SUPERPOWERS_UPSTREAM_URL: upstream.REPO,
      });
      assertCleanResult(result, 1);
      assert.equal(result.stdout, '');
      assert.match(
        result.stderr,
        /hook materialization failed: symlink escapes or is broken/,
      );
      assert.doesNotMatch(result.stderr, /Traceback/);
      assert.deepEqual(snapshotTree(sandbox.plugin), previous);
      assert.equal(readFileSync(sandbox.adapterLog, 'utf8'), 'build\n');
      assert.equal(existsSync(join(sandbox.adapterState, 'state.json')), false);
    });
  }
});

test('PROBE-READONLY-01 probe is read-only', () => {
  withSandbox({}, (sandbox) => {
    const upstream = createReleaseRepo(sandbox);
    const pin = runCli(sandbox, ['pin', 'v1.1.0'], {
      SUPERPOWERS_UPSTREAM_URL: upstream.REPO,
    });
    assertCleanResult(pin);
    writeNoopTool(sandbox);
    const before = snapshotTree(sandbox.root);
    const result = runCli(sandbox, ['probe', '--porcelain'], {
      SPW_ADAPTER: sandbox.adapter,
      SPW_BASELINE_ADAPTER_STATE: sandbox.adapterState,
    });
    assertCleanResult(result);
    assert.match(result.stdout, /^desired_commit=[0-9a-f]{40}$/m);
    assert.match(result.stdout, /^status=needs prepare$/m);
    assert.equal(result.stderr, '');
    assert.deepEqual(snapshotTree(sandbox.root), before);
  });
});

test('INSTALL-ORDER-01 install prepares and validates before adapter mutation', () => {
  withSandbox({}, (sandbox) => {
    const upstream = createReleaseRepo(sandbox);
    const result = runCli(sandbox, ['install'], lifecycleEnvironment(
      sandbox,
      upstream,
      {
        SUPERPOWERS_VALIDATOR: writeFailingValidator(
          sandbox,
          'reject-install-candidate.py',
        ),
      },
    ));
    assertCleanResult(result, 1);
    assert.match(result.stderr, /error: additional plugin validation failed/);
    assert.deepEqual(adapterOperations(sandbox), [
      'inspect fingerprint',
      'inspect ownership',
      'inspect update-control',
      'build',
    ]);
  });

  withSandbox({}, (sandbox) => {
    const upstream = createReleaseRepo(sandbox);
    const result = runCli(
      sandbox,
      ['install'],
      lifecycleEnvironment(sandbox, upstream),
    );
    assertCleanResult(result);
    assert.deepEqual(adapterOperations(sandbox), [
      'inspect fingerprint',
      'inspect ownership',
      'inspect update-control',
      'build',
      'inspect ownership',
      'inspect update-control',
      'install',
      'inspect fingerprint',
    ]);
    assert.match(result.stdout, /generated plugin validation passed:/);
    assert.match(result.stdout, /prepared v1\.1\.0 at [0-9a-f]{40}/);
    assert.match(result.stdout, /manager updated/);
  });
});

test('UPDATE-CONTROL-01 update requires current managed control evidence', () => {
  withSandbox({}, (sandbox) => {
    const upstream = createReleaseRepo(sandbox);
    writeAdapterState(sandbox, {
      plugin: false,
      marketplace: false,
      legacy_plugin: false,
      legacy_marketplace: false,
      update_control: 'unsupported',
      fingerprint: null,
    });
    const result = runCli(
      sandbox,
      ['update'],
      lifecycleEnvironment(sandbox, upstream),
    );
    assertCleanResult(result, 1);
    assert.match(
      result.stderr,
      /adapter cannot guarantee manager-controlled updates/,
    );
    assert.equal(adapterOperations(sandbox).includes('install'), false);
    assert.equal(adapterOperations(sandbox).includes('uninstall'), false);
  });

  withSandbox({}, (sandbox) => {
    const upstream = createReleaseRepo(sandbox);
    const result = runCli(sandbox, ['update'], lifecycleEnvironment(
      sandbox,
      upstream,
      { SPW_BASELINE_UPDATE_CONTROL_RESPONSE: 'malformed' },
    ));
    assertCleanResult(result, 1);
    assert.match(result.stderr, /invalid adapter response/);
    assert.equal(adapterOperations(sandbox).includes('install'), false);
    assert.equal(adapterOperations(sandbox).includes('uninstall'), false);
  });

  withSandbox({}, (sandbox) => {
    const upstream = createReleaseRepo(sandbox);
    const result = runCli(
      sandbox,
      ['update'],
      lifecycleEnvironment(sandbox, upstream),
    );
    assertCleanResult(result);
    assert.equal(adapterOperations(sandbox).includes('install'), true);
    assert.equal(adapterOperations(sandbox).includes('uninstall'), false);
    assert.equal(
      JSON.parse(readFileSync(
        join(sandbox.adapterState, 'state.json'),
        'utf8',
      )).fingerprint,
      upstream.STABLE_COMMIT,
    );
  });
});

test('UNINSTALL-OWNERSHIP-01 uninstall removes only manager-owned resources', () => {
  for (const managerPresent of [true, false]) {
    withSandbox({}, (sandbox) => {
      writeAdapterState(sandbox, {
        plugin: managerPresent,
        marketplace: managerPresent,
        legacy_plugin: true,
        legacy_marketplace: true,
        update_control: 'managed',
        fingerprint: managerPresent ? '0123456' : null,
      });
      const result = runCli(sandbox, ['uninstall'], {
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
        readFileSync(sandbox.adapterLog, 'utf8'),
        /superpowers-wrapper|other@/,
      );
      assert.deepEqual(adapterOperations(sandbox), [
        'inspect ownership',
        'uninstall',
        'inspect ownership',
      ]);
      assert.deepEqual(
        JSON.parse(readFileSync(
          join(sandbox.adapterState, 'state.json'),
          'utf8',
        )),
        {
          plugin: false,
          marketplace: false,
          legacy_plugin: true,
          legacy_marketplace: true,
          update_control: 'managed',
          fingerprint: null,
        },
      );
    });
  }
});

test('LIFECYCLE-VERIFY-01 install and uninstall verify resulting state', () => {
  withSandbox({}, (sandbox) => {
    const upstream = createReleaseRepo(sandbox);
    const result = runCli(sandbox, ['install'], lifecycleEnvironment(
      sandbox,
      upstream,
      { SPW_BASELINE_INSTALLED_FINGERPRINT: upstream.BASE_COMMIT },
    ));
    assertCleanResult(result, 1);
    assert.match(
      result.stderr,
      /installed manager fingerprint does not match .* after install/,
    );
    assert.deepEqual(adapterOperations(sandbox).slice(-2), [
      'install',
      'inspect fingerprint',
    ]);
  });

  withSandbox({}, (sandbox) => {
    writeAdapterState(sandbox, {
      plugin: true,
      marketplace: true,
      legacy_plugin: false,
      legacy_marketplace: false,
      update_control: 'managed',
      fingerprint: '0123456',
    });
    const result = runCli(sandbox, ['uninstall'], {
      SPW_ADAPTER: sandbox.adapter,
      SPW_BASELINE_ADAPTER_STATE: sandbox.adapterState,
      SPW_BASELINE_ADAPTER_LOG: sandbox.adapterLog,
      SPW_BASELINE_UNINSTALL_NOOP: '1',
    });
    assertCleanResult(result, 1);
    assert.match(
      result.stderr,
      /owned plugin resource is still installed after removal/,
    );
    assert.deepEqual(adapterOperations(sandbox), [
      'inspect ownership',
      'uninstall',
      'inspect ownership',
    ]);
  });
});

test('LIFECYCLE-INTERRUPT-01 interrupted installation state fails closed', () => {
  withSandbox({}, (sandbox) => {
    const topology = scenarioValues(runScenario(
      sandbox,
      'interrupted-install-state',
      join(sandbox.root, 'interrupted-install'),
    ));
    const upstream = createReleaseRepo(sandbox);
    writeFileSync(
      join(topology.ROOT, 'state.json'),
      `${JSON.stringify({
        plugin: true,
        marketplace: true,
        legacy_plugin: true,
        legacy_marketplace: true,
        update_control: 'managed',
        fingerprint: upstream.STABLE_COMMIT,
      })}\n`,
      { encoding: 'utf8', mode: 0o600 },
    );
    const before = snapshotTree(topology.ROOT);
    const result = runCli(sandbox, ['install'], lifecycleEnvironment(
      sandbox,
      upstream,
      { SPW_BASELINE_ADAPTER_STATE: topology.ROOT },
    ));
    assertCleanResult(result, 1);
    assert.match(
      result.stderr,
      /Legacy superpowers-wrapper Codex state is installed\./,
    );
    assert.doesNotMatch(result.stdout, /manager updated|uninstall complete/);
    assert.deepEqual(adapterOperations(sandbox), [
      'inspect fingerprint',
      'inspect ownership',
      'inspect update-control',
    ]);
    assert.deepEqual(snapshotTree(topology.ROOT), before);
    assert.equal(
      readFileSync(topology.OPERATION_MARKER, 'utf8'),
      'install interrupted before verification\n',
    );
  });
});

test('sandbox paths and copied adapter are immutable and contained', () => {
  withSandbox({}, (sandbox) => {
    assert.equal(Object.isFrozen(sandbox), true);
    for (const field of [
      'pkg',
      'bin',
      'home',
      'tmp',
      'config',
      'cache',
      'plugin',
      'codex',
      'git',
      'gitConfig',
      'work',
      'adapter',
      'runtimeAdapter',
      'adapterState',
      'adapterLog',
      'dispatchLog',
    ]) {
      assert.equal(
        sandbox[field].startsWith(`${sandbox.root}/`),
        true,
        `${field} must be beneath sandbox.root`,
      );
    }
    assert.throws(() => {
      sandbox.root = '/private/tmp/not-the-sandbox';
    }, TypeError);
  });
});

test('sandbox runners reject outside paths but preserve scalar overrides', () => {
  const sandbox = createSandbox();
  const outside = createSandbox();
  try {
    assert.throws(
      () => runCli(sandbox, ['--version'], {}, { cwd: outside.work }),
      /outside sandbox root/,
    );
    assert.throws(
      () => runCli(
        sandbox,
        ['--version'],
        { SUPERPOWERS_CACHE_DIR: outside.cache },
      ),
      /SUPERPOWERS_CACHE_DIR.*outside sandbox root/,
    );
    assert.throws(
      () => runScenario(
        sandbox,
        'broken-symlink',
        join(outside.root, 'outside-scenario'),
      ),
      /scenario destination.*outside sandbox root/,
    );
    const brokenEscape = join(sandbox.root, 'broken-escape');
    symlinkSync(join(outside.root, 'missing-cache'), brokenEscape);
    assert.throws(
      () => runCli(
        sandbox,
        ['--version'],
        { SUPERPOWERS_CACHE_DIR: brokenEscape },
      ),
      /SUPERPOWERS_CACHE_DIR.*outside sandbox root|unresolvable symlink/,
    );

    const result = runCli(
      sandbox,
      ['--version'],
      {
        SUPERPOWERS_REF: 'v9.8.7-rc.1',
        SUPERPOWERS_UPSTREAM_URL: 'https://example.invalid/upstream.git',
      },
    );
    assertCleanResult(result);
  } finally {
    destroySandbox(sandbox);
    destroySandbox(outside);
  }
});

test('sandbox cleanup rejects unregistered deletion targets', () => {
  const sandbox = createSandbox();
  const victim = createSandbox();
  try {
    assert.throws(
      () => destroySandbox({ ...sandbox, root: victim.root }),
      /unregistered sandbox/,
    );
    assert.equal(existsSync(victim.root), true);
  } finally {
    if (existsSync(sandbox.root)) destroySandbox(sandbox);
    if (existsSync(victim.root)) destroySandbox(victim);
  }
});

test('stateful adapter failures use protocol-v1 envelopes', () => {
  withSandbox({}, (sandbox) => {
    const unknown = spawnSync(
      sandbox.adapter,
      ['unknown-operation'],
      {
        cwd: sandbox.work,
        env: baseEnvironment(sandbox, {
          SPW_BASELINE_ADAPTER_STATE: sandbox.adapterState,
        }),
        encoding: 'utf8',
      },
    );
    assertCleanResult(unknown, 1);
    assert.equal(unknown.stderr, '');
    assert.deepEqual(JSON.parse(unknown.stdout), {
      protocol: 1,
      operation: 'unknown-operation',
      ok: false,
      messages: [],
      result: null,
      error: {
        code: 'unsupported-operation',
        message: 'unsupported adapter operation: unknown-operation',
        hints: [],
      },
    });

    const invalidRuntime = spawnSync(
      sandbox.adapter,
      ['build'],
      {
        cwd: sandbox.work,
        env: baseEnvironment(sandbox, {
          SPW_BASELINE_ADAPTER_STATE: sandbox.adapterState,
          SPW_BASELINE_RUNTIME_ADAPTER: sandbox.work,
        }),
        encoding: 'utf8',
      },
    );
    assertCleanResult(invalidRuntime, 1);
    assert.equal(invalidRuntime.stderr, '');
    assert.deepEqual(JSON.parse(invalidRuntime.stdout).error, {
      code: 'invalid-state',
      message: 'baseline runtime adapter must be an absolute regular file',
      hints: [],
    });

    const outsideRuntime = spawnSync(
      sandbox.adapter,
      ['build'],
      {
        cwd: sandbox.work,
        env: {
          ...baseEnvironment(sandbox, {
            SPW_BASELINE_ADAPTER_STATE: sandbox.adapterState,
          }),
          SPW_BASELINE_RUNTIME_ADAPTER: join(
            ROOT,
            'scripts',
            'adapters',
            'codex',
            'adapter',
          ),
        },
        encoding: 'utf8',
      },
    );
    assertCleanResult(outsideRuntime, 1);
    assert.equal(outsideRuntime.stderr, '');
    assert.deepEqual(JSON.parse(outsideRuntime.stdout).error, {
      code: 'invalid-state',
      message: 'baseline runtime adapter must be contained in sandbox root',
      hints: [],
    });

    const missingFingerprint = spawnSync(
      sandbox.adapter,
      ['install'],
      {
        cwd: sandbox.work,
        env: baseEnvironment(sandbox, {
          SPW_BASELINE_ADAPTER_STATE: sandbox.adapterState,
        }),
        encoding: 'utf8',
      },
    );
    assertCleanResult(missingFingerprint, 1);
    assert.deepEqual(JSON.parse(missingFingerprint.stdout).error, {
      code: 'invalid-arguments',
      message: 'SPW_BASELINE_FINGERPRINT is required for install',
      hints: [],
    });

    const missingState = spawnSync(
      sandbox.adapter,
      ['inspect', '--view', 'ownership'],
      {
        cwd: sandbox.work,
        env: baseEnvironment(sandbox, {
          SPW_BASELINE_ADAPTER_STATE: join(sandbox.root, 'missing-state'),
        }),
        encoding: 'utf8',
      },
    );
    assertCleanResult(missingState, 1);
    assert.deepEqual(JSON.parse(missingState.stdout).error, {
      code: 'invalid-state',
      message: 'baseline adapter state directory is missing',
      hints: [],
    });

    writeFileSync(
      join(sandbox.adapterState, 'state.json'),
      '{\n',
      'utf8',
    );
    const malformedState = spawnSync(
      sandbox.adapter,
      ['inspect', '--view', 'ownership'],
      {
        cwd: sandbox.work,
        env: baseEnvironment(sandbox, {
          SPW_BASELINE_ADAPTER_STATE: sandbox.adapterState,
        }),
        encoding: 'utf8',
      },
    );
    assertCleanResult(malformedState, 1);
    assert.deepEqual(JSON.parse(malformedState.stdout).error, {
      code: 'invalid-state',
      message: 'baseline adapter state is malformed',
      hints: [],
    });
  });
});
