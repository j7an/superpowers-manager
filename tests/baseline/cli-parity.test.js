import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

import {
  COMMANDS,
  PASSTHROUGH_VARIABLES,
  ROOT,
  baseEnvironment,
  clearDispatchLog,
  createSandbox,
  destroySandbox,
  readDispatchLog,
  removeTool,
  runCli,
  runScenario,
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
