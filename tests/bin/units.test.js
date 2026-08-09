// @ts-check
// Unit tests for the bin's pure functions. Platform and env are injected so
// the Windows dispatch path is testable without Windows.
import * as assert from "node:assert";
import * as cp from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { vehicleCommand } from "./dispatch-mode.js";
/** @type {typeof import('../../src/cli.js')} */
const bin = await import(new URL("../../dist/cli.js", import.meta.url).href);

assert.strictEqual(typeof bin.main, "function");

// --- parseArgs ---
assert.deepStrictEqual(bin.parseArgs([]), {
  kind: "run",
  cmd: "update",
  args: [],
});
assert.deepStrictEqual(bin.parseArgs(["probe", "--porcelain"]), {
  kind: "run",
  cmd: "probe",
  args: ["--porcelain"],
});
assert.deepStrictEqual(bin.parseArgs(["pin", "v6.1.1"]), {
  kind: "run",
  cmd: "pin",
  args: ["v6.1.1"],
});
for (const ref of [
  "v0.0.0",
  "v1.2.3-0",
  "v1.2.3-alpha.1",
  "0123456789abcdef0123456789abcdef01234567",
  "0123456789ABCDEF0123456789ABCDEF01234567",
]) {
  assert.deepStrictEqual(bin.parseArgs(["pin", ref]), {
    kind: "run",
    cmd: "pin",
    args: [ref],
  });
}
for (const ref of [
  "main",
  "1.2.3",
  "V1.2.3",
  "v01.2.3",
  "v1.02.3",
  "v1.2.03",
  "v1.2.3-01",
  "v1.2.3+build.1",
  "0123456789abcdef0123456789abcdef0123456",
  "0123456789abcdef0123456789abcdef012345678",
  "g123456789abcdef0123456789abcdef01234567",
  "v1.2.3\ninvalid",
]) {
  assert.strictEqual(bin.parseArgs(["pin", ref]).kind, "usage-error");
}
for (const argv of [
  ["pin"],
  ["pin", "a", "b"],
  ["track-latest", "x"],
  ["unpin", "x"],
  // PR 11.5 slice 2: probe's arity is CLI-owned, so a typo'd flag, a stray
  // positional, and a repeated flag are all usage errors here rather than
  // reaching runProbe. `:88`'s loop below still asserts that bare `probe`
  // parses as a run, and `:18` that `probe --porcelain` does.
  ["probe", "--porcelaine"],
  ["probe", "extra"],
  ["probe", "--porcelain", "extra"],
  ["probe", "--porcelain", "--porcelain"],
]) {
  assert.strictEqual(
    bin.parseArgs(argv).kind,
    "usage-error",
    `${argv.join(" ")} must be a usage error`,
  );
}
// The exact message matters: main() prints `error: <message>` followed by the
// full usage block, which is the half src/commands/probe.ts's PROBE_USAGE
// cannot produce on its own.
const probeUsage = bin.parseArgs(["probe", "--porcelaine"]);
assert.strictEqual(probeUsage.kind, "usage-error");
assert.strictEqual(
  probeUsage.message,
  "usage: superpowers-manager probe [--porcelain]",
);
assert.strictEqual(bin.parseArgs(["track-latest"]).kind, "run");
assert.strictEqual(bin.parseArgs(["unpin"]).kind, "run");
for (const cmd of ["prepare", "probe", "install", "update", "uninstall"]) {
  assert.strictEqual(bin.parseArgs([cmd]).kind, "run");
}
assert.strictEqual(bin.parseArgs(["--help"]).kind, "help");
assert.strictEqual(bin.parseArgs(["-h"]).kind, "help");
assert.strictEqual(bin.parseArgs(["--version"]).kind, "version");
// Unknown subcommands and stray flags NEVER fall through to update.
assert.strictEqual(bin.parseArgs(["bogus"]).kind, "usage-error");
assert.strictEqual(bin.parseArgs(["--porcelain"]).kind, "usage-error");

