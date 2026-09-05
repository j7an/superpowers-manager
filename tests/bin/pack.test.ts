import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  copyFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  listenPackEvents,
  makePackFixture,
  packDriverEnv,
  packValidatorMode,
  runPackDriver,
  startPackDriver,
  stopPackProcess,
  type PackEvent,
} from "./pack-fixture.ts";

const REPO = fileURLToPath(new URL("../..", import.meta.url));

async function settlePackCleanup(
  events: Awaited<ReturnType<typeof listenPackEvents>>,
  runs: readonly ReturnType<typeof startPackDriver>[],
  pids: readonly (number | undefined)[],
): Promise<void> {
  await Promise.allSettled([
    ...pids.map(async (pid) => {
      if (pid !== undefined) stopPackProcess(pid);
    }),
    ...runs.map((run) => run.closed),
    events.close(),
  ]);
}

for (const signal of ["SIGHUP", "SIGINT", "SIGTERM"] as const) {
  void test(
    `${signal} reaps a writer before staging cleanup`,
    { timeout: 15000 },
    async (t) => {
      const f = makePackFixture(t);
      writeFileSync(join(f.out, "unrelated.tgz"), "caller artifact");
      writeFileSync(
        join(f.root, "node_modules", ".bin", "tsc"),
        '#!/bin/sh\nexec node "$PACK_FIXTURE_DRIVER" compiler-writer "$@"\n',
        { mode: 0o755 },
      );
      writeFileSync(
        join(f.bin, "npm"),
        '#!/bin/sh\nprintf called > "$PACK_EVENTS/npm-called"\nexit 7\n',
        { mode: 0o755 },
      );
      const events = await listenPackEvents(f);
      const run = startPackDriver(f);
      let ready: PackEvent | undefined;
      try {
        const active = await events.next();
        ready = active;
        assert.equal(active.event, "writer-ready");
        assert.equal(typeof active.writerPid, "number");
        run.child.kill(signal);
        const result = await run.closed;
        assert.equal(result.signal, signal, result.stderr);
        assert.equal(result.stdout, "");
        assert.equal(
          existsSync(join(f.events, "npm-called")),
          false,
          "no subprocess may follow cancellation",
        );
        assert.throws(() => process.kill(active.writerPid!, 0), {
          code: "ESRCH",
          message: /ESRCH/,
        });
        assert.throws(() => process.kill(active.pid, 0), {
          code: "ESRCH",
          message: /ESRCH/,
        });
        const receipt = JSON.parse(
          readFileSync(join(f.events, "writer-reaped"), "utf8"),
        );
        assert.equal(
          receipt.stagingExists,
          true,
          "writer must be reaped while staging still exists",
        );
        assert.equal(
          existsSync(join(f.events, "writer-outlived-staging")),
          false,
        );
        assert.deepEqual(readdirSync(f.temp), []);
        assert.deepEqual(readdirSync(f.out), ["unrelated.tgz"]);
        assert.equal(
          readFileSync(join(f.out, "unrelated.tgz"), "utf8"),
          "caller artifact",
        );
      } finally {
        await settlePackCleanup(
          events,
          [run],
          [ready?.writerPid, ready?.pid, run.child.pid],
        );
      }
    },
  );
}

