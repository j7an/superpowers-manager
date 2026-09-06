import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import {
  mkdtemp,
  mkdir,
  readFile,
  realpath,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import type { CodexRemovalInput } from "../../src/adapter.ts";
import type { CommandContext } from "../../src/commands/context.ts";
import { runInstall } from "../../src/commands/install.ts";
import { withMutation } from "../../src/commands/mutation.ts";
import { runPrepare } from "../../src/commands/prepare.ts";
import type { EffectiveSelection } from "../../src/effective-selection.ts";
import type { HarnessAdapter } from "../../src/harness.ts";
import {
  createResourceCoordinator,
  type ResourceCoordinator,
} from "../../src/resource-lock.ts";
import { SafetyError } from "../../src/safety-error.ts";
import { upstreamCacheRoot } from "../../src/upstream-workspace.ts";
import { codexHarness } from "../../src/codex-harness.ts";
import { createHarnessFixture } from "../lib/test-harness.ts";
import { capture } from "./helpers/command-harness.ts";

const CHILD = fileURLToPath(
  new URL("../bin/helpers/resource-lock-child.ts", import.meta.url),
);
const A = "a".repeat(40);
const B = "b".repeat(40);

type ChildMessage =
  | { readonly kind: "ready" | "complete" }
  | { readonly kind: "error"; readonly name: string; readonly message: string };

function parseChildMessage(value: unknown): ChildMessage {
  if (typeof value !== "object" || value === null || !("kind" in value)) {
    throw new Error("resource-lock child sent a malformed message");
  }
  if (value.kind === "ready" || value.kind === "complete") {
    return { kind: value.kind };
  }
  if (
    value.kind === "error" &&
    "name" in value &&
    typeof value.name === "string" &&
    "message" in value &&
    typeof value.message === "string"
  ) {
    return { kind: "error", name: value.name, message: value.message };
  }
  throw new Error("resource-lock child sent a malformed message");
}

async function bounded<T>(promise: Promise<T>, label: string): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error(label)), 5_000);
      }),
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

function startChild(
  mode: "hold" | "hold-create" | "write",
  resource: string,
  marker?: string,
): {
  readonly child: ChildProcess;
  readonly stderr: () => string;
  readonly exit: Promise<{
    readonly code: number | null;
    readonly signal: NodeJS.Signals | null;
  }>;
} {
  const child = spawn(
    process.execPath,
    [CHILD, mode, resource, ...(marker === undefined ? [] : [marker])],
    { stdio: ["ignore", "ignore", "pipe", "ipc"] },
  );
  let stderr = "";
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string) => {
    stderr += chunk;
  });
  const exit = new Promise<{
    readonly code: number | null;
    readonly signal: NodeJS.Signals | null;
  }>((resolveExit, rejectExit) => {
    child.once("error", rejectExit);
    child.once("exit", (code, signal) => resolveExit({ code, signal }));
  });
  return { child, stderr: () => stderr, exit };
}

async function nextMessage(child: ChildProcess, label: string) {
  const [message] = await bounded(
    once(child, "message"),
    `resource-lock child did not report ${label}`,
  );
  return parseChildMessage(message);
}

async function childExit(child: ReturnType<typeof startChild>, label: string) {
  return await bounded(
    child.exit,
    `resource-lock child did not exit after ${label}`,
  );
}

async function sandbox(t: import("node:test").TestContext): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "spw-resource-lock-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

async function hold(resource: string) {
  const process = startChild("hold", resource);
  const first = await nextMessage(process.child, "ready");
  assert.deepEqual(first, { kind: "ready" }, process.stderr());
  return process;
}

async function holdAndCreate(resource: string) {
  const process = startChild("hold-create", resource);
  const first = await nextMessage(process.child, "ready after creation");
  assert.deepEqual(first, { kind: "ready" }, process.stderr());
  return process;
}

