// Ported from tests/test_container_contract.sh (see
// tests/migration-inventory/container-contract.md for the numbered
// assertion inventory this file maps to 1:1).
//
// The shell driver never invokes Docker, a real container, or the real
// Codex CLI — it statically inspects tests/container/Dockerfile,
// tests/container.sh, tests/container/codex-offline-probe.sh,
// tests/container/hooks-list-rpc.py, and a handful of manifest/lockfile
// files, then asserts the shell/Python source text has a specific
// structure. This port reproduces exactly that: it is hermetic (no
// network, no container runtime, no mutation of the real ~/.codex).
//
// The shell driver's structural checks were written in Ruby (embedded
// `ruby - ... <<'RUBY'` heredocs). This port re-implements the same
// helper functions and validators directly in JavaScript, rather than
// spawning `ruby`, so the port has no new runtime dependency. Only the
// Python-syntax-validity check (inventory item 37) still shells out to
// `python3`, mirroring the shell driver's own use of `python3 -S` for the
// same purpose — `python3` is already a required tool for this project
// (see AGENTS.md's "Node 24+ and Python-standard-library boundaries").

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { accessSync, constants, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { exactError } from "../lib/error-assertions.ts";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));

const DOCKERFILE_PATH = join(ROOT, "tests", "container", "Dockerfile");
const RUNNER_PATH = join(ROOT, "tests", "container.sh");
const TOOLS_PACKAGE_PATH = join(ROOT, "tests", "container", "package.json");
const PROBE_PATH = join(ROOT, "tests", "container", "codex-offline-probe.sh");
const HOOKS_RPC_PATH = join(ROOT, "tests", "container", "hooks-list-rpc.py");
const TSCONFIG_PATH = join(ROOT, "tests", "tsconfig.json");
const LOCKFILE_PATH = join(ROOT, "tests", "container", "package-lock.json");
const GITIGNORE_PATH = join(ROOT, ".gitignore");
const DOCKERIGNORE_PATH = join(ROOT, ".dockerignore");

/**
 * Read the configuration `tsc` actually resolves for tests/tsconfig.json.
 *
 * Asserts the *effective* value rather than the file's text: --showConfig
 * applies `extends`, resolves implied options, resolves duplicate keys
 * last-wins, and emits tsc's own canonical lowercase spelling. That is why
 * the retired inventory item 21 — a negative `!includes('"Node16"')`
 * substring test — is gone: a config whose effective module resolves to
 * Node16 by any route, including a duplicate key, now fails the positive
 * assertions below.
 *
 * Resolves the compiler by explicit path rather than through PATH. Inside the
 * acceptance container, PATH is prefixed with
 * /opt/spw-test-tools/node_modules/.bin, which carries `codex` and not `tsc`
 * (tests/container/Dockerfile).
 */
