import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  mkdtemp,
  mkdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { pythonStrip, pythonSplitlines } from "../../src/python-text.ts";

import * as generated from "../../src/generated-plugin.ts";

import { isAcceptedSplitValue } from "../../src/validate-generated-plugin-cli.ts";

/** An `OSError`-shaped rejection whose errno is not absence-like. */
function permissionDenied() {
  const error = new Error("permission denied");
  // @ts-expect-error Node attaches errno metadata to fs errors.
  error.code = "EACCES";
  return Promise.reject(error);
}

/** An absence-like rejection: the site's missing-path behavior must apply. */
function notFound() {
  const error = new Error("no such file or directory");
  // @ts-expect-error Node attaches errno metadata to fs errors.
  error.code = "ENOENT";
  return Promise.reject(error);
}

/**
 * Wrap the real fs deps, overriding chosen calls. Each override receives the
 * path and returns either a falsy value (delegate to the real call) or a
 * promise to return instead.
 */
function failingDeps(
  overrides: Record<string, (path: unknown, ...rest: unknown[]) => unknown>,
) {
  const deps: Record<string, Function> = {};
  for (const [name, real] of Object.entries(generated.DEFAULT_FS_DEPS)) {
    const override = overrides[name];
    deps[name] = override
      ? (...args: unknown[]) =>
          override(args[0], ...args.slice(1)) || real(...args)
      : real;
  }
  return deps as unknown as import("../../src/generated-plugin.ts").GeneratedPluginFsDeps;
}

const COMMIT = "d884ae04edebef577e82ff7c4e143debd0bbec99";
const SOURCE = "https://example.invalid/superpowers.git";

/**
 * A minimal candidate tree that passes every check except the ones a test
 * deliberately breaks.
 */
