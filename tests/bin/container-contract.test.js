// @ts-check
// Ported from tests/test_container_contract.sh (see
// tests/migration-inventory/test_container_contract.md for the numbered
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
 * applies `extends`, fills defaults, resolves duplicate keys last-wins, and
 * emits tsc's own canonical lowercase spelling. That is why the retired
 * inventory item 21 — a negative `!includes('"Node16"')` substring test — is
 * gone: a config whose effective module resolves to Node16 by any route,
 * including a duplicate key, now fails the positive assertions below.
 *
 * Resolves the compiler by explicit path rather than through PATH. Inside the
 * acceptance container, PATH is prefixed with
 * /opt/spw-test-tools/node_modules/.bin, which carries `codex` and not `tsc`
 * (tests/container/Dockerfile).
 * @returns {Record<string, unknown>}
 */
function readEffectiveTsconfig() {
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
  /** @type {unknown} */
  let parsed;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    assert.fail(`tsc --showConfig did not emit JSON for ${TSCONFIG_PATH}`);
  }
  const options = /** @type {{compilerOptions?: unknown}} */ (parsed)
    .compilerOptions;
  if (typeof options !== "object" || options === null) {
    assert.fail(
      `tsc --showConfig emitted no compilerOptions object for ${TSCONFIG_PATH}`,
    );
  }
  return /** @type {Record<string, unknown>} */ (options);
}