void test(
  "SIGTERM escalates after the compiler exits with an ignoring writer",
  { timeout: 15000 },
  async (t) => {
    const f = makePackFixture(t);
    writeFileSync(join(f.out, "unrelated.tgz"), "caller artifact");
    writeFileSync(
      join(f.root, "node_modules", ".bin", "tsc"),
      '#!/bin/sh\nexec node "$PACK_FIXTURE_DRIVER" compiler-orphan "$@"\n',
      { mode: 0o755 },
    );
    const events = await listenPackEvents(f);
    const run = startPackDriver(f);
    let ready: PackEvent | undefined;
    try {
      const active = await events.next();
      ready = active;
      assert.equal(active.event, "writer-ready");
      run.child.kill("SIGTERM");
      const result = await run.closed;
      assert.equal(result.signal, "SIGTERM", result.stderr);
      assert.equal(result.stdout, "");
      assert.throws(() => process.kill(active.writerPid!, 0), {
        code: "ESRCH",
        message: /ESRCH/,
      });
      const receipt = JSON.parse(
        readFileSync(join(f.events, "writer-signalled"), "utf8"),
      );
      assert.deepEqual(receipt, { signal: "SIGTERM", stagingExists: true });
      assert.equal(
        existsSync(join(f.events, "writer-outlived-staging")),
        false,
      );
      assert.deepEqual(readdirSync(f.temp), []);
      assert.deepEqual(readdirSync(f.out), ["unrelated.tgz"]);
      assert.equal(
        readFileSync(join(f.out, "unrelated.tgz"), "utf8"),
        "caller artifact",
      );
    } finally {
      await settlePackCleanup(
        events,
        [run],
        [ready?.writerPid, ready?.pid, run.child.pid],
      );
    }
  },
);

void test(
  "SIGTERM confirms a closed-stdio ignoring writer is dead before staging cleanup",
  { timeout: 15000 },
  async (t) => {
    const f = makePackFixture(t);
    writeFileSync(join(f.out, "unrelated.tgz"), "caller artifact");
    writeFileSync(
      join(f.root, "node_modules", ".bin", "tsc"),
      '#!/bin/sh\nexec node "$PACK_FIXTURE_DRIVER" compiler-closed-orphan "$@"\n',
      { mode: 0o755 },
    );
    const events = await listenPackEvents(f);
    const run = startPackDriver(f);
    let ready: PackEvent | undefined;
    try {
      const active = await events.next();
      ready = active;
      assert.equal(active.event, "writer-ready");
      run.child.kill("SIGTERM");
      const result = await run.closed;
      assert.equal(result.signal, "SIGTERM", result.stderr);
      assert.equal(result.stdout, "");
      assert.doesNotMatch(
        result.stderr,
        /cannot confirm package child process group exit/,
      );
      assert.throws(() => process.kill(active.writerPid!, 0), {
        code: "ESRCH",
        message: /ESRCH/,
      });
      const receipt = JSON.parse(
        readFileSync(join(f.events, "writer-signalled"), "utf8"),
      );
      assert.deepEqual(receipt, { signal: "SIGTERM", stagingExists: true });
      assert.equal(
        existsSync(join(f.events, "writer-outlived-staging")),
        false,
      );
      assert.deepEqual(readdirSync(f.temp), []);
      assert.deepEqual(readdirSync(f.out), ["unrelated.tgz"]);
      assert.equal(
        readFileSync(join(f.out, "unrelated.tgz"), "utf8"),
        "caller artifact",
      );
    } finally {
      await settlePackCleanup(
        events,
        [run],
        [ready?.writerPid, ready?.pid, run.child.pid],
      );
    }
  },
);

void test("a pre-existing output belongs to its caller", (t) => {
  const f = makePackFixture(t);
  const target = join(f.out, "superpowers-manager-0.0.0-fixture.tgz");
  writeFileSync(target, "incumbent");
  const result = runPackDriver(f);
  assert.notEqual(result.status, 0);
  assert.equal(result.stdout, "");
  assert.equal(readFileSync(target, "utf8"), "incumbent");
  assert.deepEqual(readdirSync(f.temp), []);
});

