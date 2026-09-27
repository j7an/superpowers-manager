import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, type TestContext } from "node:test";

export function scratch(t: TestContext, prefix: string): string {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

// Suite lifetime. Call at module scope only: inside a test body, after()
// attaches to that test and the tree is removed when the test ends.
export function suiteScratch(prefix: string): string {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}
