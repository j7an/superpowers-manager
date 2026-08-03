// @ts-check
// Port of tests/test_install_commands.sh:9-487 (gating, identity, validation).
// The remaining scenarios (:489-782) are appended to this same describe block
// by the follow-on task, together with the reconciliation inventory.
//
// Cases run concurrently. Every case builds its own package root, state
// directory, logs, and TMPDIR, so none depends on another's cleanup — which is
// why the driver's cross-scenario corrupt-and-restore dance (:418-423,
// :458-467, :475-476) has no counterpart here.

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
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  UPSTREAM,
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

// `^build |^install ` from :445, applied to the adapter log.
const ADAPTER_MUTATION = /^build |^install /;

/**
 * Replaces the driver's `reset` (:226-235) plus the marketplace seeding every
 * scenario in this range either wrote itself (:342, :380, :397, :409, :457,
 * :480) or inherited unchanged from the scenario before it. `reset` never
 * touched marketplace_list.json, so under per-case isolation the ambient value
 * has to be stated instead of inherited.
 * @param {object} [options]
 * @param {Record<string, unknown>} [options.config]
 * @param {string} [options.plugins]
 * @param {string} [options.marketplaces]
 * @returns {import("./lifecycle-fixture.js").CaseEnv}
 */
function installCase(options = {}) {
  const c = createCase({ fakes: "install", config: options.config ?? {} });
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
 * Reconstructs the needs-install precondition the shell driver inherited from
 * the scenario above it: by :394 and :406 the shared `$pkg` already held a
 * valid generated tree, left behind by the successful prepare inside :383.
 * `reset` cleared Codex state but never the package root, so probe reported
 * "needs install" rather than "needs prepare". Under per-case isolation that
 * state has to be built, and running prepare is how the driver built it.
 *
 * prepare never inspects update control (proved by the case at :321-336), so
 * this leaves `update-control-count` untouched and the later count assertions
 * mean what they meant in the shell.
 * @param {import("./lifecycle-fixture.js").CaseEnv} c
 * @returns {Promise<void>}
 */
async function prepareGeneratedTree(c) {
  const result = await runScript(c, "prepare");
  assert.equal(
    result.status,
    0,
    `fixture: prepare must succeed to establish needs-install state:\n${result.stdout}${result.stderr}`,
  );
  assert.ok(
    !existsSync(join(c.state, "update-control-count")),
    "fixture: prepare must not have inspected update control",
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
    const c = installCase({ config: { updateControl: "unsupported" } });
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
    const c = installCase({ config: { updateControl: "unsupported" } });
    seedInstalledCurrent(c); // :341
    const result = await runScript(c, "update");
    const out = result.stdout + result.stderr;
    // :344
    assert.notEqual(result.status, 0, `expected update to fail:\n${out}`);
    // :345
    assert.ok(
      out.includes("adapter cannot guarantee manager-controlled updates"),
      out,
    );
    // :346 — non-vacuous: the assertion above proves `out` carries the
    // subject's diagnostics.
    assert.ok(
      !out.includes("manager is current"),
      "an unsupported adapter must not report the manager as current",
    );
    // :347
    assertNoCodexMutation(readLog(c.codexLog));
  });

  void test("unsupported update control blocks a direct install (:349-352)", async () => {
    const c = installCase({ config: { updateControl: "unsupported" } });
    const result = await runScript(c, "install");
    // :351
    assert.notEqual(
      result.status,
      0,
      `expected install to fail:\n${result.stdout}${result.stderr}`,
    );
    // :352
    assertNoCodexMutation(readLog(c.codexLog));
  });

  void test("malformed update-control output exits exactly 1 (:354-364)", async () => {
    const c = installCase({ config: { updateControl: "malformed" } });
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
    const c = installCase({ config: { updateControl: "failure" } });
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
    const c = installCase();
    await prepareGeneratedTree(c);
    const result = await runScript(c, "install");
    // :398 — captured stdout only, and `set -e` made a non-zero exit fatal.
    assert.equal(result.status, 0, result.stdout + result.stderr);
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
    });
    await prepareGeneratedTree(c);
    const result = await runScript(c, "install");
    // :411-414 — probe saw `managed`; only the second, fresh inspection sees
    // `unsupported`, and it is the one that must stop the install.
    assert.notEqual(
      result.status,
      0,
      `install must reject capability drift before adapter install:\n${result.stdout}${result.stderr}`,
    );
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
    });
    await assertLegacyIdentityStops(c);
  });

  void test("mixed identity state stops before prepare or adapter mutation (:425-451, both)", async () => {
    const c = installCase({ marketplaces: LEGACY_MARKETPLACE });
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
});
