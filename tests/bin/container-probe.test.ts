import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const STATE = join(ROOT, "tests/container/codex/assert-state.ts");
const SCHEMA = join(ROOT, "tests/container/codex/assert-schema.ts");
const scratch = mkdtempSync(join(tmpdir(), "spw-container-probe-"));
const fixtureHome = join(scratch, "home");

function invoke(helper: string, args: string[]) {
  return spawnSync(process.execPath, [helper, ...args], {
    encoding: "utf8",
    env: { ...process.env, HOME: fixtureHome },
  });
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value)}\n`);
}

function expectOk(helper: string, args: string[]): void {
  const result = invoke(helper, args);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "");
}

function expectFailure(helper: string, args: string[], message: RegExp): void {
  const result = invoke(helper, args);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, message);
}

function listing(version: string, enabled = true): string {
  return JSON.stringify({
    installed: [
      {
        pluginId: "superpowers@superpowers-manager",
        version,
        enabled,
      },
    ],
  });
}

function marketplaceListing(root: string): string {
  return JSON.stringify({
    marketplaces: [{ name: "superpowers-manager", root }],
  });
}

function activeRoot(version: string): string {
  return join(
    fixtureHome,
    ".codex/plugins/cache/superpowers-manager/superpowers",
    version,
  );
}

function activeFixture(version = "1.0.0+manager.abcdef0"): {
  version: string;
  active: string;
  marketplace: string;
  upstream: string;
} {
  const active = activeRoot(version);
  const marketplace = join(scratch, "marketplace");
  const upstream = join(scratch, "upstream");
  for (const root of [active, join(marketplace, "plugins/superpowers")]) {
    mkdirSync(join(root, ".codex-plugin"), { recursive: true });
    mkdirSync(join(root, "skills/probe"), { recursive: true });
    mkdirSync(join(root, "skills/using-superpowers"), { recursive: true });
    writeJson(join(root, ".codex-plugin/plugin.json"), {
      name: "superpowers",
      version,
      hooks: {},
    });
    writeJson(join(root, ".superpowers-upstream.json"), {
      commit: "a".repeat(40),
    });
    writeFileSync(join(root, "skills/probe/SKILL.md"), "probe\n");
    writeFileSync(join(root, "skills/using-superpowers/SKILL.md"), "using\n");
  }
  mkdirSync(join(upstream, "skills/probe"), { recursive: true });
  mkdirSync(join(upstream, "skills/using-superpowers"), { recursive: true });
  writeFileSync(join(upstream, "skills/probe/SKILL.md"), "probe\n");
  writeFileSync(join(upstream, "skills/using-superpowers/SKILL.md"), "using\n");
  return { version, active, marketplace, upstream };
}

function hooksResponse(active: boolean): Record<string, unknown> {
  const hooks = active
    ? [
        {
          source: "plugin",
          pluginId: "superpowers@superpowers-manager",
          trustStatus: "untrusted",
          enabled: true,
          isManaged: false,
        },
      ]
    : [];
  return { id: 1, result: { data: [{ hooks }] } };
}

function schemaDocuments(): {
  client: Record<string, unknown>;
  response: Record<string, unknown>;
} {
  return {
    client: {
      properties: { method: { enum: ["hooks/list"] } },
    },
    response: {
      defs: {
        "Hook/Metadata": {
          title: "HookMetadata",
          required: ["source", "enabled", "isManaged", "trustStatus"],
          properties: {
            source: { const: "plugin" },
            enabled: { type: "boolean" },
            isManaged: { type: "boolean" },
            trustStatus: { enum: ["untrusted"] },
            pluginId: { type: ["string", "null"] },
          },
        },
      },
      HookMetadata: { $ref: "#/defs/Hook~1Metadata" },
    },
  };
}

void test("container Codex assertion helpers", async (t) => {
  t.after(() => rmSync(scratch, { recursive: true, force: true }));
  mkdirSync(fixtureHome, { recursive: true });
  const fixture = activeFixture();
  const listingJson = listing(fixture.version);
  const marketplaceJson = marketplaceListing(fixture.marketplace);

  await t.test("state assertions accept their known-good fixtures", () => {
    expectOk(STATE, ["marketplace-root", marketplaceJson, fixture.marketplace]);
    expectOk(STATE, [
      "installed-commit",
      listingJson,
      fixture.active,
      fixture.version,
      "a".repeat(40),
      "b".repeat(40),
    ]);
    expectOk(STATE, [
      "installed-payload",
      listingJson,
      fixture.marketplace,
      fixture.version,
      "a".repeat(40),
    ]);
    const absentHookState = invoke(STATE, [
      "hook-state",
      join(scratch, "absent-hooks.state"),
    ]);
    assert.equal(absentHookState.status, 0, absentHookState.stderr);
    assert.equal(absentHookState.stdout, "absent\n");
    const requirements = join(scratch, "requirements.toml");
    writeFileSync(requirements, "fixture\n");
    const digest = invoke(STATE, ["digest", requirements]);
    assert.equal(digest.status, 0, digest.stderr);
    expectOk(STATE, [
      "requirements-unchanged",
      requirements,
      digest.stdout.trim(),
    ]);
    expectOk(STATE, ["empty-hooks", listingJson, fixture.active]);
    writeJson(join(fixture.active, ".codex-plugin/plugin.json"), {
      hooks: "./hooks/hooks-codex.json",
    });
    mkdirSync(join(fixture.active, "hooks/support"), { recursive: true });
    writeJson(join(fixture.active, "hooks/hooks-codex.json"), {
      hooks: {
        SessionStart: [
          {
            hooks: [
              {
                type: "command",
                command: 'sh "${PLUGIN_ROOT}/hooks/session-start-codex"',
              },
            ],
          },
        ],
      },
    });
    writeFileSync(
      join(fixture.active, "hooks/session-start-codex"),
      "/tmp/superpowers-manager-hook-sentinel\n",
    );
    writeFileSync(
      join(fixture.active, "hooks/support/helper.txt"),
      "support\n",
    );
    expectOk(STATE, ["active-hooks", listingJson, fixture.active]);
    const response = join(scratch, "hooks-empty.json");
    writeJson(response, hooksResponse(false));
    expectOk(STATE, ["hooks-absent", response]);
    const skills = join(scratch, "skills.json");
    const requestedCwd = join(scratch, "requested-cwd");
    mkdirSync(requestedCwd, { recursive: true });
    writeJson(skills, {
      id: 1,
      result: {
        data: [
          {
            cwd: requestedCwd,
            errors: [],
            skills: [
              {
                name: "superpowers:probe",
                path: join(fixture.active, "skills/probe/SKILL.md"),
                enabled: true,
              },
              {
                name: "superpowers:using-superpowers",
                path: join(fixture.active, "skills/using-superpowers/SKILL.md"),
                enabled: true,
              },
              {
                name: "constructor",
                path: join(fixture.active, "skills/probe/SKILL.md"),
                enabled: true,
              },
            ],
          },
        ],
      },
    });
    expectOk(STATE, [
      "skills",
      skills,
      listingJson,
      fixture.upstream,
      requestedCwd,
    ]);
    const activeResponse = join(scratch, "hooks-active.json");
    writeJson(activeResponse, hooksResponse(true));
    expectOk(STATE, ["hook-active", activeResponse]);
    const plugins = JSON.stringify({ installed: [] });
    const marketplaces = JSON.stringify({
      marketplaces: [{ name: "unrelated-provider" }],
    });
    expectOk(STATE, ["legacy-uninstall", plugins, marketplaces]);
    expectOk(STATE, ["missing-source-uninstall", plugins, marketplaces]);
    expectOk(STATE, ["final-uninstall", plugins, marketplaces, marketplaces]);
    expectOk(STATE, [
      "damage-skill",
      listingJson,
      fixture.marketplace,
      fixture.version,
      "a".repeat(40),
    ]);
  });

  await t.test(
    "state assertion families reject their discriminating bad fixture",
    () => {
      expectFailure(
        STATE,
        [
          "marketplace-root",
          JSON.stringify({ marketplaces: [] }),
          fixture.marketplace,
        ],
        /manager marketplace root mismatch/,
      );
      expectFailure(
        STATE,
        [
          "installed-commit",
          listingJson,
          fixture.active,
          fixture.version,
          "wrong",
          "",
        ],
        /provenance/,
      );
      expectFailure(
        STATE,
        [
          "installed-payload",
          listing(fixture.version, false),
          fixture.marketplace,
          fixture.version,
          "a".repeat(40),
        ],
        /not enabled/,
      );
      expectFailure(
        STATE,
        [
          "damage-skill",
          listing(fixture.version, false),
          fixture.marketplace,
          fixture.version,
          "a".repeat(40),
        ],
        /not enabled/,
      );
      const hookState = join(scratch, "bad-hooks.state");
      mkdirSync(hookState, { recursive: true });
      expectFailure(STATE, ["hook-state", hookState], /regular file/);
      const requirements = join(scratch, "requirements.toml");
      expectFailure(
        STATE,
        ["requirements-unchanged", requirements, "bad"],
        /contents/,
      );
      writeJson(join(fixture.active, ".codex-plugin/plugin.json"), {
        hooks: null,
      });
      expectFailure(
        STATE,
        ["empty-hooks", listingJson, fixture.active],
        /exact-empty hooks/,
      );
      writeJson(join(fixture.active, ".codex-plugin/plugin.json"), {
        hooks: "./hooks/hooks-codex.json",
      });
      mkdirSync(join(fixture.active, "hooks/support"), { recursive: true });
      writeJson(join(fixture.active, "hooks/hooks-codex.json"), { hooks: {} });
      writeFileSync(
        join(fixture.active, "hooks/session-start-codex"),
        "missing sentinel\n",
      );
      writeFileSync(
        join(fixture.active, "hooks/support/helper.txt"),
        "support\n",
      );
      expectFailure(
        STATE,
        ["active-hooks", listingJson, fixture.active],
        /hook config/,
      );
      const badSkills = join(scratch, "bad-skills.json");
      const badRequestedCwd = join(scratch, "bad-requested-cwd");
      mkdirSync(badRequestedCwd, { recursive: true });
      writeJson(badSkills, {
        id: 1,
        result: {
          data: [{ cwd: badRequestedCwd, errors: ["bad"], skills: [] }],
        },
      });
      expectFailure(
        STATE,
        ["skills", badSkills, listingJson, fixture.upstream, badRequestedCwd],
        /reports errors/,
      );
      const badHooks = join(scratch, "bad-hooks.json");
      writeJson(badHooks, { id: 1, result: { data: [{}] } });
      expectFailure(
        STATE,
        ["hooks-absent", badHooks],
        /data entry is malformed/,
      );
      writeJson(badHooks, hooksResponse(false));
      expectFailure(STATE, ["hook-active", badHooks], /exactly one hook/);
      expectFailure(
        STATE,
        ["digest", join(scratch, "missing")],
        /could not read digest input/,
      );
      expectFailure(
        STATE,
        [
          "legacy-uninstall",
          JSON.stringify({
            installed: [{ pluginId: "superpowers@superpowers-manager" }],
          }),
          "{}",
        ],
        /legacy uninstall left/,
      );
      expectFailure(
        STATE,
        [
          "missing-source-uninstall",
          pluginsWithManager(),
          JSON.stringify({ marketplaces: [] }),
        ],
        /missing-source uninstall left/,
      );
      expectFailure(
        STATE,
        [
          "final-uninstall",
          JSON.stringify({ installed: [] }),
          JSON.stringify({ marketplaces: [{ name: "unrelated-provider" }] }),
          JSON.stringify({ marketplaces: [] }),
        ],
        /unrelated provider/,
      );
    },
  );

  await t.test(
    "schema checker accepts compatible schemas and rejects protocol drift",
    () => {
      const { client, response } = schemaDocuments();
      const clientPath = join(scratch, "ClientRequest.json");
      const responsePath = join(scratch, "HooksListResponse.json");
      writeJson(clientPath, client);
      writeJson(responsePath, response);
      expectOk(SCHEMA, [clientPath, responsePath]);
      for (const [name, mutate, expectation] of [
        [
          "missing required",
          (value: Record<string, unknown>) => {
            (
              (value.defs as Record<string, Record<string, unknown>>)[
                "Hook/Metadata"
              ].required as string[]
            ).pop();
          },
          /required fields changed/,
        ],
        [
          "external ref",
          (value: Record<string, unknown>) => {
            (value.HookMetadata as Record<string, unknown>).$ref =
              "other.json#/x";
          },
          /unsupported schema reference/,
        ],
        [
          "cycle",
          (value: Record<string, unknown>) => {
            (value.HookMetadata as Record<string, unknown>).$ref =
              "#/HookMetadata";
          },
          /unsupported schema reference/,
        ],
        [
          "unresolved ref",
          (value: Record<string, unknown>) => {
            (value.HookMetadata as Record<string, unknown>).$ref = "#/missing";
          },
          /unresolved schema reference/,
        ],
        [
          "required pluginId",
          (value: Record<string, unknown>) => {
            (
              (value.defs as Record<string, Record<string, unknown>>)[
                "Hook/Metadata"
              ].required as string[]
            ).push("pluginId");
          },
          /unexpectedly became required/,
        ],
        [
          "wrong pluginId types",
          (value: Record<string, unknown>) => {
            (
              (value.defs as Record<string, Record<string, unknown>>)[
                "Hook/Metadata"
              ].properties as Record<string, Record<string, unknown>>
            ).pluginId.type = "string";
          },
          /not string-or-null/,
        ],
      ] as const) {
        const copy = structuredClone(response);
        mutate(copy);
        writeJson(responsePath, copy);
        expectFailure(SCHEMA, [clientPath, responsePath], expectation);
        assert.equal(name.length > 0, true);
      }
    },
  );
});

function pluginsWithManager(): string {
  return JSON.stringify({
    installed: [{ pluginId: "superpowers@superpowers-manager" }],
  });
}