async function release(owner: ReturnType<typeof startChild>) {
  owner.child.send?.("release");
  assert.deepEqual(
    await nextMessage(owner.child, "completion"),
    { kind: "complete" },
    owner.stderr(),
  );
  assert.deepEqual(await childExit(owner, "release"), {
    code: 0,
    signal: null,
  });
}

void test("competing processes treat existing symlink aliases from different package roots as one resource", async (t) => {
  const root = await sandbox(t);
  const target = join(root, "actual", "generated");
  await mkdir(target, { recursive: true });
  const first = join(root, "package-a", "plugins");
  const second = join(root, "package-b", "plugins");
  await mkdir(dirname(first), { recursive: true });
  await mkdir(dirname(second), { recursive: true });
  await symlink(target, first, "dir");
  await symlink(target, second, "dir");
  const marker = join(target, "content");
  await writeFile(marker, "original\n", "utf8");

  const owner = await hold(first);
  t.after(() => owner.child.kill("SIGKILL"));
  const contender = startChild("write", second, marker);
  const message = await nextMessage(contender.child, "busy error");
  assert.equal(message.kind, "error");
  if (message.kind === "error") {
    assert.equal(message.name, "SafetyError");
    assert.equal(
      message.message,
      `resource is busy: ${await realpath(target)}`,
    );
  }
  assert.deepEqual(await childExit(contender, "busy error"), {
    code: 0,
    signal: null,
  });
  assert.equal(await readFile(marker, "utf8"), "original\n");
  await release(owner);
});

void test("competing processes canonicalize aliases to the same not-yet-created target", async (t) => {
  const root = await sandbox(t);
  const targetParent = join(root, "actual-parent");
  await mkdir(targetParent);
  const firstAlias = join(root, "package-a");
  const secondAlias = join(root, "package-b");
  await symlink(targetParent, firstAlias, "dir");
  await symlink(targetParent, secondAlias, "dir");
  const first = join(firstAlias, "future", "generated");
  const second = join(secondAlias, "future", "generated");

  const owner = await hold(first);
  t.after(() => owner.child.kill("SIGKILL"));
  const contender = startChild("write", second, join(root, "must-not-exist"));
  const message = await nextMessage(contender.child, "prospective busy error");
  assert.equal(message.kind, "error");
  if (message.kind === "error") {
    const canonicalParent = await realpath(targetParent);
    assert.equal(
      message.message,
      `resource is busy: ${join(canonicalParent, "future", "generated")}`,
    );
  }
  assert.deepEqual(await childExit(contender, "prospective busy error"), {
    code: 0,
    signal: null,
  });
  await assert.rejects(readFile(join(root, "must-not-exist"), "utf8"), {
    code: "ENOENT",
  });
  await release(owner);
});

void test("a prospective lock remains authoritative after its owner creates the resource", async (t) => {
  const root = await sandbox(t);
  const resource = join(root, "future", "generated");
  const marker = join(root, "must-not-exist");
  const owner = await holdAndCreate(resource);
  t.after(() => owner.child.kill("SIGKILL"));

  const contender = startChild("write", resource, marker);
  const message = await nextMessage(
    contender.child,
    "post-creation busy error",
  );
  assert.equal(message.kind, "error");
  if (message.kind === "error") {
    assert.equal(
      message.message,
      `resource is busy: ${join(await realpath(root), "future", "generated")}`,
    );
  }
  assert.deepEqual(await childExit(contender, "post-creation busy error"), {
    code: 0,
    signal: null,
  });
  await assert.rejects(readFile(marker, "utf8"), { code: "ENOENT" });
  await release(owner);
});

