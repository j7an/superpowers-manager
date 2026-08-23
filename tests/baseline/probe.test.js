#!/usr/bin/env node
// @ts-check
// End-to-end driver for the in-process `probe` command, ported from
// tests/test_probe.sh (see tests/migration-inventory/probe.md).
//
// It calls `runProbe` directly rather than spawning `node dist/cli.js probe`:
// driving the function is what lets these cases assert exact stream contents
// instead of parsing a subprocess. It was also the only option when this
// driver landed, one task before the flip, while src/cli.ts's DISPATCH still
// routed `probe` to the shell script.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join, relative } from "node:path";
import test from "node:test";
import { createCase, UPSTREAM } from "../bin/lifecycle-fixture.js";
import {
  caseEnv,
  DESIRED,
  probe,
  probeSaved,
  REQUIRED_ENV,
  seedCodex,
  seedGenerated,
  SHORT,
} from "./probe-fixture.js";

/** @type {typeof import("../../src/commands/probe.js")} */
const { PROBE_PORCELAIN_KEYS } = await import(
  new URL("../../dist/commands/probe.js", import.meta.url).href
);

/** @type {typeof import("../../src/selection-store.js")} */
const { writeSelectionState } = await import(
  new URL("../../dist/selection-store.js", import.meta.url).href
);

/** @typedef {import("../bin/lifecycle-fixture.js").CaseEnv} CaseEnv */

// One listing shape reused wherever a case needs the manager plugin ACTIVE at
// the manifest version seedCodex writes, so `installed_commit` resolves to the
// manifest's short SHA.
const ACTIVE_VERSION = `0.0.0+manager.${SHORT}`;
const ACTIVE = `{"installed":[{"pluginId":"superpowers@superpowers-manager","version":"${ACTIVE_VERSION}"}]}`;
const EMPTY_PLUGINS = '{"installed":[]}';

/**
 * Sorted `path\tkind\tdigest` lines for everything under `root`. Deliberately
 * smaller than cli-parity.test.js:267's mode- and symlink-aware snapshot:
 * probe is never a mutator, so all this has to catch is a file appearing,
 * vanishing, or changing.
 * @param {string} root
 * @returns {string[]}
 */
function snapshotTree(root) {
  if (!existsSync(root)) return [];
  return readdirSync(root, { recursive: true, withFileTypes: true })
    .map((entry) => {
      const path = join(entry.parentPath, entry.name);
      const name = relative(root, path);
      if (!entry.isFile()) return `${name}\t${entry.isDirectory() ? "d" : "?"}`;
      return `${name}\tf\t${createHash("sha256").update(readFileSync(path)).digest("hex")}`;
    })
    .sort();
}

/**
 * The saved selection document a case reads back through
 * `computeEffectiveSelection`. Written with the production writer, so a
 * fixture that the reader would reject cannot be created here at all.
 * @param {CaseEnv} c
 * @param {import("../../src/selection.js").SelectionRecord} record
 */
async function saveSelection(c, record) {
  await writeSelectionState(
    join(c.home, ".config", "superpowers-manager", "selection.json"),
    record,
  );
}

/**
 * A per-case copy of the shared fixture upstream. `UPSTREAM` is built once
 * and shared across the whole run (tests/bin/lifecycle-fixture.js's
 * `buildUpstream`), so a case that renames its source away must rename a
 * copy — renaming the original would break every concurrently running case.
 * @param {CaseEnv} c
 * @returns {string}
 */
function copyUpstream(c) {
  const copy = join(c.dir, "upstream-copy");
  cpSync(UPSTREAM, copy, { recursive: true });
  return copy;
}

void test("the case environment pins every name runProbe's dependencies read", () => {
  const c = createCase({ fakes: "probe" });
  const env = caseEnv(c);
  for (const name of REQUIRED_ENV) {
    assert.equal(
      typeof env[name] === "string" &&
        /** @type {string} */ (env[name]).length > 0,
      true,
      `caseEnv must set ${name}: runAdapter and runGit both inherit process.env`,
    );
  }
});

