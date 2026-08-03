// @ts-check
// Ported from tests/test_bootstrap.sh (see
// tests/migration-inventory/bootstrap.md for the numbered assertion
// inventory this file maps to 1:1).

import assert from "node:assert/strict";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));

/**
 * A missing or unreadable path here must not surface as a raw ENOENT with a
 * stack frame. Same shape as run-node-suites.js's lstatSync guard: report the
 * path, never re-emit the caught error, which carries errno and a stack.
 * @param {string} relPath
 */
function read(relPath) {
  try {
    return readFileSync(join(ROOT, relPath), "utf8");
  } catch {
    throw new Error(`bootstrap inventory file could not be read: ${relPath}`);
  }
}

/**
 * Mirrors assert_file()'s `[ ! -f "$root/$path" ]`: a directory (or other
 * non-regular entry) at the path must fail, the same way the shell's `-f`
 * test would. `existsSync` alone is `test -e` and is weaker.
 * @param {string} relPath
 */
function isRegularFile(relPath) {
  try {
    return statSync(join(ROOT, relPath)).isFile();
  } catch {
    return false;
  }
}

// --- inventory items 1-7, 9: file-presence assertions -----------------

const EXPECTED_FILES = [
  ".gitignore",
  "config/upstream-ref",
  ".agents/plugins/marketplace.json",
  "plugins/superpowers/.codex-plugin/plugin.template.json",
  "scripts/adapters/codex/adapter",
  "src/generated-plugin.ts",
  "src/validate-generated-plugin-cli.ts",
  "scripts/core/validate-adapter-response.py",
];
assert.equal(
  EXPECTED_FILES.length,
  8,
  "EXPECTED_FILES lost or gained a case — update tests/migration-inventory/bootstrap.md",
);

void test("bootstrap: expected repository files are present", () => {
  for (const relPath of EXPECTED_FILES) {
    assert.equal(isRegularFile(relPath), true, `missing file: ${relPath}`);
  }
});

// --- inventory item 8: the deleted Python generated-plugin validator ---

void test("bootstrap: the Python generated-plugin validator stays gone", () => {
  assert.equal(
    existsSync(
      join(ROOT, "scripts/adapters/codex/validate-generated-plugin.py"),
    ),
    false,
  );
});

// --- inventory items 10-85: text-content assertions --------------------

