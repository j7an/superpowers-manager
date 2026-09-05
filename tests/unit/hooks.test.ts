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
import { exactError } from "../lib/error-assertions.ts";

import { SafetyError } from "../../src/safety-error.ts";

import {
  classifyHooks,
  materializeHooks,
  readManifest,
} from "../../src/hooks.ts";

async function sandbox(t: import("node:test").TestContext): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "spw-hooks-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

const nested = (depth: number) => `${"[".repeat(depth)}0${"]".repeat(depth)}`;

async function seedUpstream(root: string): Promise<void> {
  await mkdir(join(root, "hooks"), { recursive: true });
  await mkdir(join(root, "bin"), { recursive: true });
  await writeFile(join(root, "hooks", "hooks.json"), "{}\n");
  await writeFile(join(root, "hooks", "hooks-codex.json"), "{}\n");
  await writeFile(join(root, "bin", "target"), "target\n");
}

async function hookFailure(
  operation: () => Promise<unknown>,
  expected: string,
) {
  await assert.rejects(operation, (error) => {
    assert.ok(
      error instanceof SafetyError,
      `expected SafetyError, got ${String(error)}`,
    );
    assert.equal(error.module, "hooks");
    assert.equal(error.message.startsWith(expected), true, error.message);
    return true;
  });
}

void test("MANIFEST-READER-MATERIALIZE-01 hook manifest reader complete matrix", async (t) => {
  const directory = await sandbox(t);
  const file = join(directory, "manifest.json");

  await writeFile(file, '{"hooks":"first","hooks":"last"}');
  assert.deepEqual(await readManifest(file), { hooks: "last" });

  await writeFile(file, `{"padding":"${"x".repeat(1_048_577)}","hooks":{}}`);
  assert.deepEqual((await readManifest(file)).hooks, {});

  await writeFile(file, `{"padding":${nested(255)}}`);
  assert.ok("padding" in (await readManifest(file)));

  const rejected: Array<[Uint8Array, string]> = [
    [Buffer.from('{"padding":NaN}'), `invalid manifest JSON in ${file}`],
    [
      Buffer.from(`{"padding":${nested(256)}}`),
      `invalid manifest JSON in ${file}`,
    ],
    [Buffer.from("[]"), `manifest must be a JSON object: ${file}`],
    [
      Uint8Array.from([0x7b, 0x22, 0x61, 0x22, 0x3a, 0x22, 0xc3, 0x28]),
      `invalid manifest JSON in ${file}`,
    ],
  ];
  for (const [input, message] of rejected) {
    await writeFile(file, input);
    await assert.rejects(
      readManifest(file),
      exactError(SafetyError, message),
      String(input),
    );
  }
});

