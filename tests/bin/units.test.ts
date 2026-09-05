// Unit tests for the bin's pure functions. Platform and env are injected so
// the Windows dispatch path is testable without Windows.
import * as assert from "node:assert";
import * as cp from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

import * as bin from "../../src/cli.ts";

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
  // reaching runProbe. `tests/bin/units.test.ts:88::const cmd of ["prepare", "probe"`'s loop below still asserts that bare `probe`
  // parses as a run, and `tests/bin/units.test.ts:18::bin.parseArgs(["probe", "--porcelain"])` that `probe --porcelain` does.
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
// `python3` left uninstall at slice 4b's flip: it was required only because
// every adapter call ran validate-adapter-response.py (scripts/core/adapter.sh),
// and the in-process path has no validator process. `codex` stays.
assert.deepStrictEqual(requirements.uninstall, ["codex"]);
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
// SUPERPOWERS_VALIDATOR_EXECUTABLE names a program invoked directly, not a
// Python script, so it must never add python3 to prepare's requirements.
assert.ok(
  !bin
    .commandRequirements({ SUPERPOWERS_VALIDATOR_EXECUTABLE: "/validator" })
    .prepare.includes("python3"),
  "python3 must stay keyed to the legacy variable alone",
);

// --- vehicleCommand's two cases are RETIRED (PR 11.5 slice 4b, Task 8) ------
// They asserted that vehicleCommand picks a spawned command and throws when
// none remains. DISPATCH was 8/8 in-process (and is now deleted, slice 6), so
// the second case was the permanent state of the world and the first could
// only be satisfied by a hand-written table that describes nothing.
// vehicleCommand itself is deleted with tests/bin/dispatch-mode.js, exactly
// as its own doc comment instructed:
// "delete it rather than re-point it". No successor.

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

// --- buildSpawn's two cases are RETIRED (PR 11.5 slice 4b, Task 8) ---------
// They asserted buildSpawn's POSIX path construction, its win32
// shell-plus-script form, and its argv passthrough. `buildSpawn` is deleted
// from src/cli.ts with the last spawned command, along with `discoverShell`
// and `GIT_BASH_CANDIDATES`. There is no successor: the CLI computes no child
// command line at all any more, so nothing inherits the contract.

// --- resolvePackageRoot walks up to package.json from the bin's real path ---
const REPOSITORY_ROOT = path.resolve(import.meta.dirname, "..", "..");
const root = bin.resolvePackageRoot(
  path.join(REPOSITORY_ROOT, "src", "cli.ts"),
);
assert.strictEqual(root, REPOSITORY_ROOT);

// --- isMain supports all declared Node 24.x releases and resolves bin symlinks ---
const entryPath = fs.realpathSync(process.argv[1]);
assert.strictEqual(bin.isMain(entryPath, process.argv[1]), true);
assert.strictEqual(bin.isMain(entryPath, undefined), false);
// Matched on `code`, not on the message: this throw comes from isMain's
// fs.realpathSync call, and its text is Node's own errno prose, which this
// repo does not pin. `code` is the stable, semantic surface.
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

// --- preflight wires configurationErrors's verdict into its own result ---
// Exercises preflight() itself, not configurationErrors() directly: the
// wiring line in src/cli.ts (const errors: string[] = [...configurationErrors(cmd, env)])
// has no other test that would go red if that call were deleted and preflight
// seeded an empty array instead -- deleting the whole feature silently.
// "prepare" is VALIDATOR_COMMANDS-gated and needs only "git" (not "codex"),
// which keeps the clean-environment case from failing for an unrelated
// tooling reason on a host without codex installed.
const realPathEnv = { PATH: process.env.PATH || "" };
const bothSetPreflightEnv = {
  ...realPathEnv,
  SUPERPOWERS_VALIDATOR: "/a",
  SUPERPOWERS_VALIDATOR_EXECUTABLE: "/b",
};
const bothSetPreflight = bin.preflight("prepare", bothSetPreflightEnv, "linux");
assert.strictEqual(
  bothSetPreflight.ok,
  false,
  "preflight must reject a both-set validator configuration",
);
assert.ok(
  bothSetPreflight.errors.join("\n").includes("both set"),
  "preflight's errors must surface configurationErrors's conflict message",
);
// Positive control: the same command, real PATH, no validator variables set
// at all -- must stay ok. Without this, a preflight that rejected EVERY
// command would also satisfy the assertion above for the wrong reason.
const cleanPreflight = bin.preflight("prepare", realPathEnv, "linux");
assert.strictEqual(
  cleanPreflight.ok,
  true,
  "preflight must stay ok when the validator configuration is clean",
);

// --- the baseline sandbox refuses network egress through git ---
// PR 11.5 slice 3. The in-process prepare CLONES, so any sandbox case that
// forgets SUPERPOWERS_UPSTREAM_URL would reach the production default at
// `src/effective-selection.ts:68::export const UPSTREAM_URL_DEFAULT`. Local paths must still pass through.
{
  const support = await import(
    new URL("../baseline/support.ts", import.meta.url).href
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
