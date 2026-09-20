import assert from "node:assert/strict";
import {
  chmod,
  lstat,
  mkdtemp,
  open,
  readFile,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  parseOpenCodeConfig,
  readOpenCodeConfig,
  removeObservedOpenCodeEntry,
  removeOpenCodeEntry,
} from "../../../../src/harnesses/opencode/config.ts";

const INVALID = /invalid OpenCode configuration/;
const CANNOT_READ = /cannot read OpenCode configuration/;
const CANNOT_REMOVE = /cannot remove owned OpenCode registration/;

function nestedConfig(depth: number): string {
  return `{"future":${"[".repeat(depth - 1)}0${"]".repeat(depth - 1)}}`;
}

void test("parses the two qualified plugin entry shapes", () => {
  const document = parseOpenCodeConfig(
    '{"plugin":["other",["file:///owned",{"answer":42,"nested":{"ok":true}}]]}',
    "/fixture/opencode.json",
  );
  assert.deepEqual(document.entries, [
    { key: "plugin", index: 0, spec: "other", options: null },
    {
      key: "plugin",
      index: 1,
      spec: "file:///owned",
      options: { answer: 42, nested: { ok: true } },
    },
  ]);
});

void test("parses registrations under both OpenCode config keys", () => {
  const document = parseOpenCodeConfig(
    '{"plugin":["one"],"plugins":["two","three"]}',
    "/fixture/opencode.json",
  );
  assert.deepEqual(document.entries, [
    { key: "plugin", index: 0, spec: "one", options: null },
    { key: "plugins", index: 0, spec: "two", options: null },
    { key: "plugins", index: 1, spec: "three", options: null },
  ]);
});

void test("removes an owned entry from the plugins key only", () => {
  const document = parseOpenCodeConfig(
    '{"plugin":["keep"],"plugins":["drop","stay"]}',
    "/fixture/opencode.json",
  );
  const output = removeOpenCodeEntry(document, "plugins", 0);
  const after = parseOpenCodeConfig(output, "/fixture/opencode.json");
  assert.deepEqual(after.entries, [
    { key: "plugin", index: 0, spec: "keep", options: null },
    { key: "plugins", index: 0, spec: "stay", options: null },
  ]);
});

void test("rejects a removal index that does not exist under the named key", () => {
  const document = parseOpenCodeConfig(
    '{"plugin":["only"]}',
    "/fixture/opencode.json",
  );
  assert.throws(
    () => removeOpenCodeEntry(document, "plugins", 0),
    CANNOT_REMOVE,
  );
});

void test("preserves special option keys without prototype pollution", () => {
  const [entry] = parseOpenCodeConfig(
    '{"plugin":[["file:///owned",{"__proto__":{"polluted":true},"constructor":{"nested":1}}]]}',
    "/fixture/opencode.json",
  ).entries;
  assert.ok(entry?.options);
  assert.equal(Object.getPrototypeOf(entry.options), Object.prototype);
  assert.equal(Object.hasOwn(entry.options, "__proto__"), true);
  assert.equal(Object.hasOwn(entry.options, "constructor"), true);
  assert.deepEqual(entry.options.__proto__, { polluted: true });
  assert.deepEqual(entry.options.constructor, { nested: 1 });
  assert.equal(({} as { polluted?: boolean }).polluted, undefined);
});

void test("accepts comments, trailing commas, and a missing plugin field", () => {
  assert.deepEqual(
    parseOpenCodeConfig(
      '{// comment\n"future": true,}',
      "/fixture/opencode.jsonc",
    ).entries,
    [],
  );
});

void test("removal preserves unrelated comments and numeric source", () => {
  const input =
    '{\n // retained\n "plugin": ["other", "file:///owned"],\n "limit": 9007199254740993,\n "literal": "https://example.invalid/a//b"\n}\n';
  const document = parseOpenCodeConfig(input, "/fixture/opencode.jsonc");
  const output = removeOpenCodeEntry(document, "plugin", 1);
  assert.deepEqual(
    parseOpenCodeConfig(output, document.path).entries.map(
      (entry) => entry.spec,
    ),
    ["other"],
  );
  assert.ok(output.includes("// retained"));
  assert.ok(output.includes('"limit": 9007199254740993'));
  assert.ok(output.includes('"literal": "https://example.invalid/a//b"'));
});

