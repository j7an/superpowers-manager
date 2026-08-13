// @ts-check
// Port of tests/test_uninstall_commands.sh (457 lines, deleted in this commit).
// Reconciliation: tests/migration-inventory/uninstall-commands.md
//
// Cases run concurrently. Every case builds its own package root, state
// directory, logs, and TMPDIR, so none depends on another's cleanup.

// Two statements, not one. tests/bin/migration-inventory.test.js:57 matches
// /^import test from "node:test";$/m and asserts it at :529-532, because the
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
  spawnFakeAdapter,
} from "./lifecycle-fixture.js";
import { caseContext, recordingAdapter } from "./command-context.js";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));

// Dynamic, matching tests/unit/commands-uninstall.test.js's own convention:
// these tests run against the BUILT output. Task 6 calls `runUninstall`
// in-process, directly, with an injected recording adapter for the seam-
// dependent cases below -- the shell is still what
// bin/superpowers-manager.js dispatches to; these specific cases just no
// longer go through it. See tests/bin/command-context.js.
const { runUninstall } = await import(
  new URL("../../dist/commands/uninstall.js", import.meta.url).href
);
const { successResult, failureResult } = await import(
  new URL("../../dist/adapter-protocol.js", import.meta.url).href
);

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
 * then one `codex plugin marketplace list --json` (src/adapter.ts:871, :883).
 * Counting the plugin listing alone is unambiguous: `plugin marketplace list
 * --json` does not contain it as a substring, and nothing else in
 * `src/commands/uninstall.ts`'s ownership-inspect / adapter-uninstall /
 * re-inspect sequence issues either listing.
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
 * `src/commands/uninstall.ts` brackets adapter uninstall between two ownership
 * inspections and reaches the second one only if the adapter uninstall
 * returned 0. So exactly one ownership inspection at the
 * Codex level means the flow never got past the first one.
 *
 * WHAT THIS CATCHES, precisely — the re-anchor is not the original assertion,
 * and the difference is worth stating rather than glossing. Paired with the
 * `assertNoRemoves(readLog(c.codexLog))` every call site already makes, it
 * rejects every adapter uninstall that either issued a Codex command (any flag
 * `true` reaches `plugin remove` or `plugin marketplace remove`) or ran to
 * completion (both flags `false` returns 0 and produces the second
 * inspection).
 *
 * WHAT IT DOES NOT CATCH: an adapter uninstall that was invoked and then failed
 * before issuing any Codex command — `requireCodex` or the workspace creation
 * failing inside `runUninstall` (src/adapter.ts:713-719). That leaves one
 * inspection and no removes, and passes here where the shell's
 * `grep -Fq "uninstall --"` would have failed. The gap is narrow rather than
 * theoretical, and it is accepted only because in all six call sites the abort
 * provably happens inside the FIRST ownership inspection — upstream of
 * adapter-uninstall step entirely — which each case's own subject diagnostic
 * pins.
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
 * in `src/commands/uninstall.ts` exists only on that path.
 *
 * It is an ORDERING witness, not a call witness: two inspections do not by
 * themselves prove the adapter-uninstall step ran, since the before and after
 * inspections emit one each.
 * Which flags the operation carried — and, for the both-`false` pair, that it
 * was called at all — is pinned separately at each call site, by the Codex
 * removes that appeared or by the operation's own skip lines on stdout
 * (src/adapter.ts:740, :757).
 *
 * No emptiness guard: this is a positive with an exact count, so an empty log
 * fails it rather than satisfying it.
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
    const uninstall = readFileSync(
      join(ROOT, "src", "commands", "uninstall.ts"),
      "utf8",
    );
    assert.ok(
      !/\brunAdapter\b|\bSPW_ADAPTER\b/.test(uninstall),
      "public uninstall must hold no Codex-adapter implementation or environment seam",
    );
    // :13-16
    const lifecycle = readFileSync(join(ROOT, "src", "lifecycle.ts"), "utf8");
    assert.ok(
      !/SPW_PLUGIN_ID|SPW_MARKETPLACE_NAME/.test(lifecycle),
      "shared lifecycle code must not reference Codex-owned identifiers",
    );
  });

  void test("selection-independent recovery: malformed selection, no git, unsupported update control (:162-190)", async () => {
    // Converted (Task 6, D4): calls `runUninstall` in-process. The old
    // `updateControl: "unsupported"` fixture config is gone along with it:
    // `runUninstall` (src/commands/uninstall.ts) never calls gatherProbe and
    // structurally never issues an `inspect --view update-control` call at
    // all -- unlike install/update, it does not route through gatherProbe --
    // so the property this case names ("uninstall must not inspect update
    // control") is now a fact about which operations the double answers
    // (ownership and uninstall only), not about a fixture value that used to
    // make a fake adapter refuse to answer that call.
    //
    // The malformed saved selection and the git-less PATH are kept for the
    // same reason the case is named "selection-independent": uninstall reads
    // neither (gatherUninstall never calls computeEffectiveSelection or runs
    // git), so proving it succeeds despite both is still meaningful
    // documentation even though the in-process double below does not route
    // through either mechanism.
    const c = uninstallCase({});
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

    let ownershipCalls = 0;
    const adapter = recordingAdapter((argv) => {
      const joined = argv.join(" ");
      if (joined === "inspect --view ownership") {
        ownershipCalls += 1;
        // First call is pre-removal (both present); second is verify-after,
        // post-removal (src/commands/uninstall.ts's own second inspection) --
        // both flipped to false is what lets `verifyUninstalledResources`
        // succeed.
        const present = ownershipCalls === 1;
        return successResult(
          "inspect",
          {
            view: "ownership",
            resources: { plugin: present, marketplace: present },
            legacy_resources: { plugin: false, marketplace: false },
            identity_state: present ? "manager" : "neither",
          },
          [],
        );
      }
      if (
        joined === "uninstall --plugin-present true --marketplace-present true"
      ) {
        return successResult("uninstall", {}, []);
      }
      return undefined;
    });
    const { ctx, stdout, stderr } = caseContext(c, {
      adapter,
      env: { PATH: noGit },
    });
    const status = await runUninstall([], ctx);
    const out = stdout() + stderr();
    assert.equal(status, 0, out);
    // :183-184, :185-189 combined, structural: the double answers exactly
    // ownership, then uninstall (with both flags true, which is what issues
    // the two Codex removes on the real adapter), then ownership again --
    // and nothing else, including "inspect --view update-control".
    assert.deepEqual(
      adapter.calls.map((call) => call.join(" ")),
      [
        "inspect --view ownership",
        "uninstall --plugin-present true --marketplace-present true",
        "inspect --view ownership",
      ],
      "uninstall must not inspect update control -- structurally, it never issues that call at all",
    );
    // :190
    assert.ok(out.includes("uninstall complete"), out);
  });

  // Rewritten in place at PR 11.5 slice 4b, Task 8. Items 7, 8 and 9 are
  // RETIRED at the gap in tests/migration-inventory/uninstall-commands.md: the
  // shell's `spw_require_command python3` (scripts/uninstall:10) has no port,
  // and `COMMAND_REQUIREMENTS.uninstall` drops from `["python3", "codex"]` to
  // `["codex"]` at the flip, because `python3` was only ever required so
  // `spw_invoke_adapter` could run validate-adapter-response.py per call
  // (scripts/core/adapter.sh:37-44). The condition those three items asserted —
  // uninstall fails, names python3, and reaches no Codex — can no longer occur
  // in either direction, and its inverse is a wholly new property with no shell
  // counterpart, so this case is kept as one `test(` site carrying the
  // successor instead of being deleted.
  //
  // The PATH-stripping is unchanged and still load-bearing: it is what makes
  // `python3`'s absence real rather than declared, and it is also the case that
  // proves runScript's retarget onto `process.execPath` kept the absolute-path
  // property the old `/bin/sh` launch had (a bare `node` would not resolve
  // through a PATH holding only `dirname`).
  void test("no python3 on PATH: uninstall runs anyway and reaches Codex (:192-212 retired)", async () => {
    // The default fixture state: the manager plugin and marketplace both
    // present, so the run has real removals to make and the sequence below is
    // the full one rather than a pair of skips.
    const c = uninstallCase({});
    const stripped = join(c.dir, "no-python");
    mkdirSync(stripped, { recursive: true });
    symlinkSync("/usr/bin/dirname", join(stripped, "dirname"));
    const result = await runScript(c, "uninstall", { path: stripped });
    const out = result.stdout + result.stderr;
    assert.equal(result.status, 0, out);
    // The successor to item 8: the diagnostic it pinned must be ABSENT, and
    // that absence is non-vacuous because the Codex sequence below proves the
    // run got all the way through.
    assert.ok(
      !out.includes("required command not found: python3"),
      `uninstall must no longer require python3:\n${out}`,
    );
    // The successor to item 9, inverted: Codex is reached, exactly. The shell
    // asserted an EMPTY log here; the port asserts the full ownership /
    // remove / re-inspect sequence, which an empty log cannot satisfy.
    assert.deepEqual(readLog(c.codexLog), [
      "plugin list --json",
      "plugin marketplace list --json",
      "plugin remove superpowers@superpowers-manager",
      "plugin marketplace remove superpowers-manager",
      "plugin list --json",
      "plugin marketplace list --json",
    ]);
  });

  void test("missing Codex: controlled ownership-inspect failure (:214-232)", async () => {
    // Converted (Task 6, D4): calls `runUninstall` in-process, with the
    // double answering the ownership inspect exactly as the real adapter's
    // requireCodex check does for a missing binary (src/adapter.ts:267-273,
    // ":180") -- a well-formed ok:false envelope, not a transport-level
    // fault. There is no re-anchor onto codex.log available for this case
    // either way: Codex is never reached by construction, so codex.log would
    // be empty regardless of channel.
    const c = uninstallCase({});
    const missingCodex = join(c.dir, "missing-codex");
    const adapter = recordingAdapter((argv) => {
      assert.equal(argv.join(" "), "inspect --view ownership");
      return failureResult(
        "inspect",
        "command-not-found",
        `required Codex command not found: ${missingCodex}`,
        [],
        [],
      );
    });
    const { ctx, stdout, stderr } = caseContext(c, { adapter });
    const status = await runUninstall([], ctx);
    const out = stdout() + stderr();
    // :220-225
    assert.notEqual(
      status,
      0,
      "expected uninstall to fail when Codex is missing",
    );
    // :226, structural: ownership was inspected -- it is the only call the
    // double answers before exhaustion would fail the case on anything else.
    assert.deepEqual(
      adapter.calls.map((call) => call.join(" ")),
      ["inspect --view ownership"],
      "ownership must be the only call made before the missing-Codex failure stops uninstall",
    );
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
    // :240, re-anchored onto the SUBJECT's stdout. The ownership-inspection
    // count alone would not do it: scripts/uninstall:23,29 emits two
    // inspections whether or not :27 runs, so deleting spw_adapter_uninstall
    // outright would leave that count at 2. These two lines are emitted by the
    // uninstall operation itself, one per flag, and only on the `false` branch
    // of each (src/adapter.ts:740, :757) — so together they pin both the call
    // and the both-false pair. The completion check is kept beneath them as the
    // ordering witness it actually is.
    assert.ok(
      result.stdout.includes("plugin not installed; skipping"),
      result.stdout,
    );
    assert.ok(
      result.stdout.includes("marketplace not registered; skipping"),
      result.stdout,
    );
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
    // Re-anchored onto codex.log (Task 6, D4/§5.3 step 1), keeping
    // `runScript` -- unlike the two cases above, every live claim here has a
    // Codex-level footprint. `inspect --view ownership` issues one
    // `plugin list --json` (src/adapter.ts:871) and one
    // `plugin marketplace list --json` (:883); `ownershipInspections` (below)
    // already counts the former. The adapter uninstall op itself issues no
    // listing, only the two removes asserted at :277-281 further down, so
    // :268-270's presence and exactly-twice claims collapse into
    // `ownershipInspections(codex) === 2`. :271's EXACTLY-ONCE claim does NOT
    // survive that collapse -- see the note at the call below; it is a drop,
    // recorded at uninstall-commands.md item 28.
    //
    // :288-289, "adapter uninstall must receive booleans, not provider names",
    // is DROPPED because it could never have failed: its needle `other@x` is
    // defined by no fixture in this repository (it occurs nowhere in tests/,
    // src/ or scripts/ outside the inventory's own prose about it), so no
    // behaviour of the subject, correct or defective, could ever have put it
    // in a log. Two arguments that look like they work here do NOT: (1)
    // `presenceFlag` (src/commands/uninstall.ts) is not in this case's path --
    // this is the case that KEEPS `runScript`, so its subject is
    // scripts/uninstall, not the TypeScript module; (2) "the surrounding
    // assertions would catch it" is wrong, since a leak emits
    // `superpowers@superpowers-manager`, which `other@x` never matched.
    const c = uninstallCase({});
    const result = await runScript(c, "uninstall");
    assert.equal(result.status, 0, result.stdout + result.stderr);

    const codex = readLog(c.codexLog);

    // :267
    assertTmpEmpty(c);
    // :268-270, re-anchored: two ownership inspections is the Codex-level
    // witness that the fresh re-inspect (scripts/uninstall:29) ran. :271's
    // exactly-once claim is DROPPED here: a duplicate op adds `plugin remove`
    // lines `has()` does not count, and leaves this count at 2 regardless.
    assertAdapterUninstallRan(
      codex,
      "both-present uninstall must reach a completed adapter uninstall",
    );
    // :272-276, re-anchored onto the SAME two ownership-inspect occurrences:
    // the first `plugin list --json` must precede the plugin remove, and the
    // plugin remove must precede the second `plugin list --json` -- the
    // Codex-level form of "ownership inspect brackets the adapter uninstall".
    // firstIndex and lastIndex are distinct here on purpose, mirroring the
    // shell's `head -n1` and `tail -n1`.
    const firstInspect = firstIndex(codex, "plugin list --json");
    const pluginRemoveAt = firstIndex(
      codex,
      "plugin remove superpowers@superpowers-manager",
    );
    const lastInspect = lastIndex(codex, "plugin list --json");
    assert.ok(
      firstInspect < pluginRemoveAt,
      "ownership inspect must precede adapter uninstall",
    );
    assert.ok(
      pluginRemoveAt < lastInspect,
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
    // :282-285
    assert.ok(
      !has(codex, "openai-curated"),
      "uninstall must never name openai-curated",
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
    // adapter issues only when both flags are true (src/adapter.ts:729-761).
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

  // Port-only (no shell original): row 18's first genuine consumer. The shell
  // had no in-process subject to guard, so this case has nothing to port —
  // see tests/migration-inventory/uninstall-commands.md's port-only section.
  // Appended at the end of the file, rather than beside the both-present case
  // it is thematically closest to, so it does not shift the line number of
  // any existing item — most of this inventory's `Port:` pointers are already
  // stale (see the file's own POINTER PROVENANCE note) and inserting in the
  // middle would silently break the ones that are not.
  //
  // `adapterSeam: "tripwire"` reaches the FAKE only. runScript exports it as
  // SPW_FIXTURE_ADAPTER_SEAM (lifecycle-fixture.js:327, whose own comment at
  // :324-326 states nothing under src/ may read it), and uninstall-fakes.js's
  // adapter role now refuses whatever its value (tests/bin/lifecycle-fakes.js's
  // tripwireTriggered with `always: true`). What the SUBJECT does is
  // unaffected: the SPW_ADAPTER seam runScript still defaults (:323) is
  // retired, which is why its guard at :301-310 rejects a caller-supplied
  // override outright.
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
  void test("both-present uninstall never reaches the fake adapter, tripwire armed or not (row 18)", async () => {
    const c = uninstallCase({ adapterSeam: "tripwire" });
    const result = await runScript(c, "uninstall");
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
      "fixture: uninstall must not spawn the adapter\n",
    );
    assert.deepEqual(
      readLog(c.adapterLog),
      ["inspect --view ownership"],
      "c.adapterLog is not the path this case's fake adapter records to, so the emptiness assertion above proves nothing",
    );
  });
});
