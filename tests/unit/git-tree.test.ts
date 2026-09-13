import assert from "node:assert/strict";
import {
  chmodSync,
  lstatSync,
  readFileSync,
  readlinkSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { materializeGitTree } from "../../src/git-tree.ts";
import {
  commitFixture,
  nativeFixture,
} from "../lib/harnesses/pi/package-fixture.ts";

void test("materializes committed bytes, modes, and contained links", async (t) => {
  const root = nativeFixture(t);
  writeFileSync(join(root, "binary"), Buffer.from([0, 255, 128]));
  writeFileSync(join(root, "tool"), "#!/bin/sh\n");
  chmodSync(join(root, "tool"), 0o755);
  symlinkSync("binary", join(root, "link"));
  const commit = commitFixture(root),
    destination = join(root, "candidate");
  await materializeGitTree(root, commit, destination);
  assert.deepEqual(
    readFileSync(join(destination, "binary")),
    Buffer.from([0, 255, 128]),
  );
  assert.equal(lstatSync(join(destination, "tool")).mode & 0o111, 0o111);
  assert.equal(readlinkSync(join(destination, "link")), "binary");
});

void test("refuses an escaping committed link", async (t) => {
  const root = nativeFixture(t);
  symlinkSync("../../outside", join(root, "escape"));
  await assert.rejects(
    materializeGitTree(root, commitFixture(root), join(root, "candidate")),
    /cannot materialize Git tree/,
  );
});