void test("malformed installed metadata falls back to the manifest short SHA", async () => {
  const c = createCase({ fakes: "probe" });
  seedGenerated(c, `{"commit":"${DESIRED}"}`);
  seedCodex(c, {
    // Two listings, one per invocation. The FIRST answers
    // `inspect --view fingerprint` and carries the active manager version, so
    // installed_commit resolves. The SECOND answers `inspect --view ownership`
    // and is empty, so identity_state is `neither`. One shared listing could
    // not produce both -- see seedCodex's note and adjudication finding 3.
    pluginListings: [ACTIVE, EMPTY_PLUGINS],
    manifestVersion: ACTIVE_VERSION,
    installedProvenance: "{",
  });
  const result = await probe(c, ["--porcelain"]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, "");
  assert.match(result.stdout, new RegExp(`^desired_commit=${DESIRED}$`, "m"));
  assert.match(result.stdout, new RegExp(`^generated_commit=${DESIRED}$`, "m"));
  assert.match(result.stdout, new RegExp(`^installed_commit=${SHORT}$`, "m"));
  assert.match(result.stdout, /^identity_state=neither$/m);
  assert.match(result.stdout, /^status=current$/m);
  assert.match(result.stdout, /^update_control=managed$/m);
  assert.match(result.stdout, /^selection_origin=environment$/m);
  assert.match(result.stdout, /^selection_mode=override$/m);
  assert.match(result.stdout, /^upstream_source_origin=environment$/m);
  assert.equal(
    result.stdout.includes(`effective_source=${UPSTREAM}\n`),
    true,
    result.stdout,
  );
  assert.match(result.stdout, /^saved_mode=none$/m);
  // src/commands/probe.ts:336-337: an absent saved source stays empty rather
  // than going through displaySource, which renders "" as <redacted-source>
  // (src/selection.ts:69-79 rejects the empty string).
  assert.match(result.stdout, /^saved_source=$/m);
  assert.match(result.stdout, /^saved_requested_ref=$/m);
  assert.match(result.stdout, /^saved_resolved_ref=$/m);
  assert.match(result.stdout, /^saved_commit=$/m);
  // Ported from tests/test_probe.sh:411-413: the whole key list, in order.
  assert.deepEqual(
    result.stdout
      .split("\n")
      .slice(0, -1)
      .map((line) => line.slice(0, line.indexOf("="))),
    [...PROBE_PORCELAIN_KEYS],
  );
});

void test("a saved exact pin stays authoritative after its source disappears", async () => {
  const c = createCase({ fakes: "probe" });
  const source = copyUpstream(c);
  // A TAG pin, not the shell's all-three-equal raw-commit pin: it makes
  // requested_ref/resolved_ref ("v1.0.0") textually different from
  // desired_commit and saved_commit (the 40-hex SHA), so a swapped field in
  // the EffectiveSelection -> ProbeFacts mapping (`gatherProbe`)
  // cannot pass. The schema forbids requested_ref and resolved_ref differing
  // for a tag pin (src/selection.ts:173-176), so those two are the one pair no
  // valid fixture can tell apart.
  await saveSelection(c, {
    schema_version: 1,
    mode: "pinned",
    source,
    requested_ref: "v1.0.0",
    resolved_ref: "v1.0.0",
    commit: DESIRED,
  });
  seedGenerated(c, `{"commit":"${DESIRED}"}`);
  seedCodex(c, {
    pluginListings: [ACTIVE, EMPTY_PLUGINS],
    manifestVersion: ACTIVE_VERSION,
  });
  // A saved pin short-circuits resolveRef (src/effective-selection.ts:117-131),
  // so an unreachable source is the proof that Git was never consulted: any
  // ls-remote against this path would fail once it is renamed away.
  renameSync(source, `${source}-offline`);
  try {
    const result = await probeSaved(c, ["--porcelain"]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, "");
    assert.match(result.stdout, /^requested_ref=v1\.0\.0$/m);
    assert.match(result.stdout, /^resolved_ref=v1\.0\.0$/m);
    assert.match(result.stdout, new RegExp(`^desired_commit=${DESIRED}$`, "m"));
    assert.match(result.stdout, new RegExp(`^installed_commit=${SHORT}$`, "m"));
    assert.match(result.stdout, /^status=current$/m);
    assert.match(result.stdout, /^selection_origin=user-config$/m);
    assert.match(result.stdout, /^selection_mode=pinned$/m);
    assert.match(result.stdout, /^upstream_source_origin=user-config$/m);
    assert.equal(result.stdout.includes(`effective_source=${source}\n`), true);
    assert.match(result.stdout, /^saved_mode=pinned$/m);
    assert.equal(result.stdout.includes(`saved_source=${source}\n`), true);
    assert.match(result.stdout, /^saved_requested_ref=v1\.0\.0$/m);
    assert.match(result.stdout, /^saved_resolved_ref=v1\.0\.0$/m);
    assert.match(result.stdout, new RegExp(`^saved_commit=${DESIRED}$`, "m"));
  } finally {
    renameSync(`${source}-offline`, source);
  }
});