async function candidate(t: import("node:test").TestContext) {
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

function options(pluginRoot: string) {
  return {
    pluginRoot,
    source: SOURCE,
    requestedRef: "latest-release",
    resolvedRef: "v6.1.1",
    commit: COMMIT,
    manifestVersion: "6.1.1+manager.d884ae0",
    manifestSource: "upstream" as const,
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
      // `src/generated-plugin.ts:918-924::pluginRoot = await resolvePath(expandUser(options.pluginRoot), deps` returns early, so this is the whole list.
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
  // `src/generated-plugin.ts:223::await deps.stat(path)`/`src/generated-plugin.ts:224::info.isDirectory()`/`src/generated-plugin.ts:225::info.isFile()` — the exists/is_dir/is_file probes inside
  // validate_local_path. `lstat` still succeeds, so resolution completes and
  // this is distinct from the `src/generated-plugin.ts:335::target = await resolvePath(` resolution failure above.
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

void test("tree validation reproduces the Python diagnostics", async (t) => {
  const { root } = await candidate(t);
  await rm(join(root, "LICENSE"));
  await rm(join(root, "skills", "brainstorming", "SKILL.md"));
  const errors = await generated.validateGeneratedPlugin(options(root));
  assert.deepStrictEqual(errors, [
    "missing required file `LICENSE`",
    "skill `brainstorming` is missing `SKILL.md`",
  ]);
});

void test("skills are enumerated in code-point order", async (t) => {
  const { root } = await candidate(t);
  await rm(join(root, "skills", "brainstorming"), { recursive: true });
  // U+FFFD sorts after U+10000 by code point and before it by UTF-16 code unit.
  for (const name of ["�-skill", "\u{10000}-skill"]) {
    await mkdir(join(root, "skills", name));
  }
  const errors = await generated.validateGeneratedPlugin(options(root));
  assert.deepStrictEqual(errors, [
    "skill `�-skill` is missing `SKILL.md`",
    "skill `\u{10000}-skill` is missing `SKILL.md`",
  ]);
});

void test("a broken hooks symlink counts as present under a forbid policy", async (t) => {
  const { root } = await candidate(t);
  await symlink("nowhere", join(root, "hooks"), "dir");
  const errors = await generated.validateGeneratedPlugin(options(root));
  assert.ok(
    errors.includes(
      "generated plugin must not contain `hooks/` for this manifest source",
    ),
    errors.join("|"),
  );
});

void test("each tree inspection site fails closed with its frozen string", async (t) => {
  const cases: [string, string, "stat" | "lstat"][] = [
    ["/LICENSE", "required file `LICENSE` could not be inspected", "stat"],
    [
      "/hooks",
      "generated plugin path `hooks/` could not be inspected",
      "lstat",
    ],
    ["/skills", "required directory `skills/` could not be inspected", "stat"],
    [
      "/skills/brainstorming/SKILL.md",
      "skill `brainstorming` `SKILL.md` could not be inspected",
      "stat",
    ],
    [
      "/.superpowers-upstream.json",
      "required file `.superpowers-upstream.json` could not be inspected",
      "stat",
    ],
  ];
  for (const [suffix, expected, call] of cases) {
    await t.test(expected, async (t) => {
      const { root } = await candidate(t);
      const deps = failingDeps({
        [call]: (path) => String(path).endsWith(suffix) && permissionDenied(),
      });
      const errors = await generated.validateGeneratedPlugin(
        options(root),
        deps,
      );
      assert.ok(errors.includes(expected), errors.join("|"));
    });
  }
});

/**
 * The `candidate` fixture declares `hooks: {}`, which forbids `hooks/`. The
 * hook-subtree sites are only reachable under a `default` policy: an upstream
 * manifest with no `hooks` key at all.
 */
async function candidateWithHooks(t: import("node:test").TestContext) {
  const { base, root } = await candidate(t);
  await writeFile(
    join(root, ".codex-plugin", "plugin.json"),
    `${JSON.stringify({
      name: "superpowers",
      version: "6.1.1+manager.d884ae0",
      description: "Fake",
      skills: "./skills/",
    })}\n`,
  );
  await mkdir(join(root, "hooks", "nested"), { recursive: true });
  await writeFile(join(root, "hooks", "hooks.json"), "{}\n");
  return { base, root };
}

void test("the hooks.json probe fails closed with its frozen string", async (t) => {
  const { root } = await candidateWithHooks(t);
  const deps = failingDeps({
    stat: (path) =>
      String(path).endsWith("/hooks/hooks.json") && permissionDenied(),
  });
  const errors = await generated.validateGeneratedPlugin(options(root), deps);
  assert.ok(
    errors.includes("`hooks/hooks.json` could not be inspected"),
    errors.join("|"),
  );
});

void test("each hook subtree site fails closed with its Python string", async (t) => {
  // `src/generated-plugin.ts:667::isLink = (await inspectLink(path, deps)) === "symlink"` reaches `src/generated-plugin.ts:672-675::if (!isLink) return true;`, the path-bearing symlink text it shares with `src/generated-plugin.ts:679::await deps.readlink(path, { encoding: "buffer" })`.
  // Only `src/generated-plugin.ts:711::resolvedDirectory = await resolvePath(directory, deps, { strict: true })`/`src/generated-plugin.ts:721::children = await listDirectory(directory, deps)`/`src/generated-plugin.ts:730::(await inspectPath(child, deps, true)) === "directory"` share the subtree string. Each site is asserted
  // separately so a site that stops reporting is still caught.
  /**
   */
  const cases: [
    string,
    Record<string, (path: unknown) => unknown>,
    (realRoot: string) => string,
  ][] = [
    [
      "the symlink probe (`:300`)",
      {
        lstat: (path) =>
          String(path).endsWith("/hooks/nested") && permissionDenied(),
      },
      (realRoot) =>
        `generated hook symlink could not be inspected: ${join(realRoot, "hooks", "nested")}`,
    ],
    [
      "the enumeration call (`:332`)",
      {
        readdir: (path) =>
          String(path).endsWith("/hooks") && permissionDenied(),
      },
      () => "generated hook subtree could not be inspected",
    ],
    [
      "the entry type probe (`:340`)",
      {
        stat: (path) =>
          String(path).endsWith("/hooks/nested") && permissionDenied(),
      },
      () => "generated hook subtree could not be inspected",
    ],
  ];
  for (const [label, overrides, expected] of cases) {
    await t.test(label, async (t) => {
      const { root } = await candidateWithHooks(t);
      // The validator addresses the tree through the resolved plugin root, so
      // a path-bearing diagnostic never carries the `tmpdir()` spelling.
      const realRoot = await realpath(root);
      const errors = await generated.validateGeneratedPlugin(
        options(root),
        failingDeps(overrides),
      );
      assert.ok(errors.includes(expected(realRoot)), errors.join("|"));
    });
  }
});

void test("each hook subtree resolution context fails closed", async (t) => {
  await t.test("the strict plugin-root resolve (`:296`)", async (t) => {
    const { root } = await candidateWithHooks(t);
    // Strict resolution of the root happens only inside validate_hook_subtree;
    // the non-strict resolve at `src/generated-plugin.ts:918-924::pluginRoot = await resolvePath(expandUser(options.pluginRoot), deps` has already succeeded by then, so an
    // absence-shaped failure is what separates the two. Matched by trailing
    // component rather than by equality with `root`: on macOS `tmpdir()` sits
    // under `/var`, a symlink to `/private/var`, so the resolved candidate root
    // never has the `root` string as a prefix.
    const deps = failingDeps({
      lstat: (path) => String(path).endsWith("/plugin") && notFound(),
    });
    const errors = await generated.validateGeneratedPlugin(options(root), deps);
    assert.ok(
      errors.includes("generated plugin root could not be resolved"),
      errors.join("|"),
    );
  });

  await t.test("the hook symlink's strict resolve (`:311`)", async (t) => {
    const { root } = await candidateWithHooks(t);
    await symlink("hooks.json", join(root, "hooks", "link"));
    // The validator addresses the tree through the resolved plugin root, so the
    // diagnostic carries the realpath, not the `tmpdir()` spelling.
    const link = join(await realpath(root), "hooks", "link");
    const deps = failingDeps({
      lstat: (path) => String(path).endsWith("/hooks/hooks.json") && notFound(),
    });
    const errors = await generated.validateGeneratedPlugin(options(root), deps);
    assert.ok(
      errors.includes(`generated hook symlink escapes or is broken: ${link}`),
      errors.join("|"),
    );
  });

  await t.test("the subtree directory's strict resolve (`:326`)", async (t) => {
    const { root } = await candidateWithHooks(t);
    const deps = failingDeps({
      lstat: (path) => String(path).endsWith("/hooks/nested") && notFound(),
    });
    const errors = await generated.validateGeneratedPlugin(options(root), deps);
    assert.ok(
      errors.includes("generated hook subtree could not be inspected"),
      errors.join("|"),
    );
  });
});

void test("a hook symlink whose readlink fails is reported, not skipped", async (t) => {
  const { root } = await candidateWithHooks(t);
  await symlink("hooks.json", join(root, "hooks", "link"));
  const link = join(await realpath(root), "hooks", "link");
  const deps = failingDeps({
    readlink: (path) =>
      String(path).endsWith("/hooks/link") && permissionDenied(),
  });
  const errors = await generated.validateGeneratedPlugin(options(root), deps);
  assert.ok(
    errors.includes(`generated hook symlink could not be inspected: ${link}`),
    errors.join("|"),
  );
});

void test("a SKILL.md read error maps to the unreadable-UTF-8 diagnostic", async (t) => {
  const { root } = await candidate(t);
  const deps = failingDeps({
    readFile: (path) => String(path).endsWith("SKILL.md") && permissionDenied(),
  });
  const errors = await generated.validateGeneratedPlugin(options(root), deps);
  assert.ok(
    errors.includes("skill `brainstorming` has unreadable UTF-8 `SKILL.md`"),
    errors.join("|"),
  );
});

void test("a skill entry type-probe failure fails closed", async (t) => {
  const { root } = await candidate(t);
  // `src/generated-plugin.ts:824::await inspectPath(posix.join(skillsRoot, name), deps, true` — an entry that survives enumeration but cannot be type-probed.
  const deps = failingDeps({
    stat: (path) =>
      String(path).endsWith("/skills/brainstorming") && permissionDenied(),
  });
  const errors = await generated.validateGeneratedPlugin(options(root), deps);
  assert.ok(
    errors.includes("skills directory could not be enumerated"),
    errors.join("|"),
  );
});

void test("skill enumeration failure is reported deterministically", async (t) => {
  const { root } = await candidate(t);
  const deps = failingDeps({
    readdir: (path) => String(path).endsWith("/skills") && permissionDenied(),
  });
  const errors = await generated.validateGeneratedPlugin(options(root), deps);
  assert.ok(
    errors.includes("skills directory could not be enumerated"),
    errors.join("|"),
  );
});

void test("an undecodable skills entry fails closed rather than vanishing", async (t) => {
  const { root } = await candidate(t);
  const deps = failingDeps({
    readdir: (path) =>
      String(path).endsWith("/skills") &&
      Promise.resolve([Buffer.from([0xff, 0x2d, 0x78])]),
  });
  const errors = await generated.validateGeneratedPlugin(options(root), deps);
  assert.ok(
    errors.includes("skills directory could not be enumerated"),
    errors.join("|"),
  );
});

void test("frontmatter parsing uses CPython line splitting", async (t) => {
  const { root } = await candidate(t);
  const skill = join(root, "skills", "brainstorming", "SKILL.md");
  await writeFile(
    skill,
    "---\r\nname: x\r\ndescription: y\r\n---\r\n# Body\r\n",
  );
  assert.deepStrictEqual(
    await generated.validateGeneratedPlugin(options(root)),
    [],
  );

  await writeFile(skill, "﻿---\nname: x\ndescription: y\n---\n");
  assert.ok(
    (await generated.validateGeneratedPlugin(options(root))).includes(
      "skill `brainstorming` must start with `---`",
    ),
  );

  await writeFile(skill, Buffer.from([0xff, 0x0a]));
  assert.ok(
    (await generated.validateGeneratedPlugin(options(root))).includes(
      "skill `brainstorming` has unreadable UTF-8 `SKILL.md`",
    ),
  );

  await writeFile(skill, "---\nname:\ndescription: y\n---\n");
  assert.ok(
    (await generated.validateGeneratedPlugin(options(root))).includes(
      "skill `brainstorming` frontmatter field `name` must be non-empty",
    ),
  );

  await writeFile(skill, "---\nname:\x1f\ndescription: y\n---\n");
  assert.ok(
    (await generated.validateGeneratedPlugin(options(root))).includes(
      "skill `brainstorming` frontmatter field `name` must be non-empty",
    ),
    "U+001F is the one strip character that discriminates here",
  );
});

void test("enumeration rejects on absence rather than reading it as empty", async (t) => {
  // The absence half of the inspection-failure rule stops at the existence and
  // type probes: a `skills/` that vanishes between its `is_dir` probe and its
  // enumeration is unenumerable, not an empty skills directory.
  const { root } = await candidate(t);
  const deps = failingDeps({
    readdir: (path) => String(path).endsWith("/skills") && notFound(),
  });
  const errors = await generated.validateGeneratedPlugin(options(root), deps);
  assert.ok(
    errors.includes("skills directory could not be enumerated"),
    errors.join("|"),
  );
});

void test("provenance validation reproduces the Python diagnostics", async (t) => {
  const { root } = await candidate(t);
  await writeFile(
    join(root, ".superpowers-upstream.json"),
    `${JSON.stringify({
      source: "https://other.invalid/x.git",
      requested_ref: "latest-release",
      resolved_ref: "v6.1.1",
      commit: "NOTACOMMIT",
      upstream_manifest_version: "6.1.1",
      extra: 1,
    })}\n`,
  );
  const errors = await generated.validateGeneratedPlugin({
    ...options(root),
    commit: "NOTACOMMIT",
  });
  assert.deepStrictEqual(errors, [
    "provenance keys do not match the manager-owned contract",
    "provenance field `source` does not match expected value",
    "commit must be 40 lowercase hexadecimal characters",
  ]);
});

void test("the full error list is ordered manifest, tree, provenance", async (t) => {
  const { root } = await candidate(t);
  await writeFile(
    join(root, ".codex-plugin", "plugin.json"),
    `${JSON.stringify({
      name: "renamed",
      version: "6.1.1+manager.d884ae0",
      description: "Fake",
      skills: "./skills/",
      hooks: {},
    })}\n`,
  );
  await rm(join(root, "README.md"));
  await writeFile(
    join(root, ".superpowers-upstream.json"),
    `${JSON.stringify({
      source: SOURCE,
      requested_ref: "latest-release",
      resolved_ref: "v6.1.0",
      commit: COMMIT,
      upstream_manifest_version: "6.1.1",
    })}\n`,
  );
  assert.deepStrictEqual(
    await generated.validateGeneratedPlugin(options(root)),
    [
      "plugin manifest field `name` must equal `superpowers`",
      "missing required file `README.md`",
      "provenance field `resolved_ref` does not match expected value",
    ],
  );
});

void test("the provenance probe fails closed with its frozen string", async (t) => {
  // `src/generated-plugin.ts:879::provenance file` — distinct from the required-files probe of the same path, which
  // reports `required file ... could not be inspected` from Task 3.
  const { root } = await candidate(t);
  const deps = failingDeps({
    stat: (path) =>
      String(path).endsWith("/.superpowers-upstream.json") &&
      permissionDenied(),
  });
  const errors = await generated.validateGeneratedPlugin(options(root), deps);
  assert.ok(
    errors.includes(
      "provenance file `.superpowers-upstream.json` could not be inspected",
    ),
    errors.join("|"),
  );
});

void test("a provenance read error maps to the unreadable-UTF-8 diagnostic", async (t) => {
  const { root } = await candidate(t);
  const deps = failingDeps({
    readFile: (path) =>
      String(path).endsWith("/.superpowers-upstream.json") &&
      permissionDenied(),
  });
  const errors = await generated.validateGeneratedPlugin(options(root), deps);
  assert.ok(
    errors.includes("provenance is unreadable UTF-8"),
    errors.join("|"),
  );
});

const execFileAsync = promisify(execFile);
const CLI = fileURLToPath(
  new URL("../../src/validate-generated-plugin-cli.ts", import.meta.url),
);

async function runCli(
  argv: string[],
): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [
      CLI,
      ...argv,
    ]);
    return { code: 0, stdout, stderr };
  } catch (error) {
    const failure = error as { code?: number; stdout: string; stderr: string };
    return {
      code: failure.code ?? 1,
      stdout: failure.stdout,
      stderr: failure.stderr,
    };
  }
}

