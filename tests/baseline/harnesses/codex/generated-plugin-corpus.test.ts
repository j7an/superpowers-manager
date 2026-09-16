// The in-process validator is a security boundary; adversarial cases pin its
// fixtures and diagnostics.
import assert from "node:assert/strict";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const FIXTURES = fileURLToPath(
  new URL("../../../fixtures/baseline/", import.meta.url),
);
const MANIFESTS = join(FIXTURES, "manifests");
const PROVENANCE = join(FIXTURES, "provenance");
const SELECTION = join(FIXTURES, "selection");

const COMMIT = "d884ae04edebef577e82ff7c4e143debd0bbec99";
const SOURCE = "https://example.invalid/superpowers.git";

// Python `reset_candidate` (:44) writes exactly these three top-level files.
const REQUIRED_TOP_LEVEL_FILES = ["LICENSE", "README.md", "CODE_OF_CONDUCT.md"];
assert.equal(REQUIRED_TOP_LEVEL_FILES.length, 3);

import { validateGeneratedPlugin } from "../../../../src/harnesses/codex/generated-plugin.ts";

type Harness = {
  base: string;
  plugin: string;
  manifestSource: "upstream" | "fallback";
  expected: Record<string, string>;
};

/**
 * Rebuilds the accepted candidate tree from scratch. Mirrors Python
 * `reset_candidate` (:39-58) exactly, including file contents.
 *
 */
function resetCandidate(harness: Harness) {
  rmSync(harness.plugin, { recursive: true, force: true });
  mkdirSync(join(harness.plugin, ".codex-plugin"), { recursive: true });
  mkdirSync(join(harness.plugin, "skills", "brainstorming"), {
    recursive: true,
  });
  mkdirSync(join(harness.plugin, "assets"));
  for (const name of REQUIRED_TOP_LEVEL_FILES) {
    writeFileSync(join(harness.plugin, name), `${name}\n`, "utf8");
  }
  writeFileSync(
    join(harness.plugin, ".codex-plugin", "plugin.template.json"),
    "{}\n",
    "utf8",
  );
  writeFileSync(
    join(harness.plugin, "skills", "brainstorming", "SKILL.md"),
    "---\nname: brainstorming\ndescription: Fake skill\n---\n# Body\n",
    "utf8",
  );
  writeFileSync(join(harness.plugin, "assets", "logo.svg"), "svg\n", "utf8");
  copyFileSync(
    join(MANIFESTS, "candidate-unknown-field.json"),
    manifestPath(harness),
  );
  writeMetadata(harness);
}

function harness(t: import("node:test").TestContext): Harness {
  const base = mkdtempSync(join(tmpdir(), "spw-generated-plugin-"));
  t.after(() => {
    rmSync(base, { recursive: true, force: true });
  });

  const state: Harness = {
    base,
    plugin: join(base, "plugin"),
    manifestSource: "upstream",
    expected: {
      source: SOURCE,
      requested_ref: "latest-release",
      resolved_ref: "v6.1.1",
      commit: COMMIT,
      manifest_version: "6.1.1+manager.d884ae0",
      upstream_manifest_version: "6.1.1",
    },
  };
  resetCandidate(state);
  return state;
}

function manifestPath(harness: Harness) {
  return join(harness.plugin, ".codex-plugin", "plugin.json");
}

function metadataPath(harness: Harness) {
  return join(harness.plugin, ".superpowers-upstream.json");
}

function writeManifest(harness: Harness, value: unknown) {
  writeFileSync(manifestPath(harness), `${JSON.stringify(value)}\n`, "utf8");
}

function readManifest(harness: Harness): Record<string, any> {
  return JSON.parse(readFileSync(manifestPath(harness), "utf8"));
}

function writeHookFile(
  harness: Harness,
  relativePath: string = "hooks/hooks-codex.json",
) {
  const path = join(harness.plugin, relativePath);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, '{"hooks":{}}\n', "utf8");
}

function setHooks(harness: Harness, value: unknown) {
  const manifest = readManifest(harness);
  manifest.hooks = value;
  writeManifest(harness, manifest);
}

/**
 * With no value, copies the accepted provenance fixture; Python
 * `write_metadata` (:80-89).
 *
 */