void test("a held resource does not block a disjoint process resource", async (t) => {
  const root = await sandbox(t);
  const first = join(root, "first");
  const second = join(root, "second");
  const marker = join(root, "second-was-written");
  const owner = await hold(first);
  t.after(() => owner.child.kill("SIGKILL"));

  const writer = startChild("write", second, marker);
  assert.deepEqual(await nextMessage(writer.child, "completion"), {
    kind: "complete",
  });
  assert.deepEqual(await childExit(writer, "completion"), {
    code: 0,
    signal: null,
  });
  assert.equal(await readFile(marker, "utf8"), "changed\n");
  await release(owner);
});

void test("reentrant ownership survives nested resource additions and action failures release owned locks", async (t) => {
  const root = await sandbox(t);
  const resource = join(root, "resource");
  const added = join(root, "cache-added-by-nested-prepare");
  const coordinator = createResourceCoordinator();
  const calls: string[] = [];
  await coordinator.withResources([resource], async () => {
    calls.push("outer-before");
    await coordinator.withResources([resource, added], async () => {
      calls.push("nested-first");
    });
    await assert.doesNotReject(
      createResourceCoordinator().withResources([added], async () => {}),
    );
    await coordinator.withResources([resource], async () => {
      calls.push("nested-second");
    });
    calls.push("outer-after");
  });
  assert.deepEqual(calls, [
    "outer-before",
    "nested-first",
    "nested-second",
    "outer-after",
  ]);

  const failure = new Error("action failed");
  await assert.rejects(
    coordinator.withResources([resource], async () => {
      throw failure;
    }),
    (error) => error === failure,
  );
  await assert.doesNotReject(
    createResourceCoordinator().withResources([resource], async () => {}),
  );
});

void test("a failed multi-resource acquisition releases only the locks acquired by that call", async (t) => {
  const root = await sandbox(t);
  const available = join(root, "a-available");
  const busy = join(root, "z-busy");
  const owner = await hold(busy);
  t.after(() => owner.child.kill("SIGKILL"));
  const canonicalBusy = join(await realpath(root), "z-busy");

  await assert.rejects(
    createResourceCoordinator().withResources([busy, available], async () =>
      assert.fail("busy acquisition ran its action"),
    ),
    (error) => {
      assert.ok(error instanceof SafetyError);
      assert.equal(error.message, `resource is busy: ${canonicalBusy}`);
      return true;
    },
  );
  await assert.doesNotReject(
    createResourceCoordinator().withResources([available], async () => {}),
  );
  await release(owner);
});

void test("an interrupted owner is never reclaimed automatically", async (t) => {
  const root = await sandbox(t);
  const resource = join(root, "resource");
  const marker = join(root, "must-not-exist");
  const owner = await hold(resource);
  owner.child.kill("SIGKILL");
  assert.deepEqual(await childExit(owner, "SIGKILL"), {
    code: null,
    signal: "SIGKILL",
  });

  const contender = startChild("write", resource, marker);
  const message = await nextMessage(contender.child, "stale busy error");
  assert.equal(message.kind, "error");
  if (message.kind === "error") {
    assert.equal(
      message.message,
      `resource is busy: ${join(await realpath(root), "resource")}`,
    );
  }
  await childExit(contender, "stale busy error");
  await assert.rejects(readFile(marker, "utf8"), { code: "ENOENT" });
});

void test("release preserves mismatched and unreadable ownership metadata", async (t) => {
  const root = await sandbox(t);
  for (const replacement of [
    '{"token":"somebody-else","resource":"wrong"}',
    "not-json",
  ]) {
    await t.test(
      replacement.startsWith("{") ? "mismatched" : "unreadable",
      async () => {
        const parent = join(
          root,
          replacement.startsWith("{") ? "first-case" : "second-case",
        );
        await mkdir(parent);
        const resource = join(parent, "resource");
        const canonicalResource = join(await realpath(parent), "resource");
        await createResourceCoordinator().withResources(
          [resource],
          async () => {
            const entries = await readdir(parent);
            const lock = entries.find((entry) =>
              entry.endsWith(".resource-lock"),
            );
            assert.notEqual(lock, undefined);
            const metadataPath = join(parent, lock!, "owner.json");
            const metadata = JSON.parse(await readFile(metadataPath, "utf8"));
            assert.equal(typeof metadata.token, "string");
            assert.notEqual(metadata.token, "");
            assert.equal(metadata.pid, process.pid);
            assert.equal(metadata.resource, canonicalResource);
            await writeFile(metadataPath, replacement, "utf8");
          },
        );
        await assert.rejects(
          createResourceCoordinator().withResources([resource], async () => {}),
          (error) => {
            assert.ok(error instanceof SafetyError);
            assert.equal(
              error.message,
              `resource is busy: ${canonicalResource}`,
            );
            return true;
          },
        );
      },
    );
  }
});

