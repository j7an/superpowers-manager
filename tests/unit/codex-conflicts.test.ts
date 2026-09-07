import assert from "node:assert/strict";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { inspectCodexConflicts } from "../../src/codex-conflicts.ts";

function listing(items: readonly Record<string, unknown>[]): string {
  return JSON.stringify({ installed: items });
}

void test("Codex unmanaged plugin conflicts follow qualified native state", async (t) => {
  await t.test("reports an active installed Superpowers provider", async () => {
    assert.deepEqual(
      await inspectCodexConflicts(
        { root: "/unused", env: {} },
        listing([
          {
            pluginId: "superpowers@another-provider",
            installed: true,
            enabled: true,
          },
        ]),
      ),
      ["active Codex plugin superpowers@another-provider"],
    );
  });

  await t.test(
    "allows disabled and marketplace-only Superpowers entries",
    async () => {
      assert.deepEqual(
        await inspectCodexConflicts(
          { root: "/unused", env: {} },
          listing([
            {
              pluginId: "superpowers@disabled-provider",
              installed: true,
              enabled: false,
            },
            {
              pluginId: "superpowers@marketplace-only",
              installed: false,
              enabled: false,
            },
          ]),
        ),
        [],
      );
    },
  );

  await t.test(
    "reports missing or malformed activity state as indeterminate",
    async () => {
      assert.deepEqual(
        await inspectCodexConflicts(
          { root: "/unused", env: {} },
          listing([
            { pluginId: "superpowers@missing-state" },
            {
              pluginId: "superpowers@malformed-state",
              installed: true,
              enabled: "yes",
            },
          ]),
        ),
        [
          "Codex plugin superpowers@missing-state has indeterminate activity",
          "Codex plugin superpowers@malformed-state has indeterminate activity",
        ],
      );
    },
  );

  await t.test(
    "ignores Manager, legacy, unrelated, and Pi-only identities",
    async () => {
      assert.deepEqual(
        await inspectCodexConflicts(
          { root: "/unused", env: {} },
          listing([
            {
              pluginId: "superpowers@superpowers-manager",
              installed: true,
              enabled: true,
            },
            {
              pluginId: "superpowers@superpowers-wrapper",
              installed: true,
              enabled: true,
            },
            {
              pluginId: "unrelated@another-provider",
              installed: true,
              enabled: true,
            },
            {
              pluginId: "superpowers",
              installed: true,
              enabled: true,
            },
          ]),
        ),
        [],
      );
    },
  );

  await t.test(
    "blocks a Superpowers identity without emitting unsafe provider text",
    async () => {
      assert.deepEqual(
        await inspectCodexConflicts(
          { root: "/unused", env: {} },
          listing([
            {
              pluginId: "superpowers@unsafe\n",
              installed: true,
              enabled: true,
            },
          ]),
        ),
        ["active Codex plugin with a non-displayable Superpowers identity"],
      );
    },
  );
});

void test("the documented native Codex skills route is indeterminate and untouched", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "spw-codex-conflicts-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const target = join(home, "native-superpowers");
  const skill = join(target, "using-superpowers", "SKILL.md");
  await mkdir(join(target, "using-superpowers"), { recursive: true });
  await writeFile(
    skill,
    "---\nname: using-superpowers\ndescription: fixture\n---\n# Fixture\n",
    "utf8",
  );
  const route = join(home, ".agents", "skills", "superpowers");
  await mkdir(join(home, ".agents", "skills"), { recursive: true });
  await symlink(target, route);

  assert.deepEqual(
    await inspectCodexConflicts(
      { root: "/unused", env: { HOME: home } },
      listing([]),
    ),
    [
      "native Codex skills route ~/.agents/skills/superpowers has indeterminate activity",
    ],
  );
  assert.equal(await readlink(route), target);
  assert.equal((await lstat(route)).isSymbolicLink(), true);
  assert.equal(
    await readFile(skill, "utf8"),
    "---\nname: using-superpowers\ndescription: fixture\n---\n# Fixture\n",
  );
});

void test("Pi resources never appear in Codex conflict results", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "spw-codex-conflicts-pi-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const piSkill = join(
    home,
    ".pi",
    "agent",
    "skills",
    "superpowers",
    "using-superpowers",
  );
  await mkdir(piSkill, { recursive: true });
  await writeFile(
    join(piSkill, "SKILL.md"),
    "---\nname: using-superpowers\n---\n",
    "utf8",
  );

  assert.deepEqual(
    await inspectCodexConflicts(
      { root: "/unused", env: { HOME: home } },
      listing([]),
    ),
    [],
  );
});
