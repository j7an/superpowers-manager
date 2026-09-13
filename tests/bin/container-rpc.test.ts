import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { shQuote } from "../lib/git-egress.ts";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const HELPER = join(ROOT, "tests/container/codex/hooks-list-rpc.ts");
const CHILD = join(ROOT, "tests/unit/helpers/rpc-server-child.ts");

function terminateOwnedGroup(pid: number | undefined): void {
  if (pid === undefined) return;
  try {
    process.kill(-pid, "SIGKILL");
  } catch (error) {
    if (!(
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "ESRCH"
    ))
      throw error;
  }
}

async function invoke(
  t: import("node:test").TestContext,
  scenario: string,
  method: "hooks/list" | "skills/list",
) {
  const scratch = mkdtempSync(join(tmpdir(), "spw-container-rpc-"));
  t.after(() => rmSync(scratch, { recursive: true, force: true }));
  const bin = join(scratch, "bin");
  const response = join(scratch, "response.json");
  const stderr = join(scratch, "app-server.stderr");
  const requestedCwd = join(scratch, "requested-cwd");
  // The wrapper, rather than PATH inherited from this test process, is the
  // only possible app-server. The helper still performs its real subprocess
  // handshake and owns normal child shutdown.
  mkdirSync(bin, { recursive: true });
  writeFileSync(
    join(bin, "codex"),
    `#!/bin/sh\nexec ${shQuote(process.execPath)} ${shQuote(CHILD)} ${shQuote(scenario)} ${shQuote(scratch)} ${shQuote(requestedCwd)}\n`,
  );
  chmodSync(join(bin, "codex"), 0o755);
  const child = spawn(
    process.execPath,
    [HELPER, requestedCwd, response, stderr, method],
    {
      cwd: scratch,
      detached: true,
      env: { PATH: `${bin}:/usr/bin:/bin` },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let stdout = "";
  let capturedStderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk: string) => {
    capturedStderr += chunk;
  });
  let settled = false;
  const deadline = setTimeout(() => {
    if (!settled) terminateOwnedGroup(child.pid);
  }, 35_000);
  const startedAt = Date.now();
  try {
    const [status, signal] = (await once(child, "close")) as [
      number | null,
      NodeJS.Signals | null,
    ];
    settled = true;
    return {
      status,
      signal,
      stdout,
      stderr: capturedStderr,
      response,
      appServerStderr: existsSync(stderr) ? readFileSync(stderr, "utf8") : "",
      elapsedMs: Date.now() - startedAt,
    };
  } finally {
    clearTimeout(deadline);
    if (!settled) terminateOwnedGroup(child.pid);
  }
}

void test("container RPC helper", async (t) => {
  for (const [scenario, method] of [
    ["hooks-success", "hooks/list"],
    ["skills-success", "skills/list"],
    ["wrong-ids", "hooks/list"],
  ] as const) {
    await t.test(
      `${scenario} persists only the successful matching response`,
      async (t) => {
        const result = await invoke(t, scenario, method);
        assert.equal(result.signal, null);
        assert.equal(result.status, 0, result.stderr);
        assert.equal(result.stdout, "");
        assert.equal(
          readFileSync(result.response, "utf8"),
          '{"id":1,"result":{"data":[]}}\n',
        );
        assert.equal(result.appServerStderr, "");
      },
    );
  }
  await t.test(
    "requires an integer token for the matching root id",
    async (t) => {
      const result = await invoke(t, "numeric-id-spellings", "hooks/list");
      assert.equal(result.signal, null);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stdout, "");
      assert.equal(
        readFileSync(result.response, "utf8"),
        '{"id":1,"result":{"data":[],"nested":{"id":2}}}\n',
      );
    },
  );
  await t.test("preserves split UTF-8 and JSONL bytes", async (t) => {
    const result = await invoke(t, "split-chunks", "hooks/list");
    assert.equal(result.signal, null);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, "");
    assert.equal(
      readFileSync(result.response, "utf8"),
      '{"id":1,"result":{"label":"split 😀"}}\n',
    );
  });
  await t.test("preserves large integer digits in result data", async (t) => {
    const result = await invoke(t, "large-integer", "hooks/list");
    assert.equal(result.signal, null);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(
      readFileSync(result.response, "utf8"),
      '{"id":1,"result":{"value":123456789012345678901234567890123456789012345678901234567890123456789012345678901234567890123456789012345678901234567890123456789012345678901234567890123456789012345678901234567890123456789012345678901234567890123456789012345678901234567890123456789012345678901234567890123456789012345678901234567890123456789012345678901234567890123456789012345678901234567890}}\n',
    );
  });
  await t.test("captures app-server stderr", async (t) => {
    const result = await invoke(t, "stderr", "hooks/list");
    assert.equal(result.signal, null);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.appServerStderr, "app-server diagnostic\n");
  });
  await t.test(
    "terminates then kills a child that will not exit",
    async (t) => {
      const result = await invoke(t, "cleanup-kill", "hooks/list");
      assert.equal(result.signal, null);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(
        result.appServerStderr,
        "cleanup child ready\nterminate received\n",
      );
      assert.ok(
        result.elapsedMs >= 3_500,
        `cleanup took ${result.elapsedMs}ms`,
      );
      assert.ok(
        result.elapsedMs < 10_000,
        `cleanup took ${result.elapsedMs}ms`,
      );
    },
  );
  for (const [scenario, diagnostic] of [
    ["malformed-json", /malformed JSONL response/],
    ["invalid-utf8", /malformed JSONL response/],
    ["nan", /malformed JSONL response/],
    ["overflow", /malformed JSONL response/],
    ["non-object", /JSONL response must be an object/],
    ["rpc-error", /RPC error for id 1/],
    ["no-result", /response id 1 has no result/],
    ["eof", /EOF before the required response/],
    ["timeout", /timed out waiting for app-server output/],
  ] as const) {
    await t.test(`${scenario} fails without writing a response`, async (t) => {
      const result = await invoke(t, scenario, "hooks/list");
      assert.equal(result.signal, null);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /^Codex hooks\/list protocol failed: /);
      assert.match(result.stderr, diagnostic);
      assert.ok(!existsSync(result.response));
      assert.equal(result.appServerStderr, "");
    });
  }
  await t.test(
    "missing initialization response stops before the list request",
    async (t) => {
      const result = await invoke(t, "missing-initialization", "hooks/list");
      assert.equal(result.signal, null);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /^Codex hooks\/list protocol failed: /);
      assert.match(result.stderr, /EOF before the required response/);
      assert.ok(!existsSync(result.response));
      assert.equal(result.appServerStderr, "");
    },
  );
});

void test("BOM-prefixed RPC response fails without publication", async (t) => {
  const result = await invoke(t, "bom-prefixed", "hooks/list");
  assert.equal(result.signal, null);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /^Codex hooks\/list protocol failed: /);
  assert.match(result.stderr, /malformed JSONL response/);
  assert.ok(!existsSync(result.response));
  assert.equal(result.appServerStderr, "");
});
