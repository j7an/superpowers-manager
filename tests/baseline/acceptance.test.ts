import assert from "node:assert/strict";
import {
  copyFileSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { shQuote } from "../lib/git-egress.ts";

const ACCEPTANCE = fileURLToPath(new URL("../acceptance.sh", import.meta.url));

function fixture(t: import("node:test").TestContext) {
  const root = mkdtempSync(join(tmpdir(), "spw-acceptance-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const tests = join(root, "tests");
  mkdirSync(tests);
  const script = join(tests, "acceptance.sh");
  const record = join(root, "record");
  copyFileSync(ACCEPTANCE, script);
  return { root, tests, script, record };
}

function recorder(record: string, label: string, exitStatus = 0): string {
  return `#!/bin/sh\nprintf '%s:%s\\n' ${shQuote(label)} "$*" >> ${shQuote(record)}\nexit ${exitStatus}\n`;
}

function harnessRecorder(
  record: string,
  codexStatus: number,
  piStatus: number,
): string {
  return `#!/bin/sh\nprintf '%s:%s\\n' container "$*" >> ${shQuote(record)}\ncase "\${1:-}" in\n  harness-codex) exit ${codexStatus} ;;\n  harness-pi) exit ${piStatus} ;;\n  *) exit 97 ;;\nesac\n`;
}

function run(script: string) {
  return spawnSync("sh", [script, "--concurrency", "2"], {
    encoding: "utf8",
    timeout: 30000,
  });
}

void test("local acceptance runs shared suites before both native harnesses", (t) => {
  const f = fixture(t);
  writeFileSync(join(f.tests, "run.sh"), recorder(f.record, "shared"), {
    mode: 0o755,
  });
  writeFileSync(
    join(f.tests, "container.sh"),
    recorder(f.record, "container"),
    { mode: 0o755 },
  );

  const result = run(f.script);

  assert.equal(result.signal, null);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(
    readFileSync(f.record, "utf8"),
    "shared:--require-package-node --concurrency 2\n" +
      "container:harness-codex\n" +
      "container:harness-pi\n",
  );
  assert.equal(
    result.stdout,
    "acceptance: shared checks: start\n" +
      "acceptance: shared checks: complete status=0\n" +
      "acceptance: Codex harness integration: start\n" +
      "acceptance: Codex harness integration: complete status=0\n" +
      "acceptance: Pi harness integration: start\n" +
      "acceptance: Pi harness integration: complete status=0\n",
  );
});

void test("local acceptance stops when the shared suite fails", (t) => {
  const f = fixture(t);
  writeFileSync(join(f.tests, "run.sh"), recorder(f.record, "shared", 7), {
    mode: 0o755,
  });
  writeFileSync(
    join(f.tests, "container.sh"),
    recorder(f.record, "container"),
    { mode: 0o755 },
  );

  const result = run(f.script);

  assert.equal(result.signal, null);
  assert.equal(result.status, 7);
  assert.equal(
    readFileSync(f.record, "utf8"),
    "shared:--require-package-node --concurrency 2\n",
  );
  assert.equal(result.stdout, "acceptance: shared checks: start\n");
});

void test("local acceptance stops when the Codex harness fails", (t) => {
  const f = fixture(t);
  writeFileSync(join(f.tests, "run.sh"), recorder(f.record, "shared"), {
    mode: 0o755,
  });
  writeFileSync(
    join(f.tests, "container.sh"),
    recorder(f.record, "container", 9),
    { mode: 0o755 },
  );

  const result = run(f.script);

  assert.equal(result.signal, null);
  assert.equal(result.status, 9);
  assert.equal(
    readFileSync(f.record, "utf8"),
    "shared:--require-package-node --concurrency 2\ncontainer:harness-codex\n",
  );
  assert.equal(
    result.stdout,
    "acceptance: shared checks: start\n" +
      "acceptance: shared checks: complete status=0\n" +
      "acceptance: Codex harness integration: start\n",
  );
});

void test("local acceptance propagates a Pi harness failure last", (t) => {
  const f = fixture(t);
  writeFileSync(join(f.tests, "run.sh"), recorder(f.record, "shared"), {
    mode: 0o755,
  });
  writeFileSync(
    join(f.tests, "container.sh"),
    harnessRecorder(f.record, 0, 11),
    { mode: 0o755 },
  );

  const result = run(f.script);

  assert.equal(result.signal, null);
  assert.equal(result.status, 11);
  assert.equal(
    readFileSync(f.record, "utf8"),
    "shared:--require-package-node --concurrency 2\n" +
      "container:harness-codex\n" +
      "container:harness-pi\n",
  );
  assert.equal(
    result.stdout,
    "acceptance: shared checks: start\n" +
      "acceptance: shared checks: complete status=0\n" +
      "acceptance: Codex harness integration: start\n" +
      "acceptance: Codex harness integration: complete status=0\n" +
      "acceptance: Pi harness integration: start\n",
  );
});

void test("local acceptance stops after a signalled shared child", (t) => {
  const f = fixture(t);
  writeFileSync(
    join(f.tests, "run.sh"),
    `#!/bin/sh\nprintf '%s:%s\\n' ${shQuote("shared")} "$*" >> ${shQuote(f.record)}\nkill -TERM $$\n`,
    { mode: 0o755 },
  );
  writeFileSync(
    join(f.tests, "container.sh"),
    recorder(f.record, "container"),
    { mode: 0o755 },
  );

  const result = run(f.script);

  assert.equal(result.signal, null);
  assert.notEqual(result.status, 0);
  assert.equal(
    readFileSync(f.record, "utf8"),
    "shared:--require-package-node --concurrency 2\n",
  );
  assert.equal(result.stdout, "acceptance: shared checks: start\n");
});
