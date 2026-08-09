// @ts-check
// Port of tests/test_uninstall_commands.sh (457 lines, deleted in this commit).
// Reconciliation: tests/migration-inventory/uninstall-commands.md
//
// Cases run concurrently. Every case builds its own package root, state
// directory, logs, and TMPDIR, so none depends on another's cleanup.

// Two statements, not one. tests/bin/migration-inventory.test.js:23 matches
// /^import test from "node:test";$/m and asserts it at :331-334, because the
// static call-site counter recognises exactly one binding form and fails closed
// rather than miscount. Both `import { describe, test } from "node:test";` and
// `import test, { describe } from "node:test";` FAIL that regex — verified.
import test from "node:test";
import { describe } from "node:test";
import assert from "node:assert/strict";
import {
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertOrder,
  createCase,
  firstIndex,
  lastIndex,
  readLog,
  runScript,
} from "./lifecycle-fixture.js";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));

// Fixture JSON, verbatim from tests/test_uninstall_commands.sh:101-108.
const PLUGIN_PRESENT =
  '{"installed":[{"pluginId":"superpowers@superpowers-manager","name":"superpowers","marketplaceName":"superpowers-manager"}],"available":[]}';
const PLUGIN_ABSENT = '{"installed":[],"available":[]}';
const MARKETPLACE_PRESENT =
  '{"marketplaces":[{"name":"openai-curated","root":"/x"},{"name":"superpowers-manager","root":"/y"}]}';
const MARKETPLACE_ABSENT =
  '{"marketplaces":[{"name":"openai-curated","root":"/x"}]}';
const LEGACY_PLUGIN_PRESENT =
  '{"installed":[{"pluginId":"superpowers@superpowers-wrapper","name":"superpowers","marketplaceName":"superpowers-wrapper"}],"available":[]}';
const LEGACY_MARKETPLACE_PRESENT =
  '{"marketplaces":[{"name":"superpowers-wrapper","root":"/legacy"}]}';
const BOTH_PLUGINS_PRESENT =
  '{"installed":[{"pluginId":"superpowers@superpowers-manager","name":"superpowers","marketplaceName":"superpowers-manager"},{"pluginId":"superpowers@superpowers-wrapper","name":"superpowers","marketplaceName":"superpowers-wrapper"}],"available":[]}';
const BOTH_MARKETPLACES_PRESENT =
  '{"marketplaces":[{"name":"superpowers-manager","root":"/manager"},{"name":"superpowers-wrapper","root":"/legacy"}]}';

// Verbatim from tests/test_uninstall_commands.sh:176. `git` is deliberately
// absent; `python3` and `node` are appended separately below, exactly as the
// shell did at :180-181.
const NO_GIT_TOOLS = [
  "awk",
  "cat",
  "cut",
  "dirname",
  "find",
  "grep",
  "head",
  "mktemp",
  "mv",
  "pwd",
  "rm",
  "sed",
  "sh",
  "tail",
  "tr",
];

/**
 * Replaces the shell driver's `reset` + fixture seeding (:110-116). Each call
 * yields a fully independent case.
 * @param {object} [options]
 * @param {Record<string, unknown>} [options.config]
 * @param {"delegate" | "tripwire" | "intercept"} [options.adapterSeam]
 * @param {{ reason: "intercept" | "log", script: string }} [options.seamDependency]
 * @param {string} [options.plugins]
 * @param {string} [options.marketplaces]
 */
function uninstallCase(options = {}) {
  // Both seam options are forwarded, never defaulted here: createCase owns the
  // default mode and the eager validation, so a case that omits them still
  // gets checked against tests/bin/adapter-seam.js.
  const c = createCase({
    fakes: "uninstall",
    config: options.config ?? {},
    adapterSeam: options.adapterSeam,
    seamDependency: options.seamDependency,
  });
  writeFileSync(
    join(c.state, "plugin_list.json"),
    `${options.plugins ?? PLUGIN_PRESENT}\n`,
  );
  writeFileSync(
    join(c.state, "marketplace_list.json"),
    `${options.marketplaces ?? MARKETPLACE_PRESENT}\n`,
  );
  return c;
}

/**
 * `grep -Fq` over a log: substring match on any line.
 * @param {string[]} log
 * @param {string} needle
 * @returns {boolean}
 */