const requirements = bin.commandRequirements({});
assert.deepStrictEqual(requirements.pin, ["git"]);
assert.deepStrictEqual(requirements["track-latest"], []);
assert.deepStrictEqual(requirements.unpin, []);
assert.deepStrictEqual(requirements.uninstall, ["python3", "codex"]);
// Independent coverage of the conditional, which CLI-PREFLIGHT-01 cannot
// provide: it derives from this same accessor, so it follows the conditional
// automatically and can never detect a wrong one (slice 3, D5).
assert.deepStrictEqual(requirements.prepare, ["git"]);
assert.deepStrictEqual(
  bin.commandRequirements({ SUPERPOWERS_VALIDATOR: "/validator.py" }).prepare,
  ["git", "python3"],
);
// An empty value is not a configured validator.
assert.deepStrictEqual(
  bin.commandRequirements({ SUPERPOWERS_VALIDATOR: "" }).prepare,
  ["git"],
);

// --- vehicleCommand: the dispatch vehicles pick their own subject ----------
// Two tests below need "some command DISPATCH still spawns" and assert nothing
// about which. Hardcoding one meant re-pointing it at every flip -- `probe` to
// `prepare` at slice 2, `prepare` to something else here -- and buildSpawn is a
// pure path computation, so a stale literal kept passing while describing a
// command that is no longer spawned. Deriving it also makes both tests fail
// loudly in slice 4, when nothing is spawned and they should be deleted.
assert.strictEqual(
  vehicleCommand({ pin: "in-process", update: "spawn", probe: "in-process" }),
  "update",
);
assert.throws(
  () => vehicleCommand({ pin: "in-process", probe: "in-process" }),
  /no spawned command remains/,
);

// --- usage separates saving selection intent from applying it ---
const help = bin.usage();
for (const text of [
  "pin REF",
  "track-latest",
  "unpin",
  "save intent only",
  "do not prepare or install",
]) {
  assert.ok(help.includes(text), `help must include ${text}`);
}
assert.ok(help.includes("SUPERPOWERS_CONFIG_DIR"));
assert.ok(help.includes("$XDG_CONFIG_HOME/superpowers-manager"));
assert.ok(help.includes("$HOME/.config/superpowers-manager"));

// --- buildSpawn: POSIX executes the script directly ---
// Vehicle only. This asserts buildSpawn's path construction and argv
// passthrough, not anything specific to the command it names — it just has to
// be one DISPATCH still spawns, which vehicleCommand now guarantees rather
// than a literal that has to be maintained. It dies with buildSpawn in slice 4,
// and vehicleCommand throws at exactly that moment.
//
// The argv is arbitrary and stays non-empty on purpose: buildSpawn is a pure
// function that forwards whatever it is handed, so passing `[]` here would
// drop the passthrough half of the contract on the ground.
const spawned = vehicleCommand(bin.DISPATCH);
const posix = bin.buildSpawn(
  spawned,
  ["--ref", "test"],
  "/root",
  "/bin/sh",
  "linux",
);
assert.strictEqual(posix.file, path.join("/root", "scripts", spawned));
assert.deepStrictEqual(posix.argv, ["--ref", "test"]);

// --- buildSpawn: Windows dispatches through the discovered shell:
// <shell> scripts/<cmd> [args...]. path.join is used on both sides so the
// assertion holds on any host separator.
const gitBash = "C:\\Program Files\\Git\\bin\\bash.exe";
const win = bin.buildSpawn(spawned, ["-x"], "C:\\pkg", gitBash, "win32");
assert.strictEqual(win.file, gitBash);
assert.deepStrictEqual(win.argv, [
  path.join("C:\\pkg", "scripts", spawned),
  "-x",
]);

// --- resolvePackageRoot walks up to package.json from the bin's real path ---
const REPOSITORY_ROOT = path.resolve(import.meta.dirname, "..", "..");
const root = bin.resolvePackageRoot(
  path.join(REPOSITORY_ROOT, "bin", "superpowers-manager.js"),
);
assert.strictEqual(root, REPOSITORY_ROOT);

// --- scripts/probe outlives this slice ---
// scripts/install:18 and scripts/update:8 still execute `scripts/probe
// --porcelain`, so deleting it breaks both commands before they reach their
// lifecycle logic. Delete the script, its two callers' probe steps, and
// tests/test_probe.sh together in the slice that ports install and update.
// Asserting the RELATIONSHIP rather than a line number keeps this stable
// against edits to either caller.
assert.ok(
  fs.existsSync(path.join(REPOSITORY_ROOT, "scripts", "probe")),
  "scripts/probe is still executed by scripts/install and scripts/update",
);
for (const caller of ["install", "update"]) {
  assert.match(
    fs.readFileSync(path.join(REPOSITORY_ROOT, "scripts", caller), "utf8"),
    /scripts\/probe" --porcelain/,
    `scripts/${caller} must still invoke scripts/probe`,
  );
}

