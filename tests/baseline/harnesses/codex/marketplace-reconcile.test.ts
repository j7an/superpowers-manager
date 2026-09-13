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
  codexInstall,
  codexRemove,
} from "../../../../src/harnesses/codex/adapter.ts";

import { codexOwnershipInspection } from "../../../../src/harnesses/codex/lifecycle.ts";
import {
  codexInstallReceipt,
  codexPresentation,
} from "../../../../src/harnesses/codex/presentation.ts";

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

void test("INSTALL-VERIFY-01 typed installed state and hints", () => {
  const desired = "abcdef0123456789abcdef0123456789abcdef01";
  const matchedReceipt = ok(
    codexInstallReceipt("adapter missing hint", "adapter mismatch hint"),
  );
  const matchedInspection = ok({ kind: "current", observedIdentity: desired });
  const matched = codexPresentation.renderInstallVerification(
    desired,
    matchedReceipt,
    matchedInspection,
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
  if (!matchedInspection.outcome.ok)
    assert.fail("expected normalized inspection");
  assert.equal(matchedInspection.outcome.result.kind, "current");

  const shortReceipt = ok(codexInstallReceipt("", ""));
  const shortInspection = ok({
    kind: "current",
    observedIdentity: desired.slice(0, 7),
  });
  const short = codexPresentation.renderInstallVerification(
    desired,
    shortReceipt,
    shortInspection,
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
  if (!shortInspection.outcome.ok)
    assert.fail("expected normalized inspection");
  assert.equal(shortInspection.outcome.result.kind, "current");

  const mismatchDesired = "1111111111111111111111111111111111111111";
  const mismatchReceipt = ok(codexInstallReceipt("", "adapter mismatch hint"));
  const mismatchInspection = ok({
    kind: "mismatch",
    observedIdentity: desired,
  });
  const mismatch = codexPresentation.renderInstallVerification(
    mismatchDesired,
    mismatchReceipt,
    mismatchInspection,
  );
  assert.deepEqual(mismatch.stderr, [
    "error: installed manager fingerprint does not match the prepared plugin after install.",
    "hint: adapter mismatch hint",
  ]);

  const missingReceipt = ok(codexInstallReceipt("adapter missing hint", ""));
  const missingInspection = ok({ kind: "absent", observedIdentity: "" });
  const missing = codexPresentation.renderInstallVerification(
    desired,
    missingReceipt,
    missingInspection,
  );
  assert.deepEqual(missing.stderr, [
    "error: installed manager fingerprint is not detectable after install.",
    "hint: adapter missing hint",
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
  const remainingPlugin = codexOwnershipInspection(
    "manager",
    { pluginPresent: true, marketplacePresent: false },
    [],
  );
  assert.deepEqual(remainingPlugin.removalVerification, {
    kind: "blocked",
    output: {
      stdout: [],
      stderr: ["error: owned plugin resource is still installed after removal"],
    },
  });

  const remainingMarketplace = codexOwnershipInspection(
    "manager",
    { pluginPresent: false, marketplacePresent: true },
    [],
  );
  assert.deepEqual(remainingMarketplace.removalVerification, {
    kind: "blocked",
    output: {
      stdout: [],
      stderr: [
        "error: owned marketplace resource is still registered after removal",
      ],
    },
  });

  const absent = codexOwnershipInspection(
    "manager",
    { pluginPresent: false, marketplacePresent: false },
    [],
  );
  assert.deepEqual(absent.removalVerification, {
    kind: "allowed",
  });
});