void test("upstreamCacheRoot preserves explicit, invocation-relative, and package defaults", () => {
  assert.equal(
    upstreamCacheRoot("/package", { SUPERPOWERS_CACHE_DIR: "/cache" }, "/cwd"),
    "/cache/superpowers",
  );
  assert.equal(
    upstreamCacheRoot("/package", { SUPERPOWERS_CACHE_DIR: "cache" }, "/cwd"),
    "/cwd/cache/superpowers",
  );
  assert.equal(
    upstreamCacheRoot("/package", {}, "/cwd"),
    "/package/.cache/upstream/superpowers",
  );
});

void test("Codex mutation ownership follows CODEX_HOME or HOME and ignores diagnostic search overrides", async () => {
  assert.deepEqual(
    await codexHarness.mutationRoots({
      root: "/package",
      env: {
        HOME: "/home/operator",
        CODEX_HOME: "/isolated/codex",
        SUPERPOWERS_INSTALLED_SEARCH_ROOT: "/read-only-search",
      },
    }),
    ["/isolated/codex"],
  );
  assert.deepEqual(
    await codexHarness.mutationRoots({
      root: "/package",
      env: {
        HOME: "/home/operator",
        SUPERPOWERS_INSTALLED_SEARCH_ROOT: "/read-only-search",
      },
    }),
    ["/home/operator/.codex"],
  );
});

function pinned(commit: string, source = "https://example.invalid/upstream") {
  return JSON.stringify({
    schema_version: 1,
    mode: "pinned",
    source,
    requested_ref: commit,
    resolved_ref: commit,
    commit,
  });
}

function observingCoordinator(observations: string[][]): ResourceCoordinator {
  return {
    async withResources(paths, action) {
      observations.push([...paths]);
      return await action();
    },
  };
}

async function mutationContext(t: import("node:test").TestContext) {
  const root = await sandbox(t);
  const config = join(root, "config-dir");
  await mkdir(config);
  await writeFile(join(config, "selection.json"), pinned(A), "utf8");
  const observations: string[][] = [];
  const adapterCalls: string[] = [];
  const adapter: HarnessAdapter<CodexRemovalInput> = {
    ...codexHarness,
    preparationLocation() {
      adapterCalls.push("preparation-location");
      return {
        destinationRoot: join(root, "prepared"),
        stagingLeaf: "superpowers",
      };
    },
    async mutationRoots() {
      adapterCalls.push("mutation-roots");
      return [join(root, "native-state")];
    },
  };
  const out = capture();
  const err = capture();
  const ctx: CommandContext<CodexRemovalInput> = {
    root,
    env: {
      HOME: join(root, "home"),
      SUPERPOWERS_CONFIG_DIR: config,
      SUPERPOWERS_CACHE_DIR: join(root, "cache-parent"),
    },
    stdout: out.stream,
    stderr: err.stream,
    options: { harness: "codex", allowExperimental: false },
    adapter,
    coordination: observingCoordinator(observations),
  };
  return { root, config, observations, adapterCalls, ctx };
}

function selected<R>(ctx: CommandContext<R>): EffectiveSelection {
  assert.notEqual(ctx.selection, undefined);
  return ctx.selection!;
}

