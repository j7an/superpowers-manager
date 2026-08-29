// @ts-check
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const { runUninstall } = await import(
  new URL("../../dist/commands/uninstall.js", import.meta.url).href
);
const { successResult, failureResult } = await import(
  new URL("../../dist/adapter-result.js", import.meta.url).href
);
const { workspaceRemovalFailure } = await import(
  new URL("../../dist/workspace.js", import.meta.url).href
);

/** Collects writes without a real stream, so no EPIPE hazard exists here. */
function sink() {
  /** @type {string[]} */
  const chunks = [];
  return {
    chunks,
    stream: /** @type {NodeJS.WritableStream} */ (
      /** @type {unknown} */ ({
        write(/** @type {string} */ text) {
          chunks.push(text);
          return true;
        },
      })
    ),
  };
}

/**
 * @param {readonly import("../../src/adapter-result.js").AdapterResult[]} responses
 */
function scriptedAdapter(responses) {
  /** @type {string[][]} */
  const calls = [];
  let index = 0;
  return {
    calls,
    /** @type {import("../../src/commands/context.js").CommandContext["adapter"]} */
    adapter: async (argv) => {
      calls.push([...argv]);
      const response = responses[index++];
      // Exhaustion is a FAILURE, not an empty answer. A double that runs out
      // and returns a benign value satisfies every absence assertion while
      // proving nothing -- the vacuity mode this slice exists to avoid.
      assert.ok(
        response !== undefined,
        `scriptedAdapter exhausted at call ${index}: ${argv.join(" ")}`,
      );
      return response;
    },
  };
}

/** @type {Record<string, unknown>} */
const CLEAN = { resources: { plugin: false, marketplace: false } };

void test("a remaining legacy state is REPORTED on stdout, not stderr", async () => {
  // `git show ad56569a4c161e7b122967442e2b026eeb6395f6:scripts/core/lifecycle.sh:75-77::remains` has no `>&2`, unlike :53. The retired
  // shell driver witnessed the split through its capture form; LegacyVerdict
  // carries no channel by design, so this is the only witness after 4a.
  // Spec §6.2.3 item 2.
  const out = sink();
  const err = sink();
  const { adapter, calls } = scriptedAdapter([
    successResult("inspect", { ...CLEAN, identity_state: "both" }, []),
    successResult("uninstall", {}, []),
    successResult("inspect", { ...CLEAN, identity_state: "both" }, []),
  ]);
  const status = await runUninstall([], {
    root: "/nowhere",
    env: {},
    stdout: out.stream,
    stderr: err.stream,
    adapter,
  });
  assert.equal(status, 0);
  const stdout = out.chunks.join("");
  assert.ok(
    stdout.includes(
      "Legacy superpowers-wrapper Codex state remains installed.\n",
    ),
    `report line missing from stdout:\n${stdout}`,
  );
  assert.ok(
    stdout.includes("Run: npx superpowers-wrapper@0.1.1 uninstall\n"),
    `report line 2 missing from stdout:\n${stdout}`,
  );
  // The converse is the half that fails silently: a caller that wrote both
  // verdicts to stderr would satisfy a stdout-only assertion nowhere and a
  // "contains" assertion on the joined output everywhere.
  assert.equal(
    err.chunks.join("").includes("remains installed"),
    false,
    "the report must NOT reach stderr",
  );
  assert.equal(calls.length, 3);
});

void test("the two closing lines port verbatim except for the prepare invocation", async () => {
  const out = sink();
  const err = sink();
  const { adapter } = scriptedAdapter([
    successResult("inspect", { ...CLEAN, identity_state: "neither" }, []),
    successResult("uninstall", {}, []),
    successResult("inspect", { ...CLEAN, identity_state: "neither" }, []),
  ]);
  const status = await runUninstall([], {
    root: "/nowhere",
    env: {},
    stdout: out.stream,
    stderr: err.stream,
    adapter,
  });
  assert.equal(status, 0);
  assert.equal(
    out.chunks.join(""),
    "uninstall complete\n" +
      "note: local generated artifacts under plugins/superpowers/ and " +
      ".cache/upstream/ were left in place; remove them manually or " +
      "regenerate with npx superpowers-manager prepare.\n",
  );
  assert.equal(err.chunks.join(""), "");
});

void test("the adapter calls are issued in order with the FIRST inspection's read presence booleans", async () => {
  const out = sink();
  const err = sink();
  const { adapter, calls } = scriptedAdapter([
    successResult(
      "inspect",
      {
        resources: { plugin: true, marketplace: false },
        identity_state: "neither",
      },
      [],
    ),
    successResult("uninstall", {}, []),
    successResult("inspect", { ...CLEAN, identity_state: "neither" }, []),
  ]);
  const status = await runUninstall([], {
    root: "/nowhere",
    env: {},
    stdout: out.stream,
    stderr: err.stream,
    adapter,
  });
  assert.equal(status, 0);
  assert.deepEqual(calls, [
    ["inspect", "--view", "ownership"],
    ["uninstall", "--plugin-present", "true", "--marketplace-present", "false"],
    ["inspect", "--view", "ownership"],
  ]);
});