void test("an environment ref overrides only the ref side and the saved fields stay visible", async () => {
  const c = createCase({ fakes: "probe" });
  const source = copyUpstream(c);
  await saveSelection(c, {
    schema_version: 1,
    mode: "pinned",
    source,
    requested_ref: "v1.0.0",
    resolved_ref: "v1.0.0",
    commit: DESIRED,
  });
  seedGenerated(c, `{"commit":"${DESIRED}"}`);
  // FOUR listings: this case runs probe twice (porcelain, then human) and each
  // run issues `plugin list --json` twice. The on-disk counter in
  // tests/bin/lifecycle-fakes.js is per case, not per run.
  seedCodex(c, {
    pluginListings: [ACTIVE, EMPTY_PLUGINS, ACTIVE, EMPTY_PLUGINS],
    manifestVersion: ACTIVE_VERSION,
  });
  // Renamed away for both runs, exactly as tests/test_probe.sh:434-477 leaves
  // it: a 40-hex SUPERPOWERS_REF resolves as `raw-commit` without Git
  // (src/upstream.ts:160-162), so an unreachable source is what proves the
  // shell's `test ! -s "$git_log"` (:460) still holds here.
  renameSync(source, `${source}-offline`);
  try {
    const porcelain = await probeSaved(c, ["--porcelain"], {
      SUPERPOWERS_REF: DESIRED,
    });
    assert.equal(porcelain.status, 0, porcelain.stderr);
    assert.equal(porcelain.stderr, "");
    assert.match(porcelain.stdout, /^selection_origin=environment$/m);
    assert.match(porcelain.stdout, /^selection_mode=override$/m);
    assert.match(porcelain.stdout, /^upstream_source_origin=user-config$/m);
    assert.match(porcelain.stdout, /^saved_mode=pinned$/m);
    assert.match(
      porcelain.stdout,
      new RegExp(`^saved_commit=${DESIRED}$`, "m"),
    );

    const human = await probeSaved(c, [], { SUPERPOWERS_REF: DESIRED });
    assert.equal(human.status, 0, human.stderr);
    assert.equal(human.stderr, "");
    for (const line of [
      "selection origin: environment",
      "selection mode: override",
      "upstream source origin: user-config",
      `effective source: ${source}`,
      "saved mode: pinned",
      `saved source: ${source}`,
      "saved requested ref: v1.0.0",
      "saved resolved ref: v1.0.0",
      `saved commit: ${DESIRED}`,
      "update control: managed",
      "warning: effective ref and source have mixed origins (ref: environment, source: user-config)",
    ]) {
      assert.equal(
        human.stdout.includes(`${line}\n`),
        true,
        `human output is missing ${JSON.stringify(line)}:\n${human.stdout}`,
      );
    }
  } finally {
    renameSync(`${source}-offline`, source);
  }
});

void test("a dash-prefixed local source saved by track-latest stays usable", async () => {
  const c = createCase({ fakes: "probe" });
  const source = join(c.dir, "-upstream");
  symlinkSync(UPSTREAM, source);
  await saveSelection(c, {
    schema_version: 1,
    mode: "track-latest",
    source,
  });
  seedGenerated(c, `{"commit":"${DESIRED}"}`);
  seedCodex(c, {
    pluginListings: [ACTIVE, EMPTY_PLUGINS],
    manifestVersion: ACTIVE_VERSION,
  });
  const result = await probeSaved(c, ["--porcelain"]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, "");
  assert.match(result.stdout, /^selection_mode=track-latest$/m);
  assert.match(result.stdout, /^selection_origin=user-config$/m);
  assert.equal(result.stdout.includes(`effective_source=${source}\n`), true);
  assert.equal(result.stdout.includes(`saved_source=${source}\n`), true);
  // track-latest is the one saved mode that still resolves through Git, and
  // it resolved: requested_ref, resolved_ref, and desired_commit are three
  // different values here, which is what makes the `requestedRef`,
  // `resolvedRef`, and `desiredCommit` entries of the EffectiveSelection ->
  // ProbeFacts mapping (`gatherProbe`'s `facts` object) discriminating.
  assert.match(result.stdout, /^requested_ref=latest-release$/m);
  assert.match(result.stdout, /^resolved_ref=v1\.0\.0$/m);
  assert.match(result.stdout, new RegExp(`^desired_commit=${DESIRED}$`, "m"));
  assert.match(result.stdout, /^saved_mode=track-latest$/m);
  assert.match(result.stdout, /^saved_requested_ref=$/m);
  assert.match(result.stdout, /^saved_resolved_ref=$/m);
  assert.match(result.stdout, /^saved_commit=$/m);
  assert.match(result.stdout, /^status=current$/m);
});

