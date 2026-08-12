// @ts-check
import assert from "node:assert/strict";
import test from "node:test";

/** @type {typeof import("../../src/codex-json.js")} */
const {
  activePluginVersionFromJson,
  installedListingHas,
  marketplaceRootFromJson,
} = await import(new URL("../../dist/codex-json.js", import.meta.url).href);
/** @type {typeof import("../../src/safety-error.js")} */
const { SafetyError } = await import(
  new URL("../../dist/safety-error.js", import.meta.url).href
);

/** @param {number} depth */
const nested = (depth) => "[".repeat(depth) + "0" + "]".repeat(depth);

// Scope note (roadmap row :1155, reclassified): this case pins that
// `marketplaceRootFromJson` forwards byte input to `parseStrictJson`
// undecoded, so the fatal UTF-8 decode can reject it. It does NOT pin the
// adoption the row was filed about. `src/strict-json.ts`'s fatal decode and
// its `string | Uint8Array` parameter both predate the Codex-adapter port
// byte-for-byte, so no mutation of that decode says anything about the port.
// The behavioural half of that adoption is the adapter passing raw `Buffer`
// stdout at `src/adapter.ts:604`, `:809`, and `:898`-`:924` instead of a
// lossily decoded string; a regression there stays green here and needs an
// adapter-boundary test, not another case in this file.
void test("marketplace reader rejects invalid UTF-8 bytes", () => {
  assert.throws(
    () =>
      marketplaceRootFromJson(
        Buffer.from(
          '{"marketplaces":[{"name":"openai-\xffcurated","root":"/other"}]}',
          "latin1",
        ),
        "superpowers-manager",
      ),
    SafetyError,
  );
});

void test("CODEX-JSON-ARRAY-01 installed listing reader complete matrix", () => {
  assert.equal(
    installedListingHas(
      '{"padding":NaN,"installed":[{"pluginId":"target@provider"}]}',
      "installed",
      "pluginId",
      "target@provider",
    ),
    true,
  );
  assert.equal(
    installedListingHas(
      '{"installed":[],"installed":[{"pluginId":"target@provider"}]}',
      "installed",
      "pluginId",
      "target@provider",
    ),
    true,
  );
  assert.equal(
    installedListingHas(
      `{"padding":"${"x".repeat(65_536)}","installed":[{"pluginId":"target@provider"}]}`,
      "installed",
      "pluginId",
      "target@provider",
    ),
    true,
  );
  assert.equal(
    installedListingHas(
      '{"marketplaces":[{"name":"superpowers-manager"}]}',
      "marketplaces",
      "name",
      "superpowers-manager",
    ),
    true,
  );
  assert.equal(
    installedListingHas(
      '{"marketplaces":[{"name":"other"}]}',
      "marketplaces",
      "name",
      "superpowers-manager",
    ),
    false,
  );
  for (const raw of [
    "{",
    "[]",
    "{}",
    '{"installed":{}}',
    '{"installed":[{}]}',
    '{"installed":[{"pluginId":42}]}',
    '{"installed":[null]}',
    '{"marketplaces":[{}]}',
    '{"marketplaces":[{"name":42}]}',
    '{"marketplaces":[null]}',
    nested(2_000),
  ]) {
    assert.throws(
      () =>
        installedListingHas(raw, "installed", "pluginId", "target@provider"),
      SafetyError,
      raw,
    );
  }
});

void test("an empty installed array reports absent", () => {
  assert.equal(
    installedListingHas(
      Buffer.from('{"installed":[]}', "utf8"),
      "installed",
      "pluginId",
      "superpowers@superpowers-manager",
    ),
    false,
  );
});

