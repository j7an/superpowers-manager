// @ts-check
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

/** @type {typeof import("../../src/safety-error.js")} */
const { SafetyError } = await import(
  new URL("../../dist/safety-error.js", import.meta.url).href
);
/** @type {typeof import("../../src/hooks.js")} */
const { classifyHooks, readManifest } = await import(
  new URL("../../dist/hooks.js", import.meta.url).href
);

/**
 * @param {import("node:test").TestContext} t
 * @returns {Promise<string>}
 */
async function sandbox(t) {
  const directory = await mkdtemp(join(tmpdir(), "spw-hooks-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

/**
 * @param {string} root
 * @returns {Promise<void>}
 */
async function seedUpstream(root) {
  await mkdir(join(root, "hooks"), { recursive: true });
  await mkdir(join(root, "bin"), { recursive: true });
  await writeFile(join(root, "hooks", "hooks.json"), "{}\n");
  await writeFile(join(root, "hooks", "hooks-codex.json"), "{}\n");
  await writeFile(join(root, "bin", "target"), "target\n");
}

/**
 * @param {() => Promise<unknown>} operation
 * @param {string} expected
 */
async function hookFailure(operation, expected) {
  await assert.rejects(operation, (error) => {
    assert.ok(error instanceof SafetyError, `expected SafetyError, got ${error}`);
    assert.equal(error.module, "hooks");
    assert.equal(error.message.startsWith(expected), true, error.message);
    return true;
  });
}

void test("readManifest rejects invalid UTF-8 bytes", async (t) => {
  const root = await sandbox(t);
  const path = join(root, "manifest.json");
  await writeFile(path, Buffer.from([0x7b, 0x22, 0xff, 0x22, 0x3a, 0x31, 0x7d]));
  // readFile returns bytes without decoding, so the fatal decoder inside
  // parseStrictJson is what rejects this — the parse branch, not the read branch.
  await hookFailure(() => readManifest(path), "invalid manifest JSON in");
});

void test("readManifest rejects a non-object top level", async (t) => {
  const root = await sandbox(t);
  const path = join(root, "manifest.json");
  await writeFile(path, "[]\n");
  await hookFailure(() => readManifest(path), "manifest must be a JSON object");
});

void test("readManifest rejects non-standard numeric constants", async (t) => {
  const root = await sandbox(t);
  const path = join(root, "manifest.json");
  await writeFile(path, '{"a": Infinity}\n');
  await hookFailure(() => readManifest(path), "invalid manifest JSON in");
});

void test("readManifest accepts duplicate keys with last-wins", async (t) => {
  const root = await sandbox(t);
  const path = join(root, "manifest.json");
  await writeFile(path, '{"a": 1, "a": 2}\n');
  assert.deepEqual(await readManifest(path), { a: 2 });
});

void test("readManifest accepts a manifest padded past 1 MiB", async (t) => {
  const root = await sandbox(t);
  const path = join(root, "manifest.json");
  await writeFile(path, `{"a":1}${" ".repeat(1_048_577)}`);
  assert.deepEqual(await readManifest(path), { a: 1 });
});

void test("readManifest accepts depth 256 and rejects depth 257", async (t) => {
  const root = await sandbox(t);
  const accepted = join(root, "accepted.json");
  const rejected = join(root, "rejected.json");
  // Mirrors write_depth_256_manifest at
  // tests/test_prepare_with_fake_upstream.sh:191-207: the top-level object is
  // depth 1, so 255 nested arrays beneath it make depth 256, and 256 make 257.
  const nest = (levels) => `${"[".repeat(levels)}0${"]".repeat(levels)}`;
  await writeFile(accepted, `{"x_future_manifest": ${nest(255)}}\n`);
  await writeFile(rejected, `{"x_future_manifest": ${nest(256)}}\n`);
  const parsed = await readManifest(accepted);
  assert.equal(typeof parsed, "object");
  assert.ok(Object.hasOwn(parsed, "x_future_manifest"));
  await hookFailure(() => readManifest(rejected), "invalid manifest JSON in");
});

void test("classifyHooks rejects hooks in a fallback manifest", async (t) => {
  const root = await sandbox(t);
  await seedUpstream(root);
  await hookFailure(
    () => classifyHooks({ hooks: {} }, "fallback", root),
    "fallback manifest must not declare hooks",
  );
});

void test("classifyHooks allows a fallback manifest without hooks", async (t) => {
  const root = await sandbox(t);
  await seedUpstream(root);
  assert.deepEqual(await classifyHooks({}, "fallback", root), {
    copyHooksSubtree: false,
    declaredPaths: [],
  });
});

void test("classifyHooks default-discovers when hooks is absent", async (t) => {
  const root = await sandbox(t);
  await seedUpstream(root);
  assert.deepEqual(await classifyHooks({}, "upstream", root), {
    copyHooksSubtree: true,
    declaredPaths: [],
  });
});

void test("classifyHooks default discovery needs a regular hooks.json", async (t) => {
  const root = await sandbox(t);
  await mkdir(join(root, "hooks"), { recursive: true });
  assert.deepEqual(await classifyHooks({}, "upstream", root), {
    copyHooksSubtree: false,
    declaredPaths: [],
  });
});

void test("classifyHooks treats an empty array as default discovery", async (t) => {
  const root = await sandbox(t);
  await seedUpstream(root);
  assert.deepEqual(await classifyHooks({ hooks: [] }, "upstream", root), {
    copyHooksSubtree: true,
    declaredPaths: [],
  });
});

void test("classifyHooks treats an empty object as forbidding hooks", async (t) => {
  const root = await sandbox(t);
  await seedUpstream(root);
  assert.deepEqual(await classifyHooks({ hooks: {} }, "upstream", root), {
    copyHooksSubtree: false,
    declaredPaths: [],
  });
});

void test("classifyHooks accepts a string declaration", async (t) => {
  const root = await sandbox(t);
  await seedUpstream(root);
  assert.deepEqual(
    await classifyHooks({ hooks: "./hooks/hooks-codex.json" }, "upstream", root),
    { copyHooksSubtree: true, declaredPaths: ["./hooks/hooks-codex.json"] },
  );
});

void test("classifyHooks accepts a string-array declaration", async (t) => {
  const root = await sandbox(t);
  await seedUpstream(root);
  assert.deepEqual(
    await classifyHooks(
      { hooks: ["./hooks/hooks.json", "./hooks/hooks-codex.json"] },
      "upstream",
      root,
    ),
    {
      copyHooksSubtree: true,
      declaredPaths: ["./hooks/hooks.json", "./hooks/hooks-codex.json"],
    },
  );
});

void test("classifyHooks treats an inline object as a subtree copy", async (t) => {
  const root = await sandbox(t);
  await seedUpstream(root);
  assert.deepEqual(
    await classifyHooks({ hooks: { SessionStart: [] } }, "upstream", root),
    { copyHooksSubtree: true, declaredPaths: [] },
  );
});

void test("classifyHooks treats an object array as a subtree copy", async (t) => {
  const root = await sandbox(t);
  await seedUpstream(root);
  assert.deepEqual(
    await classifyHooks({ hooks: [{ SessionStart: [] }] }, "upstream", root),
    { copyHooksSubtree: true, declaredPaths: [] },
  );
});

void test("classifyHooks rejects scalar, mixed, and null declarations", async (t) => {
  const root = await sandbox(t);
  await seedUpstream(root);
  for (const hooks of [42, null, true, ["./hooks/hooks.json", {}]]) {
    await hookFailure(
      () => classifyHooks({ hooks }, "upstream", root),
      "unsupported or mixed hooks declaration",
    );
  }
});

void test("classifyHooks rejects an unprefixed declared path", async (t) => {
  const root = await sandbox(t);
  await seedUpstream(root);
  await hookFailure(
    () => classifyHooks({ hooks: "hooks/hooks.json" }, "upstream", root),
    "declared hook path must start with ./",
  );
});

void test("classifyHooks rejects an absolute declared path", async (t) => {
  const root = await sandbox(t);
  await seedUpstream(root);
  await hookFailure(
    () => classifyHooks({ hooks: "/etc/passwd" }, "upstream", root),
    "declared hook path must start with ./",
  );
});

void test("classifyHooks rejects a traversing declared path", async (t) => {
  const root = await sandbox(t);
  await seedUpstream(root);
  await hookFailure(
    () => classifyHooks({ hooks: "./../outside.json" }, "upstream", root),
    "declared hook source escapes or could not be resolved",
  );
});

void test("classifyHooks rejects a missing declared path", async (t) => {
  const root = await sandbox(t);
  await seedUpstream(root);
  await hookFailure(
    () => classifyHooks({ hooks: "./hooks/missing.json" }, "upstream", root),
    "declared hook source escapes or could not be resolved",
  );
});

void test("classifyHooks rejects a declared directory", async (t) => {
  const root = await sandbox(t);
  await seedUpstream(root);
  await hookFailure(
    () => classifyHooks({ hooks: "./hooks" }, "upstream", root),
    "declared hook source is not a regular file",
  );
});

void test("classifyHooks rejects a declared symlink that escapes upstream", async (t) => {
  // The upstream root and the outside target both live inside one unique
  // sandbox, so parallel runs cannot overwrite or delete each other's files.
  const base = await sandbox(t);
  const root = join(base, "upstream");
  await mkdir(root, { recursive: true });
  await seedUpstream(root);
  const outside = join(base, "outside-target");
  await writeFile(outside, "outside\n");
  await symlink(outside, join(root, "hooks", "escape"));
  await hookFailure(
    () => classifyHooks({ hooks: "./hooks/escape" }, "upstream", root),
    "declared hook source escapes or could not be resolved",
  );
});

void test("classifyHooks accepts a declared symlink contained in upstream", async (t) => {
  const root = await sandbox(t);
  await seedUpstream(root);
  // The link must sit one level down: a root-level link to ../bin/target
  // would resolve to a SIBLING of the root and escape containment.
  await mkdir(join(root, "config"), { recursive: true });
  await symlink("../bin/target", join(root, "config", "link"));
  assert.deepEqual(
    await classifyHooks({ hooks: "./config/link" }, "upstream", root),
    { copyHooksSubtree: true, declaredPaths: ["./config/link"] },
  );
});