/** @param {string} path */
function isExecutable(path) {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** @param {readonly string[]} a @param {readonly string[]} b */
function arraysEqual(a, b) {
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
 * @param {string} text
 * @returns {string[]}
 */
function splitLines(text) {
  /** @type {string[]} */
  const lines = [];
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
 * @param {string} source
 * @returns {string[]}
 */
function activeLines(source) {
  return splitLines(source)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"));
}

/**
 * Mirrors function_body(probe, name) at :118-135.
 * @param {string} source
 * @param {string} name
 * @returns {string}
 */
function functionBody(source, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const startRe = new RegExp(`^${escaped}\\(\\) \\{\\n`, "m");
  const match = startRe.exec(source);
  if (!match) {
    throw new ContractViolation(`offline probe must define ${name}`);
  }
  const rest = source.slice(match.index + match[0].length);
  let body = "";
  /** @type {string | null} */
  let heredoc = null;
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
 * @param {string} source
 * @returns {string[]}
 */
function topLevelShellLines(source) {
  /** @type {string[]} */
  const lines = [];
  let inFunction = false;
  /** @type {string | null} */
  let heredoc = null;
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
 * @param {string} source
 * @param {readonly string[]} expected
 * @param {string} error
 */
function requireOrderedSource(source, expected, error) {
  let cursor = -1;
  for (const statement of expected) {
    const index = source.indexOf(statement, cursor + 1);
    if (index === -1) throw new ContractViolation(error);
    cursor = index;
  }
}

/**
 * Mirrors require_ordered_lifecycle(probe, expected) at :169-184.
 * @param {string} source
 * @param {readonly string[]} expected
 */
function requireOrderedLifecycle(source, expected) {
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
  /** @type {Map<string, number>} */
  const expectedCounts = new Map();
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
 * @param {string} probe
 * @param {string} name
 * @param {string} terminal
 */
function validateHookResponseAssertion(probe, name, terminal) {
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
    "requiredGate lost or gained a case — update tests/migration-inventory/test_container_contract.md",
  );
  requireOrderedSource(
    body,
    requiredGate,
    `${name} must gate hook assertions on a successful id == 1 response`,
  );
}

// --- validate_probe! (:263-524, inventory items 41-115) ----------------

/** @param {string} probe */
function validateProbe(probe) {
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
    '"$package/bin/superpowers-manager.js" "$@"',
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
    "bindingSequence lost or gained a case — update tests/migration-inventory/test_container_contract.md",
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
    "requiredAbSteps lost or gained a case — update tests/migration-inventory/test_container_contract.md",
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
    // heredoc's escaped-quote spelling at codex-offline-probe.sh:588.
    'sh \\"${PLUGIN_ROOT}/hooks/session-start-codex\\"',
    "/tmp/superpowers-manager-hook-sentinel",
    "$HOME/.codex/hooks.state",
    "$HOME/.codex/requirements.toml",
  ];
  assert.equal(
    hookContract.length,
    18,
    "hookContract lost or gained a case — update tests/migration-inventory/test_container_contract.md",
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
    "activeFields lost or gained a case — update tests/migration-inventory/test_container_contract.md",
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
    "schemaGates lost or gained a case — update tests/migration-inventory/test_container_contract.md",
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
    /** @type {number[]} */
    const indices = [];
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
    'chmod +x "$package/bin/superpowers-manager.js"',
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
    "lifecycle lost or gained a case — update tests/migration-inventory/test_container_contract.md",
  );
  requireOrderedLifecycle(probe, lifecycle);
}

// --- validate_hooks_rpc! (:195-240, inventory items 116-142) -----------

/** @param {string} hooksRpc */
function validateHooksRpc(hooksRpc) {
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
    "required (validateHooksRpc) lost or gained a case — update tests/migration-inventory/test_container_contract.md",
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
    "handshake lost or gained a case — update tests/migration-inventory/test_container_contract.md",
  );
  requireOrderedSource(
    hooksRpc,
    handshake,
    "RPC helper must keep the staged initialize and hooks/list handshake",
  );
}

// --- validate the "--inside" branch of tests/container.sh (:95-115,
// inventory items 38-40) -------------------------------------------------

/** @param {string} runner */
function validateRunnerInsideBranch(runner) {
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

  const dockerfile = readFileSync(DOCKERFILE_PATH, "utf8");
  const dockerfileLines = dockerfile.split("\n");

  // --- inventory items 7-13: Dockerfile literal-text -------------------

  await t.test(
    "Dockerfile base image is node:24-bookworm-slim (exact line)",
    () => {
      assert.ok(dockerfileLines.includes("FROM node:24-bookworm-slim"));
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
  await t.test("Dockerfile builds the package", () => {
    assert.ok(dockerfile.includes("pnpm run build"));
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

  const effectiveTsconfig = readEffectiveTsconfig();

  await t.test('tsconfig resolves "module" to NodeNext', () => {
    assert.equal(String(effectiveTsconfig.module).toLowerCase(), "nodenext");
  });
  await t.test('tsconfig resolves "moduleResolution" to NodeNext', () => {
    assert.equal(
      String(effectiveTsconfig.moduleResolution).toLowerCase(),
      "nodenext",
    );
  });

  // --- inventory items 22-28: tests/container.sh literal-text ----------

  const runner = readFileSync(RUNNER_PATH, "utf8");

  await t.test("runner disables networking", () => {
    assert.ok(runner.includes("--network none"));
  });
  await t.test("runner runs read-only", () => {
    assert.ok(runner.includes("--read-only"));
  });
  await t.test("runner pulls the base image on build", () => {
    assert.ok(runner.includes("docker build --pull "));
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

  // --- inventory items 29-33: .gitignore / .dockerignore exact lines ---

  const gitignoreLines = readFileSync(GITIGNORE_PATH, "utf8").split("\n");
  const dockerignoreLines = readFileSync(DOCKERIGNORE_PATH, "utf8").split("\n");

  await t.test(
    ".gitignore ignores plugins/.superpowers.bak.*/ (exact line)",
    () => {
      assert.ok(gitignoreLines.includes("plugins/.superpowers.bak.*/"));
    },
  );
  await t.test(".dockerignore ignores .superpowers/ (exact line)", () => {
    assert.ok(dockerignoreLines.includes(".superpowers/"));
  });
  await t.test(".dockerignore ignores .worktrees/ (exact line)", () => {
    assert.ok(dockerignoreLines.includes(".worktrees/"));
  });
  await t.test(
    ".dockerignore ignores plugins/.superpowers.prepare.*/ (exact line)",
    () => {
      assert.ok(dockerignoreLines.includes("plugins/.superpowers.prepare.*/"));
    },
  );
  await t.test(
    ".dockerignore ignores plugins/.superpowers.bak.*/ (exact line)",
    () => {
      assert.ok(dockerignoreLines.includes("plugins/.superpowers.bak.*/"));
    },
  );

  // --- inventory items 34-37: hooks-list-rpc.py file assertions --------

  await t.test("tests/container/hooks-list-rpc.py exists", () => {
    assert.ok(existsSync(HOOKS_RPC_PATH));
  });
  await t.test("tests/container/hooks-list-rpc.py is not executable", () => {
    assert.ok(!isExecutable(HOOKS_RPC_PATH));
  });

  const hooksRpc = readFileSync(HOOKS_RPC_PATH, "utf8");

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
      result.stderr
        ? `hooks-list-rpc.py failed to parse as Python: ${result.stderr}`
        : "hooks-list-rpc.py failed to parse as Python (no stderr captured)",
    );
  });

  // --- inventory items 38-40: runner --inside structural check ---------

  await t.test(
    "runner's --inside branch gates UID 10001 before mode selection and dispatch, then routes suite mode through run.sh and the offline probe",
    () => {
      assert.doesNotThrow(() => validateRunnerInsideBranch(runner));
    },
  );

  // --- inventory items 41-115: codex-offline-probe.sh structure --------

  const probe = readFileSync(PROBE_PATH, "utf8");

  await t.test(
    "codex-offline-probe.sh satisfies the full structural/ordering contract",
    () => {
      assert.doesNotThrow(() => validateProbe(probe));
    },
  );

  // --- inventory items 116-142: hooks-list-rpc.py protocol gates -------

  await t.test(
    "hooks-list-rpc.py satisfies the full protocol-gate/handshake-ordering contract",
    () => {
      assert.doesNotThrow(() => validateHooksRpc(hooksRpc));
    },
  );

  // --- inventory items 143-152: probe semantic-mutation fixtures -------
  // Mirrors the `mutations` hash at :531-572: each entry is a single
  // substring rewrite of the real probe text that must be rejected by
  // validateProbe.

  /** @type {Record<string, string>} */
  const probeMutations = {
    "no-op run_manager": probe.replace(
      /^run_manager\(\) \{\n[\s\S]*?^\}\n/m,
      "run_manager() {\n  :\n}\n",
    ),
    "unbracketed install lifecycle": probe.replace(
      "hook_state_before=$(snapshot_hook_state)\nrun_manager install\nhook_state_after=$(snapshot_hook_state)",
      "run_manager install",
    ),
    "unbound fingerprint root": probe.replace(
      'expected_root="$HOME/.codex/plugins/cache/superpowers-manager/superpowers/$expected_version"',
      'expected_root="/tmp/unbound-manager-cache"',
    ),
    "unbound Codex listing version": probe.replace(
      'if matches[0].get("version") != expected_version:',
      "if expected_version != expected_version:",
    ),
    "required pluginId accepted": probe.replace(
      'if "pluginId" in required:',
      "if False:",
    ),
    "additional pluginId types accepted": probe.replace(
      'if plugin_id_types != {"string", "null"}:',
      'if not {"string", "null"}.issubset(plugin_id_types):',
    ),
    "non-boolean enabled accepted": probe.replace(
      'if actual.get("enabled") is not True:',
      'if actual.get("enabled") != True:',
    ),
    "non-boolean isManaged accepted": probe.replace(
      'if actual.get("isManaged") is not False:',
      'if actual.get("isManaged") != False:',
    ),
    "captured hooks stderr removed": probe.replace(
      'cat "$hooks_stderr" >&2',
      ":",
    ),
    "captured hooks stderr leaked to stdout": probe.replace(
      'cat "$hooks_stderr" >&2',
      'cat "$hooks_stderr"',
    ),
  };
  assert.equal(
    Object.keys(probeMutations).length,
    10,
    "probeMutations lost or gained a case — update tests/migration-inventory/test_container_contract.md",
  );

  for (const [name, mutated] of Object.entries(probeMutations)) {
    await t.test(`probe semantic mutation is rejected: ${name}`, () => {
      assert.notEqual(
        mutated,
        probe,
        `mutation fixture made no change: ${name}`,
      );
      assert.throws(() => validateProbe(mutated), ContractViolation);
    });
  }

  // --- inventory items 153-172: RPC-helper semantic-mutation fixtures --
  // Mirrors the `rpc_mutations` hash at :584-665.

  /** @type {Record<string, string>} */
  const rpcMutations = {
    "missing pre-send process check": hooksRpc.replace(
      "if process.poll() is not None or process.stdin is None:",
      "if False:",
    ),
    "missing send failure gate": hooksRpc.replace(
      'fail(f"could not send request: {exc}")',
      "pass",
    ),
    "missing malformed JSON gate": hooksRpc.replace(
      'fail(f"malformed JSONL response: {exc}")',
      "pass",
    ),
    "missing non-standard constant parser": hooksRpc.replace(
      ", parse_constant=reject_constant",
      "",
    ),
    "weakened non-standard constant rejection": hooksRpc.replace(
      'raise ValueError(f"non-standard numeric constant: {constant}")',
      "return None",
    ),
    "removed deadline": hooksRpc.replace(
      "deadline = time.monotonic() + 25",
      'deadline = float("inf")',
    ),
    "unbounded selector wait": hooksRpc.replace(
      "if remaining <= 0 or not selector.select(remaining):",
      "if not selector.select():",
    ),
    "missing EOF failure": hooksRpc.replace(
      'fail("EOF before the required response")',
      "return {}",
    ),
    "missing stream availability gate": hooksRpc.replace(
      'fail("app-server stdout is unavailable")',
      "pass",
    ),
    "missing JSON object check": hooksRpc.replace(
      "if not isinstance(message, dict):",
      "if False:",
    ),
    "missing response id gate": hooksRpc.replace(
      "if type(id_value) is not int or id_value != expected_id:",
      "if False:",
    ),
    "weakened exact response id type": hooksRpc.replace(
      "if type(id_value) is not int or id_value != expected_id:",
      "if id_value != expected_id:",
    ),
    "missing RPC error gate": hooksRpc.replace(
      'if "error" in message:',
      "if False:",
    ),
    "skipped initialize request": hooksRpc.replace(
      '"method": "initialize",',
      '"method": "not-initialize",',
    ),
    "missing app-server pipe gate": hooksRpc.replace(
      'fail("app-server stdout pipe was not created")',
      "pass",
    ),
    "skipped initialize response": hooksRpc.replace(
      "receive(process, selector, 0)",
      "pass",
    ),
    "skipped initialized notification": hooksRpc.replace(
      'send(process, {"method": "initialized"})',
      "pass",
    ),
    "skipped hooks request": hooksRpc.replace(
      'send(process, {"id": 1, "method": "hooks/list", "params": {"cwds": [cwd]}})',
      "pass",
    ),
    "missing hooks response presence gate": hooksRpc.replace(
      "response = receive(process, selector, 1)",
      'response = {"id": 1, "result": {"data": []}}',
    ),
    "missing result gate": hooksRpc.replace(
      'if "result" not in message:',
      "if False:",
    ),
  };
  assert.equal(
    Object.keys(rpcMutations).length,
    20,
    "rpcMutations lost or gained a case — update tests/migration-inventory/test_container_contract.md",
  );

  for (const [name, mutated] of Object.entries(rpcMutations)) {
    await t.test(`RPC helper semantic mutation is rejected: ${name}`, () => {
      assert.notEqual(
        mutated,
        hooksRpc,
        `mutation fixture made no change: ${name}`,
      );
      assert.throws(() => validateHooksRpc(mutated), ContractViolation);
    });
  }
});