void test("a plugin resource still installed after removal is a distinct, named failure", async () => {
  const out = sink();
  const err = sink();
  const { adapter, calls } = scriptedAdapter([
    successResult("inspect", { ...CLEAN, identity_state: "neither" }, []),
    successResult("uninstall", {}, []),
    successResult(
      "inspect",
      {
        resources: { plugin: true, marketplace: false },
        identity_state: "neither",
      },
      [],
    ),
  ]);
  const status = await runUninstall([], {
    root: "/nowhere",
    env: {},
    stdout: out.stream,
    stderr: err.stream,
    adapter,
  });
  assert.equal(status, 1);
  assert.equal(
    err.chunks.join(""),
    "error: owned plugin resource is still installed after removal\n",
  );
  assert.equal(out.chunks.join(""), "");
  assert.equal(calls.length, 3);
});

void test("an unrecognised identity state after removal is a distinct, named failure", async () => {
  const out = sink();
  const err = sink();
  const { adapter, calls } = scriptedAdapter([
    successResult("inspect", { ...CLEAN, identity_state: "neither" }, []),
    successResult("uninstall", {}, []),
    successResult("inspect", { ...CLEAN, identity_state: "wat" }, []),
  ]);
  const status = await runUninstall([], {
    root: "/nowhere",
    env: {},
    stdout: out.stream,
    stderr: err.stream,
    adapter,
  });
  assert.equal(status, 1);
  assert.equal(
    err.chunks.join(""),
    "error: unknown adapter identity state: wat\n",
  );
  assert.equal(out.chunks.join(""), "");
  assert.equal(calls.length, 3);
});

void test("a non-string identity_state after removal fails closed with its own diagnostic", async () => {
  // src/commands/uninstall.ts's identity_state read distinguishes three
  // inputs: null/undefined -> "" (parity with spw_json_get's null/missing
  // coercion), a string -> used as-is, and any other present, non-null value
  // -> a dedicated fail-closed message, never silently stringified and never
  // collapsed into the "unknown adapter identity state: " (empty) text a
  // stringify-then-compare reading would produce for this same input.
  const out = sink();
  const err = sink();
  const { adapter, calls } = scriptedAdapter([
    successResult("inspect", { ...CLEAN, identity_state: "neither" }, []),
    successResult("uninstall", {}, []),
    successResult("inspect", { ...CLEAN, identity_state: 42 }, []),
  ]);
  const status = await runUninstall([], {
    root: "/nowhere",
    env: {},
    stdout: out.stream,
    stderr: err.stream,
    adapter,
  });
  assert.equal(status, 1);
  assert.equal(
    err.chunks.join(""),
    "error: adapter returned a non-string identity_state for inspect --view ownership\n",
  );
  assert.equal(out.chunks.join(""), "");
  assert.equal(calls.length, 3);
});

// Spec §4.2a's closing requirement: every lifecycle adapter stage gets a
// deterministic failure case AND an ordering case, since a stage with
// neither is a stage whose stop clause is unproven. `uninstall` has three
// stages -- inspect, uninstall, inspect -- so six cases below, plus a
// malformed case for the two stages that parse content (stages 1 and 3;
// stage 2's result content is never read). The failure and malformed cases
// for a given stage are the pair that must NOT be collapsed: if they ever
// produce identical stderr text, the collapse spec §4.2a exists to forbid
// has reappeared.

void test("stage 1 (inspect ownership) failure stops with ONLY the replayed diagnostic", async () => {
  const out = sink();
  const err = sink();
  const { adapter, calls } = scriptedAdapter([
    failureResult(
      "inspect",
      "E_ADAPTER",
      "cannot inspect ownership",
      ["check codex is installed"],
      [],
    ),
  ]);
  const status = await runUninstall([], {
    root: "/nowhere",
    env: {},
    stdout: out.stream,
    stderr: err.stream,
    adapter,
  });
  assert.equal(status, 1);
  // Clause 2: replayOutcome already wrote the adapter's own error:/hint:
  // lines. NO second, command-authored line may follow them.
  assert.equal(
    err.chunks.join(""),
    "error: cannot inspect ownership\nhint: check codex is installed\n",
  );
  assert.equal(out.chunks.join(""), "");
  assert.deepEqual(calls, [["inspect", "--view", "ownership"]]);
});

