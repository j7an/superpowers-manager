// @ts-check
import assert from "node:assert/strict";
import test from "node:test";

const { runUninstall } = await import(
  new URL("../../dist/commands/uninstall.js", import.meta.url).href
);
const { successResult, failureResult } = await import(
  new URL("../../dist/adapter-protocol.js", import.meta.url).href
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
 * @param {readonly import("../../src/adapter-protocol.js").AdapterResult[]} responses
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
  // scripts/core/lifecycle.sh:75-77 has no `>&2`, unlike :53. The retired
  // shell driver witnessed the split through its capture form; LegacyVerdict
  // carries no channel by design, so this is the only witness after 4a.
  // Spec §6.2.3 item 2.
  const out = sink();
  const err = sink();
  const clean = { resources: { plugin: false, marketplace: false } };
  const { adapter, calls } = scriptedAdapter([
    successResult("inspect", { ...clean, identity_state: "both" }, []),
    successResult("uninstall", {}, []),
    successResult("inspect", { ...clean, identity_state: "both" }, []),
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
  // Clause 2: replayEnvelope already wrote the adapter's own error:/hint:
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

void test('argv is ignored, matching scripts/uninstall never reading "$@"', async () => {
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
