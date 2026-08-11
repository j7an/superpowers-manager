// @ts-check
// Proves the in-process case harness catches what it exists to catch: a
// package root outside the fixture scratch tree, and a recording adapter
// double that runs out of scripted answers.
import assert from "node:assert/strict";
import test from "node:test";
import { caseContext, recordingAdapter } from "./command-context.js";
import { createCase } from "./lifecycle-fixture.js";

void test("caseContext rejects a pkg outside the scratch tree", () => {
  const c = createCase({ fakes: "install" });
  const outside = { ...c, pkg: "/etc" };
  assert.throws(
    () => caseContext(outside, { adapter: recordingAdapter(() => undefined) }),
    /refusing to build a CommandContext against a package root outside the fixture scratch tree/,
  );
});

void test("an exhausted recordingAdapter fails rather than answering", async () => {
  const adapter = recordingAdapter(() => undefined);
  await assert.rejects(
    () => adapter(["inspect", "--view", "ownership"], { root: "/dev/null" }),
    /recordingAdapter exhausted at call 1/,
  );
});