function has(log, needle) {
  return log.some((line) => line.includes(needle));
}

/**
 * `grep -Fxq` over captured output: exact whole-line match.
 * @param {string} text
 * @param {string} needle
 * @returns {boolean}
 */
function hasLine(text, needle) {
  return text.split("\n").includes(needle);
}

/**
 * Replaces `assert_no_removes` (:150-156).
 *
 * The emptiness guard is port-only. The shell's `$log` was a file the fake
 * always appended to before doing anything else, whereas `readLog` returns []
 * for a missing file — so a fixture that never launched the fake at all would
 * satisfy the negative assertion vacuously. Every call site runs a subject that
 * reaches `codex plugin list`, so an empty log here is a fixture fault.
 * @param {string[]} log
 */
function assertNoRemoves(log) {
  assert.ok(
    log.length > 0,
    "codex log is empty — the fake never ran, so 'no removes' would pass vacuously",
  );
  const offenders = log.filter((line) => line.includes("remove"));
  assert.deepEqual(offenders, [], "expected no remove commands");
}

/**
 * How many ownership inspections reached Codex.
 *
 * `inspect --view ownership` issues exactly one `codex plugin list --json` and
 * then one `codex plugin marketplace list --json` (src/adapter.ts:842-873).
 * Counting the plugin listing alone is unambiguous: `plugin marketplace list
 * --json` does not contain it as a substring, and nothing else scripts/uninstall
 * runs issues either listing.
 * @param {string[]} codex
 * @returns {number}
 */
function ownershipInspections(codex) {
  return codex.filter((line) => line === "plugin list --json").length;
}

/**
 * The six identical `if grep -Fq "uninstall --" "$adapter_log"` guards
 * (:321, :333, :345, :360, :372, :387), RE-ANCHORED onto codex.log.
 *
 * scripts/uninstall:23-29 brackets `spw_adapter_uninstall` between two
 * ownership inspections and, under `set -e`, reaches the second one only if the
 * adapter uninstall returned 0. So exactly one ownership inspection at the
 * Codex level means the flow never got past the first one. Paired with the
 * `assertNoRemoves(readLog(c.codexLog))` every call site already makes, that is
 * the original claim in full: an adapter uninstall carrying either flag `true`
 * would have issued a Codex remove, and one carrying both `false` would have
 * returned 0 and produced the second inspection.
 *
 * The emptiness guard is port-only, for the same reason as `assertNoRemoves`:
 * every call site reaches `codex plugin list --json` before aborting.
 * @param {string[]} codex
 * @param {string} message
 */
function assertNoAdapterUninstall(codex, message) {
  assert.ok(
    codex.length > 0,
    "codex log is empty — the fake never ran, so this negative would pass vacuously",
  );
  assert.equal(
    ownershipInspections(codex),
    1,
    `${message}:\n${codex.join("\n")}`,
  );
}

/**
 * The positive counterpart, and the Codex-level witness that the adapter
 * uninstall operation ran to completion: the verify-after ownership inspection
 * at scripts/uninstall:29 exists only on that path.
 *
 * This is what re-anchors the `uninstall --plugin-present … --marketplace-present
 * …` needles whose flags are both `false`, since that combination issues no
 * Codex command of its own (src/adapter.ts:686-745 — the two
 * skip branches at :724 and :741 only append stdout text). Which flags were set is
 * then pinned by which removes did or did not appear.
 * @param {string[]} codex
 * @param {string} message
 */
function assertAdapterUninstallRan(codex, message) {
  assert.equal(
    ownershipInspections(codex),
    2,
    `${message}:\n${codex.join("\n")}`,
  );
}

/**
 * Replaces `assert_uninstall_tmp_empty` (:134-140).
 * @param {import("./lifecycle-fixture.js").CaseEnv} caseEnv
 */
function assertTmpEmpty(caseEnv) {
  const leftovers = readdirSync(caseEnv.tmp, { recursive: true });
  assert.deepEqual(
    leftovers,
    [],
    "uninstall leaked its invocation workspace or adapter sidecars",
  );
}

/**
 * `command -v` for the no-git PATH (:177). Fixture precondition, not a claim
 * about the subject.
 * @param {string} tool
 * @returns {string}
 */