void test("stage 1 malformed presence content is a DIFFERENT failure than stage 1's adapter failure", async () => {
  const out = sink();
  const err = sink();
  const { adapter, calls } = scriptedAdapter([
    successResult(
      "inspect",
      {
        resources: { plugin: "yes", marketplace: false },
        identity_state: "neither",
      },
      [],
    ),
  ]);
  const status = await runUninstall([], {
    root: "/nowhere",
    env: {},
    stdout: out.stream,
    stderr: err.stream,
    adapter,
  });
  assert.equal(status, 1);
  assert.equal(
    err.chunks.join(""),
    "error: expected a Boolean adapter result at resources.plugin\n",
  );
  assert.equal(out.chunks.join(""), "");
  assert.deepEqual(calls, [["inspect", "--view", "ownership"]]);
});

void test("stage 1 clause 3: outcome.ok but status !== 0 gets its own hand-written message", async () => {
  // Spec §4.2a clause 3. successResult/failureResult cannot express this
  // input -- successResult always pairs ok:true with status:0, failureResult
  // always pairs ok:false with status:1 -- so the outcome is hand-built here
  // to reach the one combination invoke()'s gate must distinguish from both
  // clause 2 (!outcome.ok, replay-only) and clause 4 (a malformed but
  // successful result).
  const out = sink();
  const err = sink();
  /** @type {readonly import("../../src/adapter-result.js").AdapterResult[]} */
  const responses = [
    {
      status: 1,
      outcome: {
        operation: "inspect",
        ok: true,
        messages: [],
        result: null,
        error: null,
      },
    },
  ];
  const { adapter, calls } = scriptedAdapter(responses);
  const status = await runUninstall([], {
    root: "/nowhere",
    env: {},
    stdout: out.stream,
    stderr: err.stream,
    adapter,
  });
  assert.equal(status, 1);
  assert.equal(
    err.chunks.join(""),
    "error: adapter reported a failure status for inspect --view ownership\n",
  );
  assert.equal(out.chunks.join(""), "");
  assert.deepEqual(calls, [["inspect", "--view", "ownership"]]);
});

void test("stage 2 (uninstall) failure stops before the post-removal inspection", async () => {
  const out = sink();
  const err = sink();
  const { adapter, calls } = scriptedAdapter([
    successResult(
      "inspect",
      {
        resources: { plugin: true, marketplace: true },
        identity_state: "neither",
      },
      [],
    ),
    failureResult(
      "uninstall",
      "E_ADAPTER",
      "cannot remove owned resources",
      [],
      [],
    ),
  ]);
  const status = await runUninstall([], {
    root: "/nowhere",
    env: {},
    stdout: out.stream,
    stderr: err.stream,
    adapter,
  });
  assert.equal(status, 1);
  assert.equal(err.chunks.join(""), "error: cannot remove owned resources\n");
  assert.equal(out.chunks.join(""), "");
  assert.deepEqual(calls, [
    ["inspect", "--view", "ownership"],
    ["uninstall", "--plugin-present", "true", "--marketplace-present", "true"],
  ]);
});

void test("stage 3 (post-removal inspect ownership) failure stops with ONLY the replayed diagnostic", async () => {
  const out = sink();
  const err = sink();
  const { adapter, calls } = scriptedAdapter([
    successResult("inspect", { ...CLEAN, identity_state: "neither" }, []),
    successResult("uninstall", {}, []),
    failureResult(
      "inspect",
      "E_ADAPTER",
      "cannot inspect ownership after removal",
      [],
      [],
    ),
  ]);
  const status = await runUninstall([], {
    root: "/nowhere",
    env: {},
    stdout: out.stream,
    stderr: err.stream,
    adapter,
  });
  assert.equal(status, 1);
  assert.equal(
    err.chunks.join(""),
    "error: cannot inspect ownership after removal\n",
  );
  assert.equal(out.chunks.join(""), "");
  assert.deepEqual(calls, [
    ["inspect", "--view", "ownership"],
    [
      "uninstall",
      "--plugin-present",
      "false",
      "--marketplace-present",
      "false",
    ],
    ["inspect", "--view", "ownership"],
  ]);
});

void test("stage 3 malformed presence content is a DIFFERENT failure than stage 3's adapter failure", async () => {
  const out = sink();
  const err = sink();
  const { adapter, calls } = scriptedAdapter([
    successResult("inspect", { ...CLEAN, identity_state: "neither" }, []),
    successResult("uninstall", {}, []),
    successResult(
      "inspect",
      {
        resources: { plugin: "no", marketplace: false },
        identity_state: "neither",
      },
      [],
    ),
  ]);
  const status = await runUninstall([], {
    root: "/nowhere",
    env: {},
    stdout: out.stream,
    stderr: err.stream,
    adapter,
  });
  assert.equal(status, 1);
  assert.equal(
    err.chunks.join(""),
    "error: expected a Boolean adapter result at resources.plugin\n",
  );
  assert.equal(out.chunks.join(""), "");
  assert.deepEqual(calls, [
    ["inspect", "--view", "ownership"],
    [
      "uninstall",
      "--plugin-present",
      "false",
      "--marketplace-present",
      "false",
    ],
    ["inspect", "--view", "ownership"],
  ]);
});

