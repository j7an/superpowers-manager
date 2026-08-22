// @ts-check
// Port of tests/test_install_commands.sh (782 lines, deleted in this commit).
// Reconciliation: tests/migration-inventory/install-commands.md
//
// Cases run concurrently. Every case builds its own package root, state
// directory, logs, and TMPDIR, so none depends on another's cleanup — which is
// why the driver's corrupt-and-restore dance (:418-423, :458-467, :475-476)
// has no counterpart here, and why each case must state the preconditions the
// shell inherited from the scenario above it. See the inventory for those.

// Two statements, not one. tests/bin/migration-inventory.test.js:57 matches
// /^import test from "node:test";$/m and asserts it at :529-532, because the
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
  spawnFakeAdapter,
} from "./lifecycle-fixture.js";
import { caseContext, recordingAdapter } from "./command-context.js";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));

// Dynamic, matching tests/unit/commands-install.test.js's own convention:
// these tests run against the BUILT output, not against src/ directly, since
// dist/ is what the packaged CLI ships and what bin/superpowers-manager.js
// resolves at the flip. Task 6 calls these command functions in-process,
// directly, with an injected recording adapter -- the shell is still what
// bin/superpowers-manager.js dispatches to; these specific cases just no
// longer go through it. See tests/bin/command-context.js.
const { runInstall } = await import(
  new URL("../../dist/commands/install.js", import.meta.url).href
);
const { runUpdate } = await import(
  new URL("../../dist/commands/update.js", import.meta.url).href
);
const { runPrepare } = await import(
  new URL("../../dist/commands/prepare.js", import.meta.url).href
);
const { successResult, failureResult } = await import(
  new URL("../../dist/adapter-result.js", import.meta.url).href
);

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
// LEGACY_ONLY_PLUGINS, the BOTH_PLUGINS pair, and LEGACY_MARKETPLACE (:430,
// :434, :437 in the shell original) are gone: the three cases that used them
// to drive the REAL fake adapter's ownership computation now supply
// `identity_state` directly to an injected double (Task 6, D4), so no Codex
// fixture listing is read for that purpose any more.

// `assert_no_codex_mutation` (:313-319) matched with an anchored ERE, so
// "plugin marketplace add" is deliberately not a `^plugin (add|remove) ` hit.
const CODEX_MUTATION =
  /^plugin (add|remove) |^plugin marketplace (add|remove) /;

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
 * @param {string} [options.plugins]
 * @param {string} [options.marketplaces]
 * @returns {import("./lifecycle-fixture.js").CaseEnv}
 */
