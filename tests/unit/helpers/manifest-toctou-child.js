// @ts-check
// Child process for the TOCTOU case in ../adapter.test.js.
//
// This drives the real interleaving: `readManifest` (`src/hooks.ts:113::readManifest`) reads
// the candidate manifest once, fatally, for hook classification; the
// overlay's own read (src/adapter.ts, ~:360) reads the same path again
// later. Between those two reads, this test replaces the file's bytes on
// disk with a genuinely invalid UTF-8 sequence, so the second read observes
// different — and corrupt — bytes than the first one validated.
//
// Getting a real filesystem mutation between the two reads (rather than a
// mocked rejection) needs Node's experimental module-mocking API, gated
// behind `--experimental-test-module-mocks` and only reachable from a
// running `node:test` TestContext (`t.mock`). That is why this runs as its
// own child process, spawned by the parent test, exactly like
// `overlay-read-failure-child.js`.
import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readFile as realReadFile,
  rm,
  writeFile as realWriteFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const PACKAGE_ROOT = resolve(
  fileURLToPath(new URL("../../../", import.meta.url)),
);
const COMMIT = "d884ae04edebef577e82ff7c4e143debd0bbec99";

await import(new URL("../../../dist/adapter.js", import.meta.url).href);

void test("manifest TOCTOU child", async (t) => {
  const base = await mkdtemp(join(tmpdir(), "spw-manifest-toctou-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const upstream = join(base, "upstream");
  await mkdir(upstream);
  const candidate = join(base, "candidate");
  await mkdir(join(candidate, ".codex-plugin"), { recursive: true });
  await mkdir(join(candidate, "skills", "brainstorming"), { recursive: true });
  for (const name of ["LICENSE", "README.md", "CODE_OF_CONDUCT.md"]) {
    await realWriteFile(join(candidate, name), `${name}\n`);
  }
  await realWriteFile(
    join(candidate, "skills", "brainstorming", "SKILL.md"),
    "---\nname: brainstorming\ndescription: Fake skill\n---\n# Body\n",
  );
  await realWriteFile(
    join(candidate, ".superpowers-upstream.json"),
    `${JSON.stringify({
      source: "https://example.invalid/superpowers.git",
      requested_ref: "latest-release",
      resolved_ref: "v6.1.1",
      commit: COMMIT,
      upstream_manifest_version: "6.1.1",
    })}\n`,
  );

  // Valid at read-1 time: no `hooks` key (fallback manifests must not
  // declare one — classifyHooks enforces this), and "zz" is a placeholder
  // pair we corrupt one byte of below.
  const validText = `${JSON.stringify({
    name: "superpowers",
    description: "zz",
  })}\n`;
  const fallback = join(base, "fallback.json");
  await realWriteFile(fallback, validText);

  const candidateManifest = join(candidate, ".codex-plugin/plugin.json");

  // A lone 0xff is never a valid UTF-8 lead byte. Placed inside the
  // `description` string, the surrounding JSON stays syntactically valid
  // under a *lenient* decode (it just contains one U+FFFD), which is exactly
  // the shape that let the pre-fix bug parse, overlay, and write back a
  // corrupted manifest while reporting success.
  const corrupted = Buffer.from(validText, "utf8");
  const corruptIndex = validText.indexOf("zz");
  assert.ok(corruptIndex >= 0, "fixture must contain the placeholder");
  corrupted[corruptIndex] = 0xff;

  let readCount = 0;
  const real = await import("node:fs/promises");
  t.mock.module("node:fs/promises", {
    namedExports: {
      ...real,
      /**
       * @param {string} path
       * @param {...any} rest
       */
      readFile: async (path, ...rest) => {
        if (path === candidateManifest) {
          readCount += 1;
          // The static import below (before this mock is registered) already
          // gave `dist/hooks.js` a real, unmocked binding of
          // `node:fs/promises` — exactly the module-graph-identity effect
          // documented in `overlay-read-failure-child.js`. So by the time
          // this mocked `readFile` is invoked at all for this path, hook
          // classification's real read-1 (`src/hooks.ts:113::readManifest`) has already run
          // to completion against the still-valid bytes; this call is
          // read-2, the overlay's own read (src/adapter.ts). Corrupt the
          // *real* file on disk immediately before delegating to the real
          // `readFile`, so read-2 genuinely observes different bytes than
          // read-1 validated — not a mocked rejection.
          await realWriteFile(candidateManifest, corrupted);
        }
        return realReadFile(path, ...rest);
      },
    },
  });

  /** @type {typeof import("../../../src/adapter.js")} */
  const { runAdapter } = await import(
    new URL(
      `../../../dist/adapter.js?manifest-toctou-child=${Date.now()}`,
      import.meta.url,
    ).href
  );
  const argv = [
    "build",
    "--upstream-root",
    upstream,
    "--candidate-root",
    candidate,
    "--requested-ref",
    "latest-release",
    "--resolved-ref",
    "v6.1.1",
    "--commit",
    COMMIT,
    "--manager-version",
    "6.1.1+manager.d884ae0",
    "--upstream-manifest-version",
    "6.1.1",
    "--fallback-manifest",
    fallback,
  ];
  const result = await runAdapter(argv, { root: PACKAGE_ROOT });
  // Only the overlay's own read (src/adapter.ts) is observable here; hook
  // classification's read bypasses this mock entirely (see the comment
  // above). Exactly one call confirms the corruption above landed on the
  // read this test targets, and not zero (a broken fixture) or more than
  // one (an unexpected extra read of this path).
  assert.equal(readCount, 1, "expected exactly one intercepted manifest read");
  // Sanity check inside the child too, so a broken fixture fails loudly here
  // rather than producing a confusing assertion in the parent.
  assert.equal(result.outcome.ok, false, JSON.stringify(result.outcome));

  const finalBytes = await realReadFile(candidateManifest);
  process.stdout.write(`RESULT_JSON:${JSON.stringify(result.outcome)}\n`);
  process.stdout.write(
    `MANIFEST_BYTES_BASE64:${finalBytes.toString("base64")}\n`,
  );
});
