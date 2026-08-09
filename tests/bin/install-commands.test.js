// @ts-check
// Port of tests/test_install_commands.sh (782 lines, deleted in this commit).
// Reconciliation: tests/migration-inventory/install-commands.md
//
// Cases run concurrently. Every case builds its own package root, state
// directory, logs, and TMPDIR, so none depends on another's cleanup — which is
// why the driver's corrupt-and-restore dance (:418-423, :458-467, :475-476)
// has no counterpart here, and why each case must state the preconditions the
// shell inherited from the scenario above it. See the inventory for those.

// Two statements, not one. tests/bin/migration-inventory.test.js:23 matches
// /^import test from "node:test";$/m and asserts it at :331-334, because the
// static call-site counter recognises exactly one binding form and fails closed
// rather than miscount. Both `import { describe, test } from "node:test";` and
// `import test, { describe } from "node:test";` FAIL that regex.
import test from "node:test";
import { describe } from "node:test";
import assert from "node:assert/strict";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  UPSTREAM,
  assertOrder,
  createCase,
  firstIndex,
  lastIndex,
  readLog,
  runScript,
} from "./lifecycle-fixture.js";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));

// Verbatim from tests/test_install_commands.sh:16-21.
const FORBIDDEN_LITERALS = [
  "requirements.toml",
  "hooks.state",
  "trusted_hash",
  "--dangerously-bypass-hook-trust",
];

// Fixture JSON, verbatim from the shell driver at the cited lines.
const PLUGIN_LIST_EMPTY = '{"installed":[],"available":[]}'; // :232
const MARKETPLACE_ABSENT =
  '{"marketplaces":[{"name":"openai-curated","root":"/x"}]}'; // :224
const LEGACY_ONLY_PLUGINS =
  '{"installed":[{"pluginId":"superpowers@superpowers-wrapper"}],"available":[]}'; // :430
const BOTH_PLUGINS =
  '{"installed":[{"pluginId":"superpowers@superpowers-manager","version":"1.0.0"},{"pluginId":"superpowers@superpowers-wrapper"}],"available":[]}'; // :434
const LEGACY_MARKETPLACE =
  '{"marketplaces":[{"name":"superpowers-wrapper","root":"/legacy"}]}'; // :437

// `assert_no_codex_mutation` (:313-319) matched with an anchored ERE, so
// "plugin marketplace add" is deliberately not a `^plugin (add|remove) ` hit.
const CODEX_MUTATION =
  /^plugin (add|remove) |^plugin marketplace (add|remove) /;

// `^build |^install ` from :445 and :615, applied to the adapter log.
const ADAPTER_MUTATION = /^build |^install /;

// The abort-before-mutation ERE from :642. Deliberately NOT `CODEX_MUTATION`:
// this one leaves `marketplace (add|remove)` unanchored, so it also rejects a
// mutation reached through some other verb prefix.
const PARSE_ABORT_MUTATION = /marketplace (add|remove)|^plugin (add|remove)/;

/**
 * Replaces the driver's `reset` (:226-235) plus the marketplace seeding every
 * scenario in this range either wrote itself (:342, :380, :397, :409, :457,
 * :480) or inherited unchanged from the scenario before it. `reset` never
 * touched marketplace_list.json, so under per-case isolation the ambient value
 * has to be stated instead of inherited.
 * @param {object} [options]
 * @param {Record<string, unknown>} [options.config]
 * @param {"delegate" | "tripwire" | "intercept"} [options.adapterSeam]
 * @param {{ reason: "intercept" | "log", script: string }} [options.seamDependency]
 * @param {string} [options.plugins]
 * @param {string} [options.marketplaces]
 * @returns {import("./lifecycle-fixture.js").CaseEnv}
 */
function installCase(options = {}) {
  // Both seam options are forwarded, never defaulted here: createCase owns the
  // default mode and the eager validation, so a case that omits them still
  // gets checked against tests/bin/adapter-seam.js.
  const c = createCase({
    fakes: "install",
    config: options.config ?? {},
    adapterSeam: options.adapterSeam,
    seamDependency: options.seamDependency,
  });
  writeFileSync(
    join(c.state, "plugin_list.json"),
    `${options.plugins ?? PLUGIN_LIST_EMPTY}\n`,
  );
  writeFileSync(
    join(c.state, "marketplace_list.json"),
    `${options.marketplaces ?? MARKETPLACE_ABSENT}\n`,
  );
  return c;
}

/**
 * Ports `seed_installed_current` (:241-251): pre-populate the codex-home cache
 * and the installed plugin list so probe reports the manager as current.
 * @param {import("./lifecycle-fixture.js").CaseEnv} c
 * @returns {void}
 */
