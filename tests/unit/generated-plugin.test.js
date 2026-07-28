// @ts-check
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

/** @type {typeof import("../../src/python-text.js")} */
const { pythonStrip, pythonSplitlines } = await import(
  new URL("../../dist/python-text.js", import.meta.url).href
);

/** @type {typeof import("../../src/generated-plugin.js")} */
const generated = await import(
  new URL("../../dist/generated-plugin.js", import.meta.url).href
);

/** An `OSError`-shaped rejection whose errno is not absence-like. */
function permissionDenied() {
  const error = new Error("permission denied");
  // @ts-expect-error Node attaches errno metadata to fs errors.
  error.code = "EACCES";
  return Promise.reject(error);
}

/**
 * Wrap the real fs deps, overriding chosen calls. Each override receives the
 * path and returns either a falsy value (delegate to the real call) or a
 * promise to return instead.
 * @param {Record<string, (path: unknown, ...rest: unknown[]) => unknown>} overrides
 */
function failingDeps(overrides) {
  /** @type {Record<string, Function>} */
  const deps = {};
  for (const [name, real] of Object.entries(generated.DEFAULT_FS_DEPS)) {
    const override = overrides[name];
    deps[name] = override
      ? (/** @type {unknown[]} */ ...args) =>
          override(args[0], ...args.slice(1)) || real(...args)
      : real;
  }
  return /** @type {import("../../src/generated-plugin.js").GeneratedPluginFsDeps} */ (
    /** @type {unknown} */ (deps)
  );
}

const COMMIT = "d884ae04edebef577e82ff7c4e143debd0bbec99";
const SOURCE = "https://example.invalid/superpowers.git";

/**
 * A minimal candidate tree that passes every check except the ones a test
 * deliberately breaks.
 * @param {import("node:test").TestContext} t
 */