function writeMetadata(harness: Harness, value?: unknown) {
  if (value === undefined) {
    copyFileSync(join(PROVENANCE, "valid-tag.json"), metadataPath(harness));
    return;
  }
  writeFileSync(metadataPath(harness), `${JSON.stringify(value)}\n`, "utf8");
}

function readMetadata(harness: Harness): Record<string, any> {
  return JSON.parse(readFileSync(metadataPath(harness), "utf8"));
}

function nestedValue(containers: number): unknown {
  let value: unknown = 0;
  for (let index = 0; index < containers; index += 1) value = [value];
  return value;
}

async function runValidator(harness: Harness): Promise<string[]> {
  return await validateGeneratedPlugin({
    pluginRoot: harness.plugin,
    source: harness.expected.source,
    requestedRef: harness.expected.requested_ref,
    resolvedRef: harness.expected.resolved_ref,
    commit: harness.expected.commit,
    manifestVersion: harness.expected.manifest_version,
    manifestSource: harness.manifestSource,
    upstreamManifestVersion: harness.expected.upstream_manifest_version,
  });
}

async function assertRejected(
  harness: Harness,
  fragment: string,
): Promise<void> {
  const errors = await runValidator(harness);
  assert.ok(errors.length > 0);
  assert.ok(
    errors.some((error) => error.includes(fragment)),
    errors.join("\n"),
  );
}

async function assertRejectedAll(
  harness: Harness,
  fragments: readonly string[],
): Promise<void> {
  assert.equal(fragments.length, 2);
  const errors = await runValidator(harness);
  for (const fragment of fragments)
    assert.ok(
      errors.some((error) => error.includes(fragment)),
      errors.join("\n"),
    );
}

async function assertAccepted(harness: Harness): Promise<string[]> {
  const errors = await runValidator(harness);
  assert.deepStrictEqual(errors, []);
  return errors;
}

// No behavior ID: guards the accept path — the baseline candidate tree and
// unknown upstream manifest field must pass.
void test("the valid candidate and an unknown manifest field pass", async (t) => {
  const state = harness(t);
  await assertAccepted(state);
});

void test("PROV-READER-CANDIDATE-01 candidate provenance validator profile", async (t) => {
  const state = harness(t);
  const metadata = metadataPath(state);

  copyFileSync(join(PROVENANCE, "non-standard-constant.json"), metadata);
  await assertRejected(state, "provenance must contain valid JSON");

  resetCandidate(state);
  copyFileSync(join(SELECTION, "depth-257.json"), metadata);
  await assertRejected(state, "provenance exceeds maximum JSON nesting");

  resetCandidate(state);
  const deep = readMetadata(state);
  // The root object plus 255 arrays is the exact accepted depth 256.
  deep.source = nestedValue(255);
  writeMetadata(state, deep);
  const errors = await runValidator(state);
  assert.ok(
    errors.includes("provenance field `source` does not match expected value"),
    errors.join("\n"),
  );
  assert.equal(
    errors.some((error) => error.includes("exceeds maximum JSON nesting")),
    false,
    errors.join("\n"),
  );

  resetCandidate(state);
  copyFileSync(join(PROVENANCE, "duplicate-key.json"), metadata);
  await assertRejected(state, "provenance field `source` does not match");

  resetCandidate(state);
  writeFileSync(
    metadata,
    readFileSync(metadata, "utf8") + " ".repeat(1_048_576 + 1),
    "utf8",
  );
  await assertAccepted(state);

  resetCandidate(state);
  copyFileSync(join(PROVENANCE, "malformed.json"), metadata);
  await assertRejected(state, "provenance must contain valid JSON");

  resetCandidate(state);
  writeMetadata(state, []);
  await assertRejected(state, "provenance must contain a JSON object");

  resetCandidate(state);
  copyFileSync(join(PROVENANCE, "wrong-key-set.json"), metadata);
  await assertRejected(state, "provenance keys do not match");

  const mismatches = [
    ["source", "https://wrong.invalid/repo"],
    ["requested_ref", "v0.0.0"],
    ["resolved_ref", "v0.0.0"],
    ["commit", "0".repeat(40)],
    ["upstream_manifest_version", "0.0.0"],
  ];
  assert.equal(mismatches.length, 5);
  for (const [field, value] of mismatches) {
    resetCandidate(state);
    const record = readMetadata(state);
    record[field] = value;
    writeMetadata(state, record);
    await assertRejected(
      state,
      `provenance field \`${field}\` does not match expected value`,
    );
  }

  resetCandidate(state);
  copyFileSync(join(PROVENANCE, "commit-7-hex.json"), metadata);
  state.expected.commit = "d884ae0";
  await assertRejected(
    state,
    "commit must be 40 lowercase hexadecimal characters",
  );

  resetCandidate(state);
  const upper = readMetadata(state);
  upper.commit = "D".repeat(40);
  writeMetadata(state, upper);
  state.expected.commit = "D".repeat(40);
  await assertRejected(
    state,
    "commit must be 40 lowercase hexadecimal characters",
  );
});

