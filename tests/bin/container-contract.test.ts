import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  accessSync,
  chmodSync,
  constants,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const dockerfile = join(ROOT, "tests/container/Dockerfile");
const runner = join(ROOT, "tests/container.sh");
const toolPackage = join(ROOT, "tests/container/package.json");
const lockfile = join(ROOT, "tests/container/package-lock.json");
const tsconfig = join(ROOT, "tests/tsconfig.json");

function executable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}
function effectiveTsconfig(): Record<string, unknown> {
  const result = spawnSync(
    join(ROOT, "node_modules/.bin/tsc"),
    ["--showConfig", "-p", tsconfig],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);
  return (
    JSON.parse(result.stdout) as { compilerOptions: Record<string, unknown> }
  ).compilerOptions;
}

void test("container contract", async (t) => {
  await t.test(
    "container image keeps the isolated, unprivileged runtime contract",
    () => {
      const source = readFileSync(dockerfile, "utf8");
      for (const required of [
        "FROM node:24.0.0-bookworm-slim AS minimum-node",
        "FROM node:${NATIVE_NODE_VERSION}-bookworm-slim",
        "COPY --from=minimum-node /usr/local/bin/node /opt/node-min/bin/node",
        "RUN /opt/node-min/bin/node --version",
        "ENV SPW_PACKAGE_NODE=/opt/node-min/bin/node",
        "ENV SPW_PACKAGE_NODE_VERSION=24.0.0",
        "npm ci --ignore-scripts",
        "pnpm install --frozen-lockfile",
        "ENV SPW_CONTAINER=1",
        "USER spw",
      ])
        assert.ok(source.includes(required), required);
      const pack = source.indexOf(
        "node tests/tools/pack.ts --out-dir /opt/spw-package",
      );
      const user = source.indexOf("USER spw");
      assert.ok(
        pack !== -1,
        "container must package before running the unprivileged harness",
      );
      assert.ok(
        user !== -1 && pack < user,
        "container must package before USER spw",
      );
      assert.match(source, /RUN useradd --create-home --uid 10001 spw/);
      const logicalLines = source.replace(/\\\n\s*/g, " ").split("\n");
      const installs = logicalLines.filter((line) =>
        line.includes("apt-get install"),
      );
      assert.equal(
        installs.length,
        1,
        "container must have one apt-get install command",
      );
      const packageInstall = installs[0].match(
        /apt-get install -y --no-install-recommends\s+([^&]+?)\s+&&/,
      );
      assert.ok(
        packageInstall,
        "container must install its required system packages",
      );
      assert.deepEqual(
        packageInstall[1]
          .trim()
          .split(/\s+/)
          .filter((token) => token !== "\\")
          .sort(),
        ["ca-certificates", "git", "procps", "python3"],
      );
    },
  );
  await t.test(
    "container tool dependencies remain exact approved harness pins",
    () => {
      const pkg = JSON.parse(readFileSync(toolPackage, "utf8"));
      const lock = JSON.parse(readFileSync(lockfile, "utf8"));
      assert.deepEqual(Object.keys(pkg.dependencies).sort(), [
        "@earendil-works/pi-coding-agent",
        "@openai/codex",
      ]);
      for (const name of Object.keys(pkg.dependencies)) {
        assert.match(pkg.dependencies[name], /^\d+\.\d+\.\d+(?:-[\w.-]+)?$/);
        assert.equal(
          lock.packages[""].dependencies[name],
          pkg.dependencies[name],
        );
        assert.equal(
          lock.packages[`node_modules/${name}`].version,
          pkg.dependencies[name],
        );
      }
    },
  );
  await t.test(
    "container runner requests isolated Docker resources and rejects unsupported native runtimes",
    () => {
      const source = readFileSync(runner, "utf8");
      assert.ok(executable(runner));
      for (const required of [
        "--network none",
        "--read-only",
        "--tmpfs /tmp:rw,exec,nosuid,size=512m",
        "--tmpfs /home/spw:rw,nosuid,size=128m,uid=10001,gid=10001",
        "docker build --pull",
        '--build-arg "NATIVE_NODE_VERSION=$native_node"',
        "docker run --rm",
      ])
        assert.ok(source.includes(required), required);
      for (const native of ["22", "24.0.0", "24.12.1"]) {
        const result = spawnSync("/bin/sh", [runner], {
          encoding: "utf8",
          env: { PATH: "/usr/bin:/bin", SPW_NATIVE_NODE_VERSION: native },
        });
        assert.equal(result.status, 2);
        assert.equal(
          result.stderr,
          "error: SPW_NATIVE_NODE_VERSION must be 24.12.0 or 24\n",
        );
      }
    },
  );
  await t.test("test tsconfig resolves NodeNext", () => {
    const config = effectiveTsconfig();
    assert.equal(String(config.module).toLowerCase(), "nodenext");
    assert.equal(String(config.moduleResolution).toLowerCase(), "nodenext");
  });
  await t.test(
    "build context and generated plugin rules remain excluded",
    () => {
      const dockerignore = readFileSync(
        join(ROOT, ".dockerignore"),
        "utf8",
      ).split("\n");
      for (const entry of [
        ".git",
        ".cache",
        "dist/",
        "node_modules",
        "*.tgz",
        "docs/superpowers",
        "plugins/superpowers/**",
        ".superpowers/",
        ".worktrees/",
        "plugins/.superpowers.prepare.*/",
        "plugins/.superpowers.bak.*/",
      ])
        assert.ok(dockerignore.includes(entry), entry);
      const ignoreLines = readFileSync(join(ROOT, ".gitignore"), "utf8").split(
        "\n",
      );
      for (const entry of [
        "plugins/superpowers/.codex-plugin/plugin.json",
        "plugins/.superpowers.prepare.*/",
        "plugins/.superpowers.bak.*/",
      ])
        assert.ok(ignoreLines.includes(entry), `missing ignore rule: ${entry}`);
      assert.ok(!ignoreLines.includes("plugins/.superpowers.tmp.*/"));
    },
  );
  await t.test(
    "inside runner dispatches each mode and stops at each child failure",
    (t) => {
      const scratch = mkdtempSync(join(tmpdir(), "spw-container-runner-"));
      t.after(() => rmSync(scratch, { recursive: true, force: true }));
      const bin = join(scratch, "bin");
      const container = join(scratch, "tests/container");
      mkdirSync(bin, { recursive: true });
      mkdirSync(container, { recursive: true });
      copyFileSync(runner, join(scratch, "tests/container.sh"));
      writeFileSync(
        join(bin, "id"),
        '#!/bin/sh\n[ "${1:-}" = "-u" ] || exit 99\nprintf "%s\\n" "${SPW_FIXTURE_UID:-10001}"\n',
      );
      writeFileSync(join(bin, "docker"), "#!/bin/sh\nexit 99\n");
      const child = `#!/bin/sh\nset -eu\ncase "$0" in */codex/offline-probe.sh) name=codex ;; */pi/offline-probe.sh) name=pi ;; *) name=shared ;; esac\nprintf '%s\\n' "$name" >> "$SPW_RUNNER_LOG"\n[ "\${SPW_FAIL_CHILD:-}" != "$name" ] || exit 17\n`;
      const paths = [
        join(scratch, "tests/run.sh"),
        join(container, "codex/offline-probe.sh"),
        join(container, "pi/offline-probe.sh"),
      ];
      mkdirSync(join(container, "codex"), { recursive: true });
      mkdirSync(join(container, "pi"), { recursive: true });
      for (const path of paths) writeFileSync(path, child);
      for (const path of [join(bin, "id"), join(bin, "docker"), ...paths])
        chmodSync(path, 0o755);
      const log = join(scratch, "runner.log");
      const run = (mode: string, extra: Record<string, string> = {}) => {
        writeFileSync(log, "");
        return spawnSync(
          "/bin/sh",
          [join(scratch, "tests/container.sh"), "--inside", mode],
          {
            cwd: scratch,
            encoding: "utf8",
            env: {
              PATH: `${bin}:/usr/bin:/bin`,
              SPW_RUNNER_LOG: log,
              ...extra,
            },
          },
        );
      };
      for (const [mode, logText] of [
        ["suite", "shared\ncodex\npi\n"],
        ["harness-codex", "codex\n"],
        ["harness-pi", "pi\n"],
      ] as const) {
        const result = run(mode);
        assert.equal(result.status, 0, result.stderr);
        assert.equal(readFileSync(log, "utf8"), logText);
      }
      for (const [failedChild, expected, forbiddenCompletions] of [
        [
          "shared",
          "shared\n",
          [
            "container suite: shared checks: complete status=0",
            "container suite: Codex harness integration: complete status=0",
            "container suite: Pi harness integration: complete status=0",
          ],
        ],
        [
          "codex",
          "shared\ncodex\n",
          [
            "container suite: Codex harness integration: complete status=0",
            "container suite: Pi harness integration: complete status=0",
          ],
        ],
        [
          "pi",
          "shared\ncodex\npi\n",
          ["container suite: Pi harness integration: complete status=0"],
        ],
      ] as const) {
        const result = run("suite", { SPW_FAIL_CHILD: failedChild });
        assert.equal(result.status, 17);
        assert.equal(readFileSync(log, "utf8"), expected);
        for (const completion of forbiddenCompletions)
          assert.ok(!result.stdout.includes(completion), result.stdout);
      }
      const invalid = run("unknown");
      assert.equal(invalid.status, 2);
      assert.match(invalid.stderr, /unknown container test mode/);
      const uid = run("suite", { SPW_FIXTURE_UID: "999" });
      assert.equal(uid.status, 1);
      assert.match(uid.stderr, /UID 10001/);
      assert.equal(readFileSync(log, "utf8"), "");
    },
  );
});