void test("removes first, middle, last, and sole entries without consuming neighboring comments", () => {
  for (const fixture of [
    {
      input:
        '{"plugin":["first" /* keep-first-gap */,\n// before middle\n"middle",\n// before last\n"last",]}',
      index: 0,
      expected: ["middle", "last"],
      retained: ["/* keep-first-gap */", "// before middle", "// before last"],
    },
    {
      input:
        '{"plugin":["first",\n// before middle\n"middle" /* keep-middle-gap */,\n// before last\n"last"]}',
      index: 1,
      expected: ["first", "last"],
      retained: ["// before middle", "/* keep-middle-gap */", "// before last"],
    },
    {
      input: '{"plugin":["first",\n// before last\n"last" /* keep-tail */,]}',
      index: 1,
      expected: ["first"],
      retained: ["// before last", "/* keep-tail */"],
    },
    {
      input: '{"plugin":[\n// sole comment\n"sole",\n]}',
      index: 0,
      expected: [],
      retained: ["// sole comment"],
    },
  ]) {
    const document = parseOpenCodeConfig(
      fixture.input,
      "/fixture/opencode.jsonc",
    );
    const output = removeOpenCodeEntry(document, "plugin", fixture.index);
    assert.deepEqual(
      parseOpenCodeConfig(output, document.path).entries.map(
        (entry) => entry.spec,
      ),
      fixture.expected,
    );
    for (const retained of fixture.retained)
      assert.ok(output.includes(retained));
  }
});

void test("rejects malformed, non-object, duplicate-key, and unsupported plugin input", () => {
  for (const input of [
    "{",
    "[]",
    '{"plugin":{},}',
    '{"plugin":[],"plugin":["other"]}',
    '{"plugin":[["owned",{"same":1,"same":2}]]}',
    '{"plugin":[42]}',
    '{"plugin":[{"path":"owned"}]}',
    '{"plugin":[["owned"]]}',
    '{"plugin":[["owned",{} , false]]}',
    '{"plugin":[["owned",null]]}',
    '{"plugin":[["owned",[]]]}',
    '{"plugin":[["owned",false]]}',
    '{"plugin":[["owned","disabled"]]}',
  ]) {
    assert.throws(
      () => parseOpenCodeConfig(input, "/fixture/opencode.jsonc"),
      INVALID,
      input,
    );
  }
});

void test("bounds document bytes and nesting while accepting the boundary", () => {
  assert.doesNotThrow(() =>
    parseOpenCodeConfig(nestedConfig(256), "/fixture/depth.json"),
  );
  assert.throws(
    () => parseOpenCodeConfig(nestedConfig(257), "/fixture/depth.json"),
    INVALID,
  );
  const base = '{"plugin":[]}';
  assert.doesNotThrow(() =>
    parseOpenCodeConfig(
      `${base}${" ".repeat(1024 * 1024 - Buffer.byteLength(base))}`,
      "/fixture/limit.json",
    ),
  );
  const oversized = `${base}${" ".repeat(1024 * 1024)}`;
  assert.throws(
    () => parseOpenCodeConfig(oversized, "/fixture/large.json"),
    INVALID,
  );
});

void test("rejects invalid removal indexes", () => {
  const document = parseOpenCodeConfig(
    '{"plugin":["owned"]}',
    "/fixture/opencode.json",
  );
  for (const index of [-1, 0.5, 1]) {
    assert.throws(
      () => removeOpenCodeEntry(document, "plugin", index),
      CANNOT_REMOVE,
    );
  }
});

void test("observes absent and regular files without following symlinks", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "spw-opencode-config-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "opencode.jsonc");
  assert.equal(await readOpenCodeConfig(path), null);

  const bytes = Buffer.from('{"plugin":["owned"]}\n');
  await writeFile(path, bytes, { mode: 0o640 });
  const observation = await readOpenCodeConfig(path);
  assert.ok(observation);
  assert.deepEqual(observation.bytes, bytes);
  assert.equal(observation.identity.mode & 0o777, 0o640);

  const link = join(root, "linked.jsonc");
  await symlink(path, link);
  await assert.rejects(readOpenCodeConfig(link), CANNOT_READ);
});