void test("MANIFEST-READER-VALIDATOR-01 candidate validator profile", async (t) => {
  const state = harness(t);
  const manifest = manifestPath(state);

  copyFileSync(
    join(MANIFESTS, "candidate-non-standard-constant.json"),
    manifest,
  );
  await assertRejected(state, "plugin manifest must contain valid JSON");

  resetCandidate(state);
  copyFileSync(join(SELECTION, "depth-257.json"), manifest);
  await assertRejected(state, "plugin manifest exceeds maximum JSON nesting");

  resetCandidate(state);
  const deep = readManifest(state);
  // The root object plus 255 arrays is the exact accepted depth 256.
  deep.x_future_manifest = nestedValue(255);
  writeManifest(state, deep);
  await assertAccepted(state);

  resetCandidate(state);
  copyFileSync(join(MANIFESTS, "candidate-duplicate-key.json"), manifest);
  await assertRejected(state, "field `name` must equal `superpowers`");

  resetCandidate(state);
  writeFileSync(
    manifest,
    readFileSync(manifest, "utf8") + " ".repeat(1_048_576 + 1),
    "utf8",
  );
  await assertAccepted(state);

  resetCandidate(state);
  writeFileSync(manifest, "{bad", "utf8");
  await assertRejected(state, "must contain valid JSON");

  resetCandidate(state);
  writeFileSync(manifest, Buffer.from([0xff]));
  await assertRejected(state, "plugin manifest is unreadable UTF-8");

  const cases: readonly [string, any, string][] = [
    ["non-object", [], "must contain a JSON object"],
    [
      "wrong-name",
      { name: "renamed" },
      "field `name` must equal `superpowers`",
    ],
    ["wrong-version", { version: "6.1.2" }, "must equal expected version"],
    ["bad-semver", { version: "01.0.0" }, "must be SemVer 2.0.0"],
    ["empty-description", { description: "" }, "field `description`"],
    [
      "wrong-skills",
      { skills: "skills" },
      "field `skills` must equal `./skills/`",
    ],
  ];
  assert.equal(cases.length, 6);
  for (const [label, change, fragment] of cases) {
    resetCandidate(state);
    if (label === "non-object") {
      writeManifest(state, change);
    } else {
      writeManifest(state, { ...readManifest(state), ...change });
    }
    await assertRejected(state, fragment);
  }

  const missingFields = [
    ["version", "field `version` must equal expected version"],
    ["description", "field `description` must be non-empty"],
  ];
  assert.equal(missingFields.length, 2);
  for (const [field, fragment] of missingFields) {
    resetCandidate(state);
    const record = readManifest(state);
    delete record[field];
    writeManifest(state, record);
    await assertRejected(state, fragment);
  }

  resetCandidate(state);
  writeManifest(state, { ...readManifest(state), version: 611 });
  await assertRejected(state, "field `version` must be SemVer 2.0.0");

  resetCandidate(state);
  writeManifest(state, { ...readManifest(state), apps: "/absolute/.app.json" });
  await assertRejected(state, "field `apps` must be a relative path");

  resetCandidate(state);
  const escapingLogo = readManifest(state);
  escapingLogo.interface.logo = "../outside.svg";
  writeManifest(state, escapingLogo);
  await assertRejected(state, "escapes the plugin root");

  resetCandidate(state);
  const missingScreenshot = readManifest(state);
  missingScreenshot.interface.screenshots = ["./assets/missing.png"];
  writeManifest(state, missingScreenshot);
  await assertRejected(state, "does not exist");

  resetCandidate(state);
  writeManifest(state, { ...readManifest(state), interface: "not-an-object" });
  await assertRejected(state, "field `interface` must be an object");

  resetCandidate(state);
  writeManifest(state, { ...readManifest(state), mcpServers: 17 });
  await assertRejected(state, "field `mcpServers` must be a string or object");

  resetCandidate(state);
  writeManifest(state, { ...readManifest(state), apps: 17 });
  await assertRejected(state, "field `apps` must be a non-empty relative path");

  resetCandidate(state);
  const scalarScreenshots = readManifest(state);
  scalarScreenshots.interface.screenshots = "./assets/logo.svg";
  writeManifest(state, scalarScreenshots);
  await assertRejected(state, "field `interface.screenshots` must be an array");

  resetCandidate(state);
  const outside = join(state.base, "outside.svg");
  writeFileSync(outside, "outside\n", "utf8");
  symlinkSync(outside, join(state.plugin, "assets", "escape.svg"));
  const symlinkedLogo = readManifest(state);
  symlinkedLogo.interface.logo = "./assets/escape.svg";
  writeManifest(state, symlinkedLogo);
  await assertRejected(state, "escapes the plugin root");
});