void test("probe reports every validated identity state without mutating anything", async () => {
  const MANAGER_PLUGIN =
    '{"installed":[{"pluginId":"superpowers@superpowers-manager"}]}';
  const LEGACY_PLUGIN =
    '{"installed":[{"pluginId":"superpowers@superpowers-wrapper"}]}';
  const BOTH_PLUGINS =
    '{"installed":[{"pluginId":"superpowers@superpowers-manager"},{"pluginId":"superpowers@superpowers-wrapper"}]}';
  for (const { ownership, marketplaces, expected } of [
    {
      ownership: MANAGER_PLUGIN,
      marketplaces: '{"marketplaces":[{"name":"superpowers-manager"}]}',
      expected: "manager",
    },
    {
      ownership: LEGACY_PLUGIN,
      marketplaces: '{"marketplaces":[{"name":"superpowers-wrapper"}]}',
      expected: "legacy",
    },
    {
      ownership: BOTH_PLUGINS,
      marketplaces:
        '{"marketplaces":[{"name":"superpowers-manager"},{"name":"superpowers-wrapper"}]}',
      expected: "both",
    },
    {
      ownership: EMPTY_PLUGINS,
      marketplaces: '{"marketplaces":[]}',
      expected: "neither",
    },
  ]) {
    const c = createCase({ fakes: "probe" });
    seedGenerated(c, `{"commit":"${DESIRED}"}`);
    // The fingerprint listing stays the ACTIVE manager version in all four so
    // installed_commit resolves and status can be `current` even for the
    // `legacy` and `neither` rows -- impossible with one shared listing
    // (adjudication finding 3).
    seedCodex(c, {
      pluginListings: [ACTIVE, ownership],
      marketplaces,
      manifestVersion: ACTIVE_VERSION,
    });
    const pkgBefore = snapshotTree(c.pkg);
    const codexBefore = snapshotTree(join(c.home, ".codex"));
    const result = await probe(c, ["--porcelain"]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, "");
    assert.match(
      result.stdout,
      new RegExp(`^identity_state=${expected}$`, "m"),
    );
    assert.match(result.stdout, /^status=current$/m);
    assert.deepEqual(snapshotTree(c.pkg), pkgBefore, expected);
    assert.deepEqual(
      snapshotTree(join(c.home, ".codex")),
      codexBefore,
      expected,
    );
  }
});

void test("semantically invalid installed provenance falls through to the manifest", async () => {
  const c = createCase({ fakes: "probe" });
  seedGenerated(c, `{"commit":"${DESIRED}"}`);
  seedCodex(c, {
    pluginListings: [ACTIVE, EMPTY_PLUGINS],
    manifestVersion: ACTIVE_VERSION,
    installedProvenance: '{"commit":"not-a-fingerprint"}',
  });
  const result = await probe(c, ["--porcelain"]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, "");
  assert.match(result.stdout, new RegExp(`^installed_commit=${SHORT}$`, "m"));
  assert.match(result.stdout, /^status=current$/m);
});