// Convention pin (PR 11.4): a reader emits a hand-written message naming its
// input and never interpolates the caught error. Exact equality is the point —
// a `match` on a prefix would pass with strict-json's wording or an errno still
// appended, which is the failure this pins.
void test("readManifest diagnostics name the manifest and carry no reader vocabulary or errno", async (t) => {
  const directory = await sandbox(t);
  const file = join(directory, "manifest.json");
  const absent = join(directory, "absent.json");

  await assert.rejects(readManifest(absent), (error) => {
    assert.ok(error instanceof SafetyError);
    assert.equal(error.message, `cannot read manifest JSON in ${absent}`);
    return true;
  });

  // Parse-branch inputs only. `[]` is deliberately excluded: it parses
  // successfully and reaches the separate "must be a JSON object" branch.
  for (const input of [
    Buffer.from('{"padding":NaN}'),
    Buffer.from(`{"padding":${nested(256)}}`),
    Uint8Array.from([0x7b, 0x22, 0x61, 0x22, 0x3a, 0x22, 0xc3, 0x28]),
  ]) {
    await writeFile(file, input);
    await assert.rejects(readManifest(file), (error) => {
      assert.ok(error instanceof SafetyError);
      assert.equal(error.message, `invalid manifest JSON in ${file}`);
      return true;
    });
  }
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
    await classifyHooks(
      { hooks: "./hooks/hooks-codex.json" },
      "upstream",
      root,
    ),
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

async function roots(
  t: import("node:test").TestContext,
): Promise<{ source: string; candidate: string }> {
  const base = await sandbox(t);
  const source = join(base, "upstream");
  const candidate = join(base, "candidate");
  await mkdir(source, { recursive: true });
  await mkdir(candidate, { recursive: true });
  return { source, candidate };
}

void test("materializeHooks copies a regular hook subtree", async (t) => {
  const { source, candidate } = await roots(t);
  await mkdir(join(source, "hooks", "nested"), { recursive: true });
  await writeFile(join(source, "hooks", "hooks.json"), "{}\n");
  await writeFile(join(source, "hooks", "nested", "run.sh"), "#!/bin/sh\n");
  await materializeHooks(
    { copyHooksSubtree: true, declaredPaths: [] },
    source,
    candidate,
  );
  assert.equal(
    await readFile(join(candidate, "hooks", "nested", "run.sh"), "utf8"),
    "#!/bin/sh\n",
  );
});

void test("materializeHooks rejects an absolute subtree symlink", async (t) => {
  const { source, candidate } = await roots(t);
  await symlink("/tmp", join(source, "hooks"));
  await hookFailure(
    () =>
      materializeHooks(
        { copyHooksSubtree: true, declaredPaths: [] },
        source,
        candidate,
      ),
    "absolute subtree symlink is not allowed",
  );
});

void test("materializeHooks rejects a subtree that is not a directory", async (t) => {
  const { source, candidate } = await roots(t);
  await writeFile(join(source, "hooks"), "not a directory\n");
  await hookFailure(
    () =>
      materializeHooks(
        { copyHooksSubtree: true, declaredPaths: [] },
        source,
        candidate,
      ),
    "hook subtree is not a directory",
  );
});

void test("materializeHooks rejects an escaping symlink inside the subtree", async (t) => {
  const { source, candidate } = await roots(t);
  await mkdir(join(source, "hooks"), { recursive: true });
  await symlink("../../outside", join(source, "hooks", "escape"));
  await hookFailure(
    () =>
      materializeHooks(
        { copyHooksSubtree: true, declaredPaths: [] },
        source,
        candidate,
      ),
    "symlink escapes or is broken",
  );
});

void test("materializeHooks rejects a source-contained symlink that dangles in the candidate", async (t) => {
  const { source, candidate } = await roots(t);
  await mkdir(join(source, "hooks"), { recursive: true });
  await mkdir(join(source, "bin"), { recursive: true });
  await writeFile(join(source, "bin", "target"), "target\n");
  await symlink("../bin/target", join(source, "hooks", "contained"));
  await hookFailure(
    () =>
      materializeHooks(
        { copyHooksSubtree: true, declaredPaths: [] },
        source,
        candidate,
      ),
    "symlink escapes or is broken",
  );
});

void test("materializeHooks copies a declared file", async (t) => {
  const { source, candidate } = await roots(t);
  await mkdir(join(source, "config"), { recursive: true });
  await writeFile(join(source, "config", "hook.json"), "{}\n");
  await materializeHooks(
    { copyHooksSubtree: false, declaredPaths: ["./config/hook.json"] },
    source,
    candidate,
  );
  assert.equal(
    await readFile(join(candidate, "config", "hook.json"), "utf8"),
    "{}\n",
  );
});

void test("materializeHooks does not overwrite an existing declared destination", async (t) => {
  const { source, candidate } = await roots(t);
  await mkdir(join(source, "config"), { recursive: true });
  await mkdir(join(candidate, "config"), { recursive: true });
  await writeFile(join(source, "config", "hook.json"), "from upstream\n");
  await writeFile(join(candidate, "config", "hook.json"), "already here\n");
  await materializeHooks(
    { copyHooksSubtree: false, declaredPaths: ["./config/hook.json"] },
    source,
    candidate,
  );
  assert.equal(
    await readFile(join(candidate, "config", "hook.json"), "utf8"),
    "already here\n",
  );
});

void test("materializeHooks rejects a symlink at a declared destination", async (t) => {
  const { source, candidate } = await roots(t);
  await mkdir(join(source, "config"), { recursive: true });
  await mkdir(join(candidate, "config"), { recursive: true });
  await writeFile(join(source, "config", "hook.json"), "{}\n");
  await writeFile(join(candidate, "real.json"), "{}\n");
  await symlink("../real.json", join(candidate, "config", "hook.json"));
  await hookFailure(
    () =>
      materializeHooks(
        { copyHooksSubtree: false, declaredPaths: ["./config/hook.json"] },
        source,
        candidate,
      ),
    "declared hook destination must not be a symlink",
  );
});

void test("materializeHooks rejects a declared symlink that dangles in the candidate", async (t) => {
  const { source, candidate } = await roots(t);
  await mkdir(join(source, "config"), { recursive: true });
  await mkdir(join(source, "bin"), { recursive: true });
  await writeFile(join(source, "bin", "target"), "target\n");
  await symlink("../bin/target", join(source, "config", "link"));
  const plan = await classifyHooks(
    { hooks: "./config/link" },
    "upstream",
    source,
  );
  await hookFailure(
    () => materializeHooks(plan, source, candidate),
    "materialized hook destination escapes or is broken",
  );
});

void test("materializeHooks rejects a declared symlink that resolves outside the candidate", async (t) => {
  const { source, candidate } = await roots(t);
  await mkdir(join(source, "config"), { recursive: true });
  await mkdir(join(source, "bin"), { recursive: true });
  await writeFile(join(source, "bin", "target"), "target\n");
  // Absolute target inside sourceRoot: classification accepts it, and the
  // copied link RESOLVES successfully in the candidate — so a following stat
  // alone would pass. Only the containment check rejects it. This is the test
  // that proves the second pass enforces containment, not mere existence.
  await symlink(
    join(source, "bin", "target"),
    join(source, "config", "abs.json"),
  );
  const plan = await classifyHooks(
    { hooks: "./config/abs.json" },
    "upstream",
    source,
  );
  assert.deepEqual(plan.declaredPaths, ["./config/abs.json"]);
  const copied = join(candidate, "config", "abs.json");
  // The second pass must own the diagnostic (module "hooks") while retaining
  // the underlying safe-path failure as `cause`.
  await assert.rejects(
    () => materializeHooks(plan, source, candidate),
    (error) => {
      assert.ok(error instanceof SafetyError);
      assert.equal(error.module, "hooks");
      assert.equal(
        error.message.startsWith(
          "materialized hook destination escapes or is broken",
        ),
        true,
        error.message,
      );
      assert.ok(error.cause instanceof SafetyError, "cause must be retained");
      assert.equal(error.cause.module, "safe-path");
      return true;
    },
  );
  // Confirm the premise: the copied link exists and resolves.
  assert.equal((await lstat(copied)).isSymbolicLink(), true);
  assert.equal(await readFile(copied, "utf8"), "target\n");
});

void test("materializeHooks rejects an absolute symlink inside the hook subtree", async (t) => {
  const { source, candidate } = await roots(t);
  await mkdir(join(source, "hooks"), { recursive: true });
  await writeFile(join(source, "hooks", "hooks.json"), "{}\n");
  await symlink("/etc/hosts", join(source, "hooks", "abs"));
  await hookFailure(
    () =>
      materializeHooks(
        { copyHooksSubtree: true, declaredPaths: [] },
        source,
        candidate,
      ),
    "absolute symlink is not allowed",
  );
});

void test("materializeHooks accepts a declared symlink to another declared file", async (t) => {
  const { source, candidate } = await roots(t);
  await mkdir(join(source, "config"), { recursive: true });
  await writeFile(join(source, "config", "real.json"), "{}\n");
  await symlink("real.json", join(source, "config", "link.json"));
  await materializeHooks(
    {
      copyHooksSubtree: false,
      declaredPaths: ["./config/link.json", "./config/real.json"],
    },
    source,
    candidate,
  );
  const copied = join(candidate, "config", "link.json");
  // The link must survive AS a symlink with its original relative target —
  // reading the right bytes would also pass if the copy had dereferenced it.
  assert.equal((await lstat(copied)).isSymbolicLink(), true);
  assert.equal(await readlink(copied), "real.json");
  assert.equal(await readFile(copied, "utf8"), "{}\n");
});