// No behavior ID: guards that every accepted manager-version SemVer form —
// build metadata, prerelease, branch-derived, and ref-derived — still passes.
void test("full SemVer manager-version forms pass", async (t) => {
  const state = harness(t);
  const versions = [
    "6.1.1+manager.d884ae0",
    "6.1.0-beta.1+manager.d884ae0",
    "0.0.0-main+manager.d884ae0",
    "0.0.0-ref-feature-x+manager.d884ae0",
  ];
  assert.equal(versions.length, 4);
  for (const version of versions) {
    resetCandidate(state);
    state.expected.manifest_version = version;
    writeManifest(state, { ...readManifest(state), version });
    await assertAccepted(state);
  }
});

// No behavior ID: guards the SemVer grammar's ASCII-digit boundary. SEMVER_RE in
// src/harnesses/codex/generated-plugin.ts spells its digit classes `[0-9]`, so a Unicode
// category-Nd digit is not a SemVer digit and the version is REJECTED.
void test("SemVer rejects Unicode decimal digits", async (t) => {
  const state = harness(t);
  // U+0661 ARABIC-INDIC DIGIT ONE: Unicode category Nd, outside [0-9].
  const versions = ["1.1١.0", "1.0.0-١"];
  assert.equal(versions.length, 2);
  for (const version of versions) {
    resetCandidate(state);
    state.expected.manifest_version = version;
    writeManifest(state, { ...readManifest(state), version });
    await assertRejected(state, "field `version` must be SemVer 2.0.0");
  }
});

// No behavior ID: guards the JSON nesting ceiling on a hand-built 2000-deep
// document — a depth blowout must be a controlled diagnostic, never a stack
// overflow.
void test("JSON rejects excessive nesting", async (t) => {
  const state = harness(t);
  const nested = `${"[".repeat(2000)}0${"]".repeat(2000)}`;
  writeFileSync(
    manifestPath(state),
    '{"name":"superpowers","version":"6.1.1+manager.d884ae0",' +
      '"description":"Generated Superpowers","skills":"./skills/",' +
      `"x_future_manifest":${nested}}\n`,
    "utf8",
  );
  await assertRejected(state, "plugin manifest exceeds maximum JSON nesting");
});

// No behavior ID: guards the required-tree and skill-structure fail-closed
// surface — each missing required file, an empty skills tree, and every
// malformed SKILL.md shape.
void test("the required tree and skill structure fail closed", async (t) => {
  const state = harness(t);
  const required = [
    ".codex-plugin/plugin.template.json",
    ".superpowers-upstream.json",
    "LICENSE",
    "README.md",
    "CODE_OF_CONDUCT.md",
  ];
  assert.equal(required.length, 5);
  for (const relativePath of required) {
    resetCandidate(state);
    unlinkSync(join(state.plugin, relativePath));
    await assertRejected(state, `missing required file \`${relativePath}\``);
  }

  const skill = join(state.plugin, "skills", "brainstorming", "SKILL.md");

  resetCandidate(state);
  rmSync(join(state.plugin, "skills", "brainstorming"), { recursive: true });
  await assertRejected(state, "must contain at least one skill directory");

  resetCandidate(state);
  unlinkSync(skill);
  await assertRejected(state, "missing `SKILL.md`");

  resetCandidate(state);
  writeFileSync(skill, "", "utf8");
  await assertRejected(state, "has empty `SKILL.md`");

  resetCandidate(state);
  writeFileSync(skill, Buffer.from([0xff]));
  await assertRejected(state, "has unreadable UTF-8 `SKILL.md`");

  resetCandidate(state);
  mkdirSync(join(state.plugin, "hooks"));
  await assertRejected(
    state,
    "default-discovered `hooks/` must contain `hooks/hooks.json`",
  );
});

