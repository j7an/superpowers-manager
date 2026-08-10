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
//
// Best-effort, not a containment boundary. Slice 3 built this alongside
// GIT_CONFIG_NOSYSTEM, the private HOME, and the private TMPDIR, after
// CLI-COMMANDS-01 resolved the package-default ref against a real GitHub URL
// once `probe` went in-process — `prepare` is worse, it clones, and a gate
// that pattern-matches test source for "sites that reach prepare" is brittle
// and cannot see indirect reachability, so this sits at the egress point
// instead. Known gaps: the pattern list matches only `git@*:*` for SSH
// shorthand, so scp-style `host:path` and `user@host:path` remotes pass
// through unmatched; and a scheme glob only matches when the URL is the
// whole argument at its own position, so `-c url.https://x.insteadOf=…` (URL
// embedded mid-argument) and `rsync://` both slip through.
//
// Local paths are byte-identical: the shim only ADDS a rejection. This
// branch's own `prepare` driver does not rely on this shim at all — it uses
// the host PATH `git` and is protected instead by prepare-fixture.js's
// assertion that SUPERPOWERS_UPSTREAM_URL is an absolute local path.

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
