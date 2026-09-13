import assert from "node:assert/strict";
import { closeSync } from "node:fs";
import { createInterface } from "node:readline";

const scenario = process.argv[2];
assert.ok(scenario, "expected scenario argument");

const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
const requests = input[Symbol.asyncIterator]();

function asObject(value: unknown): Record<string, unknown> {
  assert.equal(typeof value, "object");
  assert.notEqual(value, null);
  assert.ok(!Array.isArray(value));
  return value as Record<string, unknown>;
}

async function request(): Promise<Record<string, unknown>> {
  const next = await requests.next();
  assert.equal(next.done, false, "unexpected input EOF");
  return asObject(JSON.parse(next.value));
}

function emit(value: string | Uint8Array): void {
  process.stdout.write(value);
}

async function assertNoExtraRequestBytes(): Promise<void> {
  for await (const _line of requests) {
    assert.fail("unexpected request bytes after initialization response");
  }
}

async function main(): Promise<void> {
  const initialize = await request();
  assert.equal(initialize.id, 0);
  assert.equal(initialize.method, "initialize");

  if (scenario === "missing-initialization") {
    closeSync(process.stdout.fd);
    await assertNoExtraRequestBytes();
    return;
  }

  emit('{"id":0,"result":{}}\n');
  assert.deepEqual(await request(), { method: "initialized" });
  const list = await request();
  assert.equal(list.id, 1);
  assert.ok(list.method === "hooks/list" || list.method === "skills/list");
  const params = asObject(list.params);
  assert.ok(Array.isArray(params.cwds));
  assert.equal(params.cwds.length, 1);
  if (list.method === "skills/list") assert.equal(params.forceReload, true);

  if (scenario === "malformed-json") emit("{\n");
  else if (scenario === "invalid-utf8") emit(new Uint8Array([0xff, 0x0a]));
  else if (scenario === "nan") emit('{"id":1,"result":NaN}\n');
  else if (scenario === "non-object") emit("[]\n");
  else if (scenario === "rpc-error") emit('{"id":1,"error":{"code":1}}\n');
  else if (scenario === "no-result") emit('{"id":1}\n');
  else if (scenario === "wrong-ids") {
    emit(
      '{"method":"notice"}\n{"id":true,"result":{"data":["wrong"]}}\n{"id":2,"result":{"data":["wrong"]}}\n{"id":1,"result":{"data":[]}}\n',
    );
  } else if (scenario === "eof") {
    input.close();
    return;
  } else if (scenario === "timeout") {
    await assertNoExtraRequestBytes();
    return;
  } else if (scenario === "hooks-success" || scenario === "skills-success") {
    emit('{"id":1,"result":{"data":[]}}\n');
  } else {
    assert.fail(`unknown scenario: ${scenario}`);
  }

  await assertNoExtraRequestBytes();
}

await main();