// No behavior ID: guards that every upstream-declared hook shape the manager
// supports is accepted, alongside a preserved unknown manifest field.
void test("upstream hook shapes are accepted", async (t) => {
  const state = harness(t);

  const cases: readonly [string, any, readonly string[]][] = [
    ["exact-empty-object", {}, []],
    ["single-path", "./hooks/hooks-codex.json", ["hooks/hooks-codex.json"]],
    [
      "path-array",
      ["./hooks/first.json", "./hooks/second.json"],
      ["hooks/first.json", "hooks/second.json"],
    ],
    [
      "inline-object",
      {
        hooks: {
          SessionStart: [{ hooks: [{ type: "prompt", prompt: "opaque" }] }],
          Stop: [{ hooks: [{ type: "agent", agent: "opaque" }] }],
        },
      },
      ["hooks/required-by-inline.json"],
    ],
    [
      "inline-object-array",
      [{ hooks: {} }, { future: { preserved: true } }],
      ["hooks/required-by-array.json"],
    ],
    ["empty-array", [], ["hooks/hooks.json"]],
  ];
  assert.equal(cases.length, 6);
  for (const [, hooks, files] of cases) {
    resetCandidate(state);
    setHooks(state, hooks);
    for (const relativePath of files) writeHookFile(state, relativePath);
    writeManifest(state, {
      ...readManifest(state),
      x_unknown_alongside_hooks: { preserved: true },
    });
    await assertAccepted(state);
  }
});

// No behavior ID: guards that the hook policy is manifest-source sensitive and
// that a physical `hooks/` prohibition co-reports with manifest-shape failures.
void test("hook policy is source sensitive and fails closed", async (t) => {
  const state = harness(t);
  state.manifestSource = "fallback";
  setHooks(state, { future: true });
  await assertRejected(
    state,
    "fallback plugin manifest field `hooks` must be absent",
  );

  resetCandidate(state);
  state.manifestSource = "fallback";
  writeHookFile(state);
  await assertRejected(
    state,
    "generated plugin must not contain `hooks/` for this manifest source",
  );

  resetCandidate(state);
  state.manifestSource = "fallback";
  setHooks(state, {});
  writeHookFile(state);
  await assertRejectedAll(state, [
    "fallback plugin manifest field `hooks` must be absent",
    "generated plugin must not contain `hooks/` for this manifest source",
  ]);

  resetCandidate(state);
  state.manifestSource = "upstream";
  const withoutInterface = readManifest(state);
  delete withoutInterface.interface;
  withoutInterface.hooks = {};
  writeManifest(state, withoutInterface);
  writeHookFile(state);
  await assertRejected(
    state,
    "generated plugin must not contain `hooks/` for this manifest source",
  );

  resetCandidate(state);
  setHooks(state, {});
  writeManifest(state, { ...readManifest(state), interface: "not-an-object" });
  writeHookFile(state);
  await assertRejectedAll(state, [
    "plugin manifest field `interface` must be an object",
    "generated plugin must not contain `hooks/` for this manifest source",
  ]);
});

