// End-to-end coverage for SUPERPOWERS_VALIDATOR_EXECUTABLE across prepare, install,
// and update.
import assert from "node:assert/strict";
import {
  existsSync,
  lstatSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import test from "node:test";
import {
  createCase,
  runScript,
  snapshotTree,
} from "../bin/lifecycle-fixture.ts";
import { prepare } from "./prepare-fixture.ts";

type CaseEnv = import("../bin/lifecycle-fixture.ts").CaseEnv;

// `createCase` builds the fake executables and the state directory and NOTHING
// else; the listings are the case's own precondition. `prepare` never contacts
// Codex, so a prepare case needs none — but `install` and `update` probe first,
// and the INSTALL fake reads a FLAT plugin_list.json (only tests/bin/probe-fakes.js
// passes `sequencePluginList` and reads the numbered plugin_list.N.json form).
// Using the probe fakes for a lifecycle command fails at the probe, before the
// validator is ever reached.
const PLUGIN_LIST_EMPTY = '{"installed":[],"available":[]}';
const MARKETPLACE_ABSENT =
  '{"marketplaces":[{"name":"openai-curated","root":"/x"}]}';

/**
 * A case that can run `install` or `update`: install fakes plus seeded listings,
 * mirroring `installCase` in tests/bin/install-commands.test.js.
 */
function lifecycleCase(): CaseEnv {
  const c = createCase({ fakes: "install", config: {} });
  writeFileSync(join(c.state, "plugin_list.json"), `${PLUGIN_LIST_EMPTY}\n`);
  writeFileSync(
    join(c.state, "marketplace_list.json"),
    `${MARKETPLACE_ABSENT}\n`,
  );
  return c;
}

/**
 * Writes an executable POSIX sh validator into the case's scratch directory.
 */
function writeValidator(
  c: { dir: string },
  name: string,
  body: string,
): string {
  const p = join(c.dir, name);
  writeFileSync(p, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  return p;
}

void test("prepare accepts a tree when the executable validator exits 0", async () => {
  const c = createCase({ fakes: "probe" });
  // R1: the configured value must be a SYMLINK to the real script, not the
  // script itself. Both createCase's scratch tree and its containing tmpdir
  // are realpath'd (`tests/bin/lifecycle-fixture.ts:36-38::export const SCRATCH = realpathSync`), so a
  // non-symlinked path already equals its own realpath -- an assertion of
  // "configured -> realpath(configured)" would then read as "X -> X" and
  // could not tell a manager that discloses a genuine resolved target apart
  // from one that just echoes what was configured. A real, distinct
  // symlink target also exercises disclosureLine's otherwise-uncovered
  // "via symlink" branch.
  const real = writeValidator(c, "accept-real.sh", "exit 0");
  const validator = join(c.dir, "accept.sh");
  symlinkSync(real, validator);
  const result = await prepare(c, {
    SUPERPOWERS_VALIDATOR_EXECUTABLE: validator,
  });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /running external validator/);
  // D8: the disclosure must name what was CONFIGURED (the symlink) and what
  // it actually RESOLVED to (the real script) -- two DISTINCT paths, joined
  // by " via symlink ->". A mutation that replaces disclosureLine's body
  // with a constant, or that echoes the configured path on both sides of
  // the arrow, fails this.
  const resolved = realpathSync(validator);
  assert.notEqual(
    resolved,
    validator,
    "fixture bug: the symlink did not add a path distinct from its target",
  );
  assert.ok(
    result.stdout.includes(
      `running external validator ${validator} via symlink -> ${resolved}`,
    ),
    `disclosure did not name the resolved symlink target:\n${result.stdout}`,
  );
});

void test("prepare discloses a bare-name executable validator without claiming a resolved path", async () => {
  // D8a: a PATH-relative name cannot be resolved the way an absolute path
  // can (resolveValidator skips lstat/realpath entirely for a bare name), so
  // the disclosure must say PATH selects it rather than presenting the bare
  // word as though it were a checked, resolved path.
  const c = createCase({ fakes: "probe" });
  const name = "bare-accept.sh";
  writeValidator(c, name, "exit 0");
  const result = await prepare(c, {
    SUPERPOWERS_VALIDATOR_EXECUTABLE: name,
    PATH: `${c.dir}:${process.env.PATH ?? ""}`,
  });
  assert.equal(result.status, 0);
  assert.ok(
    result.stdout.includes(
      `running external validator ${name} (a bare name; PATH selects the file, and the manager does not guess which)`,
    ),
    `disclosure did not report the bare-name case:\n${result.stdout}`,
  );
});

void test("prepare reports a truncated validator stream in its disclosure", async () => {
  // D7: BOUNDED_EXECUTABLE caps each stream at 64 KiB. A validator emitting
  // more than that must be reported as truncated -- silently dropping the
  // remainder with no marker would hide a validator report that ran past
  // the cap.
  const c = createCase({ fakes: "probe" });
  const validator = writeValidator(c, "chatty.sh", "yes | head -c 70000");
  const result = await prepare(c, {
    SUPERPOWERS_VALIDATOR_EXECUTABLE: validator,
  });
  assert.equal(result.status, 0);
  const marker = result.stdout.match(
    /validator stdout truncated, (\d+) bytes dropped/,
  );
  assert.ok(marker, `no truncation marker in stdout:\n${result.stdout}`);
  assert.ok(
    Number(marker[1]) > 0,
    `truncation marker reported an implausible byte count: ${marker[1]}`,
  );
});

void test("prepare rejects a tree when the executable validator exits nonzero", async () => {
  const c = createCase({ fakes: "probe" });
  const validator = writeValidator(c, "reject.sh", "echo no >&2; exit 1");
  const result = await prepare(c, {
    SUPERPOWERS_VALIDATOR_EXECUTABLE: validator,
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /external plugin validation failed/);
});

void test("a missing executable validator names itself, and still discloses", async () => {
  const c = createCase({ fakes: "probe" });
  const missing = join(c.dir, "absent");
  const result = await prepare(c, {
    SUPERPOWERS_VALIDATOR_EXECUTABLE: missing,
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /external plugin validator not found/);
  // The disclosure must survive the launch-failure path, and must say the
  // path-like value could not be resolved rather than silently omitting
  // resolution or claiming a target it never checked.
  assert.match(result.stdout, /running external validator/);
  assert.ok(
    result.stdout.includes(
      `running external validator ${missing} (unresolved)`,
    ),
    `disclosure did not report the unresolved path:\n${result.stdout}`,
  );
});

void test("prepare discloses a dangling executable-validator symlink", async () => {
  const c = createCase({ fakes: "probe" });
  const target = join(c.dir, "missing-validator-target");
  const validator = join(c.dir, "dangling-validator");
  symlinkSync(target, validator);

  assert.equal(
    lstatSync(validator).isSymbolicLink(),
    true,
    "fixture must configure a real symlink",
  );
  assert.equal(
    existsSync(validator),
    false,
    "fixture symlink target must remain absent",
  );

  const result = await prepare(c, {
    SUPERPOWERS_VALIDATOR_EXECUTABLE: validator,
  });
  const disclosure =
    `[superpowers-manager: running external validator ${validator} ` +
    "(a symlink whose target could not be resolved)]";

  assert.equal(result.status, 1);
  assert.ok(
    result.stdout.split("\n").includes(disclosure),
    "stdout must contain the exact dangling-symlink disclosure",
  );
  assert.equal(
    result.stderr,
    `error: external plugin validator not found: ${validator}\n`,
  );
  assert.equal(
    result.stdout.includes(
      `[superpowers-manager: running external validator ${validator} (unresolved)]`,
    ),
    false,
    "dangling symlink must not degrade to the generic unresolved disclosure",
  );
});

void test("retired validator rejects both harness routes without external calls", async () => {
  for (const harness of ["codex", "pi"]) {
    for (const command of ["prepare", "install", "update"] as const) {
      for (const configureReplacement of [false, true]) {
        const c = lifecycleCase();
        const log = join(c.dir, "must-not-run.log");
        const tripwire = writeValidator(
          c,
          "must-not-run.sh",
          'printf reached >> "$SPW_NO_CALL_LOG"\nexit 99',
        );
        writeFileSync(join(c.dir, "git"), readFileSync(tripwire), {
          mode: 0o755,
        });
        const before = snapshotTree(c.state);
        const result = await runScript(c, command, {
          args: ["--harness", harness],
          path: c.dir,
          env: {
            SUPERPOWERS_VALIDATOR: "/retired",
            SUPERPOWERS_VALIDATOR_EXECUTABLE: configureReplacement
              ? tripwire
              : "",
            SUPERPOWERS_CODEX: tripwire,
            SUPERPOWERS_PI: tripwire,
            SPW_NO_CALL_LOG: log,
          },
        });
        assert.equal(result.status, 1);
        assert.match(result.stderr, /SUPERPOWERS_VALIDATOR has been removed/);
        assert.equal(existsSync(log), false);
        assert.deepEqual(snapshotTree(c.state), before);
      }
    }
  }
});

void test("install runs the executable validator and rejects on its nonzero exit", async () => {
  const c = lifecycleCase();
  const validator = writeValidator(
    c,
    "install-reject.sh",
    "echo no >&2; exit 1",
  );
  const result = await runScript(c, "install", {
    env: { SUPERPOWERS_VALIDATOR_EXECUTABLE: validator },
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /external plugin validation failed/);
  assert.match(result.stdout, /running external validator/);
});

void test("update runs the executable validator and rejects on its nonzero exit", async () => {
  const c = lifecycleCase();
  const validator = writeValidator(
    c,
    "update-reject.sh",
    "echo no >&2; exit 1",
  );
  const result = await runScript(c, "update", {
    env: { SUPERPOWERS_VALIDATOR_EXECUTABLE: validator },
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /external plugin validation failed/);
  assert.match(result.stdout, /running external validator/);
});

void test("install runs the executable validator and reaches Codex on a passing exit", async () => {
  // R2: a positive control for the "existsSync(c.codexLog) === false"
  // assertions elsewhere in this suite. Those are falsifiable on their own,
  // but nothing else in this file shows a reader that c.codexLog is ever
  // actually created -- this case lets the executable validator PASS, so
  // install proceeds past prepare+validate into Codex contact, and the log
  // must exist by the time it returns.
  const c = lifecycleCase();
  const validator = writeValidator(c, "install-accept.sh", "exit 0");
  const result = await runScript(c, "install", {
    env: { SUPERPOWERS_VALIDATOR_EXECUTABLE: validator },
  });
  assert.equal(result.status, 0);
  assert.ok(existsSync(c.codexLog), "Codex was never contacted");
});