function resolveOnPath(tool) {
  const found = spawnSync("/bin/sh", ["-c", 'command -v "$1"', "sh", tool], {
    encoding: "utf8",
  });
  const resolved = found.stdout.trim();
  assert.ok(resolved !== "", `fixture: ${tool} is not on PATH`);
  return resolved;
}

/**
 * The shell resolved python3 through its own `sys.executable` realpath rather
 * than `command -v` (:174), because the PATH entry is often a shim.
 * @returns {string}
 */
function realPython3() {
  const found = spawnSync(
    "python3",
    ["-c", "import os, sys; print(os.path.realpath(sys.executable))"],
    { encoding: "utf8" },
  );
  assert.equal(
    found.status,
    0,
    "fixture: python3 is required to build the no-git PATH",
  );
  return found.stdout.trim();
}

// `void` for the same reason every `test(` call site carries it: oxlint's
// typescript(no-floating-promises) rule treats the runner's returned promise as
// floating otherwise.
void describe("uninstall commands", { concurrency: true }, () => {
  void test("source guards: no Codex ownership leaks into shared code (:9-16)", () => {
    // :9-12 — reads ROOT, not the copied package root: these are claims about
    // the repository's own source, not about a fixture snapshot.
    const uninstall = readFileSync(join(ROOT, "scripts", "uninstall"), "utf8");
    assert.ok(
      !uninstall.includes("scripts/adapters/codex/lib.sh"),
      "public uninstall must not source the Codex adapter library",
    );
    // :13-16
    const lifecycle = readFileSync(
      join(ROOT, "scripts", "core", "lifecycle.sh"),
      "utf8",
    );
    assert.ok(
      !/SPW_PLUGIN_ID|SPW_MARKETPLACE_NAME/.test(lifecycle),
      "shared lifecycle code must not reference Codex-owned identifiers",
    );
  });

  void test("selection-independent recovery: malformed selection, no git, unsupported update control (:162-190)", async () => {
    const c = uninstallCase({
      config: { updateControl: "unsupported" },
      adapterSeam: "intercept",
      // Seam-dependent on the interception AND on the log: :185-189 below reads
      // adapter.log for an update-control inspection, and that operation issues
      // no Codex command at all (src/adapter.ts:757-759), so its absence has no
      // Codex-level witness either.
      seamDependency: { reason: "intercept", script: "uninstall" },
    });
    // :168-170 — a malformed saved selection under the case-local
    // XDG_CONFIG_HOME the fixture already exports.
    const selectionDir = join(c.home, ".config", "superpowers-manager");
    mkdirSync(selectionDir, { recursive: true });
    writeFileSync(join(selectionDir, "selection.json"), "{\n");
    // :172-181 — a PATH holding the tools uninstall legitimately needs, and
    // deliberately not `git`.
    const noGit = join(c.dir, "no-git-path");
    mkdirSync(noGit, { recursive: true });
    for (const tool of NO_GIT_TOOLS) {
      symlinkSync(resolveOnPath(tool), join(noGit, tool));
    }
    symlinkSync(realPython3(), join(noGit, "python3"));
    symlinkSync(realpathSync(process.execPath), join(noGit, "node"));

    const result = await runScript(c, "uninstall", { path: noGit });
    assert.equal(result.status, 0, result.stdout + result.stderr);

    const codex = readLog(c.codexLog);
    const adapter = readLog(c.adapterLog);
    // :183-184
    assert.ok(has(codex, "plugin remove superpowers@superpowers-manager"));
    assert.ok(has(codex, "plugin marketplace remove superpowers-manager"));
    // :185-189 — non-vacuous because the two assertions above prove the
    // adapter ran (only the adapter issues those Codex calls).
    assert.ok(
      !has(adapter, "inspect --view update-control"),
      "uninstall must not inspect update control",
    );
    // :190
    assert.ok(result.stdout.includes("uninstall complete"), result.stdout);
  });

  void test("missing python3: clear requirement error, no Codex calls (:192-212)", async () => {
    const c = uninstallCase({});
    const stripped = join(c.dir, "no-python");
    mkdirSync(stripped, { recursive: true });
    symlinkSync("/usr/bin/dirname", join(stripped, "dirname"));
    // runScript launches /bin/sh by absolute path, so a PATH holding only
    // `dirname` still reaches the subject — the point of the case. A bare "sh"
    // resolved through this PATH would fail to launch instead.
    const result = await runScript(c, "uninstall", { path: stripped });
    // :198-202
    assert.notEqual(
      result.status,
      0,
      "expected uninstall to fail when python3 is missing",
    );
    // :203-207
    assert.match(
      result.stdout + result.stderr,
      /required command not found: python3/,
    );
    // :208-212
    assert.deepEqual(
      readLog(c.codexLog),
      [],
      "expected no Codex calls when python3 is missing",
    );
  });

  void test("missing Codex: controlled ownership-inspect failure (:214-232)", async () => {
    // Seam-dependent with no re-anchor available: the case removes Codex, so
    // codex.log is empty by construction and cannot witness anything. :226's
    // adapter-log read is the only evidence that the subject reached the
    // ownership inspection before failing.
    const c = uninstallCase({
      seamDependency: { reason: "log", script: "uninstall" },
    });
    const missingCodex = join(c.dir, "missing-codex");
    const result = await runScript(c, "uninstall", {
      env: { SUPERPOWERS_CODEX: missingCodex },
    });
    const out = result.stdout + result.stderr;
    // :220-225
    assert.notEqual(
      result.status,
      0,
      "expected uninstall to fail when Codex is missing",
    );
    // :226
    assert.ok(readLog(c.adapterLog).includes("inspect --view ownership"));
    // :227
    assert.ok(
      hasLine(out, `error: required Codex command not found: ${missingCodex}`),
      out,
    );
    // :228-232 — non-vacuous: the assertion above proves `out` carries the
    // adapter's diagnostics.
    assert.ok(
      !out.includes("error: invalid adapter response:"),
      "missing Codex must remain a controlled ownership-inspect failure",
    );
  });

  void test("legacy-only state is never mutated and leaves guidance (:234-242)", async () => {
    const c = uninstallCase({
      plugins: LEGACY_PLUGIN_PRESENT,
      marketplaces: LEGACY_MARKETPLACE_PRESENT,
    });
    const result = await runScript(c, "uninstall");
    assert.equal(result.status, 0, result.stdout + result.stderr);
    const codex = readLog(c.codexLog);
    // :239
    assertNoRemoves(codex);
    // :240, re-anchored onto codex.log: the verify-after ownership inspection
    // proves the adapter uninstall ran and returned 0, and :239 proves it
    // issued no remove — which is the both-false flag pair.
    assertAdapterUninstallRan(
      codex,
      "legacy-only state must still reach a completed adapter uninstall",
    );
    // :241-242
    assert.ok(
      hasLine(
        result.stdout,
        "Legacy superpowers-wrapper Codex state remains installed.",
      ),
      result.stdout,
    );
    // DELIBERATE version literal. `0.1.1` is not a dependency pin that moves on
    // someone else's schedule: it is user-facing guidance owned in-repo at
    // scripts/core/lifecycle.sh:52,77, naming the last superpowers-wrapper
    // release that can uninstall legacy state. The exact text is the contract,
    // so assert it exactly. Repeated verbatim in the mixed-state case below.
    assert.ok(
      hasLine(result.stdout, "Run: npx superpowers-wrapper@0.1.1 uninstall"),
      result.stdout,
    );
  });

  void test("mixed state removes manager resources only and reports legacy residue (:244-259)", async () => {
    const c = uninstallCase({
      plugins: BOTH_PLUGINS_PRESENT,
      marketplaces: BOTH_MARKETPLACES_PRESENT,
    });
    const result = await runScript(c, "uninstall");
    assert.equal(result.status, 0, result.stdout + result.stderr);

    const codex = readLog(c.codexLog);
    // :250-251
    assert.ok(has(codex, "plugin remove superpowers@superpowers-manager"));
    assert.ok(has(codex, "plugin marketplace remove superpowers-manager"));
    // :252-257 — one shell guard over two independent greps; non-vacuous
    // because the two assertions above prove removes reached the log.
    assert.ok(
      !has(codex, "superpowers@superpowers-wrapper"),
      "uninstall must not remove the legacy plugin",
    );
    assert.ok(
      !has(codex, "plugin marketplace remove superpowers-wrapper"),
      "uninstall must not remove the legacy marketplace",
    );
    // :258-259
    assert.ok(
      hasLine(
        result.stdout,
        "Legacy superpowers-wrapper Codex state remains installed.",
      ),
      result.stdout,
    );
    assert.ok(
      hasLine(result.stdout, "Run: npx superpowers-wrapper@0.1.1 uninstall"),
      result.stdout,
    );
  });

  void test("both present: both removed, plugin before marketplace (:261-289)", async () => {
    // Seam-dependent, and deliberately left reading adapter.log rather than
    // half-re-anchored. Most of this case's adapter claims do have Codex
    // footprints, but :288-289 does not: "adapter uninstall must receive
    // booleans, not provider names" is a claim about the adapter's OWN argv,
    // and Codex never sees it. Re-expressing it over codex.log would assert
    // something weaker (at best, that the run succeeded), so the case declares
    // instead and slice 4 re-bases the whole block at once.
    const c = uninstallCase({
      seamDependency: { reason: "log", script: "uninstall" },
    });
    const result = await runScript(c, "uninstall");
    assert.equal(result.status, 0, result.stdout + result.stderr);

    const adapter = readLog(c.adapterLog);
    const codex = readLog(c.codexLog);

    // :267
    assertTmpEmpty(c);
    // :268-269 presence
    assert.ok(adapter.includes("inspect --view ownership"));
    assert.ok(
      adapter.includes(
        "uninstall --plugin-present true --marketplace-present true",
      ),
    );
    // :270-271 exact counts
    assert.equal(
      adapter.filter((l) => l === "inspect --view ownership").length,
      2,
    );
    assert.equal(
      adapter.filter(
        (l) =>
          l === "uninstall --plugin-present true --marketplace-present true",
      ).length,
      1,
    );
    // :272-276 ownership inspect brackets the adapter uninstall. firstIndex and
    // lastIndex are distinct here on purpose — the shell used head -n1 then
    // tail -n1.
    const firstInspect = firstIndex(adapter, "inspect --view ownership");
    const uninstallAt = firstIndex(
      adapter,
      "uninstall --plugin-present true --marketplace-present true",
    );
    const lastInspect = lastIndex(adapter, "inspect --view ownership");
    assert.ok(
      firstInspect < uninstallAt,
      "ownership inspect must precede adapter uninstall",
    );
    assert.ok(
      uninstallAt < lastInspect,
      "ownership re-inspect must follow adapter uninstall",
    );
    // :277-281 both removes, in order
    assert.ok(has(codex, "plugin remove superpowers@superpowers-manager"));
    assert.ok(has(codex, "plugin marketplace remove superpowers-manager"));
    assertOrder(
      codex,
      [
        "plugin remove superpowers@superpowers-manager",
        "plugin marketplace remove superpowers-manager",
      ],
      "plugin remove must precede marketplace remove",
    );
    // :282-289 negatives
    assert.ok(
      !has(codex, "openai-curated"),
      "uninstall must never name openai-curated",
    );
    assert.ok(
      !has(adapter, "other@x"),
      "adapter uninstall must receive booleans, not provider names",
    );
  });

  void test("plugin absent, marketplace present: only the marketplace is removed (:291-302)", async () => {
    const c = uninstallCase({ plugins: PLUGIN_ABSENT });
    const result = await runScript(c, "uninstall");
    assert.equal(result.status, 0, result.stdout + result.stderr);

    const codex = readLog(c.codexLog);
    // :301 first, so the negative below cannot pass on an empty log.
    assert.ok(has(codex, "plugin marketplace remove superpowers-manager"));
    // :296-299
    assert.ok(
      !has(codex, "plugin remove superpowers@superpowers-manager"),
      "must not remove an absent plugin",
    );
    // :300, re-anchored onto codex.log. The flag pair's whole Codex footprint
    // is the marketplace remove asserted at :301 and the plugin remove ruled
    // out at :296-299; the verify-after inspection below adds that the adapter
    // uninstall ran to completion rather than aborting between them.
    assertAdapterUninstallRan(
      codex,
      "the adapter uninstall must complete when only the marketplace is present",
    );
    // :302
    assert.ok(result.stdout.includes("plugin not installed; skipping"));
  });

  void test("both absent: no removes, idempotent success, both skips reported (:304-312)", async () => {
    const c = uninstallCase({
      plugins: PLUGIN_ABSENT,
      marketplaces: MARKETPLACE_ABSENT,
    });
    const result = await runScript(c, "uninstall");
    assert.equal(result.status, 0, result.stdout + result.stderr);
    const codex = readLog(c.codexLog);
    // :309
    assertNoRemoves(codex);
    // :310, re-anchored onto codex.log for the same reason as the legacy-only
    // case: completed adapter uninstall plus no removes is the both-false pair.
    assertAdapterUninstallRan(
      codex,
      "an idempotent uninstall must still reach a completed adapter uninstall",
    );
    // :311-312
    assert.ok(result.stdout.includes("plugin not installed; skipping"));
    assert.ok(result.stdout.includes("marketplace not registered; skipping"));
  });

  void test("plugin list query fails: abort, no removes (:314-326)", async () => {
    const c = uninstallCase({ config: { pluginListRc: 1 } });
    const result = await runScript(c, "uninstall");
    // :319
    assert.notEqual(
      result.status,
      0,
      "expected uninstall to fail but it succeeded",
    );
    // :320
    assertTmpEmpty(c);
    // :321-325
    assertNoAdapterUninstall(
      readLog(c.codexLog),
      "adapter uninstall must not run when ownership inspection fails",
    );
    // :326
    assertNoRemoves(readLog(c.codexLog));
  });

  void test("malformed plugin list JSON: abort, no removes (:328-338)", async () => {
    const c = uninstallCase({ plugins: "not json {{{" });
    const result = await runScript(c, "uninstall");
    // :332
    assert.notEqual(
      result.status,
      0,
      "expected uninstall to fail but it succeeded",
    );
    // :333-337
    assertNoAdapterUninstall(
      readLog(c.codexLog),
      "adapter uninstall must not run on malformed ownership inspection",
    );
    // :338
    assertNoRemoves(readLog(c.codexLog));
  });

  void test("malformed individual plugin entry: abort, no removes (:340-351)", async () => {
    const c = uninstallCase({ plugins: '{"installed":[{}],"available":[]}' });
    const result = await runScript(c, "uninstall");
    // :344
    assert.notEqual(
      result.status,
      0,
      "expected uninstall to fail but it succeeded",
    );
    // :345-349
    assertNoAdapterUninstall(
      readLog(c.codexLog),
      "adapter uninstall must not run on malformed individual plugin entries",
    );
    // :350
    assertNoRemoves(readLog(c.codexLog));
    // :351
    assert.ok(
      (result.stdout + result.stderr).includes("cannot parse output of"),
      result.stdout + result.stderr,
    );
  });

  void test("marketplace list fails while the plugin is present: abort before ANY remove (:353-365)", async () => {
    const c = uninstallCase({ config: { marketplaceListRc: 1 } });
    const result = await runScript(c, "uninstall");
    // :359
    assert.notEqual(
      result.status,
      0,
      "expected uninstall to fail but it succeeded",
    );
    // :360-364
    assertNoAdapterUninstall(
      readLog(c.codexLog),
      "adapter uninstall must not run when marketplace ownership inspection fails",
    );
    // :365
    assertNoRemoves(readLog(c.codexLog));
  });

  void test("malformed individual marketplace entry: abort, no removes (:367-378)", async () => {
    const c = uninstallCase({ marketplaces: '{"marketplaces":[{}]}' });
    const result = await runScript(c, "uninstall");
    // :371
    assert.notEqual(
      result.status,
      0,
      "expected uninstall to fail but it succeeded",
    );
    // :372-376
    assertNoAdapterUninstall(
      readLog(c.codexLog),
      "adapter uninstall must not run on malformed individual marketplace entries",
    );
    // :377
    assertNoRemoves(readLog(c.codexLog));
    // :378
    assert.ok(
      (result.stdout + result.stderr).includes("cannot parse output of"),
      result.stdout + result.stderr,
    );
  });

  void test("malformed marketplace list while the plugin is present: abort before ANY remove (:380-392)", async () => {
    const c = uninstallCase({ marketplaces: "not json {{{" });
    const result = await runScript(c, "uninstall");
    // :386
    assert.notEqual(
      result.status,
      0,
      "expected uninstall to fail but it succeeded",
    );
    // :387-391
    assertNoAdapterUninstall(
      readLog(c.codexLog),
      "adapter uninstall must not run on malformed marketplace ownership inspection",
    );
    // :392
    assertNoRemoves(readLog(c.codexLog));
  });

  void test("remove is a no-op: verify-after detects the still-present target (:394-410)", async () => {
    // `removesMutateState: false` is the port of `: > "$state/remove_noop"`
    // (:399), which the shell fake gated BOTH removes on (:44, :68).
    const c = uninstallCase({ config: { removesMutateState: false } });
    const result = await runScript(c, "uninstall");
    const out = result.stdout + result.stderr;
    // :400
    assert.notEqual(
      result.status,
      0,
      "expected uninstall to fail but it succeeded",
    );
    const codex = readLog(c.codexLog);
    // :401, re-anchored onto codex.log: the true/true flag pair's whole Codex
    // footprint is the two removes, asserted at :408 below and here.
    assert.ok(
      has(codex, "plugin marketplace remove superpowers-manager"),
      codex.join("\n"),
    );
    // :402-406, re-anchored: one ownership inspection is one Codex plugin
    // listing, so the verify-after re-inspection is the second of them.
    assertAdapterUninstallRan(
      codex,
      "verify-after must re-run ownership inspection after adapter uninstall",
    );
    // :408 — the removal was attempted...
    assert.ok(has(codex, "plugin remove superpowers@superpowers-manager"));
    // :410 — ...but the plugin is still present on re-query.
    assert.ok(out.includes("still installed"), out);
  });

  void test("verify-after schema drift: fail closed instead of reporting success (:412-426)", async () => {
    const c = uninstallCase({ config: { pluginRemove: "missing-installed" } });
    const result = await runScript(c, "uninstall");
    const out = result.stdout + result.stderr;
    // :418
    assert.notEqual(
      result.status,
      0,
      "expected uninstall to fail but it succeeded",
    );
    const codex = readLog(c.codexLog);
    // :419, re-anchored onto codex.log: the true/true flag pair issues both
    // removes, and the verify-after inspection proves the operation completed.
    assert.ok(
      has(codex, "plugin marketplace remove superpowers-manager"),
      codex.join("\n"),
    );
    assertAdapterUninstallRan(
      codex,
      "verify-after must re-run ownership inspection after adapter uninstall",
    );
    // :420
    assert.ok(has(codex, "plugin remove superpowers@superpowers-manager"));
    // :421
    assert.ok(out.includes("cannot parse output of"), out);
    // :422-426 — non-vacuous: the assertion above proves `out` carries the
    // subject's diagnostics.
    assert.ok(
      !out.includes("uninstall complete"),
      "must not report success when verify-after sees schema drift",
    );
  });

  void test("marketplace remove fails after the plugin remove succeeds (:428-455)", async () => {
    const c = uninstallCase({ config: { marketplaceRemove: "fail" } });
    const result = await runScript(c, "uninstall");
    const out = result.stdout + result.stderr;
    // :435
    assert.notEqual(
      result.status,
      0,
      "expected uninstall to fail but it succeeded",
    );
    const codex = readLog(c.codexLog);
    // :436, re-anchored onto codex.log — and NOT onto assertAdapterUninstallRan,
    // which would be false here: the marketplace remove fails, so the flow dies
    // before scripts/uninstall:29's verify-after inspection. The true/true flag
    // pair is witnessed instead by the two removes at :437-438, which the
    // adapter issues only when both flags are true (src/adapter.ts:713-745).
    // :437-438
    assert.ok(has(codex, "plugin remove superpowers@superpowers-manager"));
    assert.ok(has(codex, "plugin marketplace remove superpowers-manager"));
    // :449-450 — asserted before the negatives below so neither can pass on
    // empty output.
    assert.ok(out.includes("marketplace remove exploded"), out);
    assert.ok(
      out.includes(
        "error: codex plugin marketplace remove failed for superpowers-manager",
      ),
      out,
    );
    // :439-443
    assert.ok(
      !out.includes("uninstall complete"),
      "core must not print final success when marketplace removal fails",
    );
    // :444-448
    assert.ok(
      !out.includes("error: invalid adapter response:"),
      "marketplace removal failure must be reported as one controlled adapter failure",
    );
    // :451-455
    assert.ok(
      !has(codex, "openai-curated"),
      "marketplace failure must not mutate unrelated providers",
    );
  });
});
