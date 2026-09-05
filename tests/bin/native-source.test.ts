import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));

void test("source CLI runs without dist and reads its own package version", (t) => {
  const root = mkdtempSync(join(tmpdir(), "spw-native-source-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  cpSync(join(ROOT, "src"), join(root, "src"), { recursive: true });
  cpSync(join(ROOT, "package.json"), join(root, "package.json"));
  const version = JSON.parse(
    readFileSync(join(root, "package.json"), "utf8"),
  ).version;
  assert.equal(existsSync(join(root, "dist")), false);
  const result = spawnSync(
    process.execPath,
    [join(root, "src", "cli.ts"), "--version"],
    { cwd: root, encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, `${version}\n`);
  assert.equal(result.stderr, "");
  assert.equal(existsSync(join(root, "dist")), false);
});