void test("withMutation freezes one selection across nested update, prepare, and install phases", async (t) => {
  const fixture = await mutationContext(t);
  const seen: string[] = [];

  await withMutation("update", fixture.ctx, async (update) => {
    seen.push(selected(update).desiredCommit);
    await writeFile(join(fixture.config, "selection.json"), pinned(B), "utf8");
    await withMutation("prepare", update, async (prepare) => {
      seen.push(selected(prepare).desiredCommit);
      return await withMutation("install", prepare, async (install) => {
        seen.push(selected(install).desiredCommit);
        return 0;
      });
    });
    return 0;
  });

  assert.deepEqual(seen, [A, A, A]);
  assert.deepEqual(fixture.observations, [
    [join(fixture.root, "prepared"), join(fixture.root, "native-state")],
    [
      join(fixture.root, "prepared"),
      join(fixture.root, "native-state"),
      join(fixture.root, "cache-parent", "superpowers"),
    ],
    [join(fixture.root, "prepared"), join(fixture.root, "native-state")],
  ]);

  await withMutation("install", fixture.ctx, async (later) => {
    assert.equal(selected(later).desiredCommit, B);
    return 0;
  });
});

void test("frozen selection drives real nested preparation, probe, and activation consumers", async (t) => {
  const fixture = await createHarnessFixture(t);
  const observations: string[][] = [];
  const adapter: HarnessAdapter<typeof fixture.removalInput> = {
    ...fixture.adapter,
    ...fixture.methods,
    async mutationRoots() {
      return [join(fixture.ctx.root, "native-state")];
    },
  };
  const ctx = {
    ...fixture.ctx,
    adapter,
    coordination: observingCoordinator(observations),
  };
  const config = ctx.env.SUPERPOWERS_CONFIG_DIR!;
  const upstream = ctx.env.SUPERPOWERS_UPSTREAM_URL!;

  assert.equal(
    await withMutation("update", ctx, async (update) => {
      assert.equal(
        selected(update).desiredCommit,
        fixture.selection.desiredCommit,
      );
      delete update.env.SUPERPOWERS_REF;
      await writeFile(
        join(config, "selection.json"),
        pinned(B, upstream),
        "utf8",
      );
      const prepared = await withMutation("prepare", update, async (prepare) =>
        runPrepare([], prepare),
      );
      assert.equal(prepared, 0, fixture.err.text());
      return await withMutation("install", update, async (install) =>
        runInstall([], install),
      );
    }),
    0,
  );
  assert.ok(fixture.calls.includes("prepare"));
  assert.ok(fixture.calls.includes("install"));

  await withMutation("install", ctx, async (later) => {
    assert.equal(selected(later).desiredCommit, B);
    return 0;
  });
});

void test("withMutation validates selection before adapter access or lock creation", async (t) => {
  const fixture = await mutationContext(t);
  await writeFile(join(fixture.config, "selection.json"), "{}", "utf8");

  await assert.rejects(
    withMutation("update", fixture.ctx, async () => 0),
    (error) => {
      assert.ok(error instanceof SafetyError);
      assert.equal(error.message, "schema_version must equal integer 1");
      return true;
    },
  );
  assert.deepEqual(fixture.adapterCalls, []);
  assert.deepEqual(fixture.observations, []);
});

void test("withMutation keeps uninstall selection-independent", async (t) => {
  const fixture = await mutationContext(t);
  await writeFile(join(fixture.config, "selection.json"), "{}", "utf8");

  assert.equal(
    await withMutation("uninstall", fixture.ctx, async (scoped) => {
      assert.equal(scoped.selection, undefined);
      return 7;
    }),
    7,
  );
  assert.deepEqual(fixture.adapterCalls, [
    "preparation-location",
    "mutation-roots",
  ]);
  assert.deepEqual(fixture.observations, [
    [join(fixture.root, "prepared"), join(fixture.root, "native-state")],
  ]);
});
