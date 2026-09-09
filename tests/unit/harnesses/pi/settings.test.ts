import assert from "node:assert/strict";
import {
  chmod,
  mkdir,
  mkdtemp,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

import {
  readPiSettings,
  resolvePiLocalSource,
} from "../../../../src/harnesses/pi/settings.ts";
import { SafetyError } from "../../../../src/safety-error.ts";
import { exactError } from "../../../lib/error-assertions.ts";

async function sandbox(t: import("node:test").TestContext): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "spw-pi-settings-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

void test("Pi settings reader reports the bounded registration state", async (t) => {
  const agentDir = await sandbox(t);
  const settingsFile = join(agentDir, "settings.json");

  await t.test("a missing settings file means no registrations", async () => {
    assert.deepEqual(await readPiSettings(settingsFile), { packages: [] });
  });

  await t.test(
    "retains top-level skill controls even when packages are absent",
    async () => {
      await writeFile(
        settingsFile,
        JSON.stringify({
          skills: ["!SKILL.md", "+skills/superpowers/using-superpowers"],
        }),
      );
      assert.deepEqual(await readPiSettings(settingsFile), {
        packages: [],
        skills: ["!SKILL.md", "+skills/superpowers/using-superpowers"],
      });

      await writeFile(settingsFile, JSON.stringify({ skills: [] }));
      assert.deepEqual(await readPiSettings(settingsFile), {
        packages: [],
        skills: [],
      });
    },
  );

  await t.test("accepts native string and object source forms", async () => {
    await writeFile(
      settingsFile,
      JSON.stringify({
        futureSetting: { preservedByTheUserFile: true },
        packages: [
          "superpowers-manager/installed",
          { source: "./default", autoload: true, future: "ignored" },
          { source: "./autoload-off", autoload: false },
          { source: "./filters-empty", skills: [], extensions: [] },
          { source: "./one-filter-empty", skills: [] },
          {
            source: "./positive-filters",
            autoload: false,
            skills: ["+skills/using-superpowers/SKILL.md"],
            extensions: ["+.pi/extensions/superpowers.ts"],
          },
        ],
      }),
    );

    assert.deepEqual(await readPiSettings(settingsFile), {
      packages: [
        {
          source: "superpowers-manager/installed",
          resourceState: "enabled",
        },
        { source: "./default", resourceState: "enabled" },
        { source: "./autoload-off", resourceState: "disabled" },
        { source: "./filters-empty", resourceState: "disabled" },
        { source: "./one-filter-empty", resourceState: "indeterminate" },
        { source: "./positive-filters", resourceState: "indeterminate" },
      ],
    });
  });

  await t.test("uses Pi JSON last-key-wins semantics", async () => {
    await writeFile(
      settingsFile,
      '{"packages":[],"packages":["superpowers-manager/installed"]}',
    );
    assert.deepEqual(await readPiSettings(settingsFile), {
      packages: [
        {
          source: "superpowers-manager/installed",
          resourceState: "enabled",
        },
      ],
    });
  });

  await t.test(
    "rejects malformed JSON instead of reporting empty",
    async () => {
      await writeFile(settingsFile, "{");
      await assert.rejects(
        readPiSettings(settingsFile),
        exactError(SafetyError, `cannot parse Pi settings ${settingsFile}`),
      );
    },
  );

  await t.test(
    "rejects an unreadable settings file instead of reporting empty",
    async () => {
      await writeFile(settingsFile, '{"packages":[]}');
      await chmod(settingsFile, 0o000);
      try {
        await assert.rejects(
          readPiSettings(settingsFile),
          exactError(SafetyError, `cannot read Pi settings ${settingsFile}`),
        );
      } finally {
        await chmod(settingsFile, 0o600);
      }
    },
  );

  await t.test("rejects malformed relevant fields", async () => {
    const invalid: readonly (readonly [string, string])[] = [
      ["[]", "settings must be an object"],
      ['{"packages":{}}', "packages must be an array"],
      ['{"skills":"all"}', "skills must be an array of strings"],
      ['{"packages":[7]}', "package 0 must be a string or object"],
      ['{"packages":[{}]}', "package 0 source must be a nonempty string"],
      [
        '{"packages":[{"source":"./x","autoload":"yes"}]}',
        "package 0 autoload must be a boolean",
      ],
      [
        '{"packages":[{"source":"./x","skills":"all"}]}',
        "package 0 skills must be an array of strings",
      ],
      [
        '{"packages":[{"source":"./x","extensions":[7]}]}',
        "package 0 extensions must be an array of strings",
      ],
    ];

    for (const [raw, detail] of invalid) {
      await writeFile(settingsFile, raw);
      await assert.rejects(
        readPiSettings(settingsFile),
        exactError(
          SafetyError,
          `invalid Pi settings ${settingsFile}: ${detail}`,
        ),
        raw,
      );
    }
  });

  await t.test(
    "rejects duplicate equivalent Manager registrations",
    async () => {
      await writeFile(
        settingsFile,
        JSON.stringify({
          packages: [
            "superpowers-manager/installed",
            "~/superpowers-manager/installed",
          ],
        }),
      );
      await assert.rejects(
        readPiSettings(settingsFile, agentDir),
        exactError(
          SafetyError,
          `invalid Pi settings ${settingsFile}: duplicate Manager package registrations`,
        ),
      );
    },
  );

  await t.test(
    "rejects duplicate Manager registrations through a symlinked agent directory",
    async () => {
      const physicalRoot = join(agentDir, "physical-root");
      const linkedRoot = join(agentDir, "linked-root");
      const physicalAgent = join(physicalRoot, "agent");
      const linkedAgent = join(linkedRoot, "agent");
      await mkdir(physicalAgent, { recursive: true });
      await symlink(physicalRoot, linkedRoot, "dir");
      const linkedSettings = join(linkedAgent, "settings.json");
      await writeFile(
        linkedSettings,
        JSON.stringify({
          packages: [
            "superpowers-manager/installed",
            join(physicalAgent, "superpowers-manager", "installed"),
          ],
        }),
      );
      await assert.rejects(
        readPiSettings(linkedSettings, agentDir),
        exactError(
          SafetyError,
          `invalid Pi settings ${linkedSettings}: duplicate Manager package registrations`,
        ),
      );
    },
  );

  await t.test("requires explicit HOME context for tilde sources", async () => {
    await writeFile(
      settingsFile,
      JSON.stringify({ packages: ["~/some-package"] }),
    );
    await assert.rejects(
      readPiSettings(settingsFile),
      exactError(
        SafetyError,
        "cannot resolve Pi local source containing ~ without HOME",
      ),
    );
  });
});

void test("Pi local source resolution matches native identities", () => {
  const agentDir = "/tmp/pi-user";
  assert.equal(
    resolvePiLocalSource("superpowers-manager/installed", agentDir),
    resolvePiLocalSource(
      "/tmp/pi-user/superpowers-manager/installed",
      agentDir,
    ),
  );
  assert.equal(
    resolvePiLocalSource(" ./packages/../local-package ", agentDir),
    "/tmp/pi-user/local-package",
  );
  assert.equal(
    resolvePiLocalSource(
      pathToFileURL("/tmp/pi-user/file-package").href,
      agentDir,
    ),
    "/tmp/pi-user/file-package",
  );
  assert.equal(
    resolvePiLocalSource("~/pi-package", agentDir, "/isolated/home"),
    "/isolated/home/pi-package",
  );
  assert.throws(
    () => resolvePiLocalSource("~/pi-package", agentDir),
    exactError(
      SafetyError,
      "cannot resolve Pi local source containing ~ without HOME",
    ),
  );
  assert.equal(
    resolvePiLocalSource("git@github.com:obra/superpowers.git", agentDir),
    "/tmp/pi-user/git@github.com:obra/superpowers.git",
  );
  for (const [source, expected] of [
    ["github:obra/superpowers", "/tmp/pi-user/github:obra/superpowers"],
    ["NPM:x", "/tmp/pi-user/NPM:x"],
    ["git+https:x", "/tmp/pi-user/git+https:x"],
    ["FILE:///native-case", "/tmp/pi-user/FILE:/native-case"],
  ]) {
    assert.equal(resolvePiLocalSource(source, agentDir), expected, source);
  }
  assert.throws(
    () => resolvePiLocalSource("file://%", agentDir),
    exactError(
      SafetyError,
      "cannot resolve Pi local source from invalid file URL",
    ),
  );

  for (const source of [
    "npm:@scope/package@1.0.0",
    "git:https://github.com/obra/superpowers.git",
    "http://github.com/obra/superpowers.git",
    "https://github.com/obra/superpowers.git",
    "ssh://git@github.com/obra/superpowers.git",
  ]) {
    assert.equal(resolvePiLocalSource(source, agentDir), null, source);
  }
});