// --- scripts/prepare outlives this slice ---
// scripts/install:25 and scripts/update:23 still execute `scripts/prepare`, so
// deleting it breaks both commands. Slice 3.4 flipped `prepare` itself to
// in-process dispatch and re-derived the cli-parity prepare cases off the
// synthetic adapter at tests/fixtures/baseline/bin/stateful-adapter, so that
// coupling is gone. What remains is the lifecycle path: `install` and `update`
// still spawn, and their test fakes stub SPW_ADAPTER — a seam only
// scripts/core/adapter.sh honours and the in-process runAdapter does not.
// Slice 3.5 re-bases those fakes and deletes this script. Asserting the
// RELATIONSHIP rather than a line number keeps this stable against edits to
// either caller.
assert.ok(
  fs.existsSync(path.join(REPOSITORY_ROOT, "scripts", "prepare")),
  "scripts/prepare is still executed by scripts/install and scripts/update",
);
for (const caller of ["install", "update"]) {
  assert.match(
    fs.readFileSync(path.join(REPOSITORY_ROOT, "scripts", caller), "utf8"),
    /sh "\$root\/scripts\/prepare"/,
    `scripts/${caller} must still invoke scripts/prepare`,
  );
}

// --- isMain supports all declared Node 24.x releases and resolves bin symlinks ---
const entryPath = fs.realpathSync(process.argv[1]);
assert.strictEqual(bin.isMain(entryPath, process.argv[1]), true);
assert.strictEqual(bin.isMain(entryPath, undefined), false);
// Matched on `code`, not on the message: this throw comes from
// fs.realpathSync (src/cli.ts:84) and its text is Node's own errno prose,
// which this repo does not pin. `code` is the stable, semantic surface.
assert.throws(
  () =>
    bin.isMain(entryPath, path.join(import.meta.dirname, "missing-entry.js")),
  { code: "ENOENT" },
);

// --- preflight: codex required for every command that inspects or mutates Codex ---
const emptyEnv = { PATH: "/nonexistent-dir-for-test" };
const probePf = bin.preflight("probe", emptyEnv, "linux");
assert.strictEqual(probePf.ok, false);
assert.ok(
  probePf.errors.join("\n").includes("codex"),
  "probe must require codex",
);
const installPf = bin.preflight("install", emptyEnv, "linux");
assert.strictEqual(installPf.ok, false);
assert.ok(
  installPf.errors.join("\n").includes("codex"),
  "install must require codex",
);
assert.ok(installPf.errors.join("\n").includes("git"));

// --- the baseline sandbox refuses network egress through git ---
// PR 11.5 slice 3. The in-process prepare CLONES, so any sandbox case that
// forgets SUPERPOWERS_UPSTREAM_URL would reach the production default at
// src/effective-selection.ts:66. Local paths must still pass through.
{
  const support = await import(
    new URL("../baseline/support.js", import.meta.url).href
  );
  const sandbox = support.createSandbox();
  try {
    for (const remote of [
      "https://example.invalid/repo.git",
      "http://example.invalid/repo.git",
      "git://example.invalid/repo.git",
      "ssh://git@example.invalid/repo.git",
      "git@example.invalid:owner/repo.git",
    ]) {
      const refused = cp.spawnSync(path.join(sandbox.bin, "git"), [
        "ls-remote",
        remote,
      ]);
      assert.notStrictEqual(refused.status, 0, `${remote} must be refused`);
      assert.match(
        String(refused.stderr),
        /sandbox refuses network git remote/,
        `${remote} must be refused by the shim, not by the network`,
      );
    }
    const version = cp.spawnSync(path.join(sandbox.bin, "git"), ["--version"]);
    assert.strictEqual(version.status, 0, "local git must pass through");
  } finally {
    support.destroySandbox(sandbox);
  }
}

console.log("units.test.js: OK");
