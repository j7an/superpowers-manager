// @ts-check
// The single git-egress refusal. Both tests/baseline/support.js's
// createSandbox and tests/bin/dispatch-fixture.js's runDispatch sit behind it.
//
// Matrix row 13: slice 3 built this refusal for createSandbox only, and
// dispatch-fixture.js symlinked the real git past it whenever pinUpstream was
// set — hermetic by convention rather than by construction, in a fixture slice
// 4b adds three more consumers to.
//
// Takes the resolved git path rather than resolving it. Each caller keeps its
// own resolver on purpose: support.js's hostExecutable special-cases python3
// and dispatch-fixture.js's deliberately does not.

import { writeFileSync } from "node:fs";
import { join } from "node:path";

/** @param {string} value */
function shQuote(value) {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/**
 * @param {string} binDir directory the case puts first on PATH
 * @param {string} realGit absolute path to a working git
 * @returns {void}
 */
export function writeGitEgressShim(binDir, realGit) {
  writeFileSync(
    join(binDir, "git"),
    [
      "#!/bin/sh",
      'for spw_arg in "$@"; do',
      '  case "$spw_arg" in',
      "    http://*|https://*|git://*|ssh://*|ftp://*|ftps://*|git@*:*)",
      '      echo "sandbox refuses network git remote: $spw_arg" >&2',
      "      exit 128",
      "      ;;",
      "  esac",
      "done",
      `exec ${shQuote(realGit)} "$@"`,
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
}
