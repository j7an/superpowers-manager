import assert from "node:assert/strict";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  codexInspect,
  codexInstall,
  codexRemove,
} from "../../../../src/harnesses/codex/adapter.ts";

import {
  normalizeCodexInstall,
  normalizeCodexInstalled,
  normalizeCodexOwnership,
} from "../../../../src/harnesses/codex/harness.ts";
import { codexPresentation } from "../../../../src/harnesses/codex/presentation.ts";

const ROOT = resolve(fileURLToPath(new URL("../../../../", import.meta.url)));
const PACKAGE_ROOT = ROOT;
const FAKE_CODEX = fileURLToPath(
  new URL("../../../unit/helpers/harnesses/codex/fake.sh", import.meta.url),
);

function ok(result: unknown): any {
  return {
    status: 0,
    outcome: {
      operation: "inspect",
      ok: true,
      messages: [],
      result,
      error: null,
    },
  };
}

/**
 * The baseline fake Codex is the same executable used by the adapter unit
 * tests; this test owns an isolated log and search root so it never observes
 * or mutates the developer's Codex state.
 */
async function codexSandbox(t: import("node:test").TestContext) {
  const base = await mkdtemp(join(tmpdir(), "spw-marketplace-reconcile-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const log = join(base, "commands.log");
  const searchRoot = join(base, "codex");
  await writeFile(log, "", "utf8");
  await mkdir(searchRoot, { recursive: true });
  return {
    base,
    log,
    searchRoot,
    env(extra = {}) {
      return {
        SUPERPOWERS_CODEX: FAKE_CODEX,
        SUPERPOWERS_INSTALLED_SEARCH_ROOT: searchRoot,
        FAKE_CODEX_LOG: log,
        ...extra,
      };
    },
  };
}

void test("INSTALL-VERIFY-01 installed fingerprint proof and hints", async (t) => {
  const sandbox = await codexSandbox(t);
  const desired = "abcdef0123456789abcdef0123456789abcdef01";
  const installedRoot = join(
    sandbox.searchRoot,
    "plugins",
    "cache",
    "superpowers-manager",
    "superpowers",
    "1.0.0",
  );
  await mkdir(installedRoot, { recursive: true });
  await writeFile(
    join(installedRoot, ".superpowers-upstream.json"),
    JSON.stringify({ commit: desired }),
    "utf8",
  );

  const inspect = await codexInspect("fingerprint", {
    root: PACKAGE_ROOT,
    env: sandbox.env({
      FAKE_CODEX_PLUGIN_LIST:
        '{"installed":[{"pluginId":"superpowers@superpowers-manager","version":"1.0.0"}]}',
    }),
  });
  assert.equal(inspect.outcome.ok, true, JSON.stringify(inspect.outcome));
  assert.deepEqual(inspect.outcome.result, {
    view: "fingerprint",
    fingerprint: desired,
  });

  const matchedReceipt = normalizeCodexInstall(
    ok({
      verification_hints: {
        mismatch: "adapter mismatch hint",
        missing: "adapter missing hint",
      },
    }),
  );
  const matchedInspection = normalizeCodexInstalled(
    inspect,
    desired,
  );
  const matched = codexPresentation.renderInstallVerification(
    desired, matchedReceipt, matchedInspection,
  );
  assert.deepEqual(matched, {
    stdout: [
      `desired_commit=${desired}`,
      `installed_commit=${desired}`,
      "manager updated",
    ],
    stderr: [],
  });
  assert.equal(matchedInspection.outcome.ok, true);
  if (!matchedInspection.outcome.ok) assert.fail("expected normalized inspection");
  assert.equal(matchedInspection.outcome.result.kind, "current");

  const shortReceipt = normalizeCodexInstall(ok({}));
  const shortInspection = normalizeCodexInstalled(
    ok({ view: "fingerprint", fingerprint: desired.slice(0, 7) }),
    desired,
  );
  const short = codexPresentation.renderInstallVerification(
    desired, shortReceipt, shortInspection,
  );
  assert.deepEqual(short, {
    stdout: [
      `desired_commit=${desired}`,
      `installed_commit=${desired.slice(0, 7)}`,
      "manager updated",
    ],
    stderr: [],
  });
  assert.equal(shortInspection.outcome.ok, true);
  if (!shortInspection.outcome.ok) assert.fail("expected normalized inspection");
  assert.equal(shortInspection.outcome.result.kind, "current");

  const mismatchDesired = "1111111111111111111111111111111111111111";
  const mismatchReceipt = normalizeCodexInstall(
    ok({ verification_hints: { mismatch: "adapter mismatch hint" } }),
  );
  const mismatchInspection = normalizeCodexInstalled(
    ok({ view: "fingerprint", fingerprint: desired }),
    mismatchDesired,
  );
  const mismatch = codexPresentation.renderInstallVerification(
    mismatchDesired, mismatchReceipt, mismatchInspection,
  );
  assert.deepEqual(mismatch.stderr, [
    "error: installed manager fingerprint does not match the prepared plugin after install.",
    "hint: adapter mismatch hint",
  ]);

  const missingReceipt = normalizeCodexInstall(
    ok({ verification_hints: { missing: "adapter missing hint" } }),
  );
  const missingInspection = normalizeCodexInstalled(
    ok({ view: "fingerprint", fingerprint: null }),
    desired,
  );
  const missing = codexPresentation.renderInstallVerification(
    desired, missingReceipt, missingInspection,
  );
  assert.deepEqual(missing.stderr, [
    "error: installed manager fingerprint is not detectable after install.",
    "hint: adapter missing hint",
  ]);

  const malformedReceipt = normalizeCodexInstall(ok({}));
  const malformedInspection = normalizeCodexInstalled(
    ok("not-an-object"),
    desired,
  );
  const malformed = codexPresentation.renderInstallVerification(
    desired, malformedReceipt, malformedInspection,
  );
  assert.deepEqual(malformed.stderr, [
    "error: cannot parse installed manager fingerprint inspection result after install.",
  ]);
});

void test("a marketplace-list command failure fails without mutation", async (t) => {
  const sandbox = await codexSandbox(t);
  const packageRoot = join(sandbox.base, "requested");
  await mkdir(packageRoot);

  const result = await codexInstall(packageRoot, {
    root: PACKAGE_ROOT,
    env: sandbox.env({ FAKE_CODEX_MARKETPLACE_LIST: "" }),
  });

  assert.equal(result.outcome.ok, false, JSON.stringify(result.outcome));
  assert.equal(result.outcome.error?.code, "install-failed");
  assert.equal(
    result.outcome.error?.message,
    `cannot list Codex marketplaces via '${FAKE_CODEX} plugin marketplace list --json'`,
  );
  assert.deepEqual((await readFile(sandbox.log, "utf8")).trim().split("\n"), [
    "plugin marketplace list --json",
  ]);
});

void test("unrelated marketplace roots do not block manager registration", async (t) => {
  for (const [name, marketplaces] of [
    ["missing root", '{"marketplaces":[{"name":"openai-curated"}]}'],
    ["invalid root", '{"marketplaces":[{"name":"openai-curated","root":17}]}'],
  ]) {
    await t.test(name, async (t) => {
      const sandbox = await codexSandbox(t);
      const packageRoot = join(sandbox.base, "requested");
      await mkdir(packageRoot);

      const result = await codexInstall(packageRoot, {
        root: PACKAGE_ROOT,
        env: sandbox.env({ FAKE_CODEX_MARKETPLACE_LIST: marketplaces }),
      });

      assert.equal(result.outcome.ok, true, JSON.stringify(result.outcome));
      assert.deepEqual(
        (await readFile(sandbox.log, "utf8")).trim().split("\n"),
        [
          "plugin marketplace list --json",
          `plugin marketplace add ${packageRoot}`,
          "plugin add superpowers@superpowers-manager",
        ],
      );
    });
  }
});

void test("a marketplace remove failure stops install before either add", async (t) => {
  const sandbox = await codexSandbox(t);
  const packageRoot = join(sandbox.base, "requested");
  const registeredRoot = join(sandbox.base, "registered");
  const failingCodex = join(sandbox.base, "codex-remove-fails");
  await mkdir(packageRoot);
  await writeFile(
    failingCodex,
    `#!/bin/sh
set -eu
printf '%s\\n' "$*" >> "$FAKE_CODEX_LOG"
case "$*" in
  "plugin marketplace list --json")
    printf '%s\\n' "$FAKE_CODEX_MARKETPLACE_LIST"
    ;;
  "plugin marketplace remove superpowers-manager")
    printf '%s\\n' 'synthetic marketplace remove failure' >&2
    exit 42
    ;;
  "plugin marketplace add "* | "plugin add "*)
    ;;
  *)
    printf '%s\\n' "unexpected fake Codex command: $*" >&2
    exit 99
    ;;
esac
`,
    "utf8",
  );
  await chmod(failingCodex, 0o755);

  const result = await codexInstall(packageRoot, {
    root: PACKAGE_ROOT,
    env: sandbox.env({
      SUPERPOWERS_CODEX: failingCodex,
      FAKE_CODEX_MARKETPLACE_LIST: JSON.stringify({
        marketplaces: [{ name: "superpowers-manager", root: registeredRoot }],
      }),
    }),
  });

  assert.equal(result.status, 1);
  assert.deepEqual(result.outcome, {
    operation: "install",
    ok: false,
    messages: [
      {
        channel: "stdout",
        text: `marketplace superpowers-manager registered at ${registeredRoot}; re-registering at ${packageRoot}`,
      },
      { channel: "stderr", text: "synthetic marketplace remove failure" },
    ],
    result: null,
    error: {
      code: "install-failed",
      message: `codex marketplace remove failed for superpowers-manager (registered at ${registeredRoot})`,
      hints: [],
    },
  });
  assert.deepEqual((await readFile(sandbox.log, "utf8")).trim().split("\n"), [
    "plugin marketplace list --json",
    "plugin marketplace remove superpowers-manager",
  ]);
});

void test("UNINSTALL-TARGETS-01 adapter removes only manager resources", async (t) => {
  const sandbox = await codexSandbox(t);
  const result = await codexRemove(
    { pluginPresent: true, marketplacePresent: true },
    { root: PACKAGE_ROOT, env: sandbox.env() },
  );
  assert.equal(result.outcome.ok, true, JSON.stringify(result.outcome));
  assert.deepEqual((await readFile(sandbox.log, "utf8")).trim().split("\n"), [
    "plugin remove superpowers@superpowers-manager",
    "plugin marketplace remove superpowers-manager",
  ]);
});

void test("UNINSTALL-VERIFY-01 both manager resources must be absent", () => {
  const remainingPlugin = normalizeCodexOwnership(ok({
    identity_state: "manager",
    resources: { plugin: true, marketplace: false },
  }));
  assert.equal(remainingPlugin.outcome.ok, true);
  if (!remainingPlugin.outcome.ok) assert.fail("expected normalized ownership");
  assert.deepEqual(remainingPlugin.outcome.result.removalVerification, {
    kind: "blocked",
    output: { stdout: [], stderr: [
      "error: owned plugin resource is still installed after removal",
    ] },
  });

  const remainingMarketplace = normalizeCodexOwnership(ok({
    identity_state: "manager",
    resources: { plugin: false, marketplace: true },
  }));
  assert.equal(remainingMarketplace.outcome.ok, true);
  if (!remainingMarketplace.outcome.ok) assert.fail("expected normalized ownership");
  assert.deepEqual(remainingMarketplace.outcome.result.removalVerification, {
    kind: "blocked",
    output: { stdout: [], stderr: [
      "error: owned marketplace resource is still registered after removal",
    ] },
  });

  const absent = normalizeCodexOwnership(ok({
    identity_state: "manager",
    resources: { plugin: false, marketplace: false },
  }));
  assert.equal(absent.outcome.ok, true);
  if (!absent.outcome.ok) assert.fail("expected normalized ownership");
  assert.deepEqual(absent.outcome.result.removalVerification, { kind: "allowed" });

  const missing = normalizeCodexOwnership(ok({ identity_state: "manager" }));
  assert.equal(missing.outcome.ok, false);
  if (missing.outcome.ok) assert.fail("expected malformed ownership");
  assert.equal(
    missing.outcome.error.message,
    "expected a Boolean adapter result at resources.plugin",
  );
});
