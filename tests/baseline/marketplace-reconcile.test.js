// @ts-check

import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

/** @type {typeof import("../../src/adapter.js")} */
const { runAdapter } = await import(
  new URL("../../dist/adapter.js", import.meta.url).href
);
/** @type {typeof import("../../src/lifecycle.js")} */
const { verifyInstalledFingerprint, verifyUninstalledResources } = await import(
  new URL("../../dist/lifecycle.js", import.meta.url).href
);

const ROOT = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const PACKAGE_ROOT = ROOT;
const FAKE_CODEX = fileURLToPath(
  new URL("../unit/helpers/fake-codex.sh", import.meta.url),
);

/**
 * @param {unknown} result
 * @returns {any}
 */
function ok(result) {
  return {
    status: 0,
    envelope: {
      protocol: 1,
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
 * @param {import("node:test").TestContext} t
 */
async function codexSandbox(t) {
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

  const inspect = await runAdapter(["inspect", "--view", "fingerprint"], {
    root: PACKAGE_ROOT,
    env: sandbox.env({
      FAKE_CODEX_PLUGIN_LIST:
        '{"installed":[{"pluginId":"superpowers@superpowers-manager","version":"1.0.0"}]}',
    }),
  });
  assert.equal(inspect.envelope.ok, true, JSON.stringify(inspect.envelope));
  assert.deepEqual(inspect.envelope.result, {
    view: "fingerprint",
    fingerprint: desired,
  });

  const matched = verifyInstalledFingerprint(
    desired,
    ok({
      verification_hints: {
        mismatch: "adapter mismatch hint",
        missing: "adapter missing hint",
      },
    }),
    inspect,
  );
  assert.deepEqual(matched, {
    ok: true,
    stdout: [
      `desired_commit=${desired}`,
      `installed_commit=${desired}`,
      "manager updated",
    ],
    stderr: [],
  });

  const short = verifyInstalledFingerprint(
    desired,
    ok({}),
    ok({ view: "fingerprint", fingerprint: desired.slice(0, 7) }),
  );
  assert.equal(short.ok, true);

  const mismatch = verifyInstalledFingerprint(
    "1111111111111111111111111111111111111111",
    ok({ verification_hints: { mismatch: "adapter mismatch hint" } }),
    ok({ view: "fingerprint", fingerprint: desired }),
  );
  assert.deepEqual(mismatch.stderr, [
    "error: installed manager fingerprint does not match the prepared plugin after install.",
    "hint: adapter mismatch hint",
  ]);

  const missing = verifyInstalledFingerprint(
    desired,
    ok({ verification_hints: { missing: "adapter missing hint" } }),
    ok({ view: "fingerprint", fingerprint: null }),
  );
  assert.deepEqual(missing.stderr, [
    "error: installed manager fingerprint is not detectable after install.",
    "hint: adapter missing hint",
  ]);

  const malformed = verifyInstalledFingerprint(
    desired,
    ok({}),
    ok("not-an-object"),
  );
  assert.deepEqual(malformed.stderr, [
    "error: cannot parse installed manager fingerprint inspection result after install.",
  ]);
});

void test("a marketplace-list command failure fails without mutation", async (t) => {
  const sandbox = await codexSandbox(t);
  const packageRoot = join(sandbox.base, "requested");
  await mkdir(packageRoot);

  const result = await runAdapter(["install", "--package-root", packageRoot], {
    root: PACKAGE_ROOT,
    env: sandbox.env({ FAKE_CODEX_MARKETPLACE_LIST: "" }),
  });

  assert.equal(result.envelope.ok, false, JSON.stringify(result.envelope));
  assert.equal(result.envelope.error?.code, "install-failed");
  assert.equal(
    result.envelope.error?.message,
    `cannot list Codex marketplaces via '${FAKE_CODEX} plugin marketplace list --json'`,
  );
  assert.deepEqual((await readFile(sandbox.log, "utf8")).trim().split("\n"), [
    "plugin marketplace list --json",
  ]);
});

void test("unrelated marketplace roots do not block manager registration", async (t) => {
  for (const [name, marketplaces] of [
    ["missing root", '{"marketplaces":[{"name":"openai-curated"}]}'],
    [
      "invalid root",
      '{"marketplaces":[{"name":"openai-curated","root":17}]}',
    ],
  ]) {
    await t.test(name, async (t) => {
      const sandbox = await codexSandbox(t);
      const packageRoot = join(sandbox.base, "requested");
      await mkdir(packageRoot);

      const result = await runAdapter(
        ["install", "--package-root", packageRoot],
        {
          root: PACKAGE_ROOT,
          env: sandbox.env({ FAKE_CODEX_MARKETPLACE_LIST: marketplaces }),
        },
      );

      assert.equal(result.envelope.ok, true, JSON.stringify(result.envelope));
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

void test("UNINSTALL-TARGETS-01 adapter removes only manager resources", async (t) => {
  const sandbox = await codexSandbox(t);
  const result = await runAdapter(
    ["uninstall", "--plugin-present", "true", "--marketplace-present", "true"],
    { root: PACKAGE_ROOT, env: sandbox.env() },
  );
  assert.equal(result.envelope.ok, true, JSON.stringify(result.envelope));
  assert.deepEqual((await readFile(sandbox.log, "utf8")).trim().split("\n"), [
    "plugin remove superpowers@superpowers-manager",
    "plugin marketplace remove superpowers-manager",
  ]);
});

void test("UNINSTALL-VERIFY-01 both manager resources must be absent", () => {
  const remainingPlugin = verifyUninstalledResources(
    ok({ resources: { plugin: true, marketplace: false } }),
  );
  assert.deepEqual(remainingPlugin, {
    ok: false,
    message: "owned plugin resource is still installed after removal",
  });

  const remainingMarketplace = verifyUninstalledResources(
    ok({ resources: { plugin: false, marketplace: true } }),
  );
  assert.deepEqual(remainingMarketplace, {
    ok: false,
    message: "owned marketplace resource is still registered after removal",
  });

  assert.deepEqual(
    verifyUninstalledResources(
      ok({ resources: { plugin: false, marketplace: false } }),
    ),
    { ok: true },
  );
  assert.equal(verifyUninstalledResources(ok({})).ok, false);
});
