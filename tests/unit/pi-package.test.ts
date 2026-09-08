import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { digestPiTree, materializePiTree } from "../../src/pi-package.ts";
import {
  commitFixture,
  fixtureGit,
  nativeFixture,
} from "../lib/pi-package-fixture.ts";

void test("materializes committed binary, mode, hidden files and links without untracked poison", async (t) => {
  const root = nativeFixture(t);
  writeFileSync(join(root, "binary"), Buffer.from([0, 255, 128, 13]));
  writeFileSync(join(root, "helper"), "#!/bin/sh\nexit 0\n");
  chmodSync(join(root, "helper"), 0o755);
  writeFileSync(join(root, ".support"), "hidden");
  symlinkSync("binary", join(root, "link"));
  const commit = commitFixture(root);
  writeFileSync(join(root, "poison"), "untracked");
  const destination = join(root, "candidate");
  await materializePiTree(root, commit, destination);
  assert.deepEqual(
    readFileSync(join(destination, "binary")),
    Buffer.from([0, 255, 128, 13]),
  );
  assert.equal(lstatSync(join(destination, "helper")).mode & 0o111, 0o111);
  assert.equal(readlinkSync(join(destination, "link")), "binary");
  assert.equal(readFileSync(join(destination, ".support"), "utf8"), "hidden");
  assert.throws(() => lstatSync(join(destination, "poison")), /ENOENT/);
  const digest = await digestPiTree(destination);
  writeFileSync(join(destination, ".superpowers-manager.json"), "receipt");
  assert.equal(await digestPiTree(destination), digest);
  writeFileSync(join(destination, "extra"), "drift");
  assert.notEqual(await digestPiTree(destination), digest);
});

void test("refuses escaping links, receipt collisions and gitlinks", async (t) => {
  for (const kind of ["escape", "receipt", "gitlink"])
    await t.test(kind, async (t) => {
      const root = nativeFixture(t);
      if (kind === "escape") symlinkSync("../../outside", join(root, "escape"));
      if (kind === "receipt")
        writeFileSync(
          join(root, ".superpowers-manager.json"),
          "owned by upstream",
        );
      let commit = commitFixture(root);
      if (kind === "gitlink") {
        fixtureGit(
          root,
          "update-index",
          "--add",
          "--cacheinfo",
          `160000,${commit},nested`,
        );
        fixtureGit(root, "commit", "-qm", "gitlink");
        commit = fixtureGit(root, "rev-parse", "HEAD");
      }
      await assert.rejects(
        materializePiTree(root, commit, join(root, "candidate")),
        /Pi (tree|artifact)/,
      );
    });
});

void test("rejects invalid UTF-8 and traversal paths in committed Git objects", async (t) => {
  for (const name of [
    Buffer.from([0xff]),
    Buffer.from("../outside"),
    Buffer.from(".git/config"),
  ])
    await t.test(name.toString("hex"), async (t) => {
      const root = nativeFixture(t);
      commitFixture(root);
      const blob = fixtureGit(root, "rev-parse", "HEAD:LICENSE");
      const tree = Buffer.concat([
        Buffer.from("100644 "),
        name,
        Buffer.from([0]),
        Buffer.from(blob, "hex"),
      ]);
      const treeOid = execFileSync(
        "git",
        ["hash-object", "--literally", "-w", "-t", "tree", "--stdin"],
        { cwd: root, input: tree, encoding: "utf8" },
      ).trim();
      const commit = fixtureGit(
        root,
        "commit-tree",
        treeOid,
        "-m",
        "invalid path fixture",
      );
      await assert.rejects(
        materializePiTree(root, commit, join(root, "candidate")),
        /cannot materialize Pi tree/,
      );
    });
});

void test("digest distinguishes framed paths, executable modes, links and nested receipt-named content", async (t) => {
  const root = nativeFixture(t),
    left = join(root, "left"),
    right = join(root, "right");
  mkdirSync(left);
  mkdirSync(right);
  writeFileSync(join(left, "a"), "0z");
  writeFileSync(join(right, "a0"), "z");
  assert.notEqual(await digestPiTree(left), await digestPiTree(right));
  const original = await digestPiTree(left);
  chmodSync(join(left, "a"), 0o755);
  assert.notEqual(await digestPiTree(left), original);
  chmodSync(join(left, "a"), 0o644);
  symlinkSync("a", join(left, "link"));
  assert.notEqual(await digestPiTree(left), original);
  mkdirSync(join(right, "nested"));
  const before = await digestPiTree(right);
  writeFileSync(join(right, "nested/.superpowers-manager.json"), "content");
  assert.notEqual(await digestPiTree(right), before);
});

void test("materialization requires a commit and ignores repository replacement refs", async (t) => {
  const root = nativeFixture(t),
    first = commitFixture(root);
  const tree = fixtureGit(root, "rev-parse", "HEAD^{tree}");
  await assert.rejects(
    materializePiTree(root, tree, join(root, "not-a-commit")),
    /cannot materialize Pi tree/,
  );
  writeFileSync(join(root, "replacement-only"), "poison");
  fixtureGit(root, "add", "replacement-only");
  fixtureGit(root, "commit", "-qm", "replacement");
  const replacement = fixtureGit(root, "rev-parse", "HEAD");
  fixtureGit(root, "replace", first, replacement);
  const candidate = join(root, "candidate");
  await materializePiTree(root, first, candidate);
  assert.throws(() => lstatSync(join(candidate, "replacement-only")), /ENOENT/);
});

void test("digest orders Unicode scalar paths and ignores creation order and root names", async (t) => {
  const root = nativeFixture(t),
    first = join(root, "first"),
    second = join(root, "second");
  mkdirSync(first);
  mkdirSync(second);
  writeFileSync(join(first, "😀"), "b");
  writeFileSync(join(first, "\ue000"), "a");
  writeFileSync(join(second, "\ue000"), "a");
  writeFileSync(join(second, "😀"), "b");
  // Hand-framed oracle: file/e000/0/a, then file/1f600/0/b; every field
  // is preceded by its unsigned 64-bit big-endian byte length.
  const expected =
    "4876f54002f825a34a7e7e3053ec35b96f58b0dab59d338838b6784b9ec7f67d";
  assert.equal(await digestPiTree(first), expected);
  assert.equal(await digestPiTree(second), expected);
});
