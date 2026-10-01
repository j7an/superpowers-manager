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
import { parse as parseYaml } from "yaml";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const dockerfile = join(ROOT, "tests/container/Dockerfile");
const runner = join(ROOT, "tests/container.sh");
const toolPackage = join(ROOT, "tests/container/package.json");
const lockfile = join(ROOT, "tests/container/pnpm-lock.yaml");
const tsconfig = join(ROOT, "tests/tsconfig.json");
const openCodeProbe = join(ROOT, "tests/container/opencode/offline-probe.sh");
const claudeCodeProbe = join(
  ROOT,
  "tests/container/claude-code/offline-probe.sh",
);

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
        "FROM node:24-bookworm-slim",
        "COPY --from=minimum-node /usr/local/bin/node /opt/node-min/bin/node",
        "RUN /opt/node-min/bin/node --version",
        "ENV SPW_PACKAGE_NODE=/opt/node-min/bin/node",
        "pnpm install --frozen-lockfile",
        "ENV SPW_CONTAINER=1",
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
        ["ca-certificates", "git", "procps"],
      );
    },
  );
  await t.test(
    "container tool dependencies remain exact approved harness pins",
    () => {
      const pkg = JSON.parse(readFileSync(toolPackage, "utf8"));
      const lock = parseYaml(readFileSync(lockfile, "utf8")) as {
        lockfileVersion: string;
        importers: Record<
          string,
          {
            dependencies: Record<
              string,
              { specifier: string; version: string }
            >;
          }
        >;
        packages: Record<string, unknown>;
      };
      // The dependency-safety gate parses only pnpm lockfile format 9.0; any
      // other format fails that required check closed on every harness bump.
      assert.equal(lock.lockfileVersion, "9.0");
      // A packageManager pin here makes pnpm write a multi-document lockfile,
      // which that gate refuses. The image reuses the root pin via corepack.
      assert.equal(pkg.packageManager, undefined);
      assert.equal(Object.keys(lock.importers).join(), ".");
      assert.deepEqual(Object.keys(pkg.dependencies).sort(), [
        "@anthropic-ai/claude-code",
        "@earendil-works/pi-coding-agent",
        "@openai/codex",
        "@opencode/cli",
        "opencode-ai",
      ]);
      for (const name of Object.keys(pkg.dependencies)) {
        assert.match(pkg.dependencies[name], /^\d+\.\d+\.\d+(?:-[\w.-]+)?$/);
        const entry = lock.importers["."].dependencies[name];
        assert.equal(entry.specifier, pkg.dependencies[name]);
        assert.ok(
          entry.version.startsWith(`${pkg.dependencies[name]}`),
          `${name} resolves to its pin`,
        );
        assert.ok(`${name}@${pkg.dependencies[name]}` in lock.packages);
      }
      const docker = readFileSync(dockerfile, "utf8").replace(/\\\n\s*/g, " ");
      const install = docker.indexOf(
        "pnpm --dir /opt/spw-test-tools --config.node-linker=hoisted install --frozen-lockfile --ignore-scripts",
      );
      const link = docker.indexOf(
        "RUN --network=none node /opt/spw-test-tools/node_modules/opencode-ai/postinstall.mjs",
      );
      const v1 = docker.indexOf(
        "/opt/spw-test-tools/node_modules/opencode-ai/bin/opencode.exe --version",
      );
      const v2Postinstall = docker.indexOf(
        "node /opt/spw-test-tools/node_modules/@opencode/cli/postinstall.mjs",
      );
      const v2 = docker.indexOf(
        "/opt/spw-test-tools/node_modules/@opencode/cli/bin/opencode.exe --version",
      );
      const seed = docker.indexOf("/opt/spw-opencode-config-seed");
      assert.ok(install !== -1, "container must install tools without scripts");
      assert.ok(
        link > install,
        "container must run only OpenCode's reviewed postinstall after pnpm install",
      );
      assert.ok(
        v1 > link && v2 > v1,
        "container must verify both OpenCode lines after their offline postinstalls",
      );
      assert.ok(
        v2Postinstall > link && v2 > v2Postinstall,
        "container must run V2's absolute postinstall between V1's postinstall and V2's version check",
      );
      assert.ok(
        seed > v2,
        "container must provision native config dependencies after verifying OpenCode",
      );
      assert.ok(
        docker.includes(
          "opencode_version=$(/opt/spw-test-tools/node_modules/opencode-ai/bin/opencode.exe --version)",
        ),
        "V1 config seeding must derive its version from V1's executable",
      );
      assert.ok(
        docker.includes(
          "npm ci --prefix /opt/spw-opencode-config-seed --ignore-scripts",
        ),
        "native config dependencies must install without lifecycle scripts",
      );
      // OpenCode fetches ripgrep from github.com during this step and hides the
      // request failure, so the build retries it; the bound keeps a real outage
      // from looping forever.
      assert.match(
        docker,
        /until [^;]*\/opt\/spw-test-tools\/node_modules\/opencode-ai\/bin\/opencode\.exe debug rg files --limit 1;\s+do\s+if \[ "\$spw_rg_attempt" -ge \d+ \];\s+then\s+[^;]*;\s+exit 1;\s+fi;/,
        "ripgrep seeding must retry a bounded number of times",
      );
    },
  );
  await t.test("container runner requests isolated Docker resources", () => {
    const source = readFileSync(runner, "utf8");
    assert.ok(executable(runner));
    for (const required of [
      "--network none",
      "--read-only",
      "--tmpfs /tmp:rw,exec,nosuid,size=512m",
      "--tmpfs /home/spw:rw,nosuid,size=128m,uid=10001,gid=10001",
      "docker build --pull",
      "docker run --rm",
    ])
      assert.ok(source.includes(required), required);
  });
  await t.test(
    "OpenCode probe rejects host execution before lifecycle work",
    () => {
      assert.ok(executable(openCodeProbe));
      const result = spawnSync("/bin/sh", [openCodeProbe], {
        encoding: "utf8",
        env: {
          PATH: "/usr/bin:/bin",
          SPW_CONTAINER: "0",
          OPENCODE_DB: "/forbidden/ambient.db",
        },
      });
      assert.equal(result.status, 1);
      assert.match(result.stderr, /isolated UID 10001 container/);
    },
  );
  await t.test(
    "Claude Code probe rejects host execution before lifecycle work",
    () => {
      assert.ok(executable(claudeCodeProbe));
      const result = spawnSync("/bin/sh", [claudeCodeProbe], {
        encoding: "utf8",
        env: { PATH: "/usr/bin:/bin", SPW_CONTAINER: "0" },
      });
      assert.equal(result.status, 1);
      assert.match(result.stderr, /isolated UID 10001 container/);
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
      const child = `#!/bin/sh
set -eu
case "$0" in */codex/offline-probe.sh) name=codex ;; */codex/real-upstream.sh) name=codex-walk ;; */pi/offline-probe.sh) name=pi ;; */pi/real-upstream.sh) name=pi-walk ;; */opencode/offline-probe.sh) name=opencode ;; */claude-code/offline-probe.sh) name=claude-code ;; */claude-code/real-upstream.sh) name=claude-code-walk ;; *) name=shared ;; esac
label=$name
if [ "$name" = opencode ]; then
  case "$SPW_OPENCODE_MAJOR:$SPW_OPENCODE_BIN" in
    1:/opt/spw-test-tools/node_modules/opencode-ai/bin/opencode.exe) label=opencode-v1 ;;
    2:/opt/spw-test-tools/node_modules/@opencode/cli/bin/opencode.exe) label=opencode-v2 ;;
    *) exit 98 ;;
  esac
fi
printf '%s\\n' "$label" >> "$SPW_RUNNER_LOG"
[ "\${SPW_FAIL_CHILD:-}" != "$name" ] || exit 17
`;
      const paths = [
        join(scratch, "tests/run.sh"),
        join(container, "codex/offline-probe.sh"),
        join(container, "codex/real-upstream.sh"),
        join(container, "pi/offline-probe.sh"),
        join(container, "pi/real-upstream.sh"),
        join(container, "opencode/offline-probe.sh"),
        join(container, "claude-code/offline-probe.sh"),
        join(container, "claude-code/real-upstream.sh"),
      ];
      mkdirSync(join(container, "codex"), { recursive: true });
      mkdirSync(join(container, "pi"), { recursive: true });
      mkdirSync(join(container, "opencode"), { recursive: true });
      mkdirSync(join(container, "claude-code"), { recursive: true });
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
      // Each stage prints "<label>: start" and "<label>: complete status=0";
      // the stubbed children print nothing, so stdout is exactly these lines.
      const stage = (label: string, inner = "") =>
        `${label}: start\n${inner}${label}: complete status=0\n`;
      const lanes =
        stage("container: OpenCode V1 lane") +
        stage("container: OpenCode V2 lane");
      for (const [mode, logText, stdout] of [
        [
          "suite",
          "shared\ncodex\ncodex-walk\npi\npi-walk\nopencode-v1\nopencode-v2\nclaude-code\nclaude-code-walk\n",
          stage("container suite: shared checks") +
            stage("container suite: Codex harness integration") +
            stage("container: Codex real-upstream walk") +
            stage("container suite: Pi harness integration") +
            stage("container: Pi real-upstream walk") +
            stage("container suite: OpenCode harness integration", lanes) +
            stage("container suite: Claude Code harness integration") +
            stage("container: Claude Code real-upstream walk"),
        ],
        [
          "harness-codex",
          "codex\ncodex-walk\n",
          stage("container: Codex harness integration") +
            stage("container: Codex real-upstream walk"),
        ],
        [
          "harness-pi",
          "pi\npi-walk\n",
          stage("container: Pi harness integration") +
            stage("container: Pi real-upstream walk"),
        ],
        [
          "harness-opencode",
          "opencode-v1\nopencode-v2\n",
          stage("container: OpenCode harness integration", lanes),
        ],
        [
          "harness-claude-code",
          "claude-code\nclaude-code-walk\n",
          stage("container: Claude Code harness integration") +
            stage("container: Claude Code real-upstream walk"),
        ],
      ] as const) {
        const result = run(mode);
        assert.equal(result.status, 0, result.stderr);
        assert.equal(readFileSync(log, "utf8"), logText);
        assert.equal(result.stdout, stdout, mode);
      }
      for (const [failedChild, expected, forbiddenCompletions] of [
        [
          "shared",
          "shared\n",
          [
            "container suite: shared checks: complete status=0",
            "container suite: Codex harness integration: complete status=0",
            "container suite: Pi harness integration: complete status=0",
            "container suite: OpenCode harness integration: complete status=0",
            "container suite: Claude Code harness integration: complete status=0",
          ],
        ],
        [
          "codex",
          "shared\ncodex\n",
          [
            "container suite: Codex harness integration: complete status=0",
            "container suite: Pi harness integration: complete status=0",
            "container suite: OpenCode harness integration: complete status=0",
            "container suite: Claude Code harness integration: complete status=0",
          ],
        ],
        [
          "codex-walk",
          "shared\ncodex\ncodex-walk\n",
          [
            "container: Codex real-upstream walk: complete status=0",
            "container suite: Pi harness integration: start",
          ],
        ],
        [
          "pi",
          "shared\ncodex\ncodex-walk\npi\n",
          [
            "container suite: Pi harness integration: complete status=0",
            "container suite: OpenCode harness integration: complete status=0",
            "container suite: Claude Code harness integration: complete status=0",
          ],
        ],
        [
          "pi-walk",
          "shared\ncodex\ncodex-walk\npi\npi-walk\n",
          [
            "container: Pi real-upstream walk: complete status=0",
            "container suite: OpenCode harness integration: start",
          ],
        ],
        [
          "opencode",
          "shared\ncodex\ncodex-walk\npi\npi-walk\nopencode-v1\n",
          [
            "container: OpenCode V1 lane: complete status=0",
            "container: OpenCode V2 lane: start",
            "container suite: OpenCode harness integration: complete status=0",
            "container suite: Claude Code harness integration: complete status=0",
          ],
        ],
        [
          "claude-code",
          "shared\ncodex\ncodex-walk\npi\npi-walk\nopencode-v1\nopencode-v2\nclaude-code\n",
          [
            "container suite: Claude Code harness integration: complete status=0",
            "container: Claude Code real-upstream walk: start",
          ],
        ],
        [
          "claude-code-walk",
          "shared\ncodex\ncodex-walk\npi\npi-walk\nopencode-v1\nopencode-v2\nclaude-code\nclaude-code-walk\n",
          ["container: Claude Code real-upstream walk: complete status=0"],
        ],
      ] as const) {
        const result = run("suite", { SPW_FAIL_CHILD: failedChild });
        assert.equal(result.status, 17);
        assert.equal(readFileSync(log, "utf8"), expected);
        for (const completion of forbiddenCompletions)
          assert.ok(!result.stdout.includes(completion), result.stdout);
      }
      const failedCodexWalk = run("harness-codex", {
        SPW_FAIL_CHILD: "codex-walk",
      });
      assert.equal(failedCodexWalk.status, 17);
      assert.equal(readFileSync(log, "utf8"), "codex\ncodex-walk\n");
      assert.ok(
        !failedCodexWalk.stdout.includes(
          "container: Codex real-upstream walk: complete status=0",
        ),
        failedCodexWalk.stdout,
      );
      const failedPiWalk = run("harness-pi", { SPW_FAIL_CHILD: "pi-walk" });
      assert.equal(failedPiWalk.status, 17);
      assert.equal(readFileSync(log, "utf8"), "pi\npi-walk\n");
      assert.ok(
        !failedPiWalk.stdout.includes(
          "container: Pi real-upstream walk: complete status=0",
        ),
        failedPiWalk.stdout,
      );
      const failedWalk = run("harness-claude-code", {
        SPW_FAIL_CHILD: "claude-code-walk",
      });
      assert.equal(failedWalk.status, 17);
      assert.equal(
        readFileSync(log, "utf8"),
        "claude-code\nclaude-code-walk\n",
      );
      assert.ok(
        !failedWalk.stdout.includes(
          "container: Claude Code real-upstream walk: complete status=0",
        ),
        failedWalk.stdout,
      );
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