// No behavior ID: guards the hook-declaration containment corpus — unsupported
// types, mixed arrays, `./` prefix, traversal, absence, directories, and an
// escaping symlink target.
void test("hook declarations reject unsupported or unsafe values", async (t) => {
  const state = harness(t);

  const cases: readonly [string, any, string][] = [
    ["unsupported-scalar", 17, "field `hooks` has an unsupported type"],
    [
      "mixed-array",
      ["./hooks/hooks-codex.json", { hooks: {} }],
      "field `hooks` array must contain only paths or only objects",
    ],
    [
      "string-array-escape",
      ["./hooks/hooks-codex.json", "./../outside.json"],
      "field `hooks[1]` escapes the plugin root",
    ],
    ["missing-dot-slash", "hooks/hooks-codex.json", "must start with `./`"],
    ["absolute", "/tmp/hooks.json", "must start with `./`"],
    ["traversal", "./../outside.json", "escapes the plugin root"],
    ["missing", "./hooks/missing.json", "does not exist"],
  ];
  assert.equal(cases.length, 7);
  for (const [, hooks, fragment] of cases) {
    resetCandidate(state);
    setHooks(state, hooks);
    await assertRejected(state, fragment);
  }

  resetCandidate(state);
  mkdirSync(join(state.plugin, "hooks", "directory.json"), { recursive: true });
  setHooks(state, "./hooks/directory.json");
  await assertRejected(state, "target `./hooks/directory.json` must be a file");

  resetCandidate(state);
  const outside = join(state.base, "outside-hooks.json");
  writeFileSync(outside, '{"hooks":{}}\n', "utf8");
  mkdirSync(join(state.plugin, "hooks"));
  symlinkSync(outside, join(state.plugin, "hooks", "escape.json"));
  setHooks(state, "./hooks/escape.json");
  await assertRejected(state, "escapes the plugin root");
});

// No behavior ID: guards that a manifest that cannot be read or parsed still
// reports the physical `hooks/` prohibition rather than short-circuiting.
void test("manifest failures preserve the physical hook prohibition", async (t) => {
  const state = harness(t);
  unlinkSync(manifestPath(state));
  writeHookFile(state);
  await assertRejectedAll(state, [
    "missing required file `.codex-plugin/plugin.json`",
    "generated plugin must not contain `hooks/` for this manifest source",
  ]);

  resetCandidate(state);
  writeFileSync(manifestPath(state), "{bad", "utf8");
  writeHookFile(state);
  await assertRejectedAll(state, [
    "plugin manifest must contain valid JSON",
    "generated plugin must not contain `hooks/` for this manifest source",
  ]);
});

// No behavior ID: guards the default-discovery contract — an undeclared `hooks/`
// is accepted only when it contains `hooks/hooks.json`.
void test("default discovery requires hooks/hooks.json", async (t) => {
  const state = harness(t);
  writeHookFile(state, "hooks/hooks.json");
  await assertAccepted(state);

  resetCandidate(state);
  mkdirSync(join(state.plugin, "hooks"));
  await assertRejected(
    state,
    "default-discovered `hooks/` must contain `hooks/hooks.json`",
  );
});

// No behavior ID: guards the symlink containment sweep across both allowing hook
// policies, both link locations, and all three unsafe target kinds.
void test("the hook subtree rejects unsafe symlinks for allowing policies", async (t) => {
  const state = harness(t);
  const policies = ["default", "allow"];
  const locations = ["root", "nested"];
  const targetKinds = ["absolute", "broken", "escape"];
  assert.equal(policies.length, 2);
  assert.equal(locations.length, 2);
  assert.equal(targetKinds.length, 3);
  assert.equal(policies.length * locations.length * targetKinds.length, 12);

  for (const policy of policies) {
    for (const location of locations) {
      for (const targetKind of targetKinds) {
        resetCandidate(state);
        if (policy === "allow") setHooks(state, { hooks: {} });

        const outsideDirectory = join(
          state.base,
          `outside-${policy}-${location}-${targetKind}`,
        );
        mkdirSync(outsideDirectory, { recursive: true });
        writeFileSync(
          join(outsideDirectory, "hooks.json"),
          '{"hooks":{}}\n',
          "utf8",
        );

        const hooksRoot = join(state.plugin, "hooks");
        if (location === "root") {
          if (targetKind === "absolute") {
            symlinkSync(outsideDirectory, hooksRoot, "dir");
          } else if (targetKind === "broken") {
            symlinkSync("missing-hooks", hooksRoot, "dir");
          } else {
            symlinkSync(
              relative(state.plugin, outsideDirectory),
              hooksRoot,
              "dir",
            );
          }
        } else {
          mkdirSync(hooksRoot);
          writeHookFile(state, "hooks/hooks.json");
          const nested = join(hooksRoot, "nested");
          if (targetKind === "absolute") {
            symlinkSync(outsideDirectory, nested, "dir");
          } else if (targetKind === "broken") {
            symlinkSync("missing-target", nested, "dir");
          } else {
            symlinkSync(relative(hooksRoot, outsideDirectory), nested, "dir");
          }
        }

        const errors = await runValidator(state);
        const label = `${policy}/${location}/${targetKind}`;
        assert.ok(errors.length > 0, `${label}: ${errors.join("\n")}`);
        assert.match(
          errors.join("\n"),
          /generated hook symlink (?:must be relative|escapes or is broken)/,
          label,
        );
      }
    }
  }
});