void test(
  "two producers cannot overwrite or remove each other's output",
  { timeout: 20000 },
  async (t) => {
    const f = makePackFixture(t);
    packValidatorMode(f, "barrier");
    const events = await listenPackEvents(f);
    const runs = [startPackDriver(f), startPackDriver(f)];
    try {
      assert.equal((await events.next()).event, "ready");
      assert.equal((await events.next()).event, "ready");
      events.release();
      const results = await Promise.all(runs.map((run) => run.closed));
      assert.deepEqual(
        results
          .map((result) => result.code)
          .sort((a, b) => (a ?? -1) - (b ?? -1)),
        [0, 1],
      );
      const winner = results.find((result) => result.code === 0)!;
      const loser = results.find((result) => result.code !== 0)!;
      assert.equal(loser.stdout, "");
      assert.match(loser.stderr, /cannot deliver packaged artifact/);
      const [report] = JSON.parse(winner.stdout);
      const target = join(f.out, report.filename);
      assert.deepEqual(readdirSync(f.out), [report.filename]);
      assert.match(
        execFileSync("tar", ["-tf", target], { encoding: "utf8" }),
        /package\/dist\/cli.js/,
      );
      assert.deepEqual(readdirSync(f.temp), []);
    } finally {
      await settlePackCleanup(
        events,
        runs,
        runs.map((run) => run.child.pid),
      );
    }
  },
);

for (const mode of ["cleanup-failure", "dual-failure"]) {
  void test(`${mode} retains every diagnostic and removes owned output`, (t) => {
    assert.notEqual(
      process.getuid?.(),
      0,
      "permission coverage requires a non-root user",
    );
    const f = makePackFixture(t);
    packValidatorMode(f, mode);
    const result = runPackDriver(f);
    assert.notEqual(result.status, 0);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /cannot remove package staging directory/);
    if (mode === "dual-failure")
      assert.match(result.stderr, /validate package contents failed/);
    assert.deepEqual(readdirSync(f.out), []);
    assert.equal(readdirSync(f.temp).length, 1);
  });
}

for (const args of [
  [],
  ["--out-dir"],
  ["--out-dir", ""],
  ["--unknown", "x"],
  ["--out-dir", "x", "--out-dir", "y"],
]) {
  void test(`CLI rejects invalid arguments before compiling: ${JSON.stringify(args)}`, (t) => {
    const f = makePackFixture(t);
    mkdirSync(join(f.root, "tests", "tools"));
    copyFileSync(
      join(REPO, "tests", "tools", "pack.ts"),
      join(f.root, "tests", "tools", "pack.ts"),
    );
    const result = spawnSync(
      process.execPath,
      [join(f.root, "tests", "tools", "pack.ts"), ...args],
      { encoding: "utf8", env: packDriverEnv(f) },
    );
    assert.equal(result.status, 2);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /usage: pack.ts --out-dir/);
    assert.deepEqual(readdirSync(f.temp), []);
    assert.deepEqual(readdirSync(f.out), []);
  });
}

for (const mode of [
  "absent",
  "file",
  "unwritable",
  "temporary-parent-in-checkout",
]) {
  void test(`rejects ${mode} paths before compiling`, (t) => {
    const f = makePackFixture(t);
    mkdirSync(join(f.root, "tests", "tools"));
    const cli = join(f.root, "tests", "tools", "pack.ts");
    copyFileSync(join(REPO, "tests", "tools", "pack.ts"), cli);
    const marker = join(f.events, "compiled");
    writeFileSync(
      join(f.root, "node_modules", ".bin", "tsc"),
      '#!/bin/sh\nprintf called > "$PACK_EVENTS/compiled"\nexit 7\n',
      { mode: 0o755 },
    );
    let out = f.out;
    let env = packDriverEnv(f);
    if (mode === "absent") out = join(f.out, "absent");
    if (mode === "file") {
      out = join(f.out, "file");
      writeFileSync(out, "caller file");
    }
    if (mode === "unwritable") {
      assert.notEqual(
        process.getuid?.(),
        0,
        "permission coverage requires a non-root user",
      );
      chmodSync(f.out, 0o500);
    }
    if (mode === "temporary-parent-in-checkout")
      env = { ...env, TMPDIR: f.root, TMP: f.root, TEMP: f.root };
    const result = spawnSync(process.execPath, [cli, "--out-dir", out], {
      encoding: "utf8",
      env,
    });
    assert.notEqual(result.status, 0);
    assert.equal(result.stdout, "");
    assert.equal(
      existsSync(marker),
      false,
      "invalid paths must fail before compilation",
    );
    assert.match(result.stderr, /package (output|temporary)/);
    assert.deepEqual(readdirSync(f.temp), []);
    assert.equal(
      readdirSync(f.root).some((name) => name.startsWith("spw-pack-")),
      false,
    );
  });
}