function installCase(options = {}) {
  const c = createCase({
    fakes: "install",
    config: options.config ?? {},
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
 * Mirrors the one real filesystem side effect the adapter's `build`
 * operation performs that a LATER prepare/install run against the SAME
 * package root depends on: copying the fallback manifest template into the
 * candidate's `.codex-plugin` directory before `atomicReplaceDir` swaps the
 * candidate into `plugins/superpowers` (src/adapter.ts:433-452). The
 * candidate this module's own doubles build never copies
 * `plugin.template.json` itself (src/commands/prepare.ts's COPY_PATHS omits
 * it), so skipping this step here silently deletes it from the package root
 * the moment the swap runs — invisible until a LATER real, shell-spawned
 * prepare re-reads it and fails closed with "missing fallback manifest
 * template", several calls away from the double that dropped it.
 * @param {readonly string[]} argv
 * @returns {void}
 */
function copyFallbackManifestIntoCandidate(argv) {
  const candidateRoot = argv[argv.indexOf("--candidate-root") + 1];
  const fallbackManifest = argv[argv.indexOf("--fallback-manifest") + 1];
  assert.ok(
    candidateRoot,
    `build call missing --candidate-root: ${argv.join(" ")}`,
  );
  assert.ok(
    fallbackManifest,
    `build call missing --fallback-manifest: ${argv.join(" ")}`,
  );
  cpSync(
    fallbackManifest,
    join(candidateRoot, ".codex-plugin", "plugin.template.json"),
  );
}

/**
 * Reconstructs the generated-tree precondition the shell driver inherited from
 * the scenario above it. `src/status.ts:21` returns "needs prepare"
 * whenever the package root carries no `.superpowers-upstream.json`, and
 * lifecycle-fixture.js:50-61 copies only `plugin.template.json` into the
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
 * Converted (Task 6, D4): calls `runPrepare` in-process with its own injected
 * recording adapter. "prepare did not inspect update control" is now a
 * property of the double's own construction — it answers ONLY a `build` call
 * and fails the case by exhaustion on anything else — rather than a read over
 * a log file that stops existing when the seam does. This double is entirely
 * separate from any double the CALLER builds for its own, later, real
 * subject call: the caller's own `c.adapterBin` / `c.codexBin` (used by
 * `runScript`) are untouched by this helper.
 * @param {import("./lifecycle-fixture.js").CaseEnv} c
 * @returns {Promise<void>}
 */
async function prepareGeneratedTree(c) {
  const adapter = recordingAdapter((argv) => {
    assert.equal(
      argv[0],
      "build",
      `fixture: prepare must only ever call adapter build, got: ${argv.join(" ")}`,
    );
    copyFallbackManifestIntoCandidate(argv);
    return successResult("build", {}, []);
  });
  const { ctx, stdout, stderr } = caseContext(c, { adapter });
  const status = await runPrepare([], ctx);
  assert.equal(
    status,
    0,
    `fixture: prepare must succeed to establish the generated tree:\n${stdout()}${stderr()}`,
  );
  // The provenance file is the exact input status.sh reads, and it is also what
  // decides which branch `seedInstalledCurrent` takes.
  assert.ok(
    existsSync(join(c.pkg, "plugins/superpowers/.superpowers-upstream.json")),
    "fixture: prepare did not leave generated provenance in the package root",
  );
  // Non-vacuous AND the negative, in one structural claim: a double that was
  // never called records [], which would satisfy `["build"]` no more than it
  // would satisfy an empty log — deepEqual fails closed on both an absent
  // build call and any unexpected extra call (e.g. an inspect --view
  // update-control this helper's whole point is to rule out).
  assert.deepEqual(
    adapter.calls.map((call) => call[0]),
    ["build"],
    `fixture: prepare must call the adapter exactly once, for build, and ` +
      `nothing else:\n${JSON.stringify(adapter.calls)}`,
  );
}

/**
 * Port-only precondition guard, not a ported assertion.
 *
 * `src/commands/prepare.ts` is the only thing that prints "prepared <ref> at
 * <commit>", and `src/commands/install.ts` runs it only on the needs-prepare
 * branch. Its
 * absence is therefore direct evidence that the subject took the needs-install
 * or current branch — the path the shell driver put it on. Without this guard a
 * lost precondition is invisible: the case still exits non-zero and still
 * carries the gate message, because `src/commands/install.ts` emits the same
 * string from a different branch. That is precisely how the case at :338-347 passed
 * while never entering the update fast path at all.
 *
 * ANCHORED, not a bare substring. `src/commands/prepare.ts` prints its banner
 * at the start of a line, but `src/lifecycle.ts` also carries the word
 * mid-sentence — "does not match the prepared plugin after install." — on
 * stderr. No current call site can see it: the three that pass combined
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
 * The commit prepareGeneratedTree just wrote. Prepare writes
 * provenance.commit = selection.desiredCommit exactly
 * (src/commands/prepare.ts:377-383), so this IS the desired commit for a
 * scenario built right after prepareGeneratedTree(c) -- reading it back is
 * simpler and less error-prone than re-resolving the same ref against
 * UPSTREAM a second time.
 * @param {import("./lifecycle-fixture.js").CaseEnv} c
 * @returns {string}
 */
function readGeneratedCommit(c) {
  const parsed = /** @type {{ commit?: unknown }} */ (
    JSON.parse(
      readFileSync(
        join(c.pkg, "plugins/superpowers/.superpowers-upstream.json"),
        "utf8",
      ),
    )
  );
  assert.equal(
    typeof parsed.commit,
    "string",
    "fixture: generated provenance has no commit",
  );
  return /** @type {string} */ (parsed.commit);
}

/**
 * A recordingAdapter double covering every call install/update/prepare
 * actually issue: inspect fingerprint/ownership/update-control, and adapter
 * install/build. Each field may be a fixed value or a function of the call
 * number FOR THAT VIEW (1-based), so a scenario can answer probe's initial
 * inspection differently from gatherInstallStages' re-inspection. Unlisted
 * operations fail the case by exhaustion rather than silently answering
 * something plausible -- structural coverage, not a log read that stops
 * existing when the seam does.
 * @param {{
 *   fingerprint?: (string | null) | ((call: number) => string | null),
 *   identityState?: string | ((call: number) => string),
 *   updateControl?: string | ((call: number) => string),
 *   install?: (argv: readonly string[]) => unknown,
 *   build?: (argv: readonly string[]) => unknown,
 * }} [scenario]
 */
function scenarioAdapter(scenario = {}) {
  const counters = { fingerprint: 0, identityState: 0, updateControl: 0 };
  /**
   * @param {"fingerprint" | "identityState" | "updateControl"} field
   * @param {unknown} fallback
   * @returns {unknown}
   */
  const resolve = (field, fallback) => {
    counters[field] += 1;
    const configured = scenario[field];
    if (configured === undefined) return fallback;
    return typeof configured === "function"
      ? configured(counters[field])
      : configured;
  };
  return recordingAdapter((argv) => {
    const joined = argv.join(" ");
    if (joined === "inspect --view fingerprint") {
      const fingerprint = resolve("fingerprint", null);
      return successResult("inspect", { view: "fingerprint", fingerprint }, []);
    }
    if (joined === "inspect --view ownership") {
      const identity_state = resolve("identityState", "neither");
      return successResult(
        "inspect",
        { view: "ownership", identity_state },
        [],
      );
    }
    if (joined === "inspect --view update-control") {
      const value = resolve("updateControl", "managed");
      if (value === "failure") {
        return failureResult(
          "inspect",
          "inspect-failed",
          "update-control inspection failed",
          [],
          [],
        );
      }
      return successResult(
        "inspect",
        { view: "update-control", update_control: value },
        [],
      );
    }
    if (argv[0] === "install") {
      return scenario.install
        ? scenario.install(argv)
        : successResult("install", {}, []);
    }
    if (argv[0] === "build") {
      if (!scenario.build) copyFallbackManifestIntoCandidate(argv);
      return scenario.build
        ? scenario.build(argv)
        : successResult("build", {}, []);
    }
    return undefined;
  });
}

/**
 * The loop body at :427-450, shared by the `legacy` and `both` identity
 * states. Converted (Task 6, D4): calls `runInstall` in-process.
 * gatherProbe's own three inspects still run unconditionally, so the double
 * answers all three and `identityState` supplies the value under test.
 * requireNoLegacyState fires immediately after gatherProbe resolves, before
 * any workspace or adapter mutation stage -- so those three calls are the
 * only ones that should ever reach the double.
 * @param {import("./lifecycle-fixture.js").CaseEnv} c
 * @param {string} identityState
 * @returns {Promise<void>}
 */
async function assertLegacyIdentityStops(c, identityState) {
  const adapter = scenarioAdapter({ identityState });
  const { ctx, stdout, stderr } = caseContext(c, { adapter });
  const status = await runInstall([], ctx);
  const out = stdout() + stderr();
  // :438-441
  assert.notEqual(
    status,
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
  // :445-450, now structural rather than an adapter.log read: ownership WAS
  // inspected (non-vacuous hoist, matching the shell's own hoist above the
  // negative) and no call named "build" or "install" ever reached the
  // double. STRONGER than the log negative it replaces: an unexpected extra
  // call now fails the case by exhaustion rather than silently satisfying a
  // substring check. The Codex-level negative (:450) has no replacement --
  // there is no codex.log at all in-process, since nothing here spawns a
  // Codex fake -- but it is subsumed: the double never reaching "install"
  // means the adapter's own unconditional `codex plugin add`
  // (src/adapter.ts:671) was structurally impossible to reach either.
  assert.ok(
    adapter.calls.some((call) => call.join(" ") === "inspect --view ownership"),
    "adapter never inspected ownership, so 'no build or install' would pass vacuously",
  );
  assert.deepEqual(
    adapter.calls.filter(
      (call) => call[0] === "build" || call[0] === "install",
    ),
    [],
    "legacy state must stop before build or install adapter mutation",
  );
}

// `void` for the same reason every `test(` call site carries it: oxlint's
// typescript(no-floating-promises) rule treats the runner's returned promise as
// floating otherwise.
void describe("install commands", { concurrency: true }, () => {
  void test("production sources carry no hook-trust mutation surface (:11-42)", () => {
    // Reads ROOT, not a copied package root: this is a claim about the
    // repository's own production sources, not about a fixture snapshot.
    const productionRoots = [join(ROOT, "src"), join(ROOT, "bin")];
    let scanned = 0;
    for (const productionRoot of productionRoots) {
      const entries = readdirSync(productionRoot, { recursive: true })
        .map(String)
        .sort();
      for (const entry of entries) {
        const path = join(productionRoot, entry);
        if (!statSync(path).isFile()) continue;
        scanned += 1;
        // :27-29 — an unreadable source is a hard failure, never a skip.
        let text = "";
        try {
          text = readFileSync(path, "utf8");
        } catch (error) {
          assert.fail(
            `production source could not be inspected: ${path}: ${String(error)}`,
          );
        }
        // :30-35
        for (const forbidden of FORBIDDEN_LITERALS) {
          assert.ok(
            !text.includes(forbidden),
            `production sources must not contain hook trust mutation surface: ${forbidden} (${path})`,
          );
        }
        // :36-41 — the literal checks deliberately include comments;
        // app-server is allowed only in comments.
        text.split("\n").forEach((line, index) => {
          const trimmed = line.trimStart();
          assert.ok(
            !line.includes("app-server") ||
              trimmed.startsWith("#") ||
              trimmed.startsWith("//") ||
              trimmed.startsWith("*") ||
              trimmed.startsWith("/*"),
            `production sources must not invoke the Codex app-server: ${path}:${index + 1}`,
          );
        });
      }
    }
    assert.ok(
      scanned > 0,
      "src/ and bin/ held no files — the scan proved nothing",
    );
  });

  void test("packaged root preconditions (:77-82)", () => {
    const c = installCase();
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
  });

  void test("prepare is capability-independent (:321-336)", async () => {
    // Converted (Task 6, D4): calls `runPrepare` in-process. The old
    // `updateControl: "unsupported"` fixture config is gone along with it --
    // it was always inert here (prepare never asks for update control) and
    // only mattered to a fake adapter this case no longer spawns. The double
    // below proves the same three properties structurally: it answers ONLY a
    // `build` call and fails the case by exhaustion on anything else,
    // including `inspect --view update-control` (:326-330) and
    // `install --package-root` (:331-335). :336's "prepare makes no Codex
    // call whatsoever" is now subsumed rather than separately witnessed:
    // there is no codex.log at all in-process, since nothing here spawns a
    // Codex fake, and the double's own exhaustiveness already proves prepare
    // issues no OTHER adapter call either.
    const c = installCase();
    const adapter = recordingAdapter((argv) => {
      assert.equal(
        argv[0],
        "build",
        `prepare must only ever call adapter build, got: ${argv.join(" ")}`,
      );
      copyFallbackManifestIntoCandidate(argv);
      return successResult("build", {}, []);
    });
    const { ctx, stdout, stderr } = caseContext(c, { adapter });
    const status = await runPrepare([], ctx);
    assert.equal(status, 0, stdout() + stderr());
    // Non-vacuous AND the negatives, in one structural claim.
    assert.deepEqual(
      adapter.calls.map((call) => call[0]),
      ["build"],
      `prepare must call the adapter exactly once, for build, and nothing ` +
        `else:\n${JSON.stringify(adapter.calls)}`,
    );
  });

  void test("unsupported update control blocks the update fast path (:338-347)", async () => {
    // Converted (Task 6, D4): calls `runUpdate` in-process, with a double
    // answering `unsupported` where the shell fixture's `updateControl`
    // config used to. The double is reachable through the real production
    // switch (src/lifecycle.ts's requireManagedUpdateControl), so the
    // contract survives the seam's removal unchanged.
    const c = installCase();
    // The generated tree, established in-process. Without it the package
    // root probes as "needs prepare" and `scripts/update` never reaches its
    // `current)` branch — the only branch that can print "manager is
    // current" — so the negative below could not fail.
    await prepareGeneratedTree(c);
    const commit = readGeneratedCommit(c);
    const adapter = scenarioAdapter({
      // "current": the installed fingerprint matches the generated commit.
      // Replaces `seedInstalledCurrent(c)`, which drove the same precondition
      // through a real fake Codex cache this case no longer spawns.
      fingerprint: commit,
      updateControl: "unsupported",
    });
    const { ctx, stdout, stderr } = caseContext(c, { adapter });
    const status = await runUpdate([], ctx);
    const out = stdout() + stderr();
    // :344
    assert.notEqual(status, 0, `expected update to fail:\n${out}`);
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
    // :347, now structural: no call named "install" or "build" ever reached
    // the double -- both calls that must precede any Codex mutation --
    // STRONGER than the codex.log read it replaces, because an unexpected
    // extra call now fails the case by exhaustion instead of silently
    // satisfying a substring check.
    assert.deepEqual(
      adapter.calls.filter(
        (call) => call[0] === "install" || call[0] === "build",
      ),
      [],
      "an unsupported adapter must not reach any mutation call",
    );
  });

  void test("unsupported update control blocks a direct install (:349-352)", async () => {
    // Converted (Task 6, D4): calls `runInstall` in-process.
    const c = installCase();
    // The shell reached this gate on the needs-install path: `reset` cleared
    // the Codex cache but left the generated tree from :325 in $pkg. Here,
    // fingerprint defaults to null (no active install), which is exactly the
    // needs-install precondition given the generated tree just below.
    await prepareGeneratedTree(c);
    const adapter = scenarioAdapter({ updateControl: "unsupported" });
    const { ctx, stdout, stderr } = caseContext(c, { adapter });
    const status = await runInstall([], ctx);
    const out = stdout() + stderr();
    // :351
    assert.notEqual(status, 0, `expected install to fail:\n${out}`);
    // Precondition: the prepare-less install path the shell covered here.
    assertNoPrepareRan(out);
    // :352, structural for the same reason as the case above.
    assert.deepEqual(
      adapter.calls.filter(
        (call) => call[0] === "install" || call[0] === "build",
      ),
      [],
      "an unsupported adapter must not reach any mutation call",
    );
  });

  // "malformed update-control output exits exactly 1" (:354-364) is RETIRED
  // at the gap: tests/migration-inventory/install-commands.md items 22-24.
  // Its subject -- an adapter transport emitting non-JSON bytes across a
  // process boundary -- cannot occur through `ctx.adapter`, an in-process
  // function call that returns an already-typed AdapterResult with no
  // serialization step to corrupt. See the inventory for the full reasoning.

  void test("failed update-control inspection exits exactly 1 (:366-375)", async () => {
    // Converted (Task 6, D4): calls `runUpdate` in-process. `updateControl:
    // "failure"` is a well-formed ok:false outcome
    // (src/adapter-result.js's failureResult) -- reachable through a
    // double exactly as it was through the fixture, unlike the genuinely
    // malformed cases retired below.
    const c = installCase();
    const adapter = scenarioAdapter({ updateControl: "failure" });
    const { ctx, stdout, stderr } = caseContext(c, { adapter });
    const status = await runUpdate([], ctx);
    // :368-374
    assert.equal(
      status,
      1,
      `failed adapter response must exit 1:\n${stdout()}${stderr()}`,
    );
    // :375, structural: no call named "install" or "build" ever reached the
    // double.
    assert.deepEqual(
      adapter.calls.filter(
        (call) => call[0] === "install" || call[0] === "build",
      ),
      [],
      "a failed update-control inspection must stop before any mutation",
    );
  });

  void test("needs-prepare install reinspects after prepare and rejects drift (:377-392)", async () => {
    // Converted (Task 6, D4): calls `runInstall` in-process. `runInstall`
    // calls `runPrepare` internally on the needs-prepare branch, through the
    // SAME ctx.adapter -- so the double below also answers `build`.
    const c = installCase();
    // :381 — malformed generated provenance forces the needs-prepare path.
    writeFileSync(
      join(c.pkg, "plugins/superpowers/.superpowers-upstream.json"),
      "{\n",
    );
    const adapter = scenarioAdapter({
      // managed-then-unsupported: the initial probe sees "managed"; only the
      // SECOND, fresh inspection (inside gatherInstallStages, after prepare
      // runs) sees "unsupported" -- the drift this case exists to catch.
      updateControl: (call) => (call === 1 ? "managed" : "unsupported"),
    });
    const { ctx, stdout, stderr } = caseContext(c, { adapter });
    const status = await runInstall([], ctx);
    const out = stdout() + stderr();
    // :383-386
    assert.notEqual(
      status,
      0,
      `install must reject capability drift after prepare:\n${out}`,
    );
    // :387
    assert.ok(out.includes("prepared v1.0.0"), out);
    // :388, structural: exactly two update-control inspections.
    assert.equal(
      adapter.calls.filter(
        (call) => call.join(" ") === "inspect --view update-control",
      ).length,
      2,
    );
    // :389-391, over the double's own call order rather than a log file.
    const calls = adapter.calls.map((call) => call.join(" "));
    const buildLine = firstIndex(calls, "build");
    const secondControlLine = lastIndex(calls, "inspect --view update-control");
    assert.notEqual(buildLine, -1, JSON.stringify(calls));
    assert.ok(
      buildLine < secondControlLine,
      `update control must be reinspected after prepare:\n${JSON.stringify(calls)}`,
    );
    // :392, structural: install's own mutation call must never be reached.
    assert.ok(
      !adapter.calls.some((call) => call[0] === "install"),
      "capability drift after prepare must stop before adapter install",
    );
  });

  void test("needs-install path inspects ownership then update control, then installs (:394-404)", async () => {
    // Converted (Task 6, D4): calls `runInstall` in-process. The interceptor's
    // on-disk counter is gone; the double's own call list supplies the count
    // directly.
    const c = installCase();
    await prepareGeneratedTree(c);
    const commit = readGeneratedCommit(c);
    let fingerprintCalls = 0;
    const adapter = scenarioAdapter({
      fingerprint: () => {
        fingerprintCalls += 1;
        // First call is probe's own, before any mutation: null (nothing
        // installed yet, the needs-install precondition). Second is
        // gatherInstallStages' post-install verification: the commit adapter
        // install "took".
        return fingerprintCalls === 1 ? null : commit;
      },
    });
    const { ctx, stdout, stderr } = caseContext(c, { adapter });
    const status = await runInstall([], ctx);
    // :398 — captured stdout only, and `set -e` made a non-zero exit fatal.
    assert.equal(status, 0, stdout() + stderr());
    // Precondition: this is the needs-install path the case is named for.
    assertNoPrepareRan(stdout());
    // :399, structural: exactly two update-control inspections.
    assert.equal(
      adapter.calls.filter(
        (call) => call.join(" ") === "inspect --view update-control",
      ).length,
      2,
    );
    // :400-404, over the double's own call order.
    const calls = adapter.calls.map((call) => call.join(" "));
    const lastOwnership = lastIndex(calls, "inspect --view ownership");
    const lastControl = lastIndex(calls, "inspect --view update-control");
    const installLine = firstIndex(calls, `install --package-root ${c.pkg}`);
    assert.notEqual(installLine, -1, JSON.stringify(calls));
    assert.ok(
      lastOwnership < lastControl,
      `fresh ownership inspection must precede update-control gate:\n${JSON.stringify(calls)}`,
    );
    assert.ok(
      lastControl < installLine,
      `fresh update-control gate must precede adapter install:\n${JSON.stringify(calls)}`,
    );
  });

  void test("the fresh gate, not the initial probe, controls mutation authority (:406-416)", async () => {
    // Converted (Task 6, D4): calls `runInstall` in-process.
    const c = installCase();
    await prepareGeneratedTree(c);
    const adapter = scenarioAdapter({
      updateControl: (call) => (call === 1 ? "managed" : "unsupported"),
    });
    const { ctx, stdout, stderr } = caseContext(c, { adapter });
    const status = await runInstall([], ctx);
    const out = stdout() + stderr();
    // :411-414 — probe saw `managed`; only the second, fresh inspection sees
    // `unsupported`, and it is the one that must stop the install.
    assert.notEqual(
      status,
      0,
      `install must reject capability drift before adapter install:\n${out}`,
    );
    // Precondition: the needs-install gate, which is what distinguishes this
    // case from the needs-prepare drift case at :377-392.
    assertNoPrepareRan(out);
    // :415, structural: exactly two update-control inspections.
    assert.equal(
      adapter.calls.filter(
        (call) => call.join(" ") === "inspect --view update-control",
      ).length,
      2,
    );
    // :416, structural: no call named "install" ever reached the double.
    assert.ok(
      !adapter.calls.some((call) => call[0] === "install"),
      "capability drift must stop before adapter install",
    );
  });

  void test("legacy identity state stops before prepare or adapter mutation (:425-451, legacy)", async () => {
    // :429-430 — converted (Task 6, D4): the fixture plugin/marketplace
    // listings that used to drive the real fake adapter's ownership
    // computation are gone; `assertLegacyIdentityStops` now supplies
    // `identity_state` directly to its own injected double.
    const c = installCase();
    await assertLegacyIdentityStops(c, "legacy");
  });

  void test("mixed identity state stops before prepare or adapter mutation (:425-451, both)", async () => {
    const c = installCase();
    await assertLegacyIdentityStops(c, "both");
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
    const c = installCase();
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
    // the three commands below (src/adapter.ts:591-672), and the second of them
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
    const c = installCase();
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
    const c = installCase();
    await prepareGeneratedTree(c);
    // :558-559 — a symlink to this case's own package root, registered as the
    // marketplace root. Portable stand-in for macOS /var vs /private/var:
    // src/adapter.ts:626 compares the two through `pathsEqual`, so a
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
    const c = installCase();
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
    const c = installCase();
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
    // `codex plugin add superpowers@superpowers-manager` (src/adapter.ts:671),
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
    // Converted (Task 6, D4): calls `runUpdate` in-process, the same
    // treatment as `assertLegacyIdentityStops`. The fixture plugin/
    // marketplace listings that used to drive the real fake adapter's
    // ownership computation are gone; the double supplies `identity_state`
    // directly.
    const c = installCase();
    await prepareGeneratedTree(c);
    const commit = readGeneratedCommit(c);
    const adapter = scenarioAdapter({
      // "current", even though this case never reaches the branch that would
      // report it as such -- the legacy check runs first, which is the
      // property "even when the fingerprint is current" names.
      fingerprint: commit,
      identityState: "both",
    });
    const { ctx, stdout, stderr } = caseContext(c, { adapter });
    const status = await runUpdate([], ctx);
    const out = stdout() + stderr();
    // :610-613
    assert.notEqual(
      status,
      0,
      `current update must reject mixed legacy state:\n${out}`,
    );
    // :614 — whole-line match, as `grep -Fxq` was.
    assert.ok(hasLine(out, "Then run: npx superpowers-manager install"), out);
    // :615-619, now structural: ownership WAS inspected (non-vacuous hoist)
    // and no call named "build" or "install" ever reached the double.
    assert.ok(
      adapter.calls.some(
        (call) => call.join(" ") === "inspect --view ownership",
      ),
      "adapter never inspected ownership, so 'no build or install' would pass vacuously",
    );
    assert.deepEqual(
      adapter.calls.filter(
        (call) => call[0] === "build" || call[0] === "install",
      ),
      [],
      "mixed legacy state must stop update before build or install",
    );
  });

  void test("a failed marketplace add after a successful remove never reaches plugin add (:622-634)", async () => {
    const c = installCase({
      config: { marketplaceAdd: "fail" },
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
    // the previous root it already removed (src/adapter.ts:650-657).
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
    const c = installCase();
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
    // :671 — the hint text lives in src/adapter.ts:681-683 and is replayed
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
    // :685 — src/adapter.ts:685, replayed through the install result.
    assert.ok(out.includes("verify with 'codex plugin list --json'"), out);
  });

  void test("a failed fingerprint inspection is reported as an inspection failure (:687-700)", async () => {
    // Re-based off the SPW_ADAPTER seam, and off a needle that did not prove
    // its claim. The shell fixture made the FAKE adapter print
    // "fingerprint inspection failed in adapter fixture" and exit 99, so :695's
    // `out.includes("fingerprint inspection")` matched the fixture's own stderr
    // line — tests/migration-inventory/install-commands.md:588 records this
    // as item 104: it proves the string appears, not that the subject produced
    // it.
    //
    // The lower lever is the fake CODEX. `pluginAdd: "orphan"` registers the
    // plugin as installed at 1.0.0 without materialising its cached tree, so
    // the REAL adapter's fingerprint handler resolves an active version
    // (src/adapter.ts:806-813), builds the installed root for it (:831-836),
    // and finds nothing readable there — installedCommitFromRoot returns ""
    // (src/codex-state.ts:67-84) — and fails with a controlled inspect-failed
    // outcome. The case therefore needs no interception and is not
    // seam-dependent.
    const c = installCase({
      config: { pluginAdd: "orphan" },
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

  // "malformed fingerprint output is rejected by response validation"
  // (:702-716) is RETIRED at the gap: tests/migration-inventory/
  // install-commands.md items 107-111. Same as items 22-24 above: a bare `{`
  // on stdout is a transport-level fault with no analogue through
  // `ctx.adapter`, which returns an already-typed AdapterResult with nothing
  // to garble in between.

  void test("remove-add refresh mode removes the plugin between reconcile and add (:718-736)", async () => {
    const c = installCase();
    await prepareGeneratedTree(c);
    clearLogs(c);
    // :724 — src/adapter.ts:573 reads this; `add-only` is the default.
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
    const c = installCase();
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
    const c = installCase();
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
    // :756 — `v1.0.0` is the fixture's own tag (lifecycle-fixture.js:120-129),
    // an input this test defines for itself, not a version owned elsewhere.
    assert.ok(result.stdout.includes("prepared v1.0.0"), result.stdout);
    // :757
    assert.ok(result.stdout.includes("manager updated"), result.stdout);
    // :758, re-anchored onto codex.log. `install --package-root ${c.pkg}` is
    // witnessed by the Codex commands that operation issues
    // (src/adapter.ts:591-672): the marketplace add carries the same package
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
    const c = installCase();
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

  // Port-only (no shell original): row 18's first genuine consumer. The shell
  // had no in-process subject to guard, so this case has nothing to port —
  // see tests/migration-inventory/install-commands.md's port-only section.
  // Appended at the end of the file, rather than beside the fresh-install
  // case it is thematically closest to, so it does not shift the line number
  // of any existing item — most of this inventory's `Port:` pointers are
  // already stale (see the file's own POINTER PROVENANCE note) and inserting
  // in the middle would silently break the ones that are not.
  //
  // The subject must not reach the fake adapter at all. install-fakes.js's
  // adapter role refuses unconditionally (tests/bin/lifecycle-fakes.js's
  // tripwireTriggered). What the SUBJECT does is unaffected: it dispatches
  // in-process, and the SPW_ADAPTER seam runScript once defaulted was retired
  // together with the fixture machinery that selected the fake's behaviour.
  //
  // The case therefore asserts two halves, and the second is what makes the
  // first mean anything. A regression that made the port spawn the adapter
  // again would leave a line in adapter.log and the tripwire's message on
  // stderr — but `readLog` returns [] for a missing file, so the emptiness
  // check alone would also pass if the tripwire had been disarmed, or if
  // c.adapterLog were simply not the path this case's fake writes to. The
  // armed-witness half runs that fake for real, through the same executable
  // and environment a regressed spawn would have used, and pins the refusal
  // it produces. Disarm the tripwire and the witness dies; that is the
  // property the emptiness check borrows.
  void test("fresh install never reaches the fake adapter (row 18)", async () => {
    const c = installCase();
    const result = await runScript(c, "install");
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.deepEqual(
      readLog(c.adapterLog),
      [],
      "the in-process port must never reach the fake adapter executable",
    );
    assert.ok(
      !result.stderr.includes("must not spawn the adapter"),
      `the tripwire's own message leaked onto the subject's stderr:\n${result.stderr}`,
    );
    // Armed witness, after the emptiness assertion above and never before it:
    // this call is the one thing in the case that writes to c.adapterLog.
    const witness = spawnFakeAdapter(c, ["inspect", "--view", "ownership"]);
    assert.equal(
      witness.status,
      94,
      `the armed tripwire did not refuse a real spawn of this case's fake adapter:\n${witness.stderr}`,
    );
    assert.equal(
      witness.stderr,
      "fixture: install must not spawn the adapter\n",
    );
    assert.deepEqual(
      readLog(c.adapterLog),
      ["inspect --view ownership"],
      "c.adapterLog is not the path this case's fake adapter records to, so the emptiness assertion above proves nothing",
    );
  });
});