function cliArgv(pluginRoot: string) {
  return [
    "--plugin-root",
    pluginRoot,
    "--source",
    SOURCE,
    "--requested-ref",
    "latest-release",
    "--resolved-ref",
    "v6.1.1",
    "--commit",
    COMMIT,
    "--manifest-version",
    "6.1.1+manager.d884ae0",
    "--manifest-source",
    "upstream",
    "--upstream-manifest-version",
    "6.1.1",
  ];
}

void test("CLI exit, stdout and stderr are exact", async (t) => {
  const { root } = await candidate(t);

  assert.deepStrictEqual(await runCli(cliArgv(root)), {
    code: 0,
    stdout: `generated plugin validation passed: ${root}\n`,
    stderr: "",
  });

  // The raw argument is echoed, not the resolved path.
  assert.equal(
    (await runCli(cliArgv(`${root}/.`))).stdout,
    `generated plugin validation passed: ${root}/.\n`,
  );

  await rm(join(root, "README.md"));
  await rm(join(root, "LICENSE"));
  assert.deepStrictEqual(await runCli(cliArgv(root)), {
    code: 1,
    stdout: "",
    stderr:
      "Generated plugin validation failed:\n" +
      "- missing required file `LICENSE`\n" +
      "- missing required file `README.md`\n",
  });
});

