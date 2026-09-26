import assert from "node:assert/strict";
import { mkdir, readdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { scratch } from "../../../lib/scratch.ts";

import {
  assertCodexPreparationSeparate,
  codexPathFailureDetails,
  codexPathRefusal,
  codexHome,
  codexPaths,
} from "../../../../src/harnesses/codex/paths.ts";
import { SafetyError } from "../../../../src/safety-error.ts";

void test("Codex home selects durable storage independently of package location", () => {
  const paths = codexPaths(
    { HOME: "/fixture/home", CODEX_HOME: "profiles/a" },
    "/fixture",
  );
  assert.equal(paths.codexHome, "/fixture/profiles/a");
  assert.equal(
    paths.preparedRoot,
    "/fixture/profiles/a/superpowers-manager/prepared",
  );
  assert.equal(
    paths.publishedPluginRoot,
    "/fixture/profiles/a/superpowers-manager/marketplace/plugins/superpowers",
  );
  assert.throws(
    () => codexHome({}, "/fixture"),
    /cannot determine Codex state root without HOME/,
  );
});

void test("Codex path refusals preserve the operation's exact error and message", async (t) => {
  const cases = [
    {
      name: "recovery inspection",
      prepare: async (paths: ReturnType<typeof codexPaths>) => {
        await mkdir(paths.managerRoot, { recursive: true });
        await writeFile(paths.recoveryRoot, "occupied");
      },
      preparedRoot: (paths: ReturnType<typeof codexPaths>) =>
        paths.preparedRoot,
      expected: (
        paths: ReturnType<typeof codexPaths>,
        suffix: string,
        _code: string,
      ) => ({
        code: "recovery-required",
        message: `cannot inspect Codex recovery state at ${paths.recoveryRoot}${suffix}`,
      }),
    },
    {
      name: "marketplace inspection",
      prepare: async (paths: ReturnType<typeof codexPaths>) => {
        await mkdir(paths.managerRoot, { recursive: true });
        await writeFile(paths.marketplaceRoot, "occupied");
      },
      preparedRoot: (paths: ReturnType<typeof codexPaths>) =>
        paths.preparedRoot,
      expected: (
        paths: ReturnType<typeof codexPaths>,
        _suffix: string,
        code: string,
      ) => ({
        code,
        message: `cannot inspect Codex marketplace storage at ${paths.marketplaceRoot}`,
      }),
    },
    {
      name: "preparation inspection",
      prepare: async (paths: ReturnType<typeof codexPaths>) => {
        await mkdir(paths.managerRoot, { recursive: true });
        await writeFile(paths.preparedRoot, "occupied");
      },
      preparedRoot: (paths: ReturnType<typeof codexPaths>) =>
        paths.preparedRoot,
      expected: (
        paths: ReturnType<typeof codexPaths>,
        _suffix: string,
        code: string,
      ) => ({
        code,
        message: `cannot inspect Codex preparation root at ${paths.preparedRoot}`,
      }),
    },
    {
      name: "overlap",
      prepare: async (paths: ReturnType<typeof codexPaths>) => {
        await mkdir(paths.marketplaceRoot, { recursive: true });
      },
      preparedRoot: (paths: ReturnType<typeof codexPaths>) =>
        join(paths.marketplaceRoot, "prepared"),
      expected: (
        paths: ReturnType<typeof codexPaths>,
        _suffix: string,
        _code: string,
      ) => ({
        code: "preparation-overlap",
        message: `Codex preparation overlaps Codex published or recovery storage: ${join(paths.marketplaceRoot, "prepared")}`,
      }),
    },
  ] as const;

  for (const { name, prepare, preparedRoot: rootFor, expected } of cases) {
    await t.test(name, async (t) => {
      const root = scratch(t, "spw-codex-refusal-");
      const paths = codexPaths({ CODEX_HOME: join(root, "home") }, root);
      await prepare(paths);
      const preparedRoot = rootFor(paths);
      let cause: unknown;
      try {
        await assertCodexPreparationSeparate(preparedRoot, paths);
        assert.fail("expected Codex path error");
      } catch (error) {
        cause = error;
      }
      for (const [code, suffix] of [
        ["prepare-failed", ""],
        ["activation-refused", "; recovery is required before mutation"],
      ] as const) {
        assert.deepEqual(
          codexPathRefusal(cause, paths, preparedRoot, code, suffix),
          expected(paths, suffix, code),
        );
      }
    });
  }

  const root = scratch(t, "spw-codex-refusal-unrelated-");
  const paths = codexPaths({ CODEX_HOME: join(root, "home") }, root);
  for (const [code, suffix] of [
    ["prepare-failed", ""],
    ["activation-refused", "; recovery is required before mutation"],
  ] as const) {
    assert.deepEqual(
      codexPathRefusal(
        new Error("unrelated"),
        paths,
        paths.preparedRoot,
        code,
        suffix,
      ),
      {
        code,
        message: `cannot validate Codex preparation storage separation at ${paths.preparedRoot}`,
      },
    );
  }
});

void test("Codex home falls back only from an empty CODEX_HOME", () => {
  assert.equal(
    codexHome({ HOME: "/fixture/home", CODEX_HOME: "" }, "/fixture"),
    "/fixture/home/.codex",
  );
  assert.equal(
    codexPaths({ HOME: "/fixture/home" }, "/fixture").codexHome,
    "/fixture/home/.codex",
  );
});

void test("Codex preparation rejects only paths that overlap published or recovery storage", async (t) => {
  const root = scratch(t, "spw-codex-paths-");
  const paths = codexPaths({ CODEX_HOME: join(root, "codex-home") }, root);
  const prefixSibling = `${paths.marketplaceRoot}-scratch`;
  const alias = join(root, "prepared-alias");
  await symlink(paths.publishedPluginRoot, alias);

  const cases: readonly [string, string, boolean][] = [
    ["the published root itself", paths.publishedPluginRoot, true],
    [
      "a different descendant of the published marketplace",
      join(paths.marketplaceRoot, ".agents", "prepared"),
      true,
    ],
    ["a published ancestor", paths.managerRoot, true],
    [
      "a descendant of recovery storage",
      join(paths.recoveryRoot, "staged"),
      true,
    ],
    ["a symlink alias to published storage", alias, true],
    ["a missing future preparation leaf", paths.preparedRoot, false],
    [
      "a root from another Codex home",
      join(root, "other-home", "prepared"),
      false,
    ],
    ["a prefix-only published sibling", prefixSibling, false],
  ];

  for (const [name, preparedRoot, rejected] of cases) {
    await t.test(name, async () => {
      if (rejected) {
        await assert.rejects(
          assertCodexPreparationSeparate(preparedRoot, paths),
          /preparation overlaps Codex published or recovery storage/,
        );
      } else {
        await assert.doesNotReject(
          assertCodexPreparationSeparate(preparedRoot, paths),
        );
      }
      assert.deepEqual(await readdir(root), ["prepared-alias"]);
    });
  }
});

void test("path failure details distinguish local evidence from unrelated errors", async (t) => {
  assert.equal(codexPathFailureDetails(new Error("ordinary")), null);
  assert.equal(
    codexPathFailureDetails(new SafetyError("codex-paths", "no details")),
    null,
  );
  const root = scratch(t, "spw-path-details-");
  const paths = codexPaths({ CODEX_HOME: join(root, "home") }, root);
  await assert.rejects(
    assertCodexPreparationSeparate(paths.marketplaceRoot, paths),
    (cause) => {
      assert.deepEqual(codexPathFailureDetails(cause), { kind: "overlap" });
      return (
        cause instanceof Error && /preparation overlaps/.test(cause.message)
      );
    },
  );
  await mkdir(paths.managerRoot, { recursive: true });
  await writeFile(paths.recoveryRoot, "preserve");
  await assert.rejects(
    assertCodexPreparationSeparate(paths.preparedRoot, paths),
    (cause) => {
      assert.deepEqual(codexPathFailureDetails(cause), {
        kind: "inspection",
        root: "recovery",
        path: paths.recoveryRoot,
      });
      return (
        cause instanceof Error &&
        /cannot inspect recovery root/.test(cause.message)
      );
    },
  );
});
