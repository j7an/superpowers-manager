import assert from "node:assert/strict";
import {
  chmod,
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
import { dirname, join } from "node:path";
import test from "node:test";

import { inspectCodexConflicts } from "../../../../src/harnesses/codex/conflicts.ts";

function listing(items: readonly Record<string, unknown>[]): string {
  return JSON.stringify({ installed: items });
}

void test("Codex unmanaged plugin conflicts follow qualified native state", async (t) => {
  const emptyHome = await mkdtemp(join(tmpdir(), "spw-codex-conflicts-empty-"));
  t.after(() => rm(emptyHome, { recursive: true, force: true }));
  for (const env of [{}, { HOME: "" }]) {
    assert.deepEqual(
      await inspectCodexConflicts({ root: "/unused", env }, listing([])),
      [
        "native Codex skills route ~/.agents/skills/superpowers has indeterminate activity",
      ],
    );
  }

  await t.test("reports an active installed Superpowers provider", async () => {
    assert.deepEqual(
      await inspectCodexConflicts(
        { root: "/unused", env: { HOME: emptyHome } },
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
          { root: "/unused", env: { HOME: emptyHome } },
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
          { root: "/unused", env: { HOME: emptyHome } },
          listing([
            { pluginId: "superpowers@missing-state" },
            {
              pluginId: "superpowers@malformed-state",
              installed: true,
              enabled: "yes",
            },
            {
              pluginId: "superpowers@contradictory-state",
              installed: false,
              enabled: true,
            },
          ]),
        ),
        [
          "Codex plugin superpowers@missing-state has indeterminate activity",
          "Codex plugin superpowers@malformed-state has indeterminate activity",
          "Codex plugin superpowers@contradictory-state has indeterminate activity",
        ],
      );
    },
  );

  await t.test(
    "ignores Manager, legacy, unrelated, and Pi-only identities",
    async () => {
      assert.deepEqual(
        await inspectCodexConflicts(
          { root: "/unused", env: { HOME: emptyHome } },
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
          { root: "/unused", env: { HOME: emptyHome } },
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

  await t.test("a dangling native-route symlink fails closed", async (t) => {
    const danglingHome = await mkdtemp(
      join(tmpdir(), "spw-codex-conflicts-dangling-"),
    );
    t.after(() => rm(danglingHome, { recursive: true, force: true }));
    const danglingRoute = join(
      danglingHome,
      ".agents",
      "skills",
      "superpowers",
    );
    await mkdir(join(danglingHome, ".agents", "skills"), { recursive: true });
    const missingTarget = join(danglingHome, "missing-superpowers");
    await symlink(missingTarget, danglingRoute);

    assert.deepEqual(
      await inspectCodexConflicts(
        { root: "/unused", env: { HOME: danglingHome } },
        listing([]),
      ),
      [
        "native Codex skills route ~/.agents/skills/superpowers has indeterminate activity",
      ],
    );
    assert.equal(await readlink(danglingRoute), missingTarget);
  });

  await t.test("an unreadable identifying asset fails closed", async (t) => {
    const unreadableHome = await mkdtemp(
      join(tmpdir(), "spw-codex-conflicts-unreadable-"),
    );
    t.after(() => rm(unreadableHome, { recursive: true, force: true }));
    const unreadableSkill = join(
      unreadableHome,
      ".agents",
      "skills",
      "superpowers",
      "using-superpowers",
      "SKILL.md",
    );
    await mkdir(dirname(unreadableSkill), { recursive: true });
    await writeFile(
      unreadableSkill,
      "---\nname: using-superpowers\n---\n",
      "utf8",
    );
    await chmod(unreadableSkill, 0o000);
    t.after(() => chmod(unreadableSkill, 0o600).catch(() => undefined));
    try {
      await readFile(unreadableSkill, "utf8");
    } catch {
      assert.deepEqual(
        await inspectCodexConflicts(
          { root: "/unused", env: { HOME: unreadableHome } },
          listing([]),
        ),
        [
          "native Codex skills route ~/.agents/skills/superpowers has indeterminate activity",
        ],
      );
      return;
    }
    t.skip("filesystem does not enforce unreadable owner mode");
  });

  await t.test(
    "an unrelated directory at the route remains allowed",
    async (t) => {
      const unrelatedHome = await mkdtemp(
        join(tmpdir(), "spw-codex-conflicts-unrelated-"),
      );
      t.after(() => rm(unrelatedHome, { recursive: true, force: true }));
      const unrelatedRoute = join(
        unrelatedHome,
        ".agents",
        "skills",
        "superpowers",
      );
      await mkdir(unrelatedRoute, { recursive: true });
      await writeFile(join(unrelatedRoute, "README.md"), "unrelated\n", "utf8");

      assert.deepEqual(
        await inspectCodexConflicts(
          { root: "/unused", env: { HOME: unrelatedHome } },
          listing([]),
        ),
        [],
      );
    },
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