function readEffectiveTsconfig(): Record<string, unknown> {
  const tscBin = join(ROOT, "node_modules", ".bin", "tsc");
  const result = spawnSync(tscBin, ["--showConfig", "-p", TSCONFIG_PATH], {
    encoding: "utf8",
  });
  if (result.error !== undefined) {
    assert.fail(
      "could not run the repo TypeScript compiler — run pnpm install --frozen-lockfile",
    );
  }
  if (result.status !== 0) {
    assert.fail(
      `tsc --showConfig exited ${result.status} for ${TSCONFIG_PATH}`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    assert.fail(`tsc --showConfig did not emit JSON for ${TSCONFIG_PATH}`);
  }
  const options = (parsed as { compilerOptions?: unknown }).compilerOptions;
  if (typeof options !== "object" || options === null) {
    assert.fail(
      `tsc --showConfig emitted no compilerOptions object for ${TSCONFIG_PATH}`,
    );
  }
  return options as Record<string, unknown>;
}

function isExecutable(path: string) {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function arraysEqual(a: readonly string[], b: readonly string[]) {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

/**
 * Mirrors Ruby's `raise "..."` (a deliberate `RuntimeError`, distinct from
 * e.g. `NoMethodError`/`TypeError`). The shell driver's `rescue
 * RuntimeError; next` only treated a deliberate raise as "the validator
 * correctly rejected this mutation" — any other exception class escaped
 * and failed the driver. The mutation-rejection tests below assert
 * `instanceof ContractViolation` rather than accepting any `throw`, so an
 * accidental bug in a hand-translated validator (a stray `TypeError` from
 * indexing `undefined`, say) still fails the test instead of being
 * miscounted as a successful rejection.
 */
class ContractViolation extends Error {}

// --- Ruby-to-JS structural helpers (mirror the shell driver's embedded
// Ruby helper functions of the same name, :117-193) --------------------

/**
 * Splits text into lines, each retaining its trailing "\n" (the final
 * line may lack one) — the same semantics as Ruby's String#each_line.
 */
function splitLines(text: string): string[] {
  const lines: string[] = [];
  let start = 0;
  while (start < text.length) {
    const idx = text.indexOf("\n", start);
    if (idx === -1) {
      lines.push(text.slice(start));
      break;
    }
    lines.push(text.slice(start, idx + 1));
    start = idx + 1;
  }
  return lines;
}

/**
 * Mirrors active_lines(source) at :137-139.
 */
function activeLines(source: string): string[] {
  return splitLines(source)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"));
}

/**
 * Mirrors function_body(probe, name) at :118-135.
 */
function functionBody(source: string, name: string): string {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const startRe = new RegExp(`^${escaped}\\(\\) \\{\\n`, "m");
  const match = startRe.exec(source);
  if (!match) {
    throw new ContractViolation(`offline probe must define ${name}`);
  }
  const rest = source.slice(match.index + match[0].length);
  let body = "";

  let heredoc: string | null = null;
  for (const raw of splitLines(rest)) {
    if (heredoc !== null) {
      body += raw;
      if (raw.trim() === heredoc) heredoc = null;
      continue;
    }
    if (/^}\s*$/.test(raw)) {
      return body;
    }
    body += raw;
    const delimiterMatch = raw.match(/<<['"]?([A-Za-z_][A-Za-z0-9_]*)['"]?/);
    if (delimiterMatch) heredoc = delimiterMatch[1];
  }
  throw new ContractViolation(
    `offline probe has unterminated function ${name}`,
  );
}

/**
 * Mirrors top_level_shell_lines(probe) at :141-167.
 */
function topLevelShellLines(source: string): string[] {
  const lines: string[] = [];
  let inFunction = false;

  let heredoc: string | null = null;
  for (const raw of splitLines(source)) {
    const stripped = raw.trim();
    if (heredoc !== null) {
      if (stripped === heredoc) heredoc = null;
      continue;
    }
    if (inFunction) {
      if (/^}\s*$/.test(raw)) inFunction = false;
      continue;
    }
    if (/^[A-Za-z_][A-Za-z0-9_]*\(\) \{\s*$/.test(raw)) {
      inFunction = true;
      continue;
    }
    if (stripped.length === 0 || stripped.startsWith("#")) continue;
    lines.push(stripped);
    const delimiterMatch = raw.match(/<<['"]?([A-Za-z_][A-Za-z0-9_]*)['"]?/);
    if (delimiterMatch) heredoc = delimiterMatch[1];
  }
  if (heredoc !== null) {
    throw new ContractViolation(
      "unterminated top-level heredoc in offline probe",
    );
  }
  if (inFunction) {
    throw new ContractViolation("unterminated function in offline probe");
  }
  return lines;
}

/**
 * Mirrors require_ordered_source(source, expected, error) at :186-193.
 */
function requireOrderedSource(
  source: string,
  expected: readonly string[],
  error: string,
) {
  let cursor = -1;
  for (const statement of expected) {
    const index = source.indexOf(statement, cursor + 1);
    if (index === -1) throw new ContractViolation(error);
    cursor = index;
  }
}

/**
 * Mirrors require_ordered_lifecycle(probe, expected) at :169-184.
 */
function requireOrderedLifecycle(source: string, expected: readonly string[]) {
  const actual = topLevelShellLines(source);
  let cursor = -1;
  for (const statement of expected) {
    const index = actual.findIndex(
      (line, candidate) => candidate > cursor && line === statement,
    );
    if (index === -1) {
      throw new ContractViolation(
        `manager A/B lifecycle is missing or reordered: ${statement}`,
      );
    }
    cursor = index;
  }

  const expectedCounts: Map<string, number> = new Map();
  for (const statement of expected) {
    expectedCounts.set(statement, (expectedCounts.get(statement) ?? 0) + 1);
  }
  for (const [statement, count] of expectedCounts) {
    const actualCount = actual.filter((line) => line === statement).length;
    if (actualCount !== count) {
      throw new ContractViolation(
        `manager A/B lifecycle must execute exactly ${count} time(s): ${statement}`,
      );
    }
  }
}

/**
 * Mirrors validate_hook_response_assertion!(probe, name, terminal) at
 * :242-261.
 */
function validateHookResponseAssertion(
  probe: string,
  name: string,
  terminal: string,
) {
  const body = functionBody(probe, name);
  const requiredGate = [
    'with Path(response_name).open(encoding="utf-8") as handle:',
    "response = json.load(handle)",
    'if not isinstance(response, dict) or response.get("id") != 1:',
    'if "error" in response:',
    'result = response.get("result")',
    "if not isinstance(result, dict):",
    'data = result.get("data")',
    "if not isinstance(data, list):",
    "manager_hooks = [",
    terminal,
  ];
  assert.equal(
    requiredGate.length,
    10,
    "requiredGate lost or gained a case — update tests/migration-inventory/container-contract.md",
  );
  requireOrderedSource(
    body,
    requiredGate,
    `${name} must gate hook assertions on a successful id == 1 response`,
  );
}

// --- validate_probe! (:263-524, inventory items 41-115) ----------------

function validateProbe(probe: string) {
  if (/^\s*codex\s+plugin\s+/m.test(probe)) {
    throw new ContractViolation(
      "offline probe Codex calls must use the timeout wrapper",
    );
  }

  const runCodexLines = activeLines(functionBody(probe, "run_codex"));
  if (!arraysEqual(runCodexLines, ['"$timeout_bin" 30 codex "$@"'])) {
    throw new ContractViolation(
      "run_codex must route through the selected timeout binary",
    );
  }

  const runManagerLines = activeLines(functionBody(probe, "run_manager"));
  const expectedManagerLines = [
    'SUPERPOWERS_CONFIG_DIR="$state/config" \\',
    'SUPERPOWERS_UPSTREAM_URL="$upstream" \\',
    'SUPERPOWERS_CACHE_DIR="$state/cache" \\',
    "SUPERPOWERS_CODEX=codex \\",
    'SUPERPOWERS_INSTALLED_SEARCH_ROOT="$HOME/.codex" \\',
    '"$package/src/cli.ts" "$@"',
  ];
  if (!arraysEqual(runManagerLines, expectedManagerLines)) {
    throw new ContractViolation(
      "run_manager must route through the local package with isolated manager state",
    );
  }

  const fingerprintBody = functionBody(probe, "assert_active_installed_commit");
  const pythonBlockRe =
    /^\s*python3 -S - "\$listing" "\$expected_root" "\$expected_version" "\$expected_commit" "\$unexpected_commit" <<'PY'\n([\s\S]*?)^PY\n?(?![\s\S])/m;
  const pythonBlockMatch = pythonBlockRe.exec(fingerprintBody);
  if (!pythonBlockMatch) {
    throw new ContractViolation(
      "fingerprint helper must pass the active-version root to Python",
    );
  }
  const prefix = fingerprintBody.slice(0, pythonBlockMatch.index);
  const expectedPrefix = [
    'listing="$1"',
    'expected_version="$2"',
    'expected_commit="$3"',
    'unexpected_commit="$4"',
    'expected_root="$HOME/.codex/plugins/cache/superpowers-manager/superpowers/$expected_version"',
  ];
  if (!arraysEqual(activeLines(prefix), expectedPrefix)) {
    throw new ContractViolation(
      "fingerprint helper must derive its exact cache root from expected_version",
    );
  }

  const pythonLines = activeLines(pythonBlockMatch[1]);
  const activeRootLine = "active_root = Path(root_arg).resolve(strict=True)";
  if (
    !arraysEqual(
      pythonLines.filter((line) => /^active_root\s*=/.test(line)),
      [activeRootLine],
    )
  ) {
    throw new ContractViolation(
      "fingerprint helper must resolve exactly one active root from root_arg",
    );
  }
  const provenanceRead =
    'with (active_root / ".superpowers-upstream.json").open(encoding="utf-8") as handle:';
  const manifestRead =
    'with (active_root / ".codex-plugin" / "plugin.json").open(encoding="utf-8") as handle:';
  const bindingSequence = [
    "data = json.loads(listing)",
    'installed = data.get("installed") if isinstance(data, dict) else None',
    "matches = [",
    'if isinstance(item, dict) and item.get("pluginId") == "superpowers@superpowers-manager"',
    "if len(matches) != 1:",
    'if matches[0].get("version") != expected_version:',
    activeRootLine,
    provenanceRead,
    manifestRead,
  ];
  assert.equal(
    bindingSequence.length,
    9,
    "bindingSequence lost or gained a case — update tests/migration-inventory/container-contract.md",
  );
  {
    let cursor = -1;
    for (const statement of bindingSequence) {
      const index = pythonLines.findIndex(
        (line, candidate) => candidate > cursor && line === statement,
      );
      if (index === -1) {
        throw new ContractViolation(
          "fingerprint helper must bind active-root reads to Codex's reported version",
        );
      }
      cursor = index;
    }
  }
  if (
    !arraysEqual(
      pythonLines.filter((line) => line.includes(".superpowers-upstream.json")),
      [provenanceRead],
    )
  ) {
    throw new ContractViolation(
      "fingerprint helper must read provenance only from the active root",
    );
  }
  if (
    !arraysEqual(
      pythonLines.filter((line) => line.includes("plugin.json")),
      [manifestRead],
    )
  ) {
    throw new ContractViolation(
      "fingerprint helper must read the manifest only from the active root",
    );
  }
  if (
    pythonLines.some(
      (line) => line === "pass" || /^if\s+(?:False|0)\s*:/.test(line),
    )
  ) {
    throw new ContractViolation(
      "fingerprint helper must not hide active-root checks in a no-op block",
    );
  }

  const requiredAbSteps = [
    'commit_a=$(git -C "$upstream" rev-parse HEAD)',
    'version_a="1.0.0+manager.$short_a"',
    'commit_b=$(git -C "$upstream" rev-parse HEAD)',
    'version_b="1.1.0+manager.$short_b"',
    "run_manager track-latest",
    "run_manager install",
    "initial_listing=$(run_codex plugin list --json)",
    'assert_active_installed_commit "$initial_listing" "$version_a" "$commit_a" ""',
    "reload_listing=$(run_codex plugin list --json)",
    'assert_active_installed_commit "$reload_listing" "$version_a" "$commit_a" "$commit_b"',
    "run_manager update",
    "updated_listing=$(run_codex plugin list --json)",
    'assert_active_installed_commit "$updated_listing" "$version_b" "$commit_b" "$commit_a"',
    "run_manager uninstall",
    'assert_marketplace_root "$package"',
  ];
  assert.equal(
    requiredAbSteps.length,
    15,
    "requiredAbSteps lost or gained a case — update tests/migration-inventory/container-contract.md",
  );
  for (const text of requiredAbSteps) {
    if (!probe.includes(text)) {
      throw new ContractViolation(`missing manager A/B step: ${text}`);
    }
  }
  if (!probe.includes("reload_listing=$(run_codex plugin list --json)")) {
    throw new ContractViolation(
      "reload opportunity must use real Codex plugin inspection",
    );
  }
  if (
    /find\s+.*(?:superpowers-manager|\.superpowers-upstream\.json)/.test(
      probe,
    ) ||
    probe.includes("search_root.rglob")
  ) {
    throw new ContractViolation(
      "offline probe must not sweep retained cache paths",
    );
  }
  if (probe.includes("install_plugin_and_assert_active")) {
    throw new ContractViolation("old generic install helper must be replaced");
  }
  if (probe.includes('assert_marketplace_root "$moved"')) {
    throw new ContractViolation(
      "old moved-marketplace assertion must be replaced",
    );
  }
  if (
    !/final_plugins=\$\(run_codex plugin list --json\)[\s\S]*final_marketplaces=\$\(run_codex plugin marketplace list --json\)/.test(
      probe,
    )
  ) {
    throw new ContractViolation(
      "offline probe must capture both final listings before absence assertions",
    );
  }

  const schemaGeneration =
    'run_codex app-server generate-json-schema --out "$schema_root"';
  const rpcInvocation = '"$package/tests/container/hooks-list-rpc.py"';
  if (!probe.includes(schemaGeneration)) {
    throw new ContractViolation(
      "offline probe must generate the app-server schema",
    );
  }
  if (!(
    probe.includes('"$timeout_bin" 30 python3 -S \\') &&
    probe.includes(rpcInvocation)
  )) {
    throw new ContractViolation(
      "offline probe must invoke the bounded hooks/list helper",
    );
  }

  const hookContract = [
    'schema_root="$root/app-server-schema"',
    "Codex hooks/list protocol changed",
    "ClientRequest.json",
    "v2/HooksListResponse.json",
    '"hooks/list"',
    '"source"',
    '"enabled"',
    '"isManaged"',
    '"trustStatus"',
    '"pluginId"',
    '"plugin"',
    '"untrusted"',
    '"hooks": {}',
    '"hooks": "./hooks/hooks-codex.json"',
    // The Ruby source's literal here was single-quoted
    // (`'sh \"${PLUGIN_ROOT}/hooks/session-start-codex\"'`); in Ruby
    // single-quoted strings `\"` is not an escape sequence, so the
    // required text carries literal backslashes and guards the JSON
    // heredoc's escaped-quote spelling at `tests/container/codex-offline-probe.sh:588::sh \`.
    'sh \\"${PLUGIN_ROOT}/hooks/session-start-codex\\"',
    "/tmp/superpowers-manager-hook-sentinel",
    "$HOME/.codex/hooks.state",
    "$HOME/.codex/requirements.toml",
  ];
  assert.equal(
    hookContract.length,
    18,
    "hookContract lost or gained a case — update tests/migration-inventory/container-contract.md",
  );
  for (const text of hookContract) {
    if (!probe.includes(text)) {
      throw new ContractViolation(`missing hook acceptance contract: ${text}`);
    }
  }
  // Port-only, strictly additive: the shell driver never guarded the
  // unescaped spelling at :229 (assert_active_hooks_fixture's expected
  // Python dict literal). Both spellings must be present so a change
  // that drops either fixture is caught.
  if (!probe.includes('sh "${PLUGIN_ROOT}/hooks/session-start-codex"')) {
    throw new ContractViolation(
      'missing hook acceptance contract (unescaped spelling): sh "${PLUGIN_ROOT}/hooks/session-start-codex"',
    );
  }
  if (!probe.includes("probe_cwd=$(pwd -P)")) {
    throw new ContractViolation(
      "offline probe must resolve its real working directory",
    );
  }
  if (/(?:^|\s)session-start-codex(?:\s|$)/m.test(probe)) {
    throw new ContractViolation(
      "offline probe must not invoke the synthetic hook",
    );
  }
  if (probe.includes("--dangerously-bypass-hook-trust")) {
    throw new ContractViolation(
      "offline probe must not enable hook trust bypasses",
    );
  }
  if (/\brun_codex\s+(?:e|exec)\b/.test(probe)) {
    throw new ContractViolation("offline probe must not make model calls");
  }

  validateHookResponseAssertion(
    probe,
    "assert_manager_hooks_absent",
    "if manager_hooks:",
  );
  validateHookResponseAssertion(
    probe,
    "assert_manager_hook_active",
    "if len(manager_hooks) != 1:",
  );
  const activeBody = functionBody(probe, "assert_manager_hook_active");
  const activeFields = [
    '"source": "plugin",',
    '"pluginId": "superpowers@superpowers-manager",',
    '"trustStatus": "untrusted",',
    'if actual.get("enabled") is not True:',
    'if actual.get("isManaged") is not False:',
  ];
  assert.equal(
    activeFields.length,
    5,
    "activeFields lost or gained a case — update tests/migration-inventory/container-contract.md",
  );
  for (const text of activeFields) {
    if (!activeBody.includes(text)) {
      throw new ContractViolation(
        `active hook assertion missing exact metadata: ${text}`,
      );
    }
  }

  const schemaBody = functionBody(probe, "assert_hooks_schema_compatible");
  const schemaGates = [
    'if "pluginId" not in properties:',
    'if "pluginId" in required:',
    'fail("HookMetadata pluginId unexpectedly became required")',
    'plugin_id_types = allowed_types(hooks_response, properties["pluginId"])',
    'if plugin_id_types != {"string", "null"}:',
  ];
  assert.equal(
    schemaGates.length,
    5,
    "schemaGates lost or gained a case — update tests/migration-inventory/container-contract.md",
  );
  requireOrderedSource(
    schemaBody,
    schemaGates,
    "schema preflight must require optional, exact string-or-null pluginId",
  );

  const captureLines = activeLines(
    functionBody(probe, "capture_hooks_response"),
  );
  const expectedCaptureLines = [
    "probe_cwd=$(pwd -P)",
    'if ! "$timeout_bin" 30 python3 -S \\',
    '"$package/tests/container/hooks-list-rpc.py" \\',
    '"$probe_cwd" "$hooks_response" "$hooks_stderr"; then',
    'cat "$hooks_stderr" >&2',
    "return 1",
    "fi",
  ];
  if (!arraysEqual(captureLines, expectedCaptureLines)) {
    throw new ContractViolation(
      "capture_hooks_response must emit captured app-server stderr only on RPC failure",
    );
  }

  const topLevel = topLevelShellLines(probe);
  const managerMutations = [
    "run_manager track-latest",
    "run_manager install",
    "run_manager update",
    "run_manager uninstall",
  ];
  for (const mutation of managerMutations) {
    const indices: number[] = [];
    topLevel.forEach((line, index) => {
      if (line === mutation) indices.push(index);
    });
    if (indices.length !== 1) {
      throw new ContractViolation(
        `manager mutation must execute exactly once: ${mutation}`,
      );
    }
    const index = indices[0];
    if (!(
      topLevel[index - 1] === "hook_state_before=$(snapshot_hook_state)" &&
      topLevel[index + 1] === "hook_state_after=$(snapshot_hook_state)"
    )) {
      throw new ContractViolation(
        `manager mutation must be immediately bracketed by hook-state snapshots: ${mutation}`,
      );
    }
  }
  const unchangedCount = topLevel.filter(
    (line) =>
      line ===
      'assert_hook_state_unchanged "$hook_state_before" "$hook_state_after"',
  ).length;
  if (unchangedCount !== managerMutations.length) {
    throw new ContractViolation(
      "every manager mutation must compare hook-state snapshots",
    );
  }
  const requirementsCount = topLevel.filter(
    (line) => line === "assert_requirements_unchanged",
  ).length;
  if (requirementsCount < managerMutations.length) {
    throw new ContractViolation(
      "requirements.toml must remain unchanged across manager mutations",
    );
  }
  const sentinelCount = topLevel.filter(
    (line) => line === "assert_sentinel_absent",
  ).length;
  if (sentinelCount < 5) {
    throw new ContractViolation(
      "synthetic hook sentinel must be checked after every acceptance phase",
    );
  }

  const lifecycle = [
    'chmod +x "$package/src/cli.ts"',
    'commit_a=$(git -C "$upstream" rev-parse HEAD)',
    "short_a=$(printf '%s' \"$commit_a\" | cut -c 1-7)",
    'version_a="1.0.0+manager.$short_a"',
    "hook_state_before=$(snapshot_hook_state)",
    "run_manager track-latest",
    "hook_state_after=$(snapshot_hook_state)",
    'assert_hook_state_unchanged "$hook_state_before" "$hook_state_after"',
    "assert_requirements_unchanged",
    "hook_state_before=$(snapshot_hook_state)",
    "run_manager install",
    "hook_state_after=$(snapshot_hook_state)",
    'assert_hook_state_unchanged "$hook_state_before" "$hook_state_after"',
    "assert_requirements_unchanged",
    "assert_sentinel_absent",
    "initial_listing=$(run_codex plugin list --json)",
    'assert_marketplace_root "$package"',
    'assert_active_installed_commit "$initial_listing" "$version_a" "$commit_a" ""',
    'assert_exact_empty_hooks_fixture "$initial_listing" "$version_a"',
    'run_codex app-server generate-json-schema --out "$schema_root"',
    "assert_hooks_schema_compatible",
    "capture_hooks_response",
    'assert_manager_hooks_absent "$hooks_response"',
    "assert_sentinel_absent",
    'commit_b=$(git -C "$upstream" rev-parse HEAD)',
    "short_b=$(printf '%s' \"$commit_b\" | cut -c 1-7)",
    'version_b="1.1.0+manager.$short_b"',
    "reload_listing=$(run_codex plugin list --json)",
    "printf '%s\\n' \"$reload_listing\" | grep -Fq 'superpowers@superpowers-manager'",
    'assert_marketplace_root "$package"',
    'assert_active_installed_commit "$reload_listing" "$version_a" "$commit_a" "$commit_b"',
    "hook_state_before=$(snapshot_hook_state)",
    "run_manager update",
    "hook_state_after=$(snapshot_hook_state)",
    'assert_hook_state_unchanged "$hook_state_before" "$hook_state_after"',
    "assert_requirements_unchanged",
    "assert_sentinel_absent",
    "updated_listing=$(run_codex plugin list --json)",
    'assert_active_installed_commit "$updated_listing" "$version_b" "$commit_b" "$commit_a"',
    'assert_active_hooks_fixture "$updated_listing" "$version_b"',
    "capture_hooks_response",
    'assert_manager_hook_active "$hooks_response"',
    "assert_sentinel_absent",
    "hook_state_before=$(snapshot_hook_state)",
    "run_manager uninstall",
    "hook_state_after=$(snapshot_hook_state)",
    'assert_hook_state_unchanged "$hook_state_before" "$hook_state_after"',
    "assert_requirements_unchanged",
    "assert_sentinel_absent",
    "final_plugins=$(run_codex plugin list --json)",
    "final_marketplaces=$(run_codex plugin marketplace list --json)",
  ];
  assert.equal(
    lifecycle.length,
    51,
    "lifecycle lost or gained a case — update tests/migration-inventory/container-contract.md",
  );
  requireOrderedLifecycle(probe, lifecycle);
}

// --- validate_hooks_rpc! (:195-240, inventory items 116-142) -----------

function validateHooksRpc(hooksRpc: string) {
  const required = [
    'raise SystemExit(f"Codex hooks/list protocol failed: {message}")',
    "if process.poll() is not None or process.stdin is None:",
    'fail(f"could not send request: {exc}")',
    "def reject_constant(constant: str) -> None:",
    'raise ValueError(f"non-standard numeric constant: {constant}")',
    "parse_constant=reject_constant",
    'fail(f"malformed JSONL response: {exc}")',
    "deadline = time.monotonic() + 25",
    "remaining = deadline - time.monotonic()",
    "if remaining <= 0 or not selector.select(remaining):",
    'fail("timed out waiting for app-server output")',
    'fail("app-server stdout is unavailable")',
    "chunk = os.read(process.stdout.fileno(), 65536)",
    "if not chunk:",
    'fail("EOF before the required response")',
    "if not isinstance(message, dict):",
    'id_value = message.get("id")',
    "if type(id_value) is not int or id_value != expected_id:",
    'if "error" in message:',
    'if "result" not in message:',
    'fail(f"response id {expected_id} has no result")',
    '["codex", "app-server"]',
    "stdin=subprocess.PIPE",
    "stdout=subprocess.PIPE",
    'fail("app-server stdout pipe was not created")',
    "selector.register(process.stdout, selectors.EVENT_READ)",
  ];
  assert.equal(
    required.length,
    26,
    "required (validateHooksRpc) lost or gained a case — update tests/migration-inventory/container-contract.md",
  );
  for (const text of required) {
    if (!hooksRpc.includes(text)) {
      throw new ContractViolation(`RPC helper missing protocol gate: ${text}`);
    }
  }

  const handshake = [
    '"id": 0,',
    '"method": "initialize",',
    "receive(process, selector, 0)",
    'send(process, {"method": "initialized"})',
    'send(process, {"id": 1, "method": "hooks/list", "params": {"cwds": [cwd]}})',
    "response = receive(process, selector, 1)",
    "Path(response_name).write_text(",
  ];
  assert.equal(
    handshake.length,
    7,
    "handshake lost or gained a case — update tests/migration-inventory/container-contract.md",
  );
  requireOrderedSource(
    hooksRpc,
    handshake,
    "RPC helper must keep the staged initialize and hooks/list handshake",
  );
}

// --- validate the "--inside" branch of tests/container.sh (:95-115,
// inventory items 38-40) -------------------------------------------------

function validateRunnerInsideBranch(runner: string) {
  const insideRe =
    /^if \[ "\$\{1:-\}" = "--inside" \]; then\n([\s\S]*?)^fi\n\nmode="\$\{1:-suite\}"/m;
  const insideMatch = insideRe.exec(runner);
  if (!insideMatch) {
    throw new ContractViolation(
      "runner must define the --inside branch before host-side mode dispatch",
    );
  }
  const insideLines = splitLines(insideMatch[1]).map((line) =>
    line.replace(/\s+$/, ""),
  );
  const uidGuard = [
    "  actual_uid=$(id -u)",
    '  if [ "$actual_uid" != 10001 ]; then',
    '    echo "error: container acceptance suite must run as UID 10001 (got $actual_uid)" >&2',
    "    exit 1",
    "  fi",
  ];
  let guardIndex = -1;
  for (let i = 0; i + uidGuard.length <= insideLines.length; i += 1) {
    if (uidGuard.every((line, j) => insideLines[i + j] === line)) {
      guardIndex = i;
      break;
    }
  }
  const modeIndex = insideLines.indexOf('  mode="${2:-suite}"');
  const dispatchIndex = insideLines.indexOf('  case "$mode" in');
  if (
    guardIndex === -1 ||
    modeIndex === -1 ||
    dispatchIndex === -1 ||
    !(guardIndex < modeIndex && modeIndex < dispatchIndex)
  ) {
    throw new ContractViolation(
      "--inside must reject UIDs other than 10001 before selecting or dispatching the acceptance mode",
    );
  }
  const suiteRe =
    /suite\)\s+sh tests\/run\.sh\s+exec sh tests\/container\/codex-offline-probe\.sh\s+;;/;
  if (!suiteRe.test(runner)) {
    throw new ContractViolation(
      "suite mode must run the inner suite and then the offline Codex probe",
    );
  }
}

void test("container-contract", async (t) => {
  // --- inventory items 1-6: file-existence / executable-bit -----------

  await t.test("tests/container/Dockerfile exists", () => {
    assert.ok(existsSync(DOCKERFILE_PATH));
  });
  await t.test("tests/container.sh is executable", () => {
    assert.ok(isExecutable(RUNNER_PATH));
  });
  await t.test("tests/container/package.json exists", () => {
    assert.ok(existsSync(TOOLS_PACKAGE_PATH));
  });
  await t.test("tests/container/codex-offline-probe.sh is executable", () => {
    assert.ok(isExecutable(PROBE_PATH));
  });
  await t.test("tests/tsconfig.json exists", () => {
    assert.ok(existsSync(TSCONFIG_PATH));
  });
  await t.test(".dockerignore exists", () => {
    assert.ok(existsSync(DOCKERIGNORE_PATH));
  });

  await t.test("Dockerfile resource contract", async (t) => {
    const dockerfile = readFileSync(DOCKERFILE_PATH, "utf8");
    const dockerfileLines = dockerfile.split("\n");

    // --- inventory items 7-13: Dockerfile literal-text -------------------

    await t.test(
      "Dockerfile separates native harness and installed-package minimum runtimes",
      () => {
        const directives = activeLines(dockerfile);
        const stages = directives
          .filter((line) => /^FROM\s/i.test(line))
          .map((line) => line.split(/\s+/));
        assert.equal(
          stages.length,
          2,
          "expected minimum binary source and native harness stages",
        );
        assert.deepEqual(stages[0].slice(1), [
          "node:24.0.0-bookworm-slim",
          "AS",
          "minimum-node",
        ]);
        assert.deepEqual(stages[1].slice(1), [
          "node:${NATIVE_NODE_VERSION}-bookworm-slim",
        ]);
        assert.ok(
          directives.indexOf("ARG NATIVE_NODE_VERSION=24") <
            directives.indexOf(stages[0].join(" ")),
        );
        assert.ok(directives.includes("ARG NATIVE_NODE_VERSION=24"));
        requireOrderedSource(
          dockerfile,
          [
            stages[1].join(" "),
            "COPY --from=minimum-node /usr/local/bin/node /opt/node-min/bin/node",
            "RUN /opt/node-min/bin/node --version",
            "ENV SPW_PACKAGE_NODE=/opt/node-min/bin/node",
            "ENV SPW_PACKAGE_NODE_VERSION=24.0.0",
          ],
          "the final harness must verify and declare the copied package minimum binary",
        );
        assert.ok(directives.includes("ENV SPW_CONTAINER=1"));
      },
    );
    await t.test(
      "Dockerfile creates the spw user with uid 10001 (exact line)",
      () => {
        assert.ok(
          dockerfileLines.includes("RUN useradd --create-home --uid 10001 spw"),
        );
      },
    );
    await t.test("Dockerfile switches to USER spw (exact line)", () => {
      assert.ok(dockerfileLines.includes("USER spw"));
    });
    await t.test("Dockerfile smoke-tests the codex binary", () => {
      assert.ok(
        dockerfile.includes("./node_modules/.bin/codex --version >/dev/null"),
      );
    });
    await t.test("Dockerfile enables corepack", () => {
      assert.ok(dockerfile.includes("corepack enable"));
    });
    await t.test("Dockerfile installs with a frozen lockfile", () => {
      assert.ok(dockerfile.includes("pnpm install --frozen-lockfile"));
    });
    await t.test(
      "Dockerfile runs native sources without a checkout build",
      () => {
        assert.doesNotMatch(dockerfile, /\bpnpm run build\b/);
        assert.match(dockerfile, /chmod \+x[^\n]*\bsrc\/cli\.ts\b/);
        assert.ok(isExecutable(join(ROOT, "src", "cli.ts")));
      },
    );

    await t.test(
      "Dockerfile installs exactly the expected system packages",
      () => {
        // Join every backslash-continued line into one logical line first, so a
        // package added on a SECOND continuation line cannot hide. The first
        // draft of this assertion captured only the first physical line after
        // `--no-install-recommends`, which meant `curl \` on the next line was
        // invisible while the assertion still claimed "exact set". Corrected
        // 2026-08-02 after review.
        const logicalLines = dockerfile.replace(/\\\n\s*/g, " ").split("\n");

        const installLines = logicalLines.filter((line) =>
          line.includes("apt-get install"),
        );
        assert.equal(
          installLines.length,
          1,
          "expected exactly one apt-get install command in the Dockerfile",
        );

        // `--no-install-recommends` is its own contract, asserted separately
        // rather than used as the parse boundary. Using it as the boundary
        // would only see packages written AFTER it, so
        // `apt-get install -y ruby --no-install-recommends` would install ruby
        // and still pass. Found by the final whole-branch review, 2026-08-02.
        assert.ok(
          installLines[0].includes("--no-install-recommends"),
          "apt-get install command lost its --no-install-recommends flag",
        );

        // The logical line is `RUN apt-get update && apt-get install -y
        // --no-install-recommends <packages> && rm -rf …`. Slice from after
        // `apt-get install`, stop at the next `&&` command boundary, and drop
        // flag tokens wherever they appear — so a package is caught whether it
        // is written before or after the flags, and on any continuation line.
        const afterInstall = installLines[0].split("apt-get install")[1];
        assert.ok(
          afterInstall !== undefined,
          "expected an `apt-get install` command in the Dockerfile",
        );

        const packages = afterInstall
          .split("&&")[0]
          .trim()
          .split(/\s+/)
          .filter(Boolean)
          .filter((token) => !token.startsWith("-"))
          .sort();
        assert.deepEqual(
          packages,
          ["ca-certificates", "git", "procps", "python3"],
          "the container's system package set changed — every entry is a supply-chain and toolchain commitment",
        );
      },
    );
  });

  // --- inventory items 14-18: container tool package/lockfile ----------

  await t.test(
    "tests/container/package.json declares exactly one dependency, @openai/codex, exact-pinned and lockfile-consistent",
    () => {
      const packageData = JSON.parse(readFileSync(TOOLS_PACKAGE_PATH, "utf8"));
      const lockData = JSON.parse(readFileSync(LOCKFILE_PATH, "utf8"));

      const dependencies = packageData.dependencies;
      assert.ok(
        dependencies && typeof dependencies === "object",
        "container tool package must declare dependencies",
      );
      assert.equal(
        Object.keys(dependencies).join("\n"),
        "@openai/codex",
        "container tool package must contain only @openai/codex",
      );

      const declared = dependencies["@openai/codex"];
      const exactSemver =
        /^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:-[0-9A-Za-z.-]+)?$/;
      assert.ok(
        typeof declared === "string" && exactSemver.test(declared),
        "@openai/codex must use an exact semantic-version pin",
      );

      const lockedRoot =
        lockData.packages?.[""]?.dependencies?.["@openai/codex"];
      const lockedPackage =
        lockData.packages?.["node_modules/@openai/codex"]?.version;
      assert.equal(
        lockedRoot,
        declared,
        "@openai/codex package and lockfile root dependency versions must agree",
      );
      assert.equal(
        lockedPackage,
        declared,
        "@openai/codex package and lockfile packages entry versions must agree",
      );
    },
  );

  // --- inventory items 19-20: tests/tsconfig.json (item 21 retired) ------
  // Item 21 was a negative `!includes('"Node16"')` substring check. It is
  // retired rather than renumbered: asserting the effective compiler config
  // subsumes it, because a duplicate "module" key resolving to Node16 fails
  // the positive assertions below. See the inventory for the retirement note.

  await t.test('tsconfig resolves "module" to NodeNext', () => {
    const effectiveTsconfig = readEffectiveTsconfig();
    assert.equal(String(effectiveTsconfig.module).toLowerCase(), "nodenext");
  });
  await t.test('tsconfig resolves "moduleResolution" to NodeNext', () => {
    const effectiveTsconfig = readEffectiveTsconfig();
    assert.equal(
      String(effectiveTsconfig.moduleResolution).toLowerCase(),
      "nodenext",
    );
  });

  // --- inventory items 22-28: tests/container.sh literal-text ----------

  await t.test("container runner resource contract", async (t) => {
    const runner = readFileSync(RUNNER_PATH, "utf8");

    await t.test("runner disables networking", () => {
      assert.ok(runner.includes("--network none"));
    });
    await t.test("runner runs read-only", () => {
      assert.ok(runner.includes("--read-only"));
      assert.ok(runner.includes("--tmpfs /tmp:rw,exec,nosuid,size=512m"));
      assert.ok(runner.includes("docker run --rm"));
    });
    await t.test("runner pulls the base image on build", () => {
      assert.ok(runner.includes("docker build --pull "));
      assert.match(runner, /native_node=\$\{SPW_NATIVE_NODE_VERSION:-24\}/);
      assert.match(runner, /case "\$native_node" in\s+24\.12\.0\|24\)/);
      assert.match(runner, /--build-arg "NATIVE_NODE_VERSION=\$native_node"/);
      assert.match(
        runner,
        /image="superpowers-manager-test:node-\$native_node"/,
      );
      for (const selector of ["22", "24.0.0", "24.12.1", "24; echo injected"]) {
        const rejected = spawnSync("/bin/sh", [RUNNER_PATH], {
          encoding: "utf8",
          env: { PATH: "/usr/bin:/bin", SPW_NATIVE_NODE_VERSION: selector },
        });
        assert.equal(rejected.status, 2, rejected.stderr);
        assert.equal(rejected.stdout, "");
        assert.equal(
          rejected.stderr,
          "error: SPW_NATIVE_NODE_VERSION must be 24.12.0 or 24\n",
        );
      }
    });
    await t.test("runner mounts a writable tmpfs home for uid 10001", () => {
      assert.ok(
        runner.includes(
          "--tmpfs /home/spw:rw,nosuid,size=128m,uid=10001,gid=10001",
        ),
      );
    });
    await t.test("runner defines the codex-spike mode", () => {
      assert.ok(runner.includes("codex-spike)"));
    });
    await t.test("runner reads the actual container uid", () => {
      assert.ok(runner.includes("actual_uid=$(id -u)"));
    });
    await t.test("runner's UID guard diagnostic is present", () => {
      assert.ok(
        runner.includes("container acceptance suite must run as UID 10001"),
      );
    });

    // --- inventory items 38-40: runner --inside structural check ---------

    await t.test(
      "runner's --inside branch gates UID 10001 before mode selection and dispatch, then routes suite mode through run.sh and the offline probe",
      () => {
        assert.doesNotThrow(() => validateRunnerInsideBranch(runner));
      },
    );
  });

  // --- inventory items 29-33: .gitignore / .dockerignore exact lines ---

  await t.test("gitignore resource contract", async (t) => {
    const gitignoreLines = readFileSync(GITIGNORE_PATH, "utf8").split("\n");

    await t.test(
      ".gitignore ignores plugins/.superpowers.bak.*/ (exact line)",
      () => {
        assert.ok(gitignoreLines.includes("plugins/.superpowers.bak.*/"));
      },
    );
  });

  await t.test("dockerignore resource contract", async (t) => {
    const dockerignoreLines = readFileSync(DOCKERIGNORE_PATH, "utf8").split(
      "\n",
    );

    await t.test(".dockerignore ignores .superpowers/ (exact line)", () => {
      assert.ok(dockerignoreLines.includes(".superpowers/"));
      for (const exclusion of [
        ".git",
        ".cache",
        "dist/",
        "node_modules",
        "*.tgz",
        "docs/superpowers",
        "plugins/superpowers/**",
      ]) {
        assert.ok(
          dockerignoreLines.includes(exclusion),
          `missing build-context exclusion: ${exclusion}`,
        );
      }
    });
    await t.test(".dockerignore ignores .worktrees/ (exact line)", () => {
      assert.ok(dockerignoreLines.includes(".worktrees/"));
    });
    await t.test(
      ".dockerignore ignores plugins/.superpowers.prepare.*/ (exact line)",
      () => {
        assert.ok(
          dockerignoreLines.includes("plugins/.superpowers.prepare.*/"),
        );
      },
    );
    await t.test(
      ".dockerignore ignores plugins/.superpowers.bak.*/ (exact line)",
      () => {
        assert.ok(dockerignoreLines.includes("plugins/.superpowers.bak.*/"));
      },
    );
  });

  // --- inventory items 34-35: hooks-list-rpc.py file preconditions ------

  await t.test("tests/container/hooks-list-rpc.py exists", () => {
    assert.ok(existsSync(HOOKS_RPC_PATH));
  });
  await t.test("tests/container/hooks-list-rpc.py is not executable", () => {
    assert.ok(!isExecutable(HOOKS_RPC_PATH));
  });

  await t.test("hooks RPC resource contract", async (t) => {
    const hooksRpc = readFileSync(HOOKS_RPC_PATH, "utf8");

    // --- inventory items 36-37: hooks-list-rpc.py content assertions -----

    await t.test(
      "hooks-list-rpc.py opts into postponed annotations (exact line)",
      () => {
        assert.ok(
          hooksRpc.split("\n").includes("from __future__ import annotations"),
        );
      },
    );
    await t.test("hooks-list-rpc.py is syntactically valid Python", () => {
      const result = spawnSync(
        "python3",
        ["-S", "-c", "import ast, sys; ast.parse(sys.stdin.read())"],
        { input: hooksRpc, encoding: "utf8" },
      );
      if (result.error) {
        assert.fail(
          "python3 -S could not be run — is python3 installed and on PATH?",
        );
      }
      assert.equal(
        result.status,
        0,
        "hooks-list-rpc.py failed to parse as Python",
      );
    });

    // --- inventory items 116-142: hooks-list-rpc.py protocol gates -------

    await t.test(
      "hooks-list-rpc.py satisfies the full protocol-gate/handshake-ordering contract",
      () => {
        assert.doesNotThrow(() => validateHooksRpc(hooksRpc));
      },
    );

    // --- inventory items 153-172: RPC-helper semantic-mutation fixtures --
    // Mirrors the `rpc_mutations` hash at :584-665.

    const rpcMutations: Record<string, { source: string; message: string }> = {
      "missing pre-send process check": {
        source: hooksRpc.replace(
          "if process.poll() is not None or process.stdin is None:",
          "if False:",
        ),
        message:
          "RPC helper missing protocol gate: if process.poll() is not None or process.stdin is None:",
      },
      "missing send failure gate": {
        source: hooksRpc.replace(
          'fail(f"could not send request: {exc}")',
          "pass",
        ),
        message:
          'RPC helper missing protocol gate: fail(f"could not send request: {exc}")',
      },
      "missing malformed JSON gate": {
        source: hooksRpc.replace(
          'fail(f"malformed JSONL response: {exc}")',
          "pass",
        ),
        message:
          'RPC helper missing protocol gate: fail(f"malformed JSONL response: {exc}")',
      },
      "missing non-standard constant parser": {
        source: hooksRpc.replace(", parse_constant=reject_constant", ""),
        message:
          "RPC helper missing protocol gate: parse_constant=reject_constant",
      },
      "weakened non-standard constant rejection": {
        source: hooksRpc.replace(
          'raise ValueError(f"non-standard numeric constant: {constant}")',
          "return None",
        ),
        message:
          'RPC helper missing protocol gate: raise ValueError(f"non-standard numeric constant: {constant}")',
      },
      "removed deadline": {
        source: hooksRpc.replace(
          "deadline = time.monotonic() + 25",
          'deadline = float("inf")',
        ),
        message:
          "RPC helper missing protocol gate: deadline = time.monotonic() + 25",
      },
      "unbounded selector wait": {
        source: hooksRpc.replace(
          "if remaining <= 0 or not selector.select(remaining):",
          "if not selector.select():",
        ),
        message:
          "RPC helper missing protocol gate: if remaining <= 0 or not selector.select(remaining):",
      },
      "missing EOF failure": {
        source: hooksRpc.replace(
          'fail("EOF before the required response")',
          "return {}",
        ),
        message:
          'RPC helper missing protocol gate: fail("EOF before the required response")',
      },
      "missing stream availability gate": {
        source: hooksRpc.replace(
          'fail("app-server stdout is unavailable")',
          "pass",
        ),
        message:
          'RPC helper missing protocol gate: fail("app-server stdout is unavailable")',
      },
      "missing JSON object check": {
        source: hooksRpc.replace(
          "if not isinstance(message, dict):",
          "if False:",
        ),
        message:
          "RPC helper missing protocol gate: if not isinstance(message, dict):",
      },
      "missing response id gate": {
        source: hooksRpc.replace(
          "if type(id_value) is not int or id_value != expected_id:",
          "if False:",
        ),
        message:
          "RPC helper missing protocol gate: if type(id_value) is not int or id_value != expected_id:",
      },
      "weakened exact response id type": {
        source: hooksRpc.replace(
          "if type(id_value) is not int or id_value != expected_id:",
          "if id_value != expected_id:",
        ),
        message:
          "RPC helper missing protocol gate: if type(id_value) is not int or id_value != expected_id:",
      },
      "missing RPC error gate": {
        source: hooksRpc.replace('if "error" in message:', "if False:"),
        message: 'RPC helper missing protocol gate: if "error" in message:',
      },
      "skipped initialize request": {
        source: hooksRpc.replace(
          '"method": "initialize",',
          '"method": "not-initialize",',
        ),
        message:
          "RPC helper must keep the staged initialize and hooks/list handshake",
      },
      "missing app-server pipe gate": {
        source: hooksRpc.replace(
          'fail("app-server stdout pipe was not created")',
          "pass",
        ),
        message:
          'RPC helper missing protocol gate: fail("app-server stdout pipe was not created")',
      },
      "skipped initialize response": {
        source: hooksRpc.replace("receive(process, selector, 0)", "pass"),
        message:
          "RPC helper must keep the staged initialize and hooks/list handshake",
      },
      "skipped initialized notification": {
        source: hooksRpc.replace(
          'send(process, {"method": "initialized"})',
          "pass",
        ),
        message:
          "RPC helper must keep the staged initialize and hooks/list handshake",
      },
      "skipped hooks request": {
        source: hooksRpc.replace(
          'send(process, {"id": 1, "method": "hooks/list", "params": {"cwds": [cwd]}})',
          "pass",
        ),
        message:
          "RPC helper must keep the staged initialize and hooks/list handshake",
      },
      "missing hooks response presence gate": {
        source: hooksRpc.replace(
          "response = receive(process, selector, 1)",
          'response = {"id": 1, "result": {"data": []}}',
        ),
        message:
          "RPC helper must keep the staged initialize and hooks/list handshake",
      },
      "missing result gate": {
        source: hooksRpc.replace('if "result" not in message:', "if False:"),
        message:
          'RPC helper missing protocol gate: if "result" not in message:',
      },
    };
    assert.equal(
      Object.keys(rpcMutations).length,
      20,
      "rpcMutations lost or gained a case — update tests/migration-inventory/container-contract.md",
    );

    for (const [name, { source, message }] of Object.entries(rpcMutations)) {
      await t.test(`RPC helper semantic mutation is rejected: ${name}`, () => {
        assert.notEqual(
          source,
          hooksRpc,
          `mutation fixture made no change: ${name}`,
        );
        assert.throws(
          () => validateHooksRpc(source),
          exactError(ContractViolation, message),
          name,
        );
      });
    }
  });

  await t.test("offline probe resource contract", async (t) => {
    const probe = readFileSync(PROBE_PATH, "utf8");

    // --- inventory items 41-115: codex-offline-probe.sh structure --------

    await t.test(
      "codex-offline-probe.sh satisfies the full structural/ordering contract",
      () => {
        assert.doesNotThrow(() => validateProbe(probe));
      },
    );

    // --- inventory items 143-152: probe semantic-mutation fixtures -------
    // Mirrors the `mutations` hash at :531-572: each entry is a single
    // substring rewrite of the real probe text that must be rejected by
    // validateProbe.

    const probeMutations: Record<string, { source: string; message: string }> =
      {
        "no-op run_manager": {
          source: probe.replace(
            /^run_manager\(\) \{\n[\s\S]*?^\}\n/m,
            "run_manager() {\n  :\n}\n",
          ),
          message:
            "run_manager must route through the local package with isolated manager state",
        },
        "unbracketed install lifecycle": {
          source: probe.replace(
            "hook_state_before=$(snapshot_hook_state)\nrun_manager install\nhook_state_after=$(snapshot_hook_state)",
            "run_manager install",
          ),
          message:
            "manager mutation must be immediately bracketed by hook-state snapshots: run_manager install",
        },
        "unbound fingerprint root": {
          source: probe.replace(
            'expected_root="$HOME/.codex/plugins/cache/superpowers-manager/superpowers/$expected_version"',
            'expected_root="/tmp/unbound-manager-cache"',
          ),
          message:
            "fingerprint helper must derive its exact cache root from expected_version",
        },
        "unbound Codex listing version": {
          source: probe.replace(
            'if matches[0].get("version") != expected_version:',
            "if expected_version != expected_version:",
          ),
          message:
            "fingerprint helper must bind active-root reads to Codex's reported version",
        },
        "required pluginId accepted": {
          source: probe.replace('if "pluginId" in required:', "if False:"),
          message:
            "schema preflight must require optional, exact string-or-null pluginId",
        },
        "additional pluginId types accepted": {
          source: probe.replace(
            'if plugin_id_types != {"string", "null"}:',
            'if not {"string", "null"}.issubset(plugin_id_types):',
          ),
          message:
            "schema preflight must require optional, exact string-or-null pluginId",
        },
        "non-boolean enabled accepted": {
          source: probe.replace(
            'if actual.get("enabled") is not True:',
            'if actual.get("enabled") != True:',
          ),
          message:
            'active hook assertion missing exact metadata: if actual.get("enabled") is not True:',
        },
        "non-boolean isManaged accepted": {
          source: probe.replace(
            'if actual.get("isManaged") is not False:',
            'if actual.get("isManaged") != False:',
          ),
          message:
            'active hook assertion missing exact metadata: if actual.get("isManaged") is not False:',
        },
        "captured hooks stderr removed": {
          source: probe.replace('cat "$hooks_stderr" >&2', ":"),
          message:
            "capture_hooks_response must emit captured app-server stderr only on RPC failure",
        },
        "captured hooks stderr leaked to stdout": {
          source: probe.replace(
            'cat "$hooks_stderr" >&2',
            'cat "$hooks_stderr"',
          ),
          message:
            "capture_hooks_response must emit captured app-server stderr only on RPC failure",
        },
      };
    assert.equal(
      Object.keys(probeMutations).length,
      10,
      "probeMutations lost or gained a case — update tests/migration-inventory/container-contract.md",
    );

    for (const [name, { source, message }] of Object.entries(probeMutations)) {
      await t.test(`probe semantic mutation is rejected: ${name}`, () => {
        assert.notEqual(
          source,
          probe,
          `mutation fixture made no change: ${name}`,
        );
        assert.throws(
          () => validateProbe(source),
          exactError(ContractViolation, message),
          name,
        );
      });
    }
  });
});