void test("CLI accepts a reversed flag order and the equals form", async (t) => {
  const { root } = await candidate(t);
  const reversed = [
    "--upstream-manifest-version",
    "6.1.1",
    "--manifest-source",
    "upstream",
    "--manifest-version",
    "6.1.1+manager.d884ae0",
    "--commit",
    COMMIT,
    "--resolved-ref",
    "v6.1.1",
    "--requested-ref",
    "latest-release",
    "--source",
    SOURCE,
    "--plugin-root",
    root,
  ];
  assert.deepStrictEqual(await runCli(reversed), {
    code: 0,
    stdout: `generated plugin validation passed: ${root}\n`,
    stderr: "",
  });

  // Attached form carrying a dash-leading value: production relies on this.
  const attached = [
    `--plugin-root=${root}`,
    "--source=-upstream",
    "--requested-ref=latest-release",
    "--resolved-ref=v6.1.1",
    `--commit=${COMMIT}`,
    "--manifest-version=6.1.1+manager.d884ae0",
    "--manifest-source=upstream",
    "--upstream-manifest-version=6.1.1",
  ];
  const result = await runCli(attached);
  assert.equal(result.code, 1, result.stderr);
  assert.equal(
    result.stderr,
    "Generated plugin validation failed:\n" +
      "- provenance field `source` does not match expected value\n",
    "the attached dash-leading value must reach validation, not usage",
  );
});