void test("no active plugin yields a null fingerprint and needs install", async () => {
  const c = createCase({ fakes: "probe" });
  seedGenerated(c, `{"commit":"${DESIRED}"}`);
  seedCodex(c, {
    pluginListings: [EMPTY_PLUGINS, EMPTY_PLUGINS],
    manifestVersion: ACTIVE_VERSION,
    installedProvenance: '{"commit":"not-a-fingerprint"}',
  });
  // The manifest is malformed as well, matching tests/test_probe.sh:588. With
  // no active plugin the adapter never reaches it, so this only pins that a
  // second unusable input does not change the outcome.
  writeFileSync(
    join(
      c.home,
      ".codex",
      "plugins",
      "cache",
      "superpowers-manager",
      "superpowers",
      ACTIVE_VERSION,
      ".codex-plugin",
      "plugin.json",
    ),
    "{",
    "utf8",
  );
  const result = await probe(c, ["--porcelain"]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, "");
  assert.match(result.stdout, /^installed_commit=$/m);
  assert.match(result.stdout, /^status=needs install$/m);
});

void test("an absent installed manifest also yields a null fingerprint", async () => {
  const c = createCase({ fakes: "probe" });
  seedGenerated(c, `{"commit":"${DESIRED}"}`);
  seedCodex(c, {
    pluginListings: [EMPTY_PLUGINS, EMPTY_PLUGINS],
    manifestVersion: null,
  });
  const result = await probe(c, ["--porcelain"]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, "");
  assert.match(result.stdout, /^installed_commit=$/m);
  assert.match(result.stdout, /^status=needs install$/m);
});

void test("stale generated provenance outranks a null installed fingerprint", async () => {
  const c = createCase({ fakes: "probe" });
  seedGenerated(c, `{"commit":"${"0".repeat(40)}"}`);
  seedCodex(c, { pluginListings: [EMPTY_PLUGINS, EMPTY_PLUGINS] });
  const result = await probe(c, ["--porcelain"]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, "");
  assert.match(
    result.stdout,
    new RegExp(`^generated_commit=${"0".repeat(40)}$`, "m"),
  );
  assert.match(result.stdout, /^installed_commit=$/m);
  assert.match(result.stdout, /^status=needs prepare$/m);
});

void test("malformed generated provenance reads as absent rather than aborting", async () => {
  const c = createCase({ fakes: "probe" });
  seedGenerated(c, "{");
  seedCodex(c, { pluginListings: [EMPTY_PLUGINS, EMPTY_PLUGINS] });
  const result = await probe(c, ["--porcelain"]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, "");
  assert.match(result.stdout, new RegExp(`^desired_commit=${DESIRED}$`, "m"));
  assert.match(result.stdout, /^generated_commit=$/m);
  assert.match(result.stdout, /^installed_commit=$/m);
  assert.match(result.stdout, /^identity_state=neither$/m);
  assert.match(result.stdout, /^status=needs prepare$/m);
});

void test("PROBE-FAIL-CLOSED-01 invalid selection and adapter evidence fail closed", async () => {
  // Clause 1: invalid selection or source is an operational failure.
  // Clause 3: that validation precedes both Git and adapter access.
  //
  // Ordering is proved by WHICH diagnostic wins, not by a recording git.
  // The credential case points SUPERPOWERS_UPSTREAM_URL at a source that would
  // fail loudly if resolveRef were reached -- `v1.0.0` is not a commit, so
  // reaching resolveRef means an ls-remote against an unreachable host and a
  // different diagnostic. This is the same technique
  // tests/unit/effective-selection.test.js:145-167 uses.
  for (const { name, seed, env, expected } of [
    {
      name: "malformed selection.json",
      seed: "{",
      env: {},
      expected: /invalid JSON/,
    },
    {
      name: "unsupported schema_version",
      seed: '{"schema_version":2,"mode":"track-latest","source":"https://example.invalid/repo"}',
      env: {},
      expected: /schema_version must equal integer 1/,
    },
    {
      name: "credential-bearing source",
      seed: null,
      env: {
        SUPERPOWERS_REF: "v1.0.0",
        SUPERPOWERS_UPSTREAM_URL: "https://token@example.invalid/repo",
      },
      expected: /HTTP\(S\) source must not include userinfo/,
    },
  ]) {
    const c = createCase({ fakes: "probe" });
    const configDir = join(c.home, ".config", "superpowers-manager");
    mkdirSync(configDir, { recursive: true });
    if (seed !== null) {
      writeFileSync(join(configDir, "selection.json"), seed, "utf8");
    }
    const result = await probeSaved(c, [], env);
    assert.equal(result.status, 1, name);
    assert.equal(result.stdout, "", `${name}: nothing may reach stdout`);
    assert.match(result.stderr, expected, name);
    // Clause 3, adapter half: the fake codex logs every invocation, so an
    // absent log proves probe never reached adapter inspection.
    assert.equal(
      existsSync(c.codexLog),
      false,
      `${name}: selection validation must precede adapter access`,
    );
  }

  // Clause 2: malformed required adapter evidence is an operational failure,
  // never reported as absent. A fake codex emitting unparseable JSON drives
  // runInspect's real inspect-failed path (src/adapter.ts:812-816).
  const c = createCase({ fakes: "probe" });
  // Sequenced: the fingerprint inspection consumes invocation 0. Only one is
  // needed here because that first inspection already fails.
  writeFileSync(join(c.state, "plugin_list.0.json"), "{ not json", "utf8");
  writeFileSync(join(c.state, "marketplace_list.json"), "{}", "utf8");
  const result = await probe(c, []);
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "", "no partial report may reach stdout");
  assert.match(result.stderr, /cannot parse output of/);
});