void test("compiler failure yields no package metadata or artifact", (t) => {
  const f = makePackFixture(t);
  writeFileSync(
    join(f.root, "node_modules", ".bin", "tsc"),
    "#!/bin/sh\nprintf '%s\\n' 'fixture compiler failure' >&2\nexit 7\n",
    { mode: 0o755 },
  );
  const result = runPackDriver(f);
  assert.notEqual(result.status, 0);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /compiler|compil/);
  assert.deepEqual(readdirSync(f.out), []);
  assert.deepEqual(readdirSync(f.temp), []);
});

void test("one staged package is delivered and all staging is removed", (t) => {
  const f = makePackFixture(t);
  mkdirSync(join(f.root, "dist"));
  writeFileSync(
    join(f.root, "dist", "stale.js"),
    "throw new Error('stale checkout output was packaged');\n",
  );
  const result = runPackDriver(f);
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(Array.isArray(report), true);
  assert.equal(report.length, 1);
  assert.equal(typeof report[0].filename, "string");
  assert.deepEqual(readdirSync(f.out), [report[0].filename]);
  assert.deepEqual(readdirSync(f.temp), []);
  const tarball = join(f.out, report[0].filename);
  const listing = execFileSync("tar", ["-tf", tarball], {
    encoding: "utf8",
  });
  assert.match(listing, /^package\/dist\/cli\.js$/m);
  assert.doesNotMatch(listing, /^package\/dist\/stale\.js$/m);
  const sealed = JSON.parse(
    execFileSync("tar", ["-xOf", tarball, "package/package.json"], {
      encoding: "utf8",
    }),
  );
  assert.equal(sealed.name, "superpowers-manager");
  assert.equal(sealed.version, "0.0.0-fixture");
  assert.equal(sealed.bin["superpowers-manager"], "dist/cli.js");
  assert.equal(sealed.scripts.prepack, undefined);
  assert.deepEqual(Object.keys(sealed.dependencies ?? {}), []);
});

void test("direct npm pack refuses absent and stale checkout output", (t) => {
  const outer = mkdtempSync(join(tmpdir(), "spw-pack-guard-"));
  t.after(() => rmSync(outer, { recursive: true, force: true }));
  const home = join(outer, "home");
  const cache = join(outer, "cache");
  mkdirSync(home);
  mkdirSync(cache);
  const runs = [
    { name: "absent", root: join(outer, "absent") },
    { name: "stale", root: join(outer, "stale") },
  ];
  for (const run of runs) {
    mkdirSync(run.root, { recursive: true });
    copyFileSync(join(REPO, "package.json"), join(run.root, "package.json"));
  }
  mkdirSync(join(runs[1].root, "dist"));
  writeFileSync(join(runs[1].root, "dist", "cli.js"), "stale\n");
  const results = runs.map((run) => ({
    name: run.name,
    result: spawnSync("npm", ["pack", "--dry-run", "--json"], {
      cwd: run.root,
      encoding: "utf8",
      env: {
        ...process.env,
        HOME: home,
        NPM_CONFIG_CACHE: cache,
        NPM_CONFIG_OFFLINE: "true",
      },
    }),
  }));
  for (const { name, result } of results) {
    assert.notEqual(
      result.status,
      0,
      `${name} checkout output must be refused`,
    );
    assert.match(
      result.stderr,
      /use node tests\/tools\/pack\.ts --out-dir <directory> to package this checkout/,
    );
  }
});