/** @type {Array<[string, string, boolean]>} */
const textContentCases = [
  ["package.json", '"type": "module"', true],
  ["bin/superpowers-manager.js", "import.meta.main", false],
  ["config/upstream-ref", "latest-release", true],
  [".agents/plugins/marketplace.json", '"name": "superpowers-manager"', true],
  [".agents/plugins/marketplace.json", '"products": ["CODEX"]', true],
  [".gitignore", "plugins/superpowers/.codex-plugin/plugin.json", true],
  [".gitignore", "plugins/.superpowers.prepare.*/", true],
  [".gitignore", "plugins/.superpowers.tmp.*/", false],
  [
    "plugins/superpowers/.codex-plugin/plugin.template.json",
    '"name": "superpowers"',
    true,
  ],
  [
    "plugins/superpowers/.codex-plugin/plugin.template.json",
    '"skills": "./skills/"',
    true,
  ],
  [
    "AGENTS.md",
    "Run `sh tests/container.sh` before declaring a change complete.",
    true,
  ],
  [
    "AGENTS.md",
    "no mutation of the developer's or runner's real Codex state",
    true,
  ],
  [
    "AGENTS.md",
    "Adapter installation and refresh mutations require current, validated update-control evidence.",
    true,
  ],
  ["AGENTS.md", "pnpm install --frozen-lockfile", true],
  ["AGENTS.md", "`src/`", true],
  ["AGENTS.md", "`dist/`", true],
  ["README.md", "sh tests/container.sh", true],
  ["README.md", "Layers 1-3 stay offline and hermetic", true],
  ["README.md", "Layer 4 is the Docker acceptance path", true],
  [
    "README.md",
    "sh tests/container.sh                    # Layers 1-4: blocking Docker acceptance command",
    true,
  ],
  ["README.md", "pnpm install --frozen-lockfile", true],
  ["README.md", "pnpm run build", true],
  ["README.md", "toolchain", true],
  ["README.md", "no public harness selector", true],
  ["README.md", "superpowers-manager pin v6.1.1", true],
  ["README.md", "superpowers-manager track-latest", true],
  ["README.md", "superpowers-manager unpin", true],
  ["README.md", "selection commands save intent only", true],
  ["README.md", "`SUPERPOWERS_REF` is an invocation-only override", true],
  [
    "README.md",
    "SUPERPOWERS_REF=feature/foo npx superpowers-manager probe",
    true,
  ],
  ["tests/expected_tarball_contents.txt", "dist/selection-state-cli.js", true],
  [
    "tests/expected_tarball_contents.txt",
    "scripts/core/selection-state.py",
    false,
  ],
  ["tests/expected_tarball_contents.txt", "dist/adapter-cli.js", true],
  ["tests/expected_tarball_contents.txt", "dist/adapter-protocol.js", true],
  ["tests/expected_tarball_contents.txt", "dist/adapter.js", true],
  ["tests/expected_tarball_contents.txt", "dist/generated-plugin.js", true],
  ["tests/expected_tarball_contents.txt", "dist/python-text.js", true],
  [
    "tests/expected_tarball_contents.txt",
    "dist/validate-generated-plugin-cli.js",
    true,
  ],
  [
    "tests/expected_tarball_contents.txt",
    "scripts/adapters/codex/validate-generated-plugin.py",
    false,
  ],
  ["tests/expected_tarball_contents.txt", "dist/codex-json.js", true],
  ["tests/expected_tarball_contents.txt", "dist/codex-state.js", true],
  ["tests/expected_tarball_contents.txt", "dist/hooks-cli.js", false],
  [
    "tests/expected_tarball_contents.txt",
    "scripts/adapters/codex/lib.sh",
    false,
  ],
  ["tests/expected_tarball_contents.txt", "dist/hooks.js", true],
  [
    "tests/expected_tarball_contents.txt",
    "scripts/adapters/codex/materialize-hooks.py",
    false,
  ],
  ["tests/expected_tarball_contents.txt", "scripts/core/selection.sh", true],
  ["tests/expected_tarball_contents.txt", "scripts/pin", true],
  ["tests/expected_tarball_contents.txt", "scripts/track-latest", true],
  ["tests/expected_tarball_contents.txt", "scripts/unpin", true],
  ["RELEASING.md", "Ensure `main` is green (`sh tests/container.sh`)", true],
  ["RELEASING.md", "sh tests/container.sh", true],
  ["RELEASING.md", "pnpm install --frozen-lockfile", true],
  ["RELEASING.md", "pnpm run build", true],
  ["RELEASING.md", "`prepack`", true],
  [
    "RELEASING.md",
    "`v0.1.2` and `v0.1.3` were failed and unpublished maintenance attempts.",
    true,
  ],
  ["RELEASING.md", "`v0.1.4` was the recovered maintenance publication.", true],
  [
    "RELEASING.md",
    "`v0.1.5` failed before publication and must never be moved, reused, rerun, or published.",
    true,
  ],
  [
    "RELEASING.md",
    "`v0.1.6` published successfully through OIDC and is immutable.",
    true,
  ],
  ["RELEASING.md", "No npm token belongs in this path.", true],
  ["RELEASING.md", "No prerelease path is authorized.", true],
  [
    "RELEASING.md",
    "Persistent upstream-version pinning is required before production `0.2.0`.",
    true,
  ],
  ["RELEASING.md", "protected `release` environment", true],
  ["RELEASING.md", "protected `npm` environment", true],
  [
    "RELEASING.md",
    "Never run or rerun a release workflow for `v0.1.5`, and never publish `superpowers-manager@0.1.5` by any path.",
    true,
  ],
  ["RELEASING.md", "j7an/superpowers-manager", true],
  ["RELEASING.md", "workflow `release.yml`", true],
  ["RELEASING.md", "environment `npm`", true],
  [
    "RELEASING.md",
    "Published Manager baseline for version monotonicity",
    false,
  ],
  ["RELEASING.md", "Advance this marker after successful publication", false],
  ["RELEASING.md", "one-time `0.1.6` recovery", false],
  ["RELEASING.md", "0.1.6 recovery", false],
  ["RELEASING.md", "npm-bootstrap", false],
  ["RELEASING.md", "NPM_BOOTSTRAP_TOKEN", false],
  ["RELEASING.md", "j7an/superpowers-wrapper", false],
  [
    "tests/manual/codex-behavior-probe.sh",
    "Optional native-only Codex compatibility probe",
    true,
  ],
  [
    "README.md",
    "The automated suite is fully hermetic: it uses a fake local upstream repo and a",
    false,
  ],
];
assert.equal(
  textContentCases.length,
  76,
  "textContentCases lost or gained a case — update tests/migration-inventory/bootstrap.md",
);

void test("bootstrap: text-content assertions", () => {
  for (const [relPath, text, shouldContain] of textContentCases) {
    const content = read(relPath);
    assert.equal(
      content.includes(text),
      shouldContain,
      `${relPath}: ${shouldContain ? "missing" : "unexpected"} text: ${text}`,
    );
  }
});

// The guard exists because the text-content loop calls read() on paths from a
// literal table; a renamed or deleted file used to produce a raw ENOENT with a
// stack instead of naming the path.
void test("bootstrap: an unreadable path is reported by name, without errno or a stack", () => {
  assert.throws(
    () => read("no/such/file/in/this/repository.md"),
    (error) => {
      assert.ok(error instanceof Error);
      assert.equal(
        error.message,
        "bootstrap inventory file could not be read: no/such/file/in/this/repository.md",
      );
      assert.ok(!/ENOENT|errno/.test(error.message));
      return true;
    },
  );
});

// --- inventory items 86-99: structural release-section assertions ------
// Re-implements tests/test_bootstrap.sh's embedded Python
// extract_section/assert_release_verification_sections logic in JS, so no
// python3 invocation is needed for this check.