// Amended after Task 5's own verification. Exit criterion 8's rethrow branch
// (src/adapter.ts:1009) is NOT reachable through `inspect`: `requireCodex`
// converts a non-executable SUPERPOWERS_CODEX into a controlled
// `command-not-found` AdapterFailure (src/adapter.ts:244-251, :267-274), and
// every other failure inside the fingerprint view is either wrapped by
// `runCodexCommand` (:206-211) or converted by a `fail()` call. What this case
// therefore pins is the property the rethrow diagnostic exists to protect:
// whatever the launch failure was, no errno text, path prose from the OS, or
// stack reaches the terminal these commands write to.
void test("an unusable Codex command fails closed without leaking errno prose", async () => {
  const c = createCase({ fakes: "probe" });
  seedGenerated(c, `{"commit":"${DESIRED}"}`);
  const dud = join(c.tmp, "not-executable");
  writeFileSync(dud, "#!/bin/sh\n", { mode: 0o644 });
  const result = await probe(c, ["--porcelain"], { SUPERPOWERS_CODEX: dud });
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.equal(
    result.stderr,
    `error: required Codex command not found: ${dud}\n`,
  );
  // The whole point of the hand-written form: no errno prose and no stack from
  // an error src/adapter.ts declined to own.
  assert.equal(/EACCES|denied|spawn|\bat \//i.test(result.stderr), false);
  assert.equal(
    existsSync(c.codexLog),
    false,
    "an unusable Codex command must never be executed",
  );
});

// Two things at once, because one fixture proves both. First: runProbe really
// calls replayOutcome on a real adapter response, so the adapter's own logged
// messages reach stderr BEFORE its error line, exactly as
// scripts/core/validate-adapter-response.py:268-270 ordered them
// (tests/unit/commands-probe.test.js proves replayOutcome only in isolation).
// Second: nextPluginList (tests/bin/lifecycle-fakes.js:148-170) FAILS CLOSED
// when the configured sequence runs out instead of repeating its last entry --
// if it repeated, the ownership inspection would succeed and this run would
// exit 0.
//
// `pluginListRc: 1` cannot prove the ordering: listingCommand logs only the
// child's stderr (src/adapter.ts:233-242), and the fake writes nothing there
// on that path, so the outcome carries no messages at all and the error line
// lands at index 0. The exhausted sequence is the failure that does write to
// the child's stderr. Recorded in tests/migration-inventory/probe.md.
void test("adapter messages precede the error line on a controlled failure", async () => {
  const c = createCase({ fakes: "probe" });
  seedGenerated(c, `{"commit":"${DESIRED}"}`);
  // ONE listing for TWO invocations: the fingerprint inspection consumes it,
  // and the ownership inspection then asks for an invocation that is not
  // configured.
  seedCodex(c, { pluginListings: [ACTIVE], manifestVersion: ACTIVE_VERSION });
  const result = await probe(c, ["--porcelain"]);
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.match(
    result.stderr,
    /^fake codex: no plugin listing configured for invocation 1$/m,
  );
  assert.match(result.stderr, /^error: cannot list Codex plugins via /m);
  const errorIndex = result.stderr.indexOf("error: ");
  assert.equal(
    errorIndex > 0,
    true,
    `replayed messages must precede the error line:\n${result.stderr}`,
  );
});
