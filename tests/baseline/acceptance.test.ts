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
  openCodeStatus = 0,
): string {
  return `#!/bin/sh\nprintf '%s:%s\\n' container "$*" >> ${shQuote(record)}\ncase "\${1:-}" in\n  harness-codex) exit ${codexStatus} ;;\n  harness-pi) exit ${piStatus} ;;\n  harness-opencode) exit ${openCodeStatus} ;;\n  *) exit 97 ;;\nesac\n`;
}

function run(script: string) {
  return spawnSync("sh", [script, "--concurrency", "2"], {
    encoding: "utf8",
    timeout: 30000,
  });
}

const phases = [
  "shared checks",
  "Codex harness integration",
  "Pi harness integration",
  "OpenCode harness integration",
] as const;
const calls = [
  "shared:--require-package-node --concurrency 2",
  "container:harness-codex",
  "container:harness-pi",
  "container:harness-opencode",
];
const cases = [
  {
    name: "runs shared suites before all native harnesses",
    failed: -1,
    code: 0,
  },
  { name: "stops when the shared suite fails", failed: 0, code: 7 },
  { name: "stops when the Codex harness fails", failed: 1, code: 9 },
  { name: "stops when the Pi harness fails", failed: 2, code: 11 },
  {
    name: "propagates an OpenCode harness failure last",
    failed: 3,
    code: 13,
  },
];

for (const row of cases) {
  void test(`local acceptance ${row.name}`, (t) => {
    const f = fixture(t);
    writeFileSync(
      join(f.tests, "run.sh"),
      recorder(f.record, "shared", row.failed === 0 ? row.code : 0),
      { mode: 0o755 },
    );
    writeFileSync(
      join(f.tests, "container.sh"),
      harnessRecorder(
        f.record,
        row.failed === 1 ? row.code : 0,
        row.failed === 2 ? row.code : 0,
        row.failed === 3 ? row.code : 0,
      ),
      { mode: 0o755 },
    );

    const result = run(f.script);
    const reached = row.failed < 0 ? phases.length : row.failed + 1;
    const records = phases
      .slice(0, reached)
      .flatMap((phase, index) => [
        `acceptance: ${phase}: start`,
        ...(index === row.failed
          ? []
          : [`acceptance: ${phase}: complete status=0`]),
      ]);

    assert.equal(result.signal, null);
    assert.equal(result.status, row.code, result.stderr);
    assert.equal(
      readFileSync(f.record, "utf8"),
      calls.slice(0, reached).join("\n") + "\n",
    );
    assert.equal(result.stdout, records.join("\n") + "\n");
  });
}

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