async function candidate(t) {
  const base = await mkdtemp(join(tmpdir(), "spw-generated-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const root = join(base, "plugin");
  await mkdir(join(root, ".codex-plugin"), { recursive: true });
  await mkdir(join(root, "skills", "brainstorming"), { recursive: true });
  for (const name of ["LICENSE", "README.md", "CODE_OF_CONDUCT.md"]) {
    await writeFile(join(root, name), `${name}\n`);
  }
  await writeFile(join(root, ".codex-plugin", "plugin.template.json"), "{}\n");
  await writeFile(
    join(root, ".codex-plugin", "plugin.json"),
    `${JSON.stringify({
      name: "superpowers",
      version: "6.1.1+manager.d884ae0",
      description: "Fake",
      skills: "./skills/",
      hooks: {},
    })}\n`,
  );
  await writeFile(
    join(root, "skills", "brainstorming", "SKILL.md"),
    "---\nname: brainstorming\ndescription: Fake skill\n---\n# Body\n",
  );
  await writeFile(
    join(root, ".superpowers-upstream.json"),
    `${JSON.stringify({
      source: SOURCE,
      requested_ref: "latest-release",
      resolved_ref: "v6.1.1",
      commit: COMMIT,
      upstream_manifest_version: "6.1.1",
    })}\n`,
  );
  return { base, root };
}

/** @param {string} pluginRoot */
function options(pluginRoot) {
  return {
    pluginRoot,
    source: SOURCE,
    requestedRef: "latest-release",
    resolvedRef: "v6.1.1",
    commit: COMMIT,
    manifestVersion: "6.1.1+manager.d884ae0",
    manifestSource: /** @type {const} */ ("upstream"),
    upstreamManifestVersion: "6.1.1",
  };
}

void test("pythonStrip matches CPython str.strip and not JavaScript trim", () => {
  assert.equal(pythonStrip("  value  "), "value");
  assert.equal(pythonStrip("\t\n\v\f\r value \r\f\v\n\t"), "value");
  // Python-only: the C0 separators and NEL.
  assert.equal(pythonStrip("\x1c\x1d\x1e\x1fvalue\x85"), "value");
  // Shared: NBSP, LS, PS, and the Unicode space run.
  assert.equal(pythonStrip("\xa0   　value"), "value");
  // JavaScript-only: trim() removes U+FEFF, Python keeps it.
  assert.equal(pythonStrip("﻿value﻿"), "﻿value﻿");
  // Neither runtime strips these.
  assert.equal(pythonStrip("᠎value​"), "᠎value​");
  assert.equal(pythonStrip("   "), "");
});

void test("pythonSplitlines matches CPython str.splitlines", () => {
  assert.deepStrictEqual(pythonSplitlines(""), []);
  assert.deepStrictEqual(pythonSplitlines("a\n"), ["a"]);
  assert.deepStrictEqual(pythonSplitlines("a\nb"), ["a", "b"]);
  assert.deepStrictEqual(pythonSplitlines("a\r\nb"), ["a", "b"]);
  assert.deepStrictEqual(pythonSplitlines("a\rb"), ["a", "b"]);
  assert.deepStrictEqual(pythonSplitlines("a\n\nb"), ["a", "", "b"]);
  assert.deepStrictEqual(
    pythonSplitlines("a\x0bb\x0cc\x1cd\x1de\x1ef\x85g h i"),
    ["a", "b", "c", "d", "e", "f", "g", "h", "i"],
  );
  // A CRLF must not produce an empty line between the halves.
  assert.deepStrictEqual(pythonSplitlines("---\r\nname: x\r\n---\r\n"), [
    "---",
    "name: x",
    "---",
  ]);
});

void test("FS-GENERATED-RESOLVE-01 filesystem boundary: resolution, cycles, pathname codec, inspection failures", async (t) => {
  await t.test(
    "a `..` returns to the existing prefix and keeps resolving",
    async (t) => {
      const { base, root } = await candidate(t);
      const outside = join(base, "outside");
      await mkdir(outside);
      await symlink(outside, join(root, "escape"), "dir");
      await writeFile(
        join(root, ".codex-plugin", "plugin.json"),
        `${JSON.stringify({
          name: "superpowers",
          version: "6.1.1+manager.d884ae0",
          description: "Fake",
          skills: "./skills/",
          hooks: {},
          apps: "missing/../escape",
        })}\n`,
      );
      const errors = await generated.validateGeneratedPlugin(options(root));
      assert.ok(
        errors.includes("plugin manifest field `apps` escapes the plugin root"),
        `expected an escape rejection, got ${JSON.stringify(errors)}`,
      );
    },
  );

  await t.test(
    "a looping component is left unresolved and resolution continues",
    async (t) => {
      const { base, root } = await candidate(t);
      const outside = join(base, "outside");
      await mkdir(outside);
      await symlink(outside, join(root, "escape"), "dir");
      await symlink("loop", join(root, "loop"));
      await writeFile(
        join(root, ".codex-plugin", "plugin.json"),
        `${JSON.stringify({
          name: "superpowers",
          version: "6.1.1+manager.d884ae0",
          description: "Fake",
          skills: "./skills/",
          hooks: {},
          apps: "loop/../escape",
        })}\n`,
      );
      const errors = await generated.validateGeneratedPlugin(options(root));
      assert.ok(
        errors.includes("plugin manifest field `apps` escapes the plugin root"),
        `frozen contract is the 3.13+ outcome, got ${JSON.stringify(errors)}`,
      );
    },
  );

  await t.test("a terminal live cycle fails closed", async (t) => {
    const { root } = await candidate(t);
    await symlink("loop", join(root, "loop"));
    await writeFile(
      join(root, ".codex-plugin", "plugin.json"),
      `${JSON.stringify({
        name: "superpowers",
        version: "6.1.1+manager.d884ae0",
        description: "Fake",
        skills: "./skills/",
        hooks: {},
        apps: "loop",
      })}\n`,
    );
    const errors = await generated.validateGeneratedPlugin(options(root));
    assert.ok(
      errors.includes("plugin manifest field `apps` could not be resolved"),
      `frozen contract is "could not be resolved", got ${JSON.stringify(errors)}`,
    );
  });

  await t.test(
    "a cycle cancelled before the end is not a live cycle",
    async (t) => {
      // The boundary case for `terminal live cycle` above: resolving `outer`
      // re-enters `loop`, but the link's own `..` pops it and resolution ends on
      // a real directory. A latch meaning "a cycle occurred" would reject this.
      const { root } = await candidate(t);
      await mkdir(join(root, "real"));
      await symlink("loop", join(root, "loop"));
      await symlink("loop/../real", join(root, "outer"), "dir");
      await writeFile(
        join(root, ".codex-plugin", "plugin.json"),
        `${JSON.stringify({
          name: "superpowers",
          version: "6.1.1+manager.d884ae0",
          description: "Fake",
          skills: "./skills/",
          hooks: {},
          apps: "outer",
        })}\n`,
      );
      assert.deepStrictEqual(
        await generated.validateGeneratedPlugin(options(root)),
        [],
      );
    },
  );

  await t.test("the component before a `..` is really lstated", async (t) => {
    // Discriminates component-wise resolution from any lexical collapse
    // upstream of it. Component-wise: `esc` resolves to `<base>/outside`, `..`
    // pops to `<base>`, and `<base>/x` escapes the root. Lexically,
    // `esc/../x` collapses to `<root>/x`, which merely does not exist — a
    // different diagnostic, so the assertion cannot pass by accident.
    const { base, root } = await candidate(t);
    await mkdir(join(base, "outside"));
    await symlink("../outside", join(root, "esc"), "dir");
    await writeFile(
      join(root, ".codex-plugin", "plugin.json"),
      `${JSON.stringify({
        name: "superpowers",
        version: "6.1.1+manager.d884ae0",
        description: "Fake",
        skills: "./skills/",
        hooks: {},
        apps: "esc/../x",
      })}\n`,
    );
    const errors = await generated.validateGeneratedPlugin(options(root));
    assert.ok(
      errors.includes("plugin manifest field `apps` escapes the plugin root"),
      `lexical collapse would report "does not exist"; got ${JSON.stringify(errors)}`,
    );
  });

  await t.test("`~` expands without collapsing a following `..`", async (t) => {
    // Guards `expandUser`. `join(homedir(), …)` collapses `link/..` to `nest`
    // before `resolvePath` ever lstats `link`, so the root becomes
    // `<base>/nest/plugin`, which does not exist. Component-wise: `link`
    // resolves to `<base>/plugin`, `..` pops to `<base>`, and `plugin` returns
    // to the real root. `os.homedir()` reads `$HOME` per call on POSIX, so the
    // override takes effect without reloading the module.
    const { base, root } = await candidate(t);
    await mkdir(join(base, "nest"));
    await symlink(root, join(base, "nest", "link"), "dir");
    const home = process.env.HOME;
    process.env.HOME = base;
    t.after(() => {
      process.env.HOME = home;
    });
    const viaHome = await generated.validateGeneratedPlugin(
      options("~/nest/link/../plugin"),
    );
    const direct = await generated.validateGeneratedPlugin(options(root));
    assert.deepStrictEqual(
      viaHome,
      direct,
      `lexical collapse would address <base>/nest/plugin; got ${JSON.stringify(viaHome)}`,
    );
  });

  await t.test(
    "a repeated non-looping link is not read as a cycle",
    async (t) => {
      const { root } = await candidate(t);
      await mkdir(join(root, "real"));
      await writeFile(join(root, "real", "x"), "x\n");
      await symlink("real", join(root, "rl"), "dir");
      await writeFile(
        join(root, ".codex-plugin", "plugin.json"),
        `${JSON.stringify({
          name: "superpowers",
          version: "6.1.1+manager.d884ae0",
          description: "Fake",
          skills: "./skills/",
          hooks: {},
          apps: "rl/../rl/x",
        })}\n`,
      );
      const errors = await generated.validateGeneratedPlugin(options(root));
      assert.deepStrictEqual(errors, []);
    },
  );

  await t.test("a non-absence lstat error fails closed", async (t) => {
    const { root } = await candidate(t);
    const deps = failingDeps({
      lstat: (path) => String(path).endsWith("/skills") && permissionDenied(),
    });
    const errors = await generated.validateGeneratedPlugin(options(root), deps);
    assert.ok(
      errors.includes("plugin manifest field `skills` could not be resolved"),
      `expected fail-closed resolution, got ${JSON.stringify(errors)}`,
    );
  });

  await t.test("a resolver `readlink` failure rejects (`:114`)", async (t) => {
    const { root } = await candidate(t);
    await mkdir(join(root, "real"));
    await symlink("real", join(root, "rl"), "dir");
    await writeFile(
      join(root, ".codex-plugin", "plugin.json"),
      `${JSON.stringify({
        name: "superpowers",
        version: "6.1.1+manager.d884ae0",
        description: "Fake",
        skills: "./skills/",
        hooks: {},
        apps: "rl",
      })}\n`,
    );
    const deps = failingDeps({
      readlink: (path) => String(path).endsWith("/rl") && permissionDenied(),
    });
    const errors = await generated.validateGeneratedPlugin(options(root), deps);
    assert.ok(
      errors.includes("plugin manifest field `apps` could not be resolved"),
      errors.join("|"),
    );
  });

  await t.test(
    "a plugin-root resolution failure rejects (`:425`)",
    async (t) => {
      const { root } = await candidate(t);
      // Matched by trailing component, not by equality with `root`: on macOS
      // `tmpdir()` sits under `/var`, a symlink to `/private/var`, so by the
      // time the resolver reaches the last component `current` no longer has
      // the `root` string as its prefix. `plugin` is the only component of the
      // candidate tree with this name.
      const deps = failingDeps({
        lstat: (path) => String(path).endsWith("/plugin") && permissionDenied(),
      });
      const errors = await generated.validateGeneratedPlugin(
        options(root),
        deps,
      );
      // `:423-426` returns early, so this is the whole list.
      assert.deepStrictEqual(errors, ["plugin root could not be resolved"]);
    },
  );

  await t.test(
    "an unpaired surrogate in a manifest path fails during resolution",
    async (t) => {
      const { root } = await candidate(t);
      await writeFile(
        join(root, ".codex-plugin", "plugin.json"),
        `${JSON.stringify({
          name: "superpowers",
          version: "6.1.1+manager.d884ae0",
          description: "Fake",
          skills: "./skills/",
          hooks: {},
          apps: "bad\ud800name",
        })}\n`,
      );
      const errors = await generated.validateGeneratedPlugin(options(root));
      assert.ok(
        errors.includes("plugin manifest field `apps` could not be resolved"),
        `expected :114, not the :129 inspection text, got ${JSON.stringify(errors)}`,
      );
    },
  );
});

void test("manifest validation reproduces the Python diagnostics", async (t) => {
  const { root } = await candidate(t);
  await writeFile(
    join(root, ".codex-plugin", "plugin.json"),
    `${JSON.stringify({
      name: "renamed",
      version: "not-semver",
      description: "   ",
      skills: "./elsewhere/",
      hooks: {},
    })}\n`,
  );
  const errors = await generated.validateGeneratedPlugin(options(root));
  assert.deepStrictEqual(errors, [
    "plugin manifest field `name` must equal `superpowers`",
    "plugin manifest field `version` must equal expected version",
    "plugin manifest field `version` must be SemVer 2.0.0",
    "plugin manifest field `description` must be non-empty",
    "plugin manifest field `skills` must equal `./skills/`",
    "plugin manifest field `skills` target `./elsewhere/` does not exist",
  ]);
});

void test("manifest JSON failure classes stay distinct", async (t) => {
  const { root } = await candidate(t);
  const manifest = join(root, ".codex-plugin", "plugin.json");

  await writeFile(manifest, Buffer.from([0x7b, 0xff, 0x7d]));
  let errors = await generated.validateGeneratedPlugin(options(root));
  assert.ok(
    errors.includes("plugin manifest is unreadable UTF-8"),
    errors.join("|"),
  );

  await writeFile(manifest, "{ not json\n");
  errors = await generated.validateGeneratedPlugin(options(root));
  assert.ok(
    errors.includes("plugin manifest must contain valid JSON"),
    errors.join("|"),
  );

  await writeFile(manifest, `${"[".repeat(257)}${"]".repeat(257)}\n`);
  errors = await generated.validateGeneratedPlugin(options(root));
  assert.ok(
    errors.includes("plugin manifest exceeds maximum JSON nesting"),
    errors.join("|"),
  );

  await writeFile(manifest, `${"[".repeat(256)}${"]".repeat(256)}\n`);
  errors = await generated.validateGeneratedPlugin(options(root));
  assert.ok(
    errors.includes("plugin manifest must contain a JSON object"),
    `depth 256 must parse, got ${errors.join("|")}`,
  );
});

void test("a manifest read error maps to the unreadable-UTF-8 diagnostic", async (t) => {
  const { root } = await candidate(t);
  const deps = failingDeps({
    readFile: (path) =>
      String(path).endsWith("plugin.json") && permissionDenied(),
  });
  const errors = await generated.validateGeneratedPlugin(options(root), deps);
  assert.ok(
    errors.includes("plugin manifest is unreadable UTF-8"),
    errors.join("|"),
  );
});

void test("a non-absence probe on the manifest itself fails closed", async (t) => {
  const { root } = await candidate(t);
  const deps = failingDeps({
    stat: (path) => String(path).endsWith("plugin.json") && permissionDenied(),
  });
  const errors = await generated.validateGeneratedPlugin(options(root), deps);
  assert.ok(
    errors.includes(
      "required file `.codex-plugin/plugin.json` could not be inspected",
    ),
    errors.join("|"),
  );
});

void test("a manifest path whose existence probe fails is reported", async (t) => {
  // `:122`/`:124`/`:126` — the exists/is_dir/is_file probes inside
  // validate_local_path. `lstat` still succeeds, so resolution completes and
  // this is distinct from the `:114` resolution failure above.
  const { root } = await candidate(t);
  const deps = failingDeps({
    stat: (path) => String(path).endsWith("/skills") && permissionDenied(),
  });
  const errors = await generated.validateGeneratedPlugin(options(root), deps);
  assert.ok(
    errors.includes(
      "plugin manifest field `skills` target `./skills/` could not be inspected",
    ),
    errors.join("|"),
  );
});
