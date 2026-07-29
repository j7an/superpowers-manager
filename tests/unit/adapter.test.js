// @ts-check
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

/** @type {typeof import("../../src/adapter.js")} */
const { runAdapter } = await import(
  new URL("../../dist/adapter.js", import.meta.url).href
);

const PACKAGE_ROOT = resolve(fileURLToPath(new URL("../../", import.meta.url)));
const COMMIT = "d884ae04edebef577e82ff7c4e143debd0bbec99";
const SOURCE = "https://example.invalid/superpowers.git";

/**
 * Build the upstream root, candidate root, and fallback manifest `build`
 * requires, with a candidate that passes validation.
 * @param {import("node:test").TestContext} t
 */
async function buildWorkspace(t) {
  const base = await mkdtemp(join(tmpdir(), "spw-adapter-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const upstream = join(base, "upstream");
  await mkdir(upstream);
  const candidate = join(base, "candidate");
  await mkdir(join(candidate, ".codex-plugin"), { recursive: true });
  await mkdir(join(candidate, "skills", "brainstorming"), { recursive: true });
  for (const name of ["LICENSE", "README.md", "CODE_OF_CONDUCT.md"]) {
    await writeFile(join(candidate, name), `${name}\n`);
  }
  // Do NOT write `.codex-plugin/plugin.json` or `plugin.template.json` here:
  // `build` generates both from `--fallback-manifest` (`src/adapter.ts:324`,
  // `:381`), so anything written here is overwritten before validation runs.
  await writeFile(
    join(candidate, "skills", "brainstorming", "SKILL.md"),
    "---\nname: brainstorming\ndescription: Fake skill\n---\n# Body\n",
  );
  await writeFile(
    join(candidate, ".superpowers-upstream.json"),
    `${JSON.stringify({
      source: SOURCE,
      requested_ref: "latest-release",
      resolved_ref: "v6.1.1",
      commit: COMMIT,
      upstream_manifest_version: "6.1.1",
    })}\n`,
  );
  // The fallback IS the manifest under validation. The overlay adds only
  // `version` and `skills`
  // (`scripts/adapters/codex/apply-manifest-overlay.py:52-53`), so `name` and
  // `description` must be valid here or the "success" case cannot succeed.
  // `hooks` must be ABSENT: its absence is what forbids `hooks/` for a
  // fallback manifest. Declaring it — even as `{}` — is rejected by
  // `classifyHooks` (`src/hooks.ts:182-183`) before the validator is reached,
  // and by `validate_hooks` if it were.
  const fallback = join(base, "fallback.json");
  await writeFile(
    fallback,
    `${JSON.stringify({
      name: "superpowers",
      description: "Fake superpowers plugin",
    })}\n`,
  );
  return { base, upstream, candidate, fallback };
}

/**
 * @param {{upstream: string, candidate: string, fallback: string}} workspace
 * @param {Record<string, string>} overrides
 */
function buildArgv(workspace, overrides = {}) {
  /** @type {Record<string, string>} */
  const flags = {
    "--upstream-root": workspace.upstream,
    "--candidate-root": workspace.candidate,
    "--requested-ref": "latest-release",
    "--resolved-ref": "v6.1.1",
    "--commit": COMMIT,
    "--manager-version": "6.1.1+manager.d884ae0",
    "--upstream-manifest-version": "6.1.1",
    "--fallback-manifest": workspace.fallback,
    ...overrides,
  };
  return ["build", ...Object.entries(flags).flat()];
}

void test("the adapter replays the validator success line as one stdout record", async (t) => {
  const workspace = await buildWorkspace(t);
  const result = await runAdapter(buildArgv(workspace), { root: PACKAGE_ROOT });
  assert.equal(result.envelope.ok, true, JSON.stringify(result.envelope));
  assert.deepStrictEqual(result.envelope.messages, [
    {
      channel: "stdout",
      text: `generated plugin validation passed: ${workspace.candidate}`,
    },
  ]);
});

void test("the adapter replays a multi-error failure as one record per line", async (t) => {
  const workspace = await buildWorkspace(t);
  await rm(join(workspace.candidate, "LICENSE"));
  await rm(join(workspace.candidate, "README.md"));
  const result = await runAdapter(buildArgv(workspace), { root: PACKAGE_ROOT });
  assert.equal(result.envelope.ok, false);
  assert.deepStrictEqual(result.envelope.messages, [
    { channel: "stderr", text: "Generated plugin validation failed:" },
    { channel: "stderr", text: "- missing required file `LICENSE`" },
    { channel: "stderr", text: "- missing required file `README.md`" },
  ]);
  assert.equal(
    result.envelope.error?.code,
    "generated-plugin-validation-failed",
  );
  assert.equal(
    result.envelope.error?.message,
    "built-in generated plugin validation failed",
  );
});

void test("a split dash-leading ref fails before the validator with a named-flag record", async (t) => {
  const workspace = await buildWorkspace(t);
  const result = await runAdapter(
    buildArgv(workspace, { "--requested-ref": "-foo" }),
    { root: PACKAGE_ROOT },
  );
  assert.equal(result.envelope.ok, false);
  assert.equal(
    result.envelope.error?.code,
    "generated-plugin-validation-failed",
  );
  // Declared exception: argparse wrote usage records here; the pre-call guard
  // writes a differently-worded record naming the rejected flag instead. The
  // failure code and message are unchanged.
  assert.deepStrictEqual(result.envelope.messages, [
    { channel: "stderr", text: "Generated plugin validation failed:" },
    {
      channel: "stderr",
      text: "- validator argument `--requested-ref` has a dash-leading value the argument parser rejects",
    },
  ]);
});

void test("a split dash-leading value on a different flag names that flag", async (t) => {
  const workspace = await buildWorkspace(t);
  const result = await runAdapter(
    buildArgv(workspace, { "--commit": "-deadbeef" }),
    { root: PACKAGE_ROOT },
  );
  assert.equal(result.envelope.ok, false);
  assert.equal(
    result.envelope.error?.code,
    "generated-plugin-validation-failed",
  );
  assert.deepStrictEqual(result.envelope.messages, [
    { channel: "stderr", text: "Generated plugin validation failed:" },
    {
      channel: "stderr",
      text: "- validator argument `--commit` has a dash-leading value the argument parser rejects",
    },
  ]);
});

void test("split dash-leading exceptions still reach the validator", async (t) => {
  for (const value of ["-", "-1", "-1.5", "-.5"]) {
    await t.test(value, async (t) => {
      const workspace = await buildWorkspace(t);
      const result = await runAdapter(
        buildArgv(workspace, { "--requested-ref": value }),
        { root: PACKAGE_ROOT },
      );
      assert.equal(result.envelope.ok, false);
      assert.deepStrictEqual(result.envelope.messages, [
        { channel: "stderr", text: "Generated plugin validation failed:" },
        {
          channel: "stderr",
          text: "- provenance field `requested_ref` does not match expected value",
        },
      ]);
    });
  }
});