void test("argv is ignored by src/commands/uninstall.ts", async () => {
  const out = sink();
  const err = sink();
  const { adapter } = scriptedAdapter([
    successResult("inspect", { ...CLEAN, identity_state: "neither" }, []),
    successResult("uninstall", {}, []),
    successResult("inspect", { ...CLEAN, identity_state: "neither" }, []),
  ]);
  const status = await runUninstall(["--bogus", "extra"], {
    root: "/nowhere",
    env: {},
    stdout: out.stream,
    stderr: err.stream,
    adapter,
  });
  assert.equal(status, 0);
});

// --- Post-success withWorkspace cleanup failure (onCleanupFailure) ---
//
// `src/workspace.ts:134-141::await remove`: with `onCleanupFailure` supplied and the callback
// not failed, a post-success cleanup failure is suppressed and the callback's
// return value survives. uninstall.ts passes it, so the UninstallOutcome the
// callback computed still reaches the operator, and the leaked workspace is
// reported on stderr with exit 1 on top of it.
//
// This is what scripts/uninstall did. It echoed "uninstall complete" and the
// note at :34-35 before the exit trap ran, and spw_cleanup_workspace_trap
// (`git show ad56569a4c161e7b122967442e2b026eeb6395f6:scripts/core/common.sh:25-30::spw_cleanup_workspace_trap(`) is `rm -rf "$path" || :`, so the removal
// failure never suppressed either line. An earlier port dropped both, frozen
// by this test asserting stdout was the first inspection's note alone; the
// shell is the authority and that assertion was pinning the defect.
//
// Outcomes collected before the cleanup failure still replay, which is the
// property this case originally existed to hold (DIAG-ADAPTER-01).

void test("a post-success withWorkspace cleanup failure keeps the computed outcome and every outcome before it", async () => {
  if (process.getuid?.() === 0) return; // chmod does not gate root
  const parent = mkdtempSync(join(tmpdir(), "spw-uninstall-workspace-"));
  try {
    const out = sink();
    const err = sink();
    const responses = [
      successResult("inspect", { ...CLEAN, identity_state: "neither" }, [
        { channel: "stdout", text: "note: first inspection ran" },
      ]),
      successResult("uninstall", {}, []),
      successResult("inspect", { ...CLEAN, identity_state: "neither" }, []),
    ];
    let index = 0;
    /** @type {string[][]} */
    const calls = [];
    // No test double for the filesystem: the THIRD (and final) call chmods
    // the workspace's own PARENT directory read-only, after the first two
    // calls have already pushed their outcomes. By the time
    // withWorkspace's post-callback `rm(workspace, ...)` runs, the parent
    // cannot be written to, so the removal genuinely fails with EACCES/EPERM
    // -- a real filesystem failure, not a mocked one.
    const adapter = async (/** @type {readonly string[]} */ argv) => {
      calls.push([...argv]);
      const response = responses[index++];
      assert.ok(
        response !== undefined,
        `adapter exhausted at call ${index}: ${argv.join(" ")}`,
      );
      if (index === responses.length) {
        chmodSync(parent, 0o500);
      }
      return response;
    };
    const status = await runUninstall([], {
      root: "/nowhere",
      env: { TMPDIR: parent },
      stdout: out.stream,
      stderr: err.stream,
      adapter,
    });
    assert.equal(status, 1);
    assert.equal(calls.length, 3);
    // The outcome collected from the FIRST call -- well before the cleanup
    // failure -- still reaches stdout, AND the domain outcome survives it,
    // exactly as `git show ad56569a4c161e7b122967442e2b026eeb6395f6:scripts/uninstall:34-35::complete` behaved. Dropping either half is a
    // divergence from the shell.
    assert.equal(
      out.chunks.join(""),
      "note: first inspection ran\n" +
        "uninstall complete\n" +
        "note: local generated artifacts under plugins/superpowers/ and " +
        ".cache/upstream/ were left in place; remove them manually or " +
        "regenerate with npx superpowers-manager prepare.\n",
    );
    const entries = readdirSync(parent);
    assert.equal(
      entries.length,
      1,
      `expected exactly one leftover workspace directory in ${parent}, found: ${entries.join(", ")}`,
    );
    const workspace = join(parent, entries[0]);
    assert.equal(
      err.chunks.join(""),
      `error: ${workspaceRemovalFailure(workspace)}\n`,
    );
  } finally {
    try {
      chmodSync(parent, 0o700);
    } catch {
      // Best-effort: the real cleanup below tolerates a missing or
      // already-writable directory either way.
    }
    rmSync(parent, { recursive: true, force: true });
  }
});