void test("CLI usage rejections exit 2 with an empty stdout and no traceback", async (t) => {
  const { root } = await candidate(t);

  for (const [argv, flag] of [
    [
      cliArgv(root).map((token) =>
        token === "latest-release" ? "-foo" : token,
      ),
      "--requested-ref",
    ],
    [
      cliArgv(root).map((token) => (token === "upstream" ? "sideways" : token)),
      "--manifest-source",
    ],
    [cliArgv(`${root}/�`), "--plugin-root"],
  ] as [string[], string][]) {
    const result = await runCli(argv);
    assert.equal(result.code, 2, `${flag}: ${result.stderr}`);
    assert.equal(result.stdout, "");
    assert.ok(result.stderr.includes(flag), result.stderr);
    assert.ok(!result.stderr.includes("Traceback"), result.stderr);
  }
});

void test("split dash-leading exceptions are accepted as argparse accepts them", async (t) => {
  const { root } = await candidate(t);
  for (const value of ["-", "-1", "-1.5", "-.5"]) {
    const argv = cliArgv(root).map((token) =>
      token === "latest-release" ? value : token,
    );
    const result = await runCli(argv);
    assert.equal(result.code, 1, `${value}: ${result.stderr}`);
    assert.equal(
      result.stderr,
      "Generated plugin validation failed:\n" +
        "- provenance field `requested_ref` does not match expected value\n",
      `${value} must reach validation, not usage`,
    );
  }
});

