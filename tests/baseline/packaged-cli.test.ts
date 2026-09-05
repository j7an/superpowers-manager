import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  accessSync,
  constants,
  mkdirSync,
  mkdtempSync,
  rmSync,
  realpathSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));

function executableOnHost(name: string) {
  for (const directory of (process.env.PATH || "").split(":")) {
    if (!directory) continue;
    const candidate = join(directory, name);
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Keep searching the host PATH used to start this test.
    }
  }
  throw new Error(`${name} was not found on the host PATH`);
}

function isolatedEnvironment(root: string) {
  const home = join(root, "home");
  const cache = join(root, "npm-cache");
  mkdirSync(home);
  mkdirSync(cache);
  return {
    HOME: home,
    NPM_CONFIG_CACHE: cache,
    PATH: [
      dirname(executableOnHost("npm")),
      dirname(process.execPath),
      "/usr/bin",
      "/bin",
    ].join(":"),
  };
}

function run(
  command: string,
  args: string[],
  options?: { cwd?: string; env?: Record<string, string> },
) {
  return spawnSync(command, args, {
    encoding: "utf8",
    ...options,
  });
}

function assertSucceeded(
  result: import("node:child_process").SpawnSyncReturns<string>,
  label: string,
) {
  assert.equal(
    result.error,
    undefined,
    `${label} failed to start: ${result.error}`,
  );
  assert.equal(
    result.signal,
    null,
    `${label} received signal ${result.signal}`,
  );
  assert.equal(result.status, 0, `${label} failed:\n${result.stderr}`);
}

function normalizePackReport(report: any) {
  assert.notEqual(
    report,
    null,
    "npm pack JSON report must be an array or keyed object",
  );
  assert.equal(
    typeof report,
    "object",
    "npm pack JSON report must be an array or keyed object",
  );
  return Array.isArray(report) ? report : Object.values(report);
}

void test("normalizes npm pack JSON array and keyed-object reports", () => {
  const entry = { filename: "superpowers-wrapper-1.0.0.tgz" };
  const expected = [entry];

  assert.deepEqual(normalizePackReport(expected), expected);
  assert.deepEqual(
    normalizePackReport({ "superpowers-wrapper": entry }),
    expected,
  );
  assert.throws(
    () => normalizePackReport(null),
    /npm pack JSON report must be an array or keyed object/,
  );
  assert.throws(
    () => normalizePackReport("not a report"),
    /npm pack JSON report must be an array or keyed object/,
  );
});

function packagedManifest(
  tarball: string,
  environment: Record<string, string>,
) {
  const extracted = run("tar", ["-xOf", tarball, "package/package.json"], {
    env: environment,
  });
  assertSucceeded(extracted, "tar package/package.json");
  return JSON.parse(extracted.stdout);
}

void test("PACKAGE-CLI-01 offline installed tarball routes through dist and exposes help and version", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "spw-packaged-cli-")));
  try {
    const pack = join(root, "pack");
    const consumer = join(root, "consumer");
    const environment = isolatedEnvironment(root);
    mkdirSync(pack);
    mkdirSync(consumer);

    const packed = run(
      process.execPath,
      [join(ROOT, "tests", "tools", "pack.ts"), "--out-dir", pack],
      {
        cwd: ROOT,
        env: environment,
      },
    );
    assertSucceeded(packed, "explicit package command");
    const report = normalizePackReport(JSON.parse(packed.stdout));
    assert.equal(report.length, 1, "npm pack must produce one artifact");
    assert.equal(
      typeof report[0].filename,
      "string",
      "npm pack report must include filename",
    );
    const tarball = isAbsolute(report[0].filename)
      ? report[0].filename
      : resolve(pack, report[0].filename);
    assert.equal(
      relative(pack, tarball).startsWith(".."),
      false,
      "tarball must be below pack root",
    );
    const manifest = packagedManifest(tarball, environment);
    assert.equal(
      typeof manifest.version,
      "string",
      "packed package.json must include version",
    );

    writeFileSync(join(consumer, "package.json"), '{ "private": true }\n');
    const installed = run(
      "npm",
      [
        "install",
        "--offline",
        "--ignore-scripts",
        "--no-audit",
        "--no-fund",
        "--cache",
        join(root, "npm-cache"),
        tarball,
      ],
      {
        cwd: consumer,
        env: environment,
      },
    );
    assertSucceeded(installed, "offline npm install");

    const executable = join(
      consumer,
      "node_modules",
      ".bin",
      "superpowers-manager",
    );
    assert.equal(
      realpathSync(executable),
      join(consumer, "node_modules", "superpowers-manager", "dist", "cli.js"),
      "npm executable must resolve to the emitted CLI",
    );
    accessSync(executable, constants.X_OK);
    assert.match(readFileSync(executable, "utf8"), /^#!\/usr\/bin\/env node\n/);

    const runtimes = [process.execPath];
    const minimumNode = process.env.SPW_PACKAGE_NODE;
    if (process.env.SPW_CONTAINER === "1") {
      assert.equal(
        typeof minimumNode,
        "string",
        "container must supply package minimum Node",
      );
      assert.equal(typeof process.env.SPW_PACKAGE_NODE_VERSION, "string");
    }
    if (minimumNode !== undefined) {
      const observed = run(minimumNode, ["--version"]);
      assertSucceeded(observed, "package minimum Node --version");
      assert.equal(
        observed.stdout.trim(),
        `v${process.env.SPW_PACKAGE_NODE_VERSION}`,
      );
      runtimes.push(minimumNode);
    }
    for (const [index, executableNode] of runtimes.entries()) {
      const runtimeBin = join(root, `runtime-bin-${index}`);
      mkdirSync(runtimeBin);
      symlinkSync(executableNode, join(runtimeBin, "node"));
      const consumerEnv = {
        ...environment,
        PATH: `${runtimeBin}:${environment.PATH}`,
      };
      const help = run(executable, ["--help"], {
        cwd: consumer,
        env: consumerEnv,
      });
      assertSucceeded(help, "installed CLI --help");
      assert.match(help.stdout, /usage:/i);
      assert.equal(help.stderr, "");
      const version = run(executable, ["--version"], {
        cwd: consumer,
        env: consumerEnv,
      });
      assertSucceeded(version, "installed CLI --version");
      assert.equal(version.stdout.trim(), manifest.version);
      assert.equal(version.stderr, "");
    }
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});
