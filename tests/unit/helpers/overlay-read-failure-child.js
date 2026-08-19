// @ts-check
// Child process for the read-failure case in ../adapter.test.js.
//
// Simulating a read failure at the overlay's own `readFile` call (and only
// there — not at the pre-existing hook-classification read of the same
// path) requires Node's module-mocking API, which is gated behind
// `--experimental-test-module-mocks` and only reachable through a running
// `node:test` TestContext (`t.mock`). The shared suite runner
// (`tests/run-node-suites.js`) does not set that flag for the whole suite,
// so this case runs as its own `node --experimental-test-module-mocks
// --test` child process, spawned by the parent test.
//
// The static import below runs before any mock is registered, so
// `dist/hooks.js` (imported transitively by `dist/adapter.js`) captures a
// real, unmocked binding of `node:fs/promises`. The mock is registered
// after that, and only a freshly re-imported (cache-busted) copy of
// `dist/adapter.js` observes it — so hook classification's manifest read
// still hits the real filesystem and succeeds, while the overlay's own
// `readFile` call (added in this PR) observes the mocked rejection. This is
// a module-graph-identity effect, not a timing race.
import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readFile as realReadFile,
  rm,
  writeFile,
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

void test("overlay read failure child", async (t) => {
  const base = await mkdtemp(join(tmpdir(), "spw-overlay-read-fail-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const upstream = join(base, "upstream");
  await mkdir(upstream);
  const candidate = join(base, "candidate");
  await mkdir(join(candidate, ".codex-plugin"), { recursive: true });
  await mkdir(join(candidate, "skills", "brainstorming"), { recursive: true });
  for (const name of ["LICENSE", "README.md", "CODE_OF_CONDUCT.md"]) {
    await writeFile(join(candidate, name), `${name}\n`);
  }
  await writeFile(
    join(candidate, "skills", "brainstorming", "SKILL.md"),
    "---\nname: brainstorming\ndescription: Fake skill\n---\n# Body\n",
  );
  await writeFile(
    join(candidate, ".superpowers-upstream.json"),
    `${JSON.stringify({
      source: "https://example.invalid/superpowers.git",
      requested_ref: "latest-release",
      resolved_ref: "v6.1.1",
      commit: COMMIT,
      upstream_manifest_version: "6.1.1",
    })}\n`,
  );
  const fallback = join(base, "fallback.json");
  await writeFile(
    fallback,
    `${JSON.stringify({
      name: "superpowers",
      description: "Fake superpowers plugin",
    })}\n`,
  );
  const candidateManifest = join(candidate, ".codex-plugin/plugin.json");

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
          const error = new Error(
            `ENOENT: no such file or directory, open '${path}'`,
          );
          // @ts-expect-error - synthetic OSError-shaped rejection
          error.code = "ENOENT";
          // @ts-expect-error - synthetic OSError-shaped rejection
          error.errno = -2;
          throw error;
        }
        return realReadFile(path, ...rest);
      },
    },
  });

  /** @type {typeof import("../../../src/adapter.js")} */
  const { runAdapter } = await import(
    new URL(
      `../../../dist/adapter.js?overlay-read-failure-child=${Date.now()}`,
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
  // Sanity check inside the child too, so a broken mock fails loudly here
  // rather than producing a confusing assertion in the parent.
  assert.equal(result.outcome.ok, false, JSON.stringify(result.outcome));
  process.stdout.write(`RESULT_JSON:${JSON.stringify(result.outcome)}\n`);
});