void test("CODEX-JSON-MARKETPLACE-01 marketplace reader complete matrix", () => {
  assert.equal(
    marketplaceRootFromJson(
      '{"padding":NaN,"marketplaces":[{"name":"superpowers-manager","root":"/manager"}]}',
      "superpowers-manager",
    ),
    "/manager",
  );
  assert.equal(
    marketplaceRootFromJson(
      '{"marketplaces":[],"marketplaces":[{"name":"superpowers-manager","root":"/last"}]}',
      "superpowers-manager",
    ),
    "/last",
  );
  assert.equal(
    marketplaceRootFromJson(
      '{"marketplaces":[{"name":"unrelated"}]}',
      "superpowers-manager",
    ),
    "",
  );
  assert.equal(
    marketplaceRootFromJson(
      '{"marketplaces":[{"name":"unrelated","root":17}]}',
      "superpowers-manager",
    ),
    "",
  );
  assert.equal(
    marketplaceRootFromJson(
      `{"padding":"${"x".repeat(65_536)}","marketplaces":[{"name":"superpowers-manager","root":"/manager"}]}`,
      "superpowers-manager",
    ),
    "/manager",
  );
  for (const raw of [
    "{",
    "[]",
    "{}",
    '{"marketplaces":{}}',
    '{"marketplaces":["bad"]}',
    '{"marketplaces":[{"root":"/x"}]}',
    '{"marketplaces":[{"name":17,"root":"/x"}]}',
    '{"marketplaces":[{"name":"superpowers-manager"}]}',
    '{"marketplaces":[{"name":"superpowers-manager","root":17}]}',
    nested(2_000),
  ]) {
    assert.throws(
      () => marketplaceRootFromJson(raw, "superpowers-manager"),
      SafetyError,
      raw,
    );
  }
});

void test("an empty marketplaces array yields no root", () => {
  assert.equal(
    marketplaceRootFromJson(
      Buffer.from('{"marketplaces":[]}', "utf8"),
      "superpowers-manager",
    ),
    "",
  );
});

void test("CODEX-JSON-VERSION-01 active version reader complete matrix", () => {
  assert.equal(
    activePluginVersionFromJson(
      '{"installed":[{"pluginId":"target@provider","version":"1.0.0"}]}',
      "target@provider",
    ),
    "1.0.0",
  );
  assert.equal(
    activePluginVersionFromJson(
      '{"installed":[{"pluginId":"other@provider","version":"1.0.0"}]}',
      "target@provider",
    ),
    "",
  );
  assert.equal(
    activePluginVersionFromJson(
      '{"installed":[],"installed":[{"pluginId":"target@provider","version":"2.0.0"}]}',
      "target@provider",
    ),
    "2.0.0",
  );
  assert.equal(
    activePluginVersionFromJson(
      `{"padding":"${"x".repeat(65_536)}","installed":[{"pluginId":"target@provider","version":"3.0.0"}]}`,
      "target@provider",
    ),
    "3.0.0",
  );
  for (const raw of [
    '{"padding":Infinity,"installed":[]}',
    "{",
    "[]",
    '{"installed":{}}',
    '{"installed":[{}]}',
    '{"installed":[{"pluginId":""}]}',
    '{"installed":[{"pluginId":7}]}',
    '{"installed":[{"pluginId":"target@provider"}]}',
    '{"installed":[{"pluginId":"target@provider","version":7}]}',
    '{"installed":[{"pluginId":"target@provider","version":""}]}',
    '{"installed":[{"pluginId":"target@provider","version":"."}]}',
    '{"installed":[{"pluginId":"target@provider","version":".."}]}',
    '{"installed":[{"pluginId":"target@provider","version":"bad/name"}]}',
    '{"installed":[{"pluginId":"target@provider","version":"bad\\\\name"}]}',
    '{"installed":[{"pluginId":"target@provider","version":"bad\\nname"}]}',
    '{"installed":[{"pluginId":"target@provider","version":"bad\\rname"}]}',
    '{"installed":[{"pluginId":"target@provider","version":"bad\\u001bname"}]}',
    '{"installed":[{"pluginId":"target@provider","version":"bad\\u0085name"}]}',
    '{"installed":[{"pluginId":"target@provider","version":"1"},{"pluginId":"target@provider","version":"2"}]}',
    nested(2_000),
  ]) {
    assert.throws(
      () => activePluginVersionFromJson(raw, "target@provider"),
      SafetyError,
      raw,
    );
  }
});
