import assert from "node:assert/strict";
import { existsSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import {
  findSuperpowersManifests,
  projectPluginsEnabled,
  readHermesStatus,
} from "../../../../src/harnesses/hermes/observe.ts";
import { hermesSandbox } from "../../../lib/harnesses/hermes/package-fixture.ts";

function write(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}

void test("readHermesStatus inspects a padded managed directory override", async (t) => {
  const s = hermesSandbox(t);
  write(
    join(s.paths.hermesHome, "config.yaml"),
    "plugins: {enabled: [superpowers]}",
  );
  write(
    join(s.env.HERMES_MANAGED_DIR!, "config.yaml"),
    "plugins: {disabled: [superpowers]}",
  );
  await assert.rejects(
    readHermesStatus(
      s.paths,
      {
        ...s.env,
        HERMES_MANAGED_DIR: ` \t${s.env.HERMES_MANAGED_DIR!}\n `,
      },
      join(s.root, "system"),
    ),
    {
      message: "cannot determine Hermes plugin activation",
    },
  );
});

for (const [text, found] of [
  ["false", true],
  ["0", true],
  ['""', true],
  ["[]", true],
  ["null", true],
  ["", true],
  ["{}", true],
  [".nan", false],
  ["!!set {unrelated: null}", false],
  ["!!binary c3VwZXJwb3dlcnM=", false],
  ["!!omap [{unrelated: null}]", false],
  ["!!set {}", true],
  ['!!binary ""', true],
  ["!!omap []", true],
] as const) {
  void test(`findSuperpowersManifests mirrors Python YAML fallback for ${JSON.stringify(text)}`, async (t) => {
    const s = hermesSandbox(t);
    const directory = join(s.paths.pluginsRoot, "category", "superpowers");
    write(join(directory, "plugin.yaml"), text);
    assert.deepEqual(
      await findSuperpowersManifests(s.paths),
      found ? [directory] : [],
    );
  });
}

for (const [subject, text] of [
  ["configuration", "plugins: {enabled: [!unknown superpowers]}"],
  ["manifest", "name: !unknown superpowers"],
] as const) {
  void test(`Hermes observation refuses unresolved YAML tags in ${subject}`, async (t) => {
    const s = hermesSandbox(t);
    if (subject === "configuration") {
      write(join(s.paths.hermesHome, "config.yaml"), text);
      await assert.rejects(
        readHermesStatus(s.paths, s.env, join(s.root, "system")),
        {
          message: "cannot inspect Hermes configuration",
        },
      );
    } else {
      write(join(s.paths.pluginRoot, "plugin.yaml"), text);
      assert.deepEqual(await findSuperpowersManifests(s.paths), []);
    }
  });
}

for (const [value, expected] of [
  ["[]", "refuse"],
  ["other", "refuse"],
  ["null", "enabled"],
  ["!!set {unrelated: null}", "refuse"],
  ["!!binary c3VwZXJwb3dlcnM=", "refuse"],
  ["!!omap [{unrelated: null}]", "refuse"],
  ["!!set {}", "refuse"],
  ['!!binary ""', "refuse"],
  ["!!omap []", "refuse"],
] as const) {
  void test(`readHermesStatus handles managed plugins ${value} without guessing activation`, async (t) => {
    const s = hermesSandbox(t);
    write(
      join(s.paths.hermesHome, "config.yaml"),
      "plugins: {enabled: [superpowers]}",
    );
    write(join(s.env.HERMES_MANAGED_DIR!, "config.yaml"), `plugins: ${value}`);
    const status = readHermesStatus(s.paths, s.env, join(s.root, "system"));
    if (expected === "refuse")
      await assert.rejects(status, {
        message: "cannot determine Hermes plugin activation",
      });
    else assert.equal(await status, "enabled");
  });
}

for (const [name, text, expected] of [
  ["no file", null, "not enabled"],
  ["enabled", "plugins: {enabled: [superpowers]}", "enabled"],
  ["merged activation", "plugins: {<<: {enabled: [superpowers]}}", "enabled"],
  [
    "both lists",
    "plugins: {enabled: [superpowers], disabled: [superpowers]}",
    "disabled",
  ],
  ["non-list", "plugins: {enabled: superpowers}", "not enabled"],
  ["numeric item", "plugins: {enabled: [superpowers, 3]}", "enabled"],
  ["scalar plugins", "plugins: superpowers", "not enabled"],
  ["list plugins", "plugins: [superpowers]", "not enabled"],
  ["unrelated managed config", "plugins: {enabled: [superpowers]}", "enabled"],
] as const) {
  void test(`readHermesStatus is ${expected} for ${name}`, async (t) => {
    const s = hermesSandbox(t);
    if (text !== null) write(join(s.paths.hermesHome, "config.yaml"), text);
    if (name === "unrelated managed config")
      write(join(s.env.HERMES_MANAGED_DIR!, "config.yaml"), "model: example");
    assert.equal(
      await readHermesStatus(s.paths, s.env, join(s.root, "system")),
      expected,
    );
    if (text === null) assert.equal(existsSync(s.paths.hermesHome), false);
  });
}

for (const [name, text] of [
  ["malformed YAML", "plugins: ["],
  ["duplicate keys", "plugins: {}\nplugins: {}"],
  ["top-level list", "- superpowers"],
  ["top-level scalar", "superpowers"],
  ["oversized file", "x".repeat(1024 * 1024 + 1)],
  ["symlink", "plugins: {}"],
] as const) {
  void test(`readHermesStatus fails closed on ${name}`, async (t) => {
    const s = hermesSandbox(t);
    const config = join(s.paths.hermesHome, "config.yaml");
    if (name === "symlink") {
      write(join(s.root, "target"), text);
      mkdirSync(s.paths.hermesHome);
      symlinkSync(join(s.root, "target"), config);
    } else write(config, text);
    await assert.rejects(
      readHermesStatus(s.paths, s.env, join(s.root, "system")),
      {
        message: "cannot inspect Hermes configuration",
      },
    );
  });
}

void test("readHermesStatus rejects invalid UTF-8 configuration", async (t) => {
  const s = hermesSandbox(t);
  mkdirSync(s.paths.hermesHome, { recursive: true });
  writeFileSync(
    join(s.paths.hermesHome, "config.yaml"),
    Buffer.concat([
      Buffer.from("plugins: {enabled: [superpowers]}\n# "),
      Buffer.from([0xff]),
    ]),
  );
  await assert.rejects(
    readHermesStatus(s.paths, s.env, join(s.root, "system")),
    {
      message: "cannot inspect Hermes configuration",
    },
  );
});

void test("findSuperpowersManifests skips invalid UTF-8 manifests", async (t) => {
  const s = hermesSandbox(t);
  mkdirSync(s.paths.pluginRoot, { recursive: true });
  writeFileSync(
    join(s.paths.pluginRoot, "plugin.yaml"),
    Buffer.concat([Buffer.from("name: superpowers\n# "), Buffer.from([0xff])]),
  );
  assert.deepEqual(await findSuperpowersManifests(s.paths), []);
});

for (const [name, text] of [
  ["mapping item", "plugins: {enabled: [superpowers, {}]}"],
  ["list item", "plugins: {disabled: [[superpowers]]}"],
  ["enabled expansion", 'plugins: {enabled: ["${SPW_PLUGIN}"]}'],
  ["disabled expansion", 'plugins: {disabled: ["${env:X}"]}'],
  ["managed activation", "plugins: {disabled: [superpowers]}"],
  ["system activation", "plugins: {disabled: [superpowers]}"],
  ["malformed managed config", "plugins: ["],
  ["managed activation without user config", "plugins: {enabled: []}"],
  ["system activation without user config", "plugins: {enabled: []}"],
  ["managed null activation", "plugins: {disabled: null}"],
  ["managed merged activation", "plugins: {<<: {enabled: [superpowers]}}"],
] as const) {
  void test(`readHermesStatus refuses undeterminable activation for ${name}`, async (t) => {
    const s = hermesSandbox(t);
    const managed = name.includes("managed") || name.includes("system");
    const system = join(s.root, "system");
    const env = name.includes("system")
      ? { ...s.env, HERMES_MANAGED_DIR: "" }
      : s.env;
    if (managed) {
      write(
        join(
          name.includes("system") ? system : s.env.HERMES_MANAGED_DIR!,
          "config.yaml",
        ),
        text,
      );
      if (!name.includes("without user"))
        write(join(s.paths.hermesHome, "config.yaml"), "plugins: {}");
    } else write(join(s.paths.hermesHome, "config.yaml"), text);
    await assert.rejects(readHermesStatus(s.paths, env, system), {
      message: "cannot determine Hermes plugin activation",
    });
  });
}

void test("findSuperpowersManifests mirrors Hermes discovery", async (t) => {
  const s = hermesSandbox(t);
  for (const [file, text] of [
    ["superpowers/plugin.yaml", "name: superpowers"],
    ["other/plugin.yaml", "name: superpowers"],
    ["nameless/superpowers/plugin.yaml", "description: fixture"],
    ["portable/plugin.json", '{"name":"superpowers"}'],
    ["__cache__/plugin.yaml", "name: superpowers"],
    [".kimi-plugin/plugin.json", '{"name":"superpowers"}'],
    ["broken/plugin.yaml", "name: ["],
    ["unrelated/plugin.yaml", "name: x"],
    ["preferred/plugin.yaml", "name: x"],
    ["preferred/plugin.json", '{"name":"superpowers"}'],
    ["yml/plugin.yml", "name: superpowers"],
    ["deep/category/superpowers/plugin.yaml", "name: superpowers"],
  ])
    write(join(s.paths.pluginsRoot, file!), text!);
  assert.deepEqual(
    await findSuperpowersManifests(s.paths),
    ["nameless/superpowers", "other", "portable", "superpowers", "yml"].map(
      (name) => join(s.paths.pluginsRoot, name),
    ),
  );
});

void test("findSuperpowersManifests uses the last duplicate name like Hermes", async (t) => {
  const s = hermesSandbox(t);
  for (const [file, text] of [
    ["yaml-match/plugin.yaml", "name: other\nname: superpowers"],
    ["yaml-other/plugin.yaml", "name: superpowers\nname: other"],
    ["json-match/plugin.json", '{"name":"other","name":"superpowers"}'],
    ["json-other/plugin.json", '{"name":"superpowers","name":"other"}'],
  ])
    write(join(s.paths.pluginsRoot, file!), text!);
  assert.deepEqual(await findSuperpowersManifests(s.paths), [
    join(s.paths.pluginsRoot, "json-match"),
    join(s.paths.pluginsRoot, "yaml-match"),
  ]);
});

void test("findSuperpowersManifests resolves YAML merged names like Hermes", async (t) => {
  const s = hermesSandbox(t);
  write(
    join(s.paths.pluginsRoot, "merged", "plugin.yaml"),
    "<<: {name: superpowers}",
  );
  assert.deepEqual(await findSuperpowersManifests(s.paths), [
    join(s.paths.pluginsRoot, "merged"),
  ]);
});

void test("findSuperpowersManifests is empty when plugins/ is missing and creates nothing", async (t) => {
  const s = hermesSandbox(t);
  assert.deepEqual(await findSuperpowersManifests(s.paths), []);
  assert.equal(existsSync(s.paths.hermesHome), false);
});

for (const kind of [
  "oversized manifest",
  "symlinked manifest",
  "non-directory root",
] as const) {
  void test(`findSuperpowersManifests fails closed on ${kind}`, async (t) => {
    const s = hermesSandbox(t);
    const manifest = join(s.paths.pluginRoot, "plugin.yaml");
    if (kind === "oversized manifest")
      write(manifest, "x".repeat(64 * 1024 + 1));
    else if (kind === "symlinked manifest") {
      write(join(s.root, "manifest"), "name: superpowers");
      mkdirSync(s.paths.pluginRoot, { recursive: true });
      symlinkSync(join(s.root, "manifest"), manifest);
    } else write(s.paths.pluginsRoot, "file");
    await assert.rejects(findSuperpowersManifests(s.paths), {
      message: "cannot inspect Hermes plugins",
    });
  });
}

void test("projectPluginsEnabled accepts only Hermes truthy values", () => {
  for (const value of ["1", "true", "yes", " On "])
    assert.equal(
      projectPluginsEnabled({ HERMES_ENABLE_PROJECT_PLUGINS: value }),
      true,
    );
  for (const value of ["0", "no", "", undefined])
    assert.equal(
      projectPluginsEnabled({ HERMES_ENABLE_PROJECT_PLUGINS: value }),
      false,
    );
});

for (const text of [
  "!!set {unrelated: null}",
  "!!binary c3VwZXJwb3dlcnM=",
  "!!omap [{unrelated: null}]",
  "!!set {}",
  '!!binary ""',
  "!!omap []",
]) {
  void test(`readHermesStatus refuses tagged non-mapping configuration ${text}`, async (t) => {
    const s = hermesSandbox(t);
    write(join(s.paths.hermesHome, "config.yaml"), text);
    await assert.rejects(
      readHermesStatus(s.paths, s.env, join(s.root, "system")),
      { message: "cannot inspect Hermes configuration" },
    );
  });
}

for (const text of ["", "# comment only\n", "null", "~"]) {
  for (const scope of ["user", "managed"] as const) {
    void test(`readHermesStatus accepts ${scope} empty or null configuration ${JSON.stringify(text)}`, async (t) => {
      const s = hermesSandbox(t);
      const root =
        scope === "user" ? s.paths.hermesHome : s.env.HERMES_MANAGED_DIR!;
      write(join(root, "config.yaml"), text);
      if (scope === "managed")
        write(
          join(s.paths.hermesHome, "config.yaml"),
          "plugins: {enabled: [superpowers]}",
        );
      assert.equal(
        await readHermesStatus(s.paths, s.env, join(s.root, "system")),
        scope === "user" ? "not enabled" : "enabled",
      );
    });
  }
}

void test("findSuperpowersManifests follows directory aliases while preserving lexical names and one-level recursion", async (t) => {
  const s = hermesSandbox(t);
  const targets = join(s.root, "external");
  write(join(targets, "direct", "plugin.yaml"), "name: superpowers");
  write(join(targets, "default", "plugin.yaml"), "description: fixture");
  write(
    join(targets, "group", "nested", "plugin.json"),
    '{"name":"superpowers"}',
  );
  write(
    join(targets, "group", "too", "deep", "plugin.yaml"),
    "name: superpowers",
  );
  mkdirSync(join(s.paths.pluginsRoot, "category"), { recursive: true });
  symlinkSync(
    join(targets, "direct"),
    join(s.paths.pluginsRoot, "direct-alias"),
  );
  symlinkSync(
    join(targets, "default"),
    join(s.paths.pluginsRoot, "category", "superpowers"),
  );
  symlinkSync(join(targets, "group"), join(s.paths.pluginsRoot, "group-alias"));
  assert.deepEqual(
    await findSuperpowersManifests(s.paths),
    ["category/superpowers", "direct-alias", "group-alias/nested"].map((name) =>
      join(s.paths.pluginsRoot, name),
    ),
  );
});

void test("findSuperpowersManifests skips unrelated, file, and broken aliases", async (t) => {
  const s = hermesSandbox(t);
  write(join(s.root, "external", "plugin.yaml"), "name: unrelated");
  mkdirSync(s.paths.pluginsRoot, { recursive: true });
  symlinkSync(join(s.root, "external"), join(s.paths.pluginsRoot, "other"));
  symlinkSync(
    join(s.root, "external", "plugin.yaml"),
    join(s.paths.pluginsRoot, "file"),
  );
  symlinkSync(join(s.root, "missing"), join(s.paths.pluginsRoot, "broken"));
  assert.deepEqual(await findSuperpowersManifests(s.paths), []);
});

for (const kind of [
  "oversized",
  "symlinked leaf",
  "owned alias",
  "root alias",
] as const) {
  void test(`findSuperpowersManifests fails closed on ${kind} with a directory alias`, async (t) => {
    const s = hermesSandbox(t);
    const target = join(s.root, "external");
    if (kind === "symlinked leaf") {
      write(join(s.root, "linked-manifest"), "name: superpowers");
      mkdirSync(target);
      symlinkSync(join(s.root, "linked-manifest"), join(target, "plugin.yaml"));
      mkdirSync(s.paths.pluginsRoot, { recursive: true });
      symlinkSync(target, join(s.paths.pluginsRoot, "other"));
    } else if (kind === "root alias") {
      write(join(target, "plugin.yaml"), "name: superpowers");
      mkdirSync(s.paths.hermesHome, { recursive: true });
      symlinkSync(target, s.paths.pluginsRoot);
    } else {
      write(
        join(target, "plugin.yaml"),
        kind === "oversized" ? "x".repeat(64 * 1024 + 1) : "name: superpowers",
      );
      mkdirSync(s.paths.pluginsRoot, { recursive: true });
      symlinkSync(
        target,
        kind === "owned alias"
          ? s.paths.pluginRoot
          : join(s.paths.pluginsRoot, "other"),
      );
    }
    await assert.rejects(findSuperpowersManifests(s.paths), {
      message: "cannot inspect Hermes plugins",
    });
  });
}