function seedInstalledCurrent(c) {
  const dest = join(
    c.state,
    "codex-home/plugins/cache/superpowers-manager/superpowers/1.0.0",
  );
  mkdirSync(dest, { recursive: true });
  const generated = join(
    c.pkg,
    "plugins/superpowers/.superpowers-upstream.json",
  );
  if (existsSync(generated)) {
    cpSync(generated, join(dest, ".superpowers-upstream.json"));
  } else {
    const head = spawnSync("git", ["-C", UPSTREAM, "rev-parse", "HEAD"], {
      encoding: "utf8",
    });
    assert.equal(head.status, 0, "fixture upstream has no HEAD");
    writeFileSync(
      join(dest, ".superpowers-upstream.json"),
      `${JSON.stringify({ commit: head.stdout.trim() })}\n`,
    );
  }
  writeFileSync(
    join(c.state, "plugin_list.json"),
    '{"installed":[{"pluginId":"superpowers@superpowers-manager","version":"1.0.0"}],"available":[]}\n',
  );
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
 * Replaces `assert_no_codex_mutation` (:313-319).
 *
 * The emptiness guard is port-only. The shell's `$log` was a file the fake
 * appended to before doing anything else, whereas `readLog` returns [] for a
 * missing file — so a fixture whose subject never reached the fake would
 * satisfy the negative vacuously. Every call site below runs a subject that
 * reaches probe's `codex plugin list`; the one place that legitimately makes
 * no Codex call at all (prepare) asserts the stronger empty-log property
 * inline instead of calling this.
 * @param {string[]} log
 * @returns {void}
 */
function assertNoCodexMutation(log) {
  assert.ok(
    log.length > 0,
    "codex log is empty — the fake never ran, so 'no mutation' would pass vacuously",
  );
  const offenders = log.filter((line) => CODEX_MUTATION.test(line));
  assert.deepEqual(offenders, [], "expected no Codex mutation");
}

/**
 * `cat "$state/update-control-count"` (:388, :399, :415). A missing file is a
 * hard failure here exactly as `cat` under `set -e` was in the shell.
 * @param {import("./lifecycle-fixture.js").CaseEnv} c
 * @returns {number}
 */
function updateControlCount(c) {
  return Number(
    readFileSync(join(c.state, "update-control-count"), "utf8").trim(),
  );
}

/**
 * Reconstructs the generated-tree precondition the shell driver inherited from
 * the scenario above it. `scripts/core/status.sh:15-16` returns "needs prepare"
 * whenever the package root carries no `.superpowers-upstream.json`, and
 * lifecycle-fixture.js:48-59 copies only `plugin.template.json` into the
 * snapshot — so a fresh `c.pkg` always probes as "needs prepare". In the shell
 * the prepare at :325 (and again inside the install at :383) left a valid
 * generated tree in the shared `$pkg`, and `reset` cleared Codex state but
 * never the package root. Every scenario from :340 to :416 therefore reached
 * the subject with that tree present, probing as "needs install" — or, once
 * `seed_installed_current` also populates the cache, as "current".
 *
 * Under per-case isolation that state has to be built, and running prepare is
 * exactly how the driver built it.
 *
 * prepare never inspects update control (proved by the case at :321-336), so
 * this leaves `update-control-count` untouched and the later count assertions
 * mean what they meant in the shell.
 *
 * SEAM: this helper reads adapter.log, so EVERY caller declares a
 * seamDependency. See the guard below for why no other channel can carry the
 * claim.
 * @param {import("./lifecycle-fixture.js").CaseEnv} c
 * @returns {Promise<void>}
 */
async function prepareGeneratedTree(c) {
  const result = await runScript(c, "prepare");
  assert.equal(
    result.status,
    0,
    `fixture: prepare must succeed to establish the generated tree:\n${result.stdout}${result.stderr}`,
  );
  // The provenance file is the exact input status.sh reads, and it is also what
  // decides which branch `seedInstalledCurrent` takes.
  assert.ok(
    existsSync(join(c.pkg, "plugins/superpowers/.superpowers-upstream.json")),
    "fixture: prepare did not leave generated provenance in the package root",
  );
  // Over adapter.log, NOT over the update-control-count file. That counter is
  // written only inside install-fakes.js's interception block, so an
  // existsSync() negative on it cannot fail in a `delegate` case: the file can
  // never exist there whatever scripts/prepare does. adapter.log is written in
  // all three seam modes, so this form is live in every caller.
  //
  // The consequence is deliberate and accepted: every caller of this helper is
  // now an adapter-log reader and declares a seamDependency. "prepare did not
  // inspect update control" is observable ONLY through the fake adapter — the
  // operation issues no Codex command (src/adapter.ts:757-759) and prints
  // nothing — so the guard genuinely dies with the seam wherever it is used,
  // and recording that is the whole point of the registry.
  assert.ok(
    !has(readLog(c.adapterLog), "inspect --view update-control"),
    "fixture: prepare must not have inspected update control",
  );
}

/**
 * Port-only precondition guard, not a ported assertion.
 *
 * `scripts/prepare` is the only thing that prints "prepared <ref> at <commit>",
 * and `scripts/install:23-25` runs it only on the needs-prepare branch. Its
 * absence is therefore direct evidence that the subject took the needs-install
 * or current branch — the path the shell driver put it on. Without this guard a
 * lost precondition is invisible: the case still exits non-zero and still
 * carries the gate message, because scripts/install:54 emits the same string
 * from a different branch. That is precisely how the case at :338-347 passed
 * while never entering the update fast path at all.
 *
 * ANCHORED, not a bare substring. `scripts/prepare:117` prints its banner at
 * the start of a line, but `scripts/core/lifecycle.sh:116` also carries the
 * word mid-sentence — "does not match the prepared plugin after install." —
 * on stderr. No current call site can see it: the three that pass combined
 * output (:519, :546, :658) all stop at the update-control gate, before
 * `spw_verify_installed_fingerprint` runs at all. The anchor is therefore
 * defensive hardening, not a live fix — it keeps this guard meaning "prepare
 * ran" for any future case whose `out` could carry that diagnostic.
 * @param {string} out
 * @returns {void}
 */
function assertNoPrepareRan(out) {
  assert.ok(
    !/^prepared /m.test(out),
    `the subject re-ran prepare, so it took the needs-prepare branch instead of the branch this case exists to cover:\n${out}`,
  );
}

/**
 * Ports `reset`'s log truncation (:233-234).
 *
 * In the shell the generated tree was left behind by an EARLIER scenario, and
 * `reset` then emptied both logs before the scenario under test ran — so a
 * scenario's logs held only its own subject's calls. Here
 * `prepareGeneratedTree` runs inside the case, so without this its
 * `build --upstream-root` adapter line sits in the log the assertions read.
 * That is not hypothetical: the `^build |^install ` negative at :615-619 fails
 * against it, and would have to be weakened to accommodate a line the shell
 * never saw.
 *
 * Only the two logs. `reset` also cleared `update-control-count`, and
 * `prepareGeneratedTree` already asserts prepare left none.
 * @param {import("./lifecycle-fixture.js").CaseEnv} c
 * @returns {void}
 */
function clearLogs(c) {
  writeFileSync(c.codexLog, "");
  writeFileSync(c.adapterLog, "");
}

/**
 * Replaces `assert_install_tmp_empty` (:297-303).
 *
 * Scope narrowed by per-case isolation, exactly as the uninstall port's
 * `assertTmpEmpty` was: the shell created `$install_tmp` once at :96-97 and
 * `reset` never cleared it, so by :503 the check covered every run since the
 * start of the file. `createCase` gives each case a private TMPDIR, so this
 * catches a leak in the case that makes it and no longer sweeps up its
 * predecessors.
 * @param {import("./lifecycle-fixture.js").CaseEnv} c
 * @returns {void}
 */
function assertTmpEmpty(c) {
  assert.deepEqual(
    readdirSync(c.tmp, { recursive: true }),
    [],
    "install leaked its invocation workspace or adapter sidecars",
  );
}

/**
 * Port-only non-vacuity guard, used where no ported positive is available to
 * hoist above a negative. The shell's `$log` and `$state/adapter.log` were
 * files the fakes appended to before doing anything else, so `grep` over them
 * could not silently degrade; `readLog` returns [] for a missing file, so a
 * negative over an empty log would pass whether or not the property holds.
 * @param {string[]} log
 * @param {string} what
 * @returns {string[]}
 */
function nonEmpty(log, what) {
  assert.ok(
    log.length > 0,
    `${what} log is empty — the fake never ran, so the negative below would pass vacuously`,
  );
  return log;
}

/**
 * Overwrites the case's marketplace listing fixture.
 * @param {import("./lifecycle-fixture.js").CaseEnv} c
 * @param {{ name: string, root: string }[]} marketplaces
 * @returns {void}
 */
function writeMarketplaces(c, marketplaces) {
  writeFileSync(
    join(c.state, "marketplace_list.json"),
    `${JSON.stringify({ marketplaces })}\n`,
  );
}

/**
 * The commit recorded in the case's generated provenance. Ports the embedded
 * `python3` check at :759-768: the value must be a string of exactly 40 hex
 * digits, so a `{`-corrupted file (which does not parse) or a non-commit value
 * both fail.
 * @param {import("./lifecycle-fixture.js").CaseEnv} c
 * @returns {void}
 */
function assertGeneratedCommitIsSha(c) {
  const parsed = /** @type {{ commit?: unknown }} */ (
    JSON.parse(
      readFileSync(
        join(c.pkg, "plugins/superpowers/.superpowers-upstream.json"),
        "utf8",
      ),
    )
  );
  assert.ok(
    typeof parsed.commit === "string" &&
      /^[0-9a-fA-F]{40}$/.test(parsed.commit),
    `did not replace malformed generated provenance: ${JSON.stringify(parsed.commit)}`,
  );
}

/**
 * The loop body at :427-450, shared by the `legacy` and `both` identity states.
 * @param {import("./lifecycle-fixture.js").CaseEnv} c
 * @returns {Promise<void>}
 */
async function assertLegacyIdentityStops(c) {
  const result = await runScript(c, "install");
  const out = result.stdout + result.stderr;
  // :438-441
  assert.notEqual(
    result.status,
    0,
    `install must reject this identity state:\n${out}`,
  );
  // :442-444. DELIBERATE version literal: `0.1.1` is not a dependency pin that
  // moves on someone else's schedule — it is user-facing guidance owned in-repo
  // at scripts/core/lifecycle.sh:52, naming the last superpowers-wrapper
  // release that can uninstall legacy state. The exact text is the contract.
  assert.ok(
    hasLine(out, "Legacy superpowers-wrapper Codex state is installed."),
    out,
  );
  assert.ok(hasLine(out, "Run: npx superpowers-wrapper@0.1.1 uninstall"), out);
  assert.ok(hasLine(out, "Then run: npx superpowers-manager install"), out);
  // :445-449 — non-vacuous: the adapter log must show the ownership inspection
  // that produced the identity verdict asserted above.
  //
  // NOT re-anchored onto codex.log, and both callers therefore declare a
  // seamDependency. The `^install ` half does have a Codex footprint — adapter
  // install always reaches `codex plugin add` (src/adapter.ts:650-656) — and
  // :450 already asserts it. The `^build ` half does not: the adapter's build
  // operation is pure filesystem work and issues no Codex command at all, so
  // no expression over codex.log can witness its absence.
  const adapter = readLog(c.adapterLog);
  assert.ok(
    adapter.includes("inspect --view ownership"),
    "adapter never inspected ownership, so 'no build or install' would pass vacuously",
  );
  assert.deepEqual(
    adapter.filter((line) => ADAPTER_MUTATION.test(line)),
    [],
    "legacy state must stop before build or install adapter mutation",
  );
  // :450
  assertNoCodexMutation(readLog(c.codexLog));
}

// `void` for the same reason every `test(` call site carries it: oxlint's
// typescript(no-floating-promises) rule treats the runner's returned promise as
// floating otherwise.
void describe("install commands", { concurrency: true }, () => {
  void test("production scripts carry no hook-trust mutation surface (:11-42)", () => {
    // Reads ROOT, not a copied package root: this is a claim about the
    // repository's own production scripts, not about a fixture snapshot.
    const scriptsRoot = join(ROOT, "scripts");
    const entries = readdirSync(scriptsRoot, { recursive: true })
      .map(String)
      .sort();
    let scanned = 0;
    for (const entry of entries) {
      const path = join(scriptsRoot, entry);
      if (!statSync(path).isFile()) continue;
      scanned += 1;
      // :27-29 — an unreadable script is a hard failure, never a skip.
      let text = "";
      try {
        text = readFileSync(path, "utf8");
      } catch (error) {
        assert.fail(
          `production script could not be inspected: ${path}: ${String(error)}`,
        );
      }
      // :30-35
      for (const forbidden of FORBIDDEN_LITERALS) {
        assert.ok(
          !text.includes(forbidden),
          `production scripts must not contain hook trust mutation surface: ${forbidden} (${path})`,
        );
      }
      // :36-41 — the literal checks deliberately include comments; app-server
      // is allowed only in comments.
      text.split("\n").forEach((line, index) => {
        assert.ok(
          !line.includes("app-server") || line.trimStart().startsWith("#"),
          `production scripts must not invoke the Codex app-server: ${path}:${index + 1}`,
        );
      });
    }
    assert.ok(scanned > 0, "scripts/ held no files — the scan proved nothing");
  });

  void test("packaged root preconditions (:77-82)", () => {
    const c = installCase();
    // :77-78 — executability, not mere presence.
    for (const relative of [
      "scripts/install",
      "scripts/adapters/codex/adapter",
    ]) {
      const path = join(c.pkg, relative);
      // existsSync first so a missing file reports the contract, not ENOENT.
      assert.ok(
        existsSync(path) && (statSync(path).mode & 0o111) !== 0,
        `${relative} must remain executable in the packaged root`,
      );
    }
    // :79-81
    for (const relative of [
      "dist/validate-generated-plugin-cli.js",
      "dist/generated-plugin.js",
      "dist/python-text.js",
    ]) {
      const path = join(c.pkg, relative);
      assert.ok(
        existsSync(path) && statSync(path).isFile(),
        `${relative} must remain packaged`,
      );
    }
    // :82
    assert.ok(
      !existsSync(
        join(c.pkg, "scripts/adapters/codex/validate-generated-plugin.py"),
      ),
      "the Python generated-plugin validator must not be packaged",
    );
  });

  void test("prepare is capability-independent (:321-336)", async () => {
    // `updateControl: "unsupported"` is INERT here and deliberately so: prepare
    // never inspects update control, which is exactly what :326-330 asserts. So
    // the case is not intercept-dependent — the interceptor is never reached —
    // but it is log-dependent, because every assertion below names an adapter
    // operation on a path that makes no Codex call whatsoever (:336).
    const c = installCase({
      config: { updateControl: "unsupported" },
      seamDependency: { reason: "log", script: "prepare" },
    });
    const result = await runScript(c, "prepare");
    assert.equal(result.status, 0, result.stdout + result.stderr);

    const adapter = readLog(c.adapterLog);
    // Hoisted above the negatives: prepare must have reached the adapter at
    // all, or every assertion below passes on an empty log.
    assert.ok(has(adapter, "build --upstream-root"), adapter.join("\n"));
    // :326-330
    assert.ok(
      !has(adapter, "inspect --view update-control"),
      "prepare must not inspect update control",
    );
    // :331-335
    assert.ok(
      !has(adapter, "install --package-root"),
      "prepare must not invoke adapter install",
    );
    // :336 — prepare makes no Codex call whatsoever, which is strictly
    // stronger than `assert_no_codex_mutation` and, unlike it, non-vacuous
    // here: an empty log is the property rather than an absent fixture.
    assert.deepEqual(
      readLog(c.codexLog),
      [],
      "prepare must not invoke Codex at all",
    );
  });

  void test("unsupported update control blocks the update fast path (:338-347)", async () => {
    const c = installCase({
      config: { updateControl: "unsupported" },
      adapterSeam: "intercept",
      // `update`, not `install`: runScript spawns scripts/update below, and the
      // registry is keyed by the script actually spawned.
      seamDependency: { reason: "intercept", script: "update" },
    });
    // The generated tree the shell inherited from the prepare at :325. Without
    // it the package root probes as "needs prepare", `seed_installed_current`
    // is inert, and `scripts/update` never reaches its `current)` branch — the
    // only branch that can print "manager is current" — so the negative below
    // could not fail.
    await prepareGeneratedTree(c);
    seedInstalledCurrent(c); // :341
    const result = await runScript(c, "update");
    const out = result.stdout + result.stderr;
    // :344
    assert.notEqual(result.status, 0, `expected update to fail:\n${out}`);
    // Precondition: probe reported "current", so the gate below is the update
    // fast path's gate and not scripts/install:54 reached via needs-prepare.
    assertNoPrepareRan(out);
    // :345
    assert.ok(
      out.includes("adapter cannot guarantee manager-controlled updates"),
      out,
    );
    // :346 — non-vacuous: the assertion above proves `out` carries the
    // subject's diagnostics, and the precondition guard proves the branch that
    // prints this string was actually entered.
    assert.ok(
      !out.includes("manager is current"),
      "an unsupported adapter must not report the manager as current",
    );
    // :347
    assertNoCodexMutation(readLog(c.codexLog));
  });

  void test("unsupported update control blocks a direct install (:349-352)", async () => {
    const c = installCase({
      config: { updateControl: "unsupported" },
      adapterSeam: "intercept",
      seamDependency: { reason: "intercept", script: "install" },
    });
    // The shell reached this gate on the needs-install path: `reset` cleared
    // the Codex cache but left the generated tree from :325 in $pkg.
    await prepareGeneratedTree(c);
    const result = await runScript(c, "install");
    const out = result.stdout + result.stderr;
    // :351
    assert.notEqual(result.status, 0, `expected install to fail:\n${out}`);
    // Precondition: the prepare-less install path the shell covered here.
    assertNoPrepareRan(out);
    // :352
    assertNoCodexMutation(readLog(c.codexLog));
  });

  void test("malformed update-control output exits exactly 1 (:354-364)", async () => {
    const c = installCase({
      config: { updateControl: "malformed" },
      adapterSeam: "intercept",
      seamDependency: { reason: "intercept", script: "install" },
    });
    const result = await runScript(c, "install");
    // :357-363 — the shell checked "did not succeed" and then "rc is exactly
    // 1"; one equality carries both claims.
    assert.equal(
      result.status,
      1,
      `malformed adapter response must exit 1:\n${result.stdout}${result.stderr}`,
    );
    // :364
    assertNoCodexMutation(readLog(c.codexLog));
  });

  void test("failed update-control inspection exits exactly 1 (:366-375)", async () => {
    const c = installCase({
      config: { updateControl: "failure" },
      adapterSeam: "intercept",
      seamDependency: { reason: "intercept", script: "update" },
    });
    const result = await runScript(c, "update");
    // :368-374
    assert.equal(
      result.status,
      1,
      `failed adapter response must exit 1:\n${result.stdout}${result.stderr}`,
    );
    // :375
    assertNoCodexMutation(readLog(c.codexLog));
  });

  void test("needs-prepare install reinspects after prepare and rejects drift (:377-392)", async () => {
    const c = installCase({
      config: { updateControl: "managed-then-unsupported" },
      adapterSeam: "intercept",
      // Both halves of the interception: the drifting VALUE and the count file
      // asserted at :388, which only the interceptor writes.
      seamDependency: { reason: "intercept", script: "install" },
    });
    // :381 — malformed generated provenance forces the needs-prepare path.
    writeFileSync(
      join(c.pkg, "plugins/superpowers/.superpowers-upstream.json"),
      "{\n",
    );
    const result = await runScript(c, "install");
    const out = result.stdout + result.stderr;
    // :383-386
    assert.notEqual(
      result.status,
      0,
      `install must reject capability drift after prepare:\n${out}`,
    );
    // :387
    assert.ok(out.includes("prepared v1.0.0"), out);
    // :388
    assert.equal(updateControlCount(c), 2);
    // :389-391 — head -n1 for the build line, tail -n1 for the second
    // update-control inspection, exactly as the shell did.
    const adapter = readLog(c.adapterLog);
    const buildLine = firstIndex(adapter, "build --upstream-root");
    const secondControlLine = lastIndex(
      adapter,
      "inspect --view update-control",
    );
    assert.notEqual(buildLine, -1, adapter.join("\n"));
    assert.ok(
      buildLine < secondControlLine,
      `update control must be reinspected after prepare:\n${adapter.join("\n")}`,
    );
    // :392
    assertNoCodexMutation(readLog(c.codexLog));
  });

  void test("needs-install path inspects ownership then update control, then installs (:394-404)", async () => {
    // Intercept-dependent on the COUNT alone: the config is the default, but
    // :399 reads update-control-count, which nothing writes except the
    // interceptor at install-fakes.js:180-192.
    const c = installCase({
      adapterSeam: "intercept",
      seamDependency: { reason: "intercept", script: "install" },
    });
    await prepareGeneratedTree(c);
    const result = await runScript(c, "install");
    // :398 — captured stdout only, and `set -e` made a non-zero exit fatal.
    assert.equal(result.status, 0, result.stdout + result.stderr);
    // Precondition: this is the needs-install path the case is named for.
    assertNoPrepareRan(result.stdout);
    // :399
    assert.equal(updateControlCount(c), 2);
    // :400-404
    const adapter = readLog(c.adapterLog);
    const lastOwnership = lastIndex(adapter, "inspect --view ownership");
    const lastControl = lastIndex(adapter, "inspect --view update-control");
    const installLine = firstIndex(adapter, `install --package-root ${c.pkg}`);
    assert.notEqual(installLine, -1, adapter.join("\n"));
    assert.ok(
      lastOwnership < lastControl,
      `fresh ownership inspection must precede update-control gate:\n${adapter.join("\n")}`,
    );
    assert.ok(
      lastControl < installLine,
      `fresh update-control gate must precede adapter install:\n${adapter.join("\n")}`,
    );
  });

  void test("the fresh gate, not the initial probe, controls mutation authority (:406-416)", async () => {
    const c = installCase({
      config: { updateControl: "managed-then-unsupported" },
      adapterSeam: "intercept",
      seamDependency: { reason: "intercept", script: "install" },
    });
    await prepareGeneratedTree(c);
    const result = await runScript(c, "install");
    const out = result.stdout + result.stderr;
    // :411-414 — probe saw `managed`; only the second, fresh inspection sees
    // `unsupported`, and it is the one that must stop the install.
    assert.notEqual(
      result.status,
      0,
      `install must reject capability drift before adapter install:\n${out}`,
    );
    // Precondition: the needs-install gate, which is what distinguishes this
    // case from the needs-prepare drift case at :377-392.
    assertNoPrepareRan(out);
    // :415
    assert.equal(updateControlCount(c), 2);
    // :416
    assertNoCodexMutation(readLog(c.codexLog));
  });

  void test("legacy identity state stops before prepare or adapter mutation (:425-451, legacy)", async () => {
    // :429-430
    const c = installCase({
      plugins: LEGACY_ONLY_PLUGINS,
      marketplaces: LEGACY_MARKETPLACE,
      seamDependency: { reason: "log", script: "install" },
    });
    await assertLegacyIdentityStops(c);
  });

  void test("mixed identity state stops before prepare or adapter mutation (:425-451, both)", async () => {
    const c = installCase({
      marketplaces: LEGACY_MARKETPLACE,
      seamDependency: { reason: "log", script: "install" },
    });
    // :432-434 — seed_installed_current writes its own plugin list, which the
    // driver then overwrote with the mixed one. Order preserved.
    seedInstalledCurrent(c);
    writeFileSync(join(c.state, "plugin_list.json"), `${BOTH_PLUGINS}\n`);
    await assertLegacyIdentityStops(c);
  });

  void test("built-in validation failure leaves Codex untouched (:453-476)", async () => {
    const c = installCase();
    // :458-467 — corrupt this case's own template. The driver's restore at
    // :475-476 existed only to undo damage to a shared package root; per-case
    // isolation removes the coupling, so the restore is deliberately not
    // ported.
    const template = join(
      c.pkg,
      "plugins/superpowers/.codex-plugin/plugin.template.json",
    );
    const manifest = JSON.parse(readFileSync(template, "utf8"));
    manifest.name = "wrong-name";
    writeFileSync(template, `${JSON.stringify(manifest, null, 2)}\n`);

    const result = await runScript(c, "install");
    const out = result.stdout + result.stderr;
    // :468-472
    assert.notEqual(
      result.status,
      0,
      `expected install to fail on built-in validation:\n${out}`,
    );
    // :473
    assert.ok(out.includes("field `name` must equal `superpowers`"), out);
    // :474
    assertNoCodexMutation(readLog(c.codexLog));
  });

  void test("additional-validator failure leaves Codex untouched (:478-487)", async () => {
    const c = installCase();
    // :84-89 — the failing additional-validator fixture.
    const validator = join(c.dir, "failing_validator.py");
    writeFileSync(validator, "import sys\nsys.exit(1)\n");

    const result = await runScript(c, "install", {
      env: { SUPERPOWERS_VALIDATOR: validator },
    });
    const out = result.stdout + result.stderr;
    // :481-485
    assert.notEqual(
      result.status,
      0,
      `expected install to fail on additional validation:\n${out}`,
    );
    // :486
    assert.ok(out.includes("additional plugin validation failed"), out);
    // :487
    assertNoCodexMutation(readLog(c.codexLog));
  });

  // ==========================================================================
  // Reconciliation and verification (:489-780).
  //
  // The shared precondition, and why it is rebuilt case by case: the driver's
  // teardown at :420-423 stripped $pkg back to a bare template, and the fresh
  // install at :495 put a VALID generated tree back. Nothing removed it again,
  // so every scenario from :519 to :745 reached the subject with that tree in
  // place and an empty Codex cache — probing as "needs install", or as
  // "current" once `seed_installed_current` also populated the cache. Those
  // cases call `prepareGeneratedTree(c)` (and `clearLogs(c)`, which is what
  // `reset` did between the scenario that built the tree and the one under
  // test).
  //
  // Three cases deliberately do NOT: :493 is the fresh-install case the tree
  // must be absent for, and :754/:776 corrupt the provenance on purpose after
  // building a real tree to corrupt.
  // ==========================================================================

  void test("fresh install prepares, then lists, adds, and adds the plugin (:489-512)", async () => {
    // No prepareGeneratedTree: :496 asserts prepare generated the tree, which
    // is only a claim about the subject if the tree is absent beforehand.
    const c = installCase();
    const result = await runScript(c, "install");
    // :495 — stdout captured, stderr left alone; `set -e` made a non-zero exit
    // fatal.
    assert.equal(result.status, 0, result.stdout + result.stderr);
    // :496
    assert.ok(
      existsSync(join(c.pkg, "plugins/superpowers/.superpowers-upstream.json")),
      "prepare must have generated the tree",
    );
    // :497-501 — `line_of` is `grep -Fn … | head -n1`, which assertOrder's
    // firstIndex reproduces. Two ordering claims, one call.
    const codex = readLog(c.codexLog);
    assertOrder(
      codex,
      [
        "plugin marketplace list",
        `plugin marketplace add ${c.pkg}`,
        "plugin add superpowers@superpowers-manager",
      ],
      "order must be: marketplace list, marketplace add, plugin add",
    );
    // :502
    assert.ok(result.stdout.includes("manager updated"), result.stdout);
    // :503
    assertTmpEmpty(c);
    // :504-512 — non-vacuous: assertOrder above proves all three commands
    // reached the log, so it is neither missing nor empty.
    assert.ok(
      !has(codex, "marketplace remove"),
      `fresh install must not remove any marketplace:\n${codex.join("\n")}`,
    );
    assert.ok(
      !has(codex, "plugin remove superpowers@superpowers-manager"),
      `add-only fresh install must not remove the manager plugin:\n${codex.join("\n")}`,
    );
    assert.ok(
      !has(codex, "openai-curated"),
      `install must never name openai-curated:\n${codex.join("\n")}`,
    );
  });

  void test("a current manager is reconciled, not skipped as up to date (:514-532)", async () => {
    const c = installCase({
      // Seam-dependent through prepareGeneratedTree, which reads adapter.log
      // to prove prepare did not inspect update control.
      seamDependency: { reason: "log", script: "install" },
    });
    await prepareGeneratedTree(c);
    seedInstalledCurrent(c); // :520
    clearLogs(c);
    const result = await runScript(c, "install");
    // :522
    assert.equal(result.status, 0, result.stdout + result.stderr);
    // Precondition. `prepareGeneratedTree` proves the generated provenance
    // exists and `seedInstalledCurrent` copies that same file into the Codex
    // cache, so scripts/core/status.sh:11-23 reports "current" — the branch
    // this case exists to cover. Without the tree the package root probes as
    // "needs prepare" and the subject re-runs prepare, which this catches.
    assertNoPrepareRan(result.stdout);
    // :523, re-anchored onto codex.log. The shell grepped the adapter log for
    // `install --package-root $pkg`; that operation's whole Codex footprint is
    // the three commands below (src/adapter.ts:575-656), and the second of them
    // carries the package root the original needle pinned. Nothing else in this
    // subject issues `plugin add`, so the ordering assertion is the same claim.
    // :524-532
    assertOrder(
      readLog(c.codexLog),
      [
        "plugin marketplace list",
        `plugin marketplace add ${c.pkg}`,
        "plugin add superpowers@superpowers-manager",
      ],
      "current install must still reconcile via adapter install",
    );
  });

  void test("a matching fingerprint at a different registered root still reconciles (:534-551)", async () => {
    const c = installCase({
      // Seam-dependent through prepareGeneratedTree, which reads adapter.log
      // to prove prepare did not inspect update control.
      seamDependency: { reason: "log", script: "install" },
    });
    await prepareGeneratedTree(c);
    seedInstalledCurrent(c); // :539
    // :540 — `$tmpdir/otherroot` was never created in the shell either; only
    // its name matters.
    const otherRoot = join(c.dir, "otherroot");
    writeMarketplaces(c, [{ name: "superpowers-manager", root: otherRoot }]);
    clearLogs(c);
    const result = await runScript(c, "install");
    // :541
    assert.equal(result.status, 0, result.stdout + result.stderr);
    // Precondition: the "current" branch, as in the case above.
    assertNoPrepareRan(result.stdout);
    // :542, re-anchored onto codex.log for the same reason as the case above:
    // `plugin marketplace add ${c.pkg}` in the ordering below is the adapter
    // install operation's own Codex footprint, package root included.
    // :543-551
    assertOrder(
      readLog(c.codexLog),
      [
        "plugin marketplace remove superpowers-manager",
        `plugin marketplace add ${c.pkg}`,
        "plugin add superpowers@superpowers-manager",
      ],
      "same-commit install must still reconcile a different package root",
    );
  });

  void test("the same physical root reached via a symlink is kept (:553-567)", async () => {
    const c = installCase({
      // Seam-dependent through prepareGeneratedTree, which reads adapter.log
      // to prove prepare did not inspect update control.
      seamDependency: { reason: "log", script: "install" },
    });
    await prepareGeneratedTree(c);
    // :558-559 — a symlink to this case's own package root, registered as the
    // marketplace root. Portable stand-in for macOS /var vs /private/var:
    // src/adapter.ts:586 compares the two through `pathsEqual`, so a
    // lexical comparison would re-register and turn the negatives below RED.
    const link = join(c.dir, "pkg-link");
    symlinkSync(c.pkg, link);
    writeMarketplaces(c, [{ name: "superpowers-manager", root: link }]);
    clearLogs(c);
    const result = await runScript(c, "install");
    // :560
    assert.equal(result.status, 0, result.stdout + result.stderr);
    const codex = readLog(c.codexLog);
    // :564 — hoisted above the negatives at :561-563 and :565-567, which would
    // otherwise pass on an empty log.
    assert.ok(
      has(codex, "plugin add superpowers@superpowers-manager"),
      codex.join("\n"),
    );
    // :561-563 — two independent greps sharing one diagnostic block.
    assert.ok(
      !has(codex, "marketplace add"),
      `same-root install must not re-register the marketplace:\n${codex.join("\n")}`,
    );
    assert.ok(
      !has(codex, "marketplace remove"),
      `same-root install must not re-register the marketplace:\n${codex.join("\n")}`,
    );
    // :565-567
    assert.ok(
      !has(codex, "plugin remove superpowers@superpowers-manager"),
      `add-only same-root install must not remove the manager plugin:\n${codex.join("\n")}`,
    );
  });

  void test("a different registered root is removed then added, in order (:569-585)", async () => {
    const c = installCase({
      // Seam-dependent through prepareGeneratedTree, which reads adapter.log
      // to prove prepare did not inspect update control.
      seamDependency: { reason: "log", script: "install" },
    });
    await prepareGeneratedTree(c);
    // :573
    const otherRoot = join(c.dir, "otherroot");
    writeMarketplaces(c, [
      { name: "openai-curated", root: "/x" },
      { name: "superpowers-manager", root: otherRoot },
    ]);
    clearLogs(c);
    const result = await runScript(c, "install");
    // :574
    assert.equal(result.status, 0, result.stdout + result.stderr);
    const codex = readLog(c.codexLog);
    // :575-579
    assertOrder(
      codex,
      [
        "plugin marketplace remove superpowers-manager",
        `plugin marketplace add ${c.pkg}`,
        "plugin add superpowers@superpowers-manager",
      ],
      "order must be: marketplace remove, marketplace add, plugin add",
    );
    // :580-585 — non-vacuous via assertOrder above.
    assert.ok(
      !has(codex, "marketplace remove openai-curated"),
      `must only ever remove the manager marketplace:\n${codex.join("\n")}`,
    );
    assert.ok(
      !has(codex, "plugin remove superpowers@superpowers-manager"),
      `add-only drift reconciliation must not remove the manager plugin:\n${codex.join("\n")}`,
    );
  });

  void test("update stays read-only when probe reports current (:587-602)", async () => {
    const c = installCase({
      // Seam-dependent through prepareGeneratedTree, which reads adapter.log
      // to prove prepare did not inspect update control.
      seamDependency: { reason: "log", script: "update" },
    });
    await prepareGeneratedTree(c);
    seedInstalledCurrent(c); // :591
    clearLogs(c);
    const result = await runScript(c, "update");
    // :593
    assert.equal(result.status, 0, result.stdout + result.stderr);
    // :594. Also the precondition pin: `manager is current` is printed only by
    // scripts/update:20, inside the `current)` branch, so a lost generated
    // tree or cache seed turns this RED rather than silently rerouting the
    // case through needs-prepare.
    assert.ok(result.stdout.includes("manager is current"), result.stdout);
    // :595-599, re-anchored onto codex.log. `install --package-root` absent
    // from the adapter log and "no Codex mutation" are the same claim here:
    // the adapter install operation unconditionally reaches
    // `codex plugin add superpowers@superpowers-manager` (src/adapter.ts:650),
    // which CODEX_MUTATION matches, so :600-602 below already excludes it —
    // and it carries its own emptiness guard, which is what `nonEmpty` gave
    // the adapter-log form.
    // :600-602. The shell guarded this with `[ ! -s "$log" ] ||`, tolerating an
    // empty Codex log. That escape hatch is deliberately not ported: probe
    // always reaches `codex plugin list`, so an empty log is a fixture fault,
    // and assertNoCodexMutation's emptiness guard reports it as one.
    assertNoCodexMutation(readLog(c.codexLog));
  });

  void test("update rejects mixed legacy state even when the fingerprint is current (:604-620)", async () => {
    const c = installCase({
      marketplaces: LEGACY_MARKETPLACE, // :609
      // Same shape as assertLegacyIdentityStops, and seam-dependent for the
      // same reason: the `^build ` half of :615-619 has no Codex footprint.
      seamDependency: { reason: "log", script: "update" },
    });
    await prepareGeneratedTree(c);
    seedInstalledCurrent(c); // :607
    // :608 — seed_installed_current writes its own plugin list, which the
    // driver then overwrote with the mixed one. Order preserved.
    writeFileSync(join(c.state, "plugin_list.json"), `${BOTH_PLUGINS}\n`);
    // Without this the `^build ` negative at :615-619 would see
    // prepareGeneratedTree's own `build --upstream-root` line, which the shell
    // never had in scope here.
    clearLogs(c);
    const result = await runScript(c, "update");
    const out = result.stdout + result.stderr;
    // :610-613
    assert.notEqual(
      result.status,
      0,
      `current update must reject mixed legacy state:\n${out}`,
    );
    // :614 — whole-line match, as `grep -Fxq` was.
    assert.ok(hasLine(out, "Then run: npx superpowers-manager install"), out);
    // :615-619 — non-vacuous: the adapter log must show the ownership
    // inspection that produced the identity verdict asserted above.
    const adapter = readLog(c.adapterLog);
    assert.ok(
      has(adapter, "inspect --view ownership"),
      "adapter never inspected ownership, so 'no build or install' would pass vacuously",
    );
    assert.deepEqual(
      adapter.filter((line) => ADAPTER_MUTATION.test(line)),
      [],
      "mixed legacy state must stop update before build or install",
    );
    // :620
    assertNoCodexMutation(readLog(c.codexLog));
  });

  void test("a failed marketplace add after a successful remove never reaches plugin add (:622-634)", async () => {
    const c = installCase({
      config: { marketplaceAdd: "fail" },
      // Seam-dependent through prepareGeneratedTree, which reads adapter.log
      // to prove prepare did not inspect update control.
      seamDependency: { reason: "log", script: "install" },
    }); // :628
    await prepareGeneratedTree(c);
    // :627
    const otherRoot = join(c.dir, "otherroot");
    writeMarketplaces(c, [{ name: "superpowers-manager", root: otherRoot }]);
    clearLogs(c);
    const result = await runScript(c, "install");
    // :289-295 — `expect_fail` redirected stderr into the same capture.
    const out = result.stdout + result.stderr;
    // :629
    assert.notEqual(
      result.status,
      0,
      `expected install to fail but it succeeded:\n${out}`,
    );
    // :630-631 — the recovery message must name the root it failed to add AND
    // the previous root it already removed (src/adapter.ts:610-617).
    assert.ok(out.includes(`plugin marketplace add ${c.pkg}`), out);
    assert.ok(out.includes(otherRoot), out);
    // :632-634
    const codex = nonEmpty(readLog(c.codexLog), "codex");
    assert.ok(
      !has(codex, "plugin add superpowers@superpowers-manager"),
      `plugin add must not run after a failed marketplace add:\n${codex.join("\n")}`,
    );
  });

  void test("a malformed marketplace listing aborts before any mutation (:636-646)", async () => {
    const c = installCase({
      // Seam-dependent through prepareGeneratedTree, which reads adapter.log
      // to prove prepare did not inspect update control.
      seamDependency: { reason: "log", script: "install" },
    });
    await prepareGeneratedTree(c);
    // :640
    writeFileSync(join(c.state, "marketplace_list.json"), "not json {{{\n");
    clearLogs(c);
    const result = await runScript(c, "install");
    const out = result.stdout + result.stderr;
    // :641
    assert.notEqual(
      result.status,
      0,
      `expected install to fail but it succeeded:\n${out}`,
    );
    // :642-646
    const codex = nonEmpty(readLog(c.codexLog), "codex");
    assert.deepEqual(
      codex.filter((line) => PARSE_ABORT_MUTATION.test(line)),
      [],
      "parse failure must abort before any mutation",
    );
  });

  void test("a plugin add that refreshes nothing fails verification (:648-659)", async () => {
    const c = installCase({
      config: { pluginAdd: "noop" },
      // Seam-dependent through prepareGeneratedTree, which reads adapter.log
      // to prove prepare did not inspect update control.
      seamDependency: { reason: "log", script: "install" },
    }); // :653
    await prepareGeneratedTree(c);
    clearLogs(c);
    const result = await runScript(c, "install");
    const out = result.stdout + result.stderr;
    // :654
    assert.notEqual(
      result.status,
      0,
      `expected install to fail but it succeeded:\n${out}`,
    );
    // :655
    assert.ok(out.includes("fingerprint is not detectable"), out);
    // :656
    assertTmpEmpty(c);
    // :657-659 — non-vacuous: :655 proves `out` carries the subject's
    // verification diagnostics.
    assert.ok(
      !out.includes("manager updated"),
      `must not print success when the installed manager is undetectable:\n${out}`,
    );
  });

  void test("a stale installed fingerprint fails, with the retry hint from the adapter result (:661-674)", async () => {
    const c = installCase({
      config: { pluginAdd: "stale" },
      // Seam-dependent through prepareGeneratedTree, which reads adapter.log
      // to prove prepare did not inspect update control.
      seamDependency: { reason: "log", script: "install" },
    }); // :668
    await prepareGeneratedTree(c);
    clearLogs(c);
    const result = await runScript(c, "install");
    const out = result.stdout + result.stderr;
    // :669
    assert.notEqual(
      result.status,
      0,
      `expected install to fail but it succeeded:\n${out}`,
    );
    // :670
    assert.ok(out.includes("does not match the prepared plugin"), out);
    // :671 — the hint text lives in src/adapter.ts:641-643 and is replayed
    // from the adapter result by scripts/core/lifecycle.sh:109,121; core owns
    // no copy of it.
    assert.ok(out.includes("SUPERPOWERS_INSTALL_REFRESH_MODE=remove-add"), out);
    // :672-674
    assert.ok(
      !out.includes("manager updated"),
      `must not print success while stale:\n${out}`,
    );
  });

  void test("the missing-fingerprint replay hint also comes only from the adapter result (:676-685)", async () => {
    const c = installCase({
      config: { pluginAdd: "noop" },
      // Seam-dependent through prepareGeneratedTree, which reads adapter.log
      // to prove prepare did not inspect update control.
      seamDependency: { reason: "log", script: "install" },
    }); // :682
    await prepareGeneratedTree(c);
    clearLogs(c);
    const result = await runScript(c, "install");
    const out = result.stdout + result.stderr;
    // :683
    assert.notEqual(
      result.status,
      0,
      `expected install to fail but it succeeded:\n${out}`,
    );
    // :684
    assert.ok(out.includes("fingerprint is not detectable"), out);
    // :685 — src/adapter.ts:645, replayed through the install result.
    assert.ok(out.includes("verify with 'codex plugin list --json'"), out);
  });

  void test("a failed fingerprint inspection is reported as an inspection failure (:687-700)", async () => {
    // Re-based off the SPW_ADAPTER seam, and off a needle that did not prove
    // its claim. The shell fixture made the FAKE adapter print
    // "fingerprint inspection failed in adapter fixture" and exit 99, so :695's
    // `out.includes("fingerprint inspection")` matched the fixture's own stderr
    // line — tests/migration-inventory/install-commands.md:704-714 records this
    // as item 104: it proves the string appears, not that the subject produced
    // it.
    //
    // The lower lever is the fake CODEX. `pluginAdd: "orphan"` registers the
    // plugin as installed at 1.0.0 without materialising its cached tree, so
    // the REAL adapter's fingerprint handler resolves an active version
    // (src/adapter.ts:790-797), builds the installed root for it (:815-820),
    // and finds nothing readable there — installedCommitFromRoot returns ""
    // (src/codex-state.ts:67-84) — and fails with a controlled inspect-failed
    // envelope. The case therefore needs no interception and is not
    // seam-dependent.
    const c = installCase({
      config: { pluginAdd: "orphan" },
      // Seam-dependent through prepareGeneratedTree, which reads adapter.log
      // to prove prepare did not inspect update control.
      seamDependency: { reason: "log", script: "install" },
    }); // :693
    await prepareGeneratedTree(c);
    clearLogs(c);
    const result = await runScript(c, "install");
    const out = result.stdout + result.stderr;
    // :694
    assert.notEqual(
      result.status,
      0,
      `expected install to fail but it succeeded:\n${out}`,
    );
    // :695, re-anchored onto the SUBJECT's own diagnostic at
    // scripts/core/lifecycle.sh:92, whole-line so no substring of a longer
    // adapter or fixture message can satisfy it.
    assert.ok(
      hasLine(
        out,
        "error: installed manager fingerprint inspection failed after install.",
      ),
      out,
    );
    // :696-700 — two independent greps, now non-vacuous because the assertion
    // above proves `out` carries the subject's verification diagnostics.
    assert.ok(
      !out.includes("fingerprint is not detectable"),
      `unverifiable fingerprint state must not be reported as absence:\n${out}`,
    );
    assert.ok(
      !out.includes("manager updated"),
      `unverifiable fingerprint state must not be reported as success:\n${out}`,
    );
  });

  void test("malformed fingerprint output is rejected by response validation (:702-716)", async () => {
    // Stays on `intercept`, and no lower lever is wanted: a bare `{` on stdout
    // is a PROTOCOL-level fault. The real adapter always emits a well-formed
    // envelope, so nothing the fake Codex can do reaches this branch.
    const c = installCase({
      config: { fingerprintInspect: "malformed" }, // :708
      adapterSeam: "intercept",
      seamDependency: { reason: "intercept", script: "install" },
    });
    await prepareGeneratedTree(c);
    clearLogs(c);
    const result = await runScript(c, "install");
    const out = result.stdout + result.stderr;
    // :709
    assert.notEqual(
      result.status,
      0,
      `expected install to fail but it succeeded:\n${out}`,
    );
    // :710
    assert.ok(out.includes("invalid adapter response"), out);
    // :711
    assert.ok(out.includes("fingerprint inspection"), out);
    // :712-716
    assert.ok(
      !out.includes("fingerprint is not detectable"),
      `unverifiable fingerprint state must not be reported as absence:\n${out}`,
    );
    assert.ok(
      !out.includes("manager updated"),
      `unverifiable fingerprint state must not be reported as success:\n${out}`,
    );
  });

  void test("remove-add refresh mode removes the plugin between reconcile and add (:718-736)", async () => {
    const c = installCase({
      // Seam-dependent through prepareGeneratedTree, which reads adapter.log
      // to prove prepare did not inspect update control.
      seamDependency: { reason: "log", script: "install" },
    });
    await prepareGeneratedTree(c);
    clearLogs(c);
    // :724 — src/adapter.ts:533 reads this; `add-only` is the default.
    const result = await runScript(c, "install", {
      env: { SUPERPOWERS_INSTALL_REFRESH_MODE: "remove-add" },
    });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    const codex = readLog(c.codexLog);
    // :725-733 — three ordering claims, one call.
    assertOrder(
      codex,
      [
        "plugin marketplace list",
        `plugin marketplace add ${c.pkg}`,
        "plugin remove superpowers@superpowers-manager",
        "plugin add superpowers@superpowers-manager",
      ],
      "remove-add order must be: marketplace reconcile, plugin remove, plugin add",
    );
    // :734-736 — non-vacuous via assertOrder above.
    assert.ok(
      !has(codex, "openai-curated"),
      `remove-add mode must not touch openai-curated:\n${codex.join("\n")}`,
    );
  });

  void test("an invalid refresh mode makes no Codex mutation (:738-745)", async () => {
    const c = installCase({
      // Seam-dependent through prepareGeneratedTree, which reads adapter.log
      // to prove prepare did not inspect update control.
      seamDependency: { reason: "log", script: "install" },
    });
    await prepareGeneratedTree(c);
    clearLogs(c);
    const result = await runScript(c, "install", {
      env: { SUPERPOWERS_INSTALL_REFRESH_MODE: "bogus" },
    });
    const out = result.stdout + result.stderr;
    // :744
    assert.notEqual(
      result.status,
      0,
      `expected install to fail but it succeeded:\n${out}`,
    );
    // :745
    assertNoCodexMutation(readLog(c.codexLog));
  });

  void test("install remediates malformed generated provenance (:747-768)", async () => {
    const c = installCase({
      // Seam-dependent through prepareGeneratedTree, which reads adapter.log
      // to prove prepare did not inspect update control.
      seamDependency: { reason: "log", script: "install" },
    });
    // The shell's $pkg carried a complete generated tree at this point and
    // corrupted only the provenance file, so the remediation exercised
    // spw_replace_generated_tree's replace-an-existing-tree path
    // (scripts/core/lifecycle.sh:7-26). Building the tree first keeps that.
    await prepareGeneratedTree(c);
    clearLogs(c);
    // :754
    writeFileSync(
      join(c.pkg, "plugins/superpowers/.superpowers-upstream.json"),
      "{\n",
    );
    const result = await runScript(c, "install");
    // :755
    assert.equal(result.status, 0, result.stdout + result.stderr);
    // :756 — `v1.0.0` is the fixture's own tag (lifecycle-fixture.js:118-127),
    // an input this test defines for itself, not a version owned elsewhere.
    assert.ok(result.stdout.includes("prepared v1.0.0"), result.stdout);
    // :757
    assert.ok(result.stdout.includes("manager updated"), result.stdout);
    // :758, re-anchored onto codex.log. `install --package-root ${c.pkg}` is
    // witnessed by the Codex commands that operation issues
    // (src/adapter.ts:575-656): the marketplace add carries the same package
    // root the original needle pinned, and the plugin add is unconditional.
    // clearLogs above means both lines can only have come from this run.
    assertOrder(
      readLog(c.codexLog),
      [
        `plugin marketplace add ${c.pkg}`,
        "plugin add superpowers@superpowers-manager",
      ],
      "remediating install must reconcile via adapter install",
    );
    // :759-768
    assertGeneratedCommitIsSha(c);
  });

  void test("update takes the same remediation path, not the current-state skip (:770-780)", async () => {
    const c = installCase({
      // Seam-dependent through prepareGeneratedTree, which reads adapter.log
      // to prove prepare did not inspect update control.
      seamDependency: { reason: "log", script: "update" },
    });
    await prepareGeneratedTree(c);
    clearLogs(c);
    // :776
    writeFileSync(
      join(c.pkg, "plugins/superpowers/.superpowers-upstream.json"),
      "{\n",
    );
    const result = await runScript(c, "update");
    // :777
    assert.equal(result.status, 0, result.stdout + result.stderr);
    // :778
    assert.ok(result.stdout.includes("prepared v1.0.0"), result.stdout);
    // :779
    assert.ok(result.stdout.includes("manager updated"), result.stdout);
    // :780, re-anchored onto codex.log for the same reason as the case above.
    assertOrder(
      readLog(c.codexLog),
      [
        `plugin marketplace add ${c.pkg}`,
        "plugin add superpowers@superpowers-manager",
      ],
      "remediating update must reconcile via adapter install",
    );
    // Port-only: the shell ran its provenance check only for the install path
    // (:759-768). Update reaches the same remediation through
    // scripts/update:22-25, so the same claim is asserted here.
    assertGeneratedCommitIsSha(c);
  });
});
