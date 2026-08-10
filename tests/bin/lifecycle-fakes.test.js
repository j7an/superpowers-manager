// @ts-check
// The one property of the shared fake shell (tests/bin/lifecycle-fakes.js)
// that nothing else in the tree asserts: under the `tripwire` seam, a fake's
// adapter role must stop BEFORE delegateToRealAdapter.
//
// `process.exitCode = 94` does not halt execution. Drop the `return` after
// `tripwireTriggered(ctx)` in either fake and the tripwire still reports, then
// falls through and spawns `scripts/adapters/codex/adapter` for real — the
// exact inverse of what the tripwire is for, and a breach of the Layer 1-3
// hermeticity rule rather than merely a wrong exit code. It would not turn any
// suite red: the real adapter's own status simply overwrites the 94.
//
// So each case asserts BOTH halves — the 94 AND the absence of a delegation
// footprint. The exit code alone proves nothing, because a delegation that
// happens to exit 94 is indistinguishable from a tripwire that held.
//
// No committed case passes adapterSeam: "tripwire" through runScript yet (all
// nine declared seams are "intercept"); slice 4b is the first consumer. These
// cases therefore spawn the fakes directly, which is also what keeps them
// independent of slice 4b's dispatch change.
//
// The delegating control case beside each tripwire case is what stops the
// assertion going vacuous: it proves this harness DOES observe a delegation
// when one happens, so "no marker" means "did not delegate" rather than "did
// not look".

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { registerScratch } from "./fixture-scratch.js";

const BIN = fileURLToPath(new URL(".", import.meta.url));

// mkdtemp under os.tmpdir() for the same reason lifecycle-fixture.js:28-36
// gives: TMPDIR when the runner sets one, the platform default when it does
// not, and uniqueness from mkdtemp rather than from a fixed name.
const SCRATCH = mkdtempSync(join(tmpdir(), "spw-fakes-"));
// registerScratch, not a bare process.on("exit"): the exit-only form is the
// carried defect (row :2040) that fixture-scratch.js exists to close, and it
// leaks this tree on SIGHUP/SIGINT/SIGTERM. This file was added before that
// module landed and kept the old form for five commits.
registerScratch(SCRATCH);

// A stand-in for `scripts/adapters/codex/adapter` whose only job is to be
// noticed. It exits 7 — a status no branch of the shell produces — so the
// control case can also prove the delegated status is what propagates.
const STANDIN_STATUS = 7;
const STANDIN =
  "#!/bin/sh\n" +
  'echo "DELEGATED $*" >>"$SPW_FIXTURE_STATE/delegated.marker"\n' +
  `exit ${STANDIN_STATUS}\n`;

/**
 * A package root holding nothing but the stand-in adapter, so a delegation
 * cannot reach the repository's real adapter even if one of these cases
 * regresses.
 * @returns {string}
 */
function makePkgRoot() {
  const pkg = mkdtempSync(join(SCRATCH, "pkg-"));
  const dir = join(pkg, "scripts", "adapters", "codex");
  mkdirSync(dir, { recursive: true });
  const adapter = join(dir, "adapter");
  writeFileSync(adapter, STANDIN);
  chmodSync(adapter, 0o755);
  return pkg;
}

/**
 * @param {"install" | "uninstall"} kind
 * @param {string | undefined} seam
 * @returns {{
 *   status: number | null,
 *   stderr: string,
 *   state: string,
 *   delegated: boolean,
 *   adapterLog: string,
 * }}
 */
function runAdapterRole(kind, seam) {
  const state = mkdtempSync(join(SCRATCH, `${kind}-`));
  writeFileSync(join(state, "config.json"), "{}");
  /** @type {NodeJS.ProcessEnv} */
  const env = {
    ...process.env,
    SPW_FIXTURE_STATE: state,
    SPW_TEST_PKG_ROOT: makePkgRoot(),
  };
  // Deleted rather than left alone: an ambient seam in the developer's shell
  // would otherwise decide what these cases test.
  delete env.SPW_FIXTURE_ADAPTER_SEAM;
  if (seam !== undefined) env.SPW_FIXTURE_ADAPTER_SEAM = seam;
  const result = spawnSync(
    process.execPath,
    [
      join(BIN, `${kind}-fakes.js`),
      "adapter",
      "inspect",
      "--view",
      "ownership",
    ],
    { encoding: "utf8", env },
  );
  const marker = join(state, "delegated.marker");
  return {
    status: result.status,
    stderr: result.stderr,
    state,
    delegated: existsSync(marker),
    adapterLog: readFileSync(join(state, "adapter.log"), "utf8"),
  };
}

for (const kind of /** @type {const} */ (["install", "uninstall"])) {
  void test(`${kind}: the tripwire seam stops before the adapter is spawned`, () => {
    const run = runAdapterRole(kind, "tripwire");
    assert.equal(run.status, 94);
    assert.equal(
      run.stderr,
      "fixture: this command must not spawn the adapter\n",
    );
    assert.equal(
      run.delegated,
      false,
      "the tripwire reported but execution fell through into the real adapter",
    );
    // The role body did run — otherwise "no delegation" would be true for the
    // uninteresting reason that nothing happened at all.
    assert.equal(run.adapterLog, "inspect --view ownership\n");
  });

  void test(`${kind}: without the tripwire seam the adapter IS spawned`, () => {
    const run = runAdapterRole(kind, undefined);
    assert.equal(
      run.delegated,
      true,
      "the control case did not delegate, so the tripwire case above proves nothing",
    );
    assert.equal(run.status, STANDIN_STATUS);
  });
}