void test("rejects directories, invalid UTF-8, and oversized files as unreadable config", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "spw-opencode-config-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await assert.rejects(readOpenCodeConfig(root), CANNOT_READ);
  const invalid = join(root, "invalid.json");
  await writeFile(invalid, Buffer.from([0xff]));
  await assert.rejects(readOpenCodeConfig(invalid), CANNOT_READ);
  const oversized = join(root, "oversized.json");
  await writeFile(oversized, Buffer.alloc(1024 * 1024 + 1, 0x20));
  await assert.rejects(readOpenCodeConfig(oversized), CANNOT_READ);
});

void test("descriptor observation handles short bounded reads without readFile", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "spw-opencode-config-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "opencode.json");
  await writeFile(path, '{"plugin":["owned"]}\n');

  const probe = await open(path, "r");
  const prototype = Object.getPrototypeOf(probe) as {
    read: typeof probe.read;
    readFile: typeof probe.readFile;
  };
  await probe.close();
  const originalRead = prototype.read;
  const originalReadFile = prototype.readFile;
  prototype.read = async function (
    this: typeof probe,
    buffer: Buffer,
    offset: number,
    length: number,
    position: number | null,
  ) {
    return Reflect.apply(originalRead, this, [
      buffer,
      offset,
      Math.min(length, 3),
      position,
    ]) as Promise<{ bytesRead: number; buffer: Buffer }>;
  } as typeof probe.read;
  prototype.readFile = async () => {
    throw new Error("unbounded descriptor read attempted");
  };
  try {
    const observation = await readOpenCodeConfig(path);
    assert.ok(observation);
    assert.deepEqual(
      observation.document.entries.map((entry) => entry.spec),
      ["owned"],
    );
  } finally {
    prototype.read = originalRead;
    prototype.readFile = originalReadFile;
  }
});

void test("checked removal preserves mode and publishes only the intended edit", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "spw-opencode-config-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "opencode.jsonc");
  await writeFile(
    path,
    '{\n// keep\n"plugin":["other","owned",],\n"future":1\n}\n',
  );
  await chmod(path, 0o644);
  const observation = await readOpenCodeConfig(path);
  assert.ok(observation);
  await removeObservedOpenCodeEntry(observation, "plugin", 1);
  const after = await readFile(path, "utf8");
  assert.deepEqual(
    parseOpenCodeConfig(after, path).entries.map((entry) => entry.spec),
    ["other"],
  );
  assert.ok(after.includes("// keep"));
  assert.ok(after.includes('"future":1'));
  assert.equal((await lstat(path)).mode & 0o777, 0o644);
});

void test("checked removal refuses a concurrent edit and preserves the newer bytes", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "spw-opencode-config-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "opencode.json");
  await writeFile(path, '{"plugin":["owned"],"future":1}\n');
  const observation = await readOpenCodeConfig(path);
  assert.ok(observation);
  const newer = '{"plugin":["owned"],"future":2}\n';
  await writeFile(path, newer);
  await assert.rejects(
    removeObservedOpenCodeEntry(observation, "plugin", 0),
    CANNOT_REMOVE,
  );
  assert.equal(await readFile(path, "utf8"), newer);
});

void test("checked removal refuses a same-byte concurrent replacement", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "spw-opencode-config-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "opencode.json");
  const replacement = join(root, "replacement.json");
  const bytes = '{"plugin":["owned"]}\n';
  await writeFile(path, bytes);
  const observation = await readOpenCodeConfig(path);
  assert.ok(observation);
  await writeFile(replacement, bytes);
  await rename(replacement, path);
  await assert.rejects(
    removeObservedOpenCodeEntry(observation, "plugin", 0),
    CANNOT_REMOVE,
  );
  assert.equal(await readFile(path, "utf8"), bytes);
});

void test("checked removal refuses a mode change and preserves the newer policy", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "spw-opencode-config-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "opencode.json");
  const bytes = '{"plugin":["owned"],"future":1}\n';
  await writeFile(path, bytes, { mode: 0o644 });
  const observation = await readOpenCodeConfig(path);
  assert.ok(observation);
  await chmod(path, 0o600);

  await assert.rejects(
    removeObservedOpenCodeEntry(observation, "plugin", 0),
    CANNOT_REMOVE,
  );
  assert.equal(await readFile(path, "utf8"), bytes);
  assert.equal((await lstat(path)).mode & 0o777, 0o600);
});
