import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { failureResult, successResult } from "../../src/adapter-result.ts";
import { runPrepare } from "../../src/commands/prepare.ts";
import { createHarnessFixture } from "../lib/test-harness.ts";

void test("preparation does not require a Codex template or manifest", async (t) => {
  const fixture = await createHarnessFixture(t);

  assert.equal(await runPrepare([], fixture.ctx), 0);
  assert.equal(
    readFileSync(join(fixture.destinationRoot, "payload.txt"), "utf8"),
    "fixture\n",
  );
  assert.equal(
    existsSync(join(fixture.destinationRoot, ".codex-plugin")),
    false,
  );
  assert.deepEqual(fixture.calls, ["location", "prefetch", "prepare"]);
});

void test("preparation rejects unsafe locations before allocating a workspace", async (t) => {
  const locations = [
    { destinationRoot: "relative", stagingLeaf: "candidate" },
    { destinationRoot: "absolute", stagingLeaf: "" },
    { destinationRoot: "absolute", stagingLeaf: "." },
    { destinationRoot: "absolute", stagingLeaf: ".." },
    { destinationRoot: "absolute", stagingLeaf: "nested/candidate" },
    { destinationRoot: "absolute", stagingLeaf: "nested\\candidate" },
  ] as const;
  for (const configured of locations) {
    const fixture = await createHarnessFixture(t);
    const destinationRoot =
      configured.destinationRoot === "absolute"
        ? fixture.destinationRoot
        : configured.destinationRoot;
    const adapter = {
      ...fixture.adapter,
      preparationLocation() {
        fixture.calls.push("location");
        return { destinationRoot, stagingLeaf: configured.stagingLeaf };
      },
      async validatePreparationBeforeFetch() {
        fixture.calls.push("prefetch");
        return failureResult(
          "prefetch",
          "sentinel",
          "location validation did not run first",
          [],
          [],
        );
      },
    };
    const status = await runPrepare([], { ...fixture.ctx, adapter });
    assert.equal(status, 1);
    assert.deepEqual(fixture.calls, ["location"]);
    assert.equal(
      fixture.err.text(),
      configured.destinationRoot === "relative"
        ? "error: adapter returned a non-absolute preparation destination\n"
        : "error: adapter returned an invalid preparation staging leaf\n",
    );
  }
});

void test("preparation hides a location resolver's thrown diagnostic", async (t) => {
  const fixture = await createHarnessFixture(t);
  const adapter = {
    ...fixture.adapter,
    preparationLocation(): never {
      fixture.calls.push("location");
      throw new Error("hostile location details");
    },
  };

  assert.equal(await runPrepare([], { ...fixture.ctx, adapter }), 1);
  assert.deepEqual(fixture.calls, ["location"]);
  assert.equal(
    fixture.err.text(),
    "error: cannot determine preparation location\n",
  );
});

void test("preparation rejects artifact evidence for another root", async (t) => {
  const fixture = await createHarnessFixture(t);
  const adapter = {
    ...fixture.adapter,
    async prepareCandidate(
      input: Parameters<typeof fixture.adapter.prepareCandidate>[0],
    ) {
      const result = await fixture.adapter.prepareCandidate(input, {
        root: fixture.ctx.root,
        env: fixture.ctx.env,
      });
      assert.equal(result.outcome.ok, true);
      return successResult(
        result.outcome.operation,
        {
          root: `${input.candidateRoot}-other`,
          commit: input.selection.desiredCommit,
        },
        result.outcome.messages,
      );
    },
  };

  assert.equal(await runPrepare([], { ...fixture.ctx, adapter }), 1);
  assert.deepEqual(fixture.calls, ["location", "prefetch", "prepare"]);
  assert.equal(
    fixture.err.text(),
    "error: adapter returned an unexpected preparation root\n",
  );
});

void test("preparation rejects artifact evidence for another commit", async (t) => {
  const fixture = await createHarnessFixture(t);
  const adapter = {
    ...fixture.adapter,
    async prepareCandidate(
      input: Parameters<typeof fixture.adapter.prepareCandidate>[0],
    ) {
      const result = await fixture.adapter.prepareCandidate(input, {
        root: fixture.ctx.root,
        env: fixture.ctx.env,
      });
      assert.equal(result.outcome.ok, true);
      return successResult(
        result.outcome.operation,
        { root: input.candidateRoot, commit: "0".repeat(40) },
        result.outcome.messages,
      );
    },
  };

  assert.equal(await runPrepare([], { ...fixture.ctx, adapter }), 1);
  assert.deepEqual(fixture.calls, ["location", "prefetch", "prepare"]);
  assert.equal(
    fixture.err.text(),
    "error: adapter returned an unexpected preparation commit\n",
  );
});
