import assert from "node:assert/strict";
import { cpSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { successResult } from "../../src/adapter-result.ts";
import { gatherProbe } from "../../src/commands/probe.ts";
import {
  inspectPiPrepared,
  preparePiCandidate,
  readPiPrepared,
} from "../../src/harnesses/pi/prepare.ts";
import { piHarness } from "../../src/harnesses/pi/harness.ts";
import {
  digestPiTree,
  readPiReceipt,
  piReceiptBinding,
} from "../../src/harnesses/pi/package.ts";
import {
  commitFixture,
  nativeFixture,
  nativeSelection,
} from "../lib/pi-package-fixture.ts";
import {
  capture,
  notCalledAdapter,
  observingCoordinator,
} from "../lib/command-doubles.ts";

void test("prepared Pi identity survives fetch removal and frozen copies survive replacement", async (t) => {
  const root = nativeFixture(t),
    commit = commitFixture(root);
  const ctx = { root, env: { HOME: join(root, "home") } };
  const prepared = join(root, "home/.pi/agent/superpowers-manager/prepared");
  const result = await preparePiCandidate(
    {
      upstreamRoot: root,
      workspaceRoot: root,
      candidateRoot: prepared,
      selection: nativeSelection(commit),
    },
    ctx,
  );
  assert.equal(result.outcome.ok, true);
  const installed = join(root, "installed");
  cpSync(prepared, installed, { recursive: true, verbatimSymlinks: true });
  const frozenDigest = await digestPiTree(installed);
  rmSync(join(root, ".git"), { recursive: true });
  assert.equal((await readPiPrepared(ctx)).outcome.ok, true);
  const state = await inspectPiPrepared(nativeSelection(commit), ctx);
  assert.equal(state.outcome.ok && state.outcome.result.kind, "current");
  const nextUpstream = nativeFixture(t);
  writeFileSync(join(nextUpstream, "additional-support"), "B");
  const nextCommit = commitFixture(nextUpstream);
  rmSync(prepared, { recursive: true });
  const replacement = await preparePiCandidate(
    {
      upstreamRoot: nextUpstream,
      workspaceRoot: root,
      candidateRoot: prepared,
      selection: nativeSelection(nextCommit),
    },
    ctx,
  );
  assert.equal(replacement.outcome.ok, true);
  rmSync(nextUpstream, { recursive: true });
  assert.equal((await readPiPrepared(ctx)).outcome.ok, true);
  writeFileSync(join(prepared, "extra"), "B");
  assert.equal((await readPiPrepared(ctx)).outcome.ok, false);
  assert.equal(await digestPiTree(installed), frozenDigest);
  assert.match(
    readFileSync(join(installed, "skills/using-superpowers/SKILL.md"), "utf8"),
    /name: using-superpowers/,
  );
});

void test("receipt support claims cannot bless bootstrap drift and commit-only tampering cannot match a candidate", async (t) => {
  const root = nativeFixture(t),
    commit = commitFixture(root);
  const prepared = join(root, "home/.pi/agent/superpowers-manager/prepared"),
    ctx = { root, env: { HOME: join(root, "home") } };
  await preparePiCandidate(
    {
      upstreamRoot: root,
      workspaceRoot: root,
      candidateRoot: prepared,
      selection: nativeSelection(commit),
    },
    ctx,
  );
  const path = join(prepared, ".superpowers-manager.json"),
    receipt = JSON.parse(readFileSync(path, "utf8"));
  writeFileSync(path, JSON.stringify({ ...receipt, commit: "2".repeat(40) }));
  const observed = await inspectPiPrepared(
    nativeSelection("2".repeat(40)),
    ctx,
  );
  assert.equal(observed.outcome.ok, false);
  writeFileSync(
    path,
    JSON.stringify({ ...receipt, source: "https://other.invalid/superpowers" }),
  );
  assert.equal(
    (
      await inspectPiPrepared(
        nativeSelection(commit, "https://other.invalid/superpowers"),
        ctx,
      )
    ).outcome.ok,
    false,
  );
  writeFileSync(join(prepared, ".pi/extensions/superpowers.ts"), "unsupported");
  const rewritten = { ...receipt, digest: await digestPiTree(prepared) };
  writeFileSync(
    path,
    JSON.stringify({
      ...rewritten,
      binding: piReceiptBinding(rewritten),
      compatibility: {
        kind: "supported",
        generation: "invented",
        reason: "trust me",
      },
    }),
  );
  const unsupported = await inspectPiPrepared(nativeSelection(commit), ctx);
  assert.equal(unsupported.status, 0);
  assert.equal(unsupported.outcome.ok, true);
  if (!unsupported.outcome.ok) assert.fail("expected unsupported inspection");
  assert.deepEqual(unsupported.outcome.result, {
    kind: "needs-prepare",
    observedIdentity: rewritten.digest,
    compatibility: {
      kind: "unsupported",
      reason: `Pi package does not match the qualified native bootstrap profile: ${prepared}`,
    },
  });

  for (const selection of [
    nativeSelection("3".repeat(40)),
    nativeSelection(commit, "https://other.invalid/superpowers"),
  ]) {
    const mismatch = await inspectPiPrepared(selection, ctx);
    assert.equal(mismatch.outcome.ok, true);
    if (!mismatch.outcome.ok) assert.fail("expected mismatched inspection");
    assert.equal(mismatch.outcome.result.kind, "needs-prepare");
    assert.equal(mismatch.outcome.result.compatibility.kind, "unknown");
  }

  const adapter: typeof notCalledAdapter = {
    ...notCalledAdapter,
    preparationLocation(adapterCtx) {
      return piHarness.preparationLocation(adapterCtx);
    },
    async mutationRoots(adapterCtx) {
      return await piHarness.mutationRoots(adapterCtx);
    },
    inspectPrepared: inspectPiPrepared,
    async inspectInstalled() {
      return successResult(
        "inspect",
        { kind: "absent", observedIdentity: "" },
        [],
      );
    },
    async inspectOwnership() {
      return successResult(
        "inspect",
        {
          installEligibility: { kind: "allowed" },
          removalInput: { pluginPresent: false, marketplacePresent: false },
          removalVerification: { kind: "allowed" },
          postRemovalOutput: { stdout: [], stderr: [] },
          presentationValue: "ownership-collected",
        },
        [],
      );
    },
    async inspectUpdateControl() {
      return successResult(
        "inspect",
        {
          probeEligibility: { kind: "allowed" },
          mutationEligibility: { kind: "allowed" },
          presentationValue: "control-collected",
        },
        [],
      );
    },
  };
  const probed = await gatherProbe({
    root,
    env: ctx.env,
    stdout: capture().stream,
    stderr: capture().stream,
    options: { harness: "pi", allowExperimental: false },
    coordination: observingCoordinator(),
    selection: nativeSelection(commit),
    adapter,
  });
  assert.equal(probed.status, 0);
  if (probed.status !== 0) assert.fail("expected complete probe collection");
  assert.equal(probed.facts.compatibility.kind, "unsupported");
  assert.equal(probed.facts.installed.kind, "absent");
  assert.equal(probed.facts.ownership.presentationValue, "ownership-collected");
  assert.equal(probed.facts.control.presentationValue, "control-collected");
  assert.equal(probed.facts.status, "needs prepare");

  const unreadablePrepared = await readPiPrepared(ctx);
  assert.equal(unreadablePrepared.outcome.ok, false);
  if (!unreadablePrepared.outcome.ok)
    assert.match(
      unreadablePrepared.outcome.error.message,
      /cannot read Pi prepared artifact/,
    );
});

void test("validates every receipt identity field independently and preserves raw custom source classification", async (t) => {
  const root = nativeFixture(t),
    commit = commitFixture(root),
    prepared = join(root, "home/.pi/agent/superpowers-manager/prepared"),
    ctx = { root, env: { HOME: join(root, "home") } };
  const result = await preparePiCandidate(
    {
      upstreamRoot: root,
      workspaceRoot: root,
      candidateRoot: prepared,
      selection: nativeSelection(commit, "github.com/obra/superpowers"),
    },
    ctx,
  );
  assert.equal(
    result.outcome.ok && result.outcome.result.compatibility.kind,
    "experimental",
  );
  const path = join(prepared, ".superpowers-manager.json"),
    original = readFileSync(path, "utf8"),
    receipt = JSON.parse(original);
  assert.equal(
    (await readPiReceipt(prepared)).source,
    "github.com/obra/superpowers",
  );
  assert.equal((await readPiPrepared(ctx)).outcome.ok, true);
  writeFileSync(
    path,
    JSON.stringify({
      ...receipt,
      compatibility: {
        kind: "supported",
        generation: "invented",
        reason: "cached claim",
      },
    }),
  );
  const reassessed = await readPiPrepared(ctx);
  assert.equal(
    reassessed.outcome.ok && reassessed.outcome.result.compatibility.kind,
    "experimental",
  );
  for (const [key, value] of Object.entries({
    schema: 2,
    manager: "other",
    harness: "codex",
    source: "https://user:password@github.com/obra/superpowers",
    commit: "short",
    digest: "invalid",
    compatibility: { kind: "supported" },
  })) {
    writeFileSync(path, JSON.stringify({ ...receipt, [key]: value }));
    await assert.rejects(
      readPiReceipt(prepared),
      /invalid Pi artifact receipt/,
    );
  }
  writeFileSync(path, original);
  const observed = await inspectPiPrepared(nativeSelection(commit), ctx);
  assert.equal(
    observed.outcome.ok && observed.outcome.result.kind,
    "needs-prepare",
  );
});

void test("missing prepared evidence is unknown and unsupported candidates preserve previous prepared bytes", async (t) => {
  const root = nativeFixture(t),
    ctx = { root, env: { HOME: join(root, "home") } },
    prepared = join(root, "home/.pi/agent/superpowers-manager/prepared");
  const absent = await inspectPiPrepared(nativeSelection(), ctx);
  assert.equal(
    absent.outcome.ok && absent.outcome.result.kind,
    "needs-prepare",
  );
  assert.equal(
    absent.outcome.ok && absent.outcome.result.compatibility.kind,
    "unknown",
  );
  const commit = commitFixture(root);
  await preparePiCandidate(
    {
      upstreamRoot: root,
      candidateRoot: prepared,
      workspaceRoot: root,
      selection: nativeSelection(commit),
    },
    ctx,
  );
  const digest = await digestPiTree(prepared);
  const unsupported = nativeFixture(t);
  writeFileSync(
    join(unsupported, ".pi/extensions/superpowers.ts"),
    "unknown mechanics",
  );
  const rejected = await preparePiCandidate(
    {
      upstreamRoot: unsupported,
      candidateRoot: join(root, "rejected"),
      workspaceRoot: root,
      selection: nativeSelection(commitFixture(unsupported)),
    },
    ctx,
  );
  assert.equal(rejected.outcome.ok, false);
  assert.equal(await digestPiTree(prepared), digest);
  writeFileSync(
    join(prepared, ".superpowers-manager.json"),
    "{ invalid\u001b[2J",
  );
  const malformed = await inspectPiPrepared(nativeSelection(commit), ctx);
  assert.equal(malformed.outcome.ok, false);
  if (malformed.outcome.ok) assert.fail("expected malformed receipt failure");
  assert.doesNotMatch(malformed.outcome.error.message, /SyntaxError|JSON/);
  assert.equal(
    malformed.outcome.error.message.includes(String.fromCharCode(27)),
    false,
  );
});