/**
 * @param {string} document
 * @param {string} title
 * @returns {{ start: number, body: string }}
 */
function extractSection(document, title) {
  const escaped = title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`^### ${escaped}$`, "gm");
  const matches = [...document.matchAll(pattern)];
  if (matches.length !== 1) {
    throw new Error(
      `expected exactly one ${JSON.stringify(title)} section, found ${matches.length}`,
    );
  }
  const match = matches[0];
  const bodyStart = /** @type {number} */ (match.index) + match[0].length;
  const rest = document.slice(bodyStart);
  const nextHeading = rest.match(/^#{1,3} /m);
  const bodyEnd =
    nextHeading === null || nextHeading.index === undefined
      ? document.length
      : bodyStart + nextHeading.index;
  return {
    start: /** @type {number} */ (match.index),
    body: document.slice(bodyStart, bodyEnd),
  };
}

const REQUIRED_PRE = [
  "frozen tag and source SHA",
  "package name and version",
  "tarball digest",
  "zero npm secrets",
  "before approving publication",
];
assert.equal(
  REQUIRED_PRE.length,
  5,
  "REQUIRED_PRE lost or gained a case — update tests/migration-inventory/bootstrap.md",
);

const REQUIRED_POST = [
  "npm provenance",
  "clean-cache `npx` execution",
  "published version and source SHA",
  "after publication",
];
assert.equal(
  REQUIRED_POST.length,
  4,
  "REQUIRED_POST lost or gained a case — update tests/migration-inventory/bootstrap.md",
);

/** @param {string} document */
function assertReleaseVerificationSections(document) {
  const pre = extractSection(document, "Pre-publication approval");
  const post = extractSection(document, "Post-publication verification");
  if (pre.start >= post.start) {
    throw new Error(
      "Pre-publication approval must precede Post-publication verification",
    );
  }
  for (const text of REQUIRED_PRE) {
    if (!pre.body.includes(text)) {
      throw new Error(`missing pre-publication evidence: ${text}`);
    }
  }
  for (const text of REQUIRED_POST) {
    if (!post.body.includes(text)) {
      throw new Error(`missing post-publication evidence: ${text}`);
    }
  }
}

void test("bootstrap: RELEASING.md has exactly one Pre-publication approval section", () => {
  assert.doesNotThrow(() =>
    extractSection(read("RELEASING.md"), "Pre-publication approval"),
  );
});

void test("bootstrap: RELEASING.md has exactly one Post-publication verification section", () => {
  assert.doesNotThrow(() =>
    extractSection(read("RELEASING.md"), "Post-publication verification"),
  );
});

void test("bootstrap: Pre-publication approval precedes Post-publication verification", () => {
  const releaseDoc = read("RELEASING.md");
  const pre = extractSection(releaseDoc, "Pre-publication approval");
  const post = extractSection(releaseDoc, "Post-publication verification");
  assert.ok(pre.start < post.start);
});

void test("bootstrap: pre-publication section carries every required evidence phrase", () => {
  const pre = extractSection(read("RELEASING.md"), "Pre-publication approval");
  for (const text of REQUIRED_PRE) {
    assert.ok(
      pre.body.includes(text),
      `missing pre-publication evidence: ${text}`,
    );
  }
});

void test("bootstrap: post-publication section carries every required evidence phrase", () => {
  const post = extractSection(
    read("RELEASING.md"),
    "Post-publication verification",
  );
  for (const text of REQUIRED_POST) {
    assert.ok(
      post.body.includes(text),
      `missing post-publication evidence: ${text}`,
    );
  }
});

const SWAPPED_SECTIONS_FIXTURE = `### Post-publication verification

Verify npm provenance and clean-cache \`npx\` execution against the published
version and source SHA after publication.

### Pre-publication approval

Verify the frozen tag and source SHA, package name and version, tarball digest,
and zero npm secrets before approving publication.
`;

const MISPLACED_EVIDENCE_FIXTURE = `### Pre-publication approval

Verify npm provenance and clean-cache \`npx\` execution against the published
version and source SHA after publication.

### Post-publication verification

Verify the frozen tag and source SHA, package name and version, tarball digest,
and zero npm secrets before approving publication.
`;

void test("bootstrap: a swapped-sections fixture is rejected", () => {
  assert.throws(
    () => assertReleaseVerificationSections(SWAPPED_SECTIONS_FIXTURE),
    {
      message:
        "Pre-publication approval must precede Post-publication verification",
    },
  );
});

void test("bootstrap: a misplaced-evidence fixture is rejected", () => {
  // The REQUIRED_PRE loop (:313) fires before the REQUIRED_POST loop (:318),
  // and "frozen tag and source SHA" is the first REQUIRED_PRE entry (:280)
  // absent from this fixture's pre-publication body. Verified by execution.
  assert.throws(
    () => assertReleaseVerificationSections(MISPLACED_EVIDENCE_FIXTURE),
    { message: "missing pre-publication evidence: frozen tag and source SHA" },
  );
});