// No behavior ID: guards that containment does not stop at the `hooks/`
// boundary — a contained relative directory symlink is followed, and an unsafe
// absolute link inside the followed target is still rejected.
void test("the hook subtree follows a contained directory symlink", async (t) => {
  const state = harness(t);
  setHooks(state, { hooks: {} });
  mkdirSync(join(state.plugin, "hooks"));
  const contained = join(state.plugin, "hook-targets", "contained-directory");
  mkdirSync(contained, { recursive: true });
  const outside = join(state.base, "outside-hook.json");
  writeFileSync(outside, '{"hooks":{}}\n', "utf8");
  symlinkSync(outside, join(contained, "unsafe.json"));
  symlinkSync(".", join(contained, "cycle"), "dir");
  symlinkSync(
    "../hook-targets/contained-directory",
    join(state.plugin, "hooks", "contained-directory"),
    "dir",
  );

  await assertRejected(state, "generated hook symlink must be relative");
});

// No behavior ID: guards the accept side of the same sweep — contained relative
// file and directory symlinks, self-cycle included, must pass.
void test("the hook subtree accepts contained materialized relative symlinks", async (t) => {
  const state = harness(t);
  setHooks(state, { hooks: {} });
  writeHookFile(state, "hook-targets/contained.json");
  const containedDirectory = join(
    state.plugin,
    "hook-targets",
    "contained-directory",
  );
  mkdirSync(containedDirectory);
  writeFileSync(
    join(containedDirectory, "hook.json"),
    '{"hooks":{}}\n',
    "utf8",
  );
  symlinkSync(".", join(containedDirectory, "cycle"), "dir");
  mkdirSync(join(state.plugin, "hooks"));
  symlinkSync(
    "../hook-targets/contained.json",
    join(state.plugin, "hooks", "contained.json"),
  );
  symlinkSync(
    "../hook-targets/contained-directory",
    join(state.plugin, "hooks", "contained-directory"),
    "dir",
  );
  await assertAccepted(state);
});

// No behavior ID: guards the SKILL.md frontmatter reader — it closes on the
// first `---` fence, owns only `name:` and `description:`, and fails closed on
// every malformed shape.
void test("frontmatter uses the first closing fence and owned keys only", async (t) => {
  const state = harness(t);
  const skill = () => join(state.plugin, "skills", "brainstorming", "SKILL.md");

  writeFileSync(
    skill(),
    "---\nname: brainstorming\ndescription: Valid\n---\n" +
      "---\nname: teaching-example\ndescription:\n---\n",
    "utf8",
  );
  await assertAccepted(state);

  resetCandidate(state);
  writeFileSync(
    skill(),
    "---\nname: brainstorming\ndescription: >\n  Block text\n---\n# Body\n",
    "utf8",
  );
  await assertAccepted(state);

  const cases = [
    ["name: brainstorming\ndescription: x\n---\n", "must start with `---`"],
    ["---\nname: brainstorming\ndescription: x\n", "frontmatter is not closed"],
    ["---\ndescription: x\n---\n", "exactly one top-level `name:`"],
    [
      "---\nname: a\nname: b\ndescription: x\n---\n",
      "exactly one top-level `name:`",
    ],
    ["---\nname: ''\ndescription: x\n---\n", "field `name` must be non-empty"],
    [
      "---\nname: a\ndescription: # empty\n---\n",
      "field `description` must be non-empty",
    ],
  ];
  assert.equal(cases.length, 6);
  for (const [contents, fragment] of cases) {
    resetCandidate(state);
    writeFileSync(skill(), contents, "utf8");
    await assertRejected(state, fragment);
  }
});