// Ground truth measured against CPython 3.11.15 `argparse` on 2026-07-29.
// `_negative_number_matcher` is `^-\d+$|^-\d*\.\d+$`; CPython `\d` is Unicode
// category Nd, JavaScript `\d` is ASCII-only.
const DASH_LEADING_PARITY = [
  { value: "-1", accepted: true, note: "ASCII integer" },
  { value: "-0", accepted: true, note: "ASCII zero" },
  { value: "-1.5", accepted: true, note: "ASCII fractional" },
  { value: "-.5", accepted: true, note: "leading-dot fractional, \\d* empty" },
  { value: "-١", accepted: true, note: "U+0661 ARABIC-INDIC ONE" },
  { value: "-१", accepted: true, note: "U+0967 DEVANAGARI ONE" },
  {
    value: "-١.٥",
    accepted: true,
    note: "Unicode fractional, second alternative",
  },
  { value: "-", accepted: true, note: "bare dash" },
  { value: "-𐒠", accepted: true, note: "U+104A0 OSMANYA ZERO, astral Nd" },
  { value: "-x", accepted: false, note: "flag" },
  { value: "--flagish", accepted: false, note: "long flag" },
  { value: "-1a", accepted: false, note: "trailing non-digit" },
  // Nd, not N: every other rejection row here is non-numeric, so widening
  // `\p{Nd}` to `\p{N}` would break parity while keeping the table green.
  // CPython 3.11.15 rejects both against `^-\d+$|^-\d*\.\d+$`.
  { value: "-²", accepted: false, note: "U+00B2 category No, not Nd" },
  { value: "-½", accepted: false, note: "U+00BD category No, not Nd" },
  { value: "-Ⅳ", accepted: false, note: "U+2163 category Nl, not Nd" },
];

/**
 * Unicode-decimal values the helper, the CLI and the adapter must all accept.
 * Kept in sync by hand with the inline list in tests/unit/adapter.test.js —
 * adding a value in only one place makes it look covered at all three levels.
 */
const UNICODE_ACCEPTED_VALUES = ["-١", "-१", "-١.٥"];

void test("split dash-leading values match argparse", () => {
  for (const { value, accepted, note } of DASH_LEADING_PARITY) {
    assert.equal(
      isAcceptedSplitValue(value),
      accepted,
      `${JSON.stringify(value)} (${note})`,
    );
  }
});

// INTENTIONAL DIVERGENCE — PR 8 divergence #1, not a defect.
// `argparse` accepts a dash-leading token containing a space as a positional;
// this port rejects it. Verified against CPython 3.11.15: `-x y` is accepted as
// a value there. Both implementations reject the input overall, though this test
// pins only the helper — the CLI surface is pinned separately by the
// dash-leading exit-2 case above. Asserted explicitly so a later reader does not
// "fix" the rejection into a regression.
void test("a dash-leading token containing a space is rejected", () => {
  assert.equal(isAcceptedSplitValue("-x y"), false);
});

// A helper-only table would let a call-site bypass regress while staying green,
// so the same values are driven through the built CLI in split form. The
// diagnostic is asserted exactly: reaching validation and failing there is the
// only outcome that proves the value was not rejected as an option.
void test("split Unicode-decimal values reach CLI validation", async (t) => {
  const { root } = await candidate(t);
  for (const value of UNICODE_ACCEPTED_VALUES) {
    const argv = cliArgv(root).map((token) =>
      token === "latest-release" ? value : token,
    );
    const result = await runCli(argv);
    assert.equal(result.code, 1, `${value}: ${result.stderr}`);
    assert.equal(
      result.stderr,
      "Generated plugin validation failed:\n" +
        "- provenance field `requested_ref` does not match expected value\n",
      `${value} must reach validation, not usage`,
    );
  }
});
