// Ports scripts/update. The shell sourced common.sh and lifecycle.sh; the
// predicates now live in src/lifecycle.ts. Unlike install and uninstall,
// update issues no ctx.adapter call of its own: every adapter interaction
// this module needs already happens inside gatherProbe, runPrepare or
// runInstall, each of which owns its own §4.2a-conformant invoke() gate. That
// is also why update opens no temporary workspace of its own -- there is no
// mutation here for one to protect.
// FROZEN CITATIONS: `scripts/…:NN` references below resolve against the tree at
// ad56569a4c161e7b122967442e2b026eeb6395f6, the last commit in which those paths existed. They are unmaintained
// and will not be re-derived. Resolve one with:
//   git show ad56569a4c161e7b122967442e2b026eeb6395f6:scripts/update
import { oneLine } from "../cli-arguments.js";
import {
  requireManagedUpdateControl,
  requireNoLegacyState,
} from "../lifecycle.js";
import type { CommandContext } from "./context.js";
import {
  formatPorcelain,
  gatherProbe,
  replayOutcome,
  type ProbeFacts,
} from "./probe.js";
import { runInstall } from "./install.js";
import { runPrepare } from "./prepare.js";

// `git show ad56569a4c161e7b122967442e2b026eeb6395f6:scripts/update:29-32::echo "$probe_output`'s `case ... *)` wildcard. Same unreachability shape as
// src/commands/install.ts's renderUnknownProbeStatus: statusForCommits
// (src/status.ts) can only ever return "needs prepare", "needs
// install" or "current", so this branch is NOT reachable through runUpdate's
// own call to gatherProbe today. ProbeFacts.status is typed `string`, not
// that three-literal union, so a future caller that builds facts by hand (as
// this module's own unit test does, directly) must still see it fail closed
// rather than silently proceed.
//
// Exported specifically so a direct test can reach it -- not part of the
// interface Task 5 or Task 8 consume. A test against this export proves the
// two writes below are correct for a given `facts`; it does NOT prove that
// runUpdate's own final `else` branch actually reaches and calls this
// function, or that runUpdate returns 1 afterward -- those are properties of
// the call site, not of this function, and need their own coverage there.
export function renderUnknownProbeStatus(
  facts: ProbeFacts,
  ctx: CommandContext,
): void {
  // `git show ad56569a4c161e7b122967442e2b026eeb6395f6:scripts/update:30-31::echo "$probe_output` -- `echo "$probe_output"` (stdout), then the error
  // to stderr via an explicit `>&2`. This is a DIFFERENT mechanism from
  // `git show ad56569a4c161e7b122967442e2b026eeb6395f6:scripts/install:30-31::printf`'s `spw_die`, even though both end up writing the
  // porcelain to stdout and an `error: `-prefixed line to stderr: install's
  // error text flows through spw_die's own `error: $*` formatting, while
  // update's is spelled out inline in the shell literal already. The two
  // command modules therefore each need their own case pinning this arm --
  // one must not be inferred from the other.
  ctx.stdout.write(formatPorcelain(facts));
  ctx.stderr.write(`error: unknown probe status: ${facts.status}\n`);
}

export async function runUpdate(
  argv: readonly string[],
  ctx: CommandContext,
): Promise<number> {
  // scripts/update never reads "$@", so extra arguments are silently
  // ignored -- the same asymmetry runPrepare and runInstall document.
  void argv;

  let probe: Awaited<ReturnType<typeof gatherProbe>>;
  try {
    probe = await gatherProbe(ctx);
  } catch (cause) {
    // gatherProbe performs no writes of its own (src/commands/probe.ts), so
    // this catch cannot also be reached by an EPIPE from update's own
    // output -- update writes nothing before this call resolves, unlike
    // install's NOTE line.
    //
    // This is a THIRD consumer of gatherProbe's throw channel --
    // `src/commands/probe.ts:386-438::THREE exceptions, all inherited and none a regression:`'s
    // runProbe catch is the first and src/commands/install.ts's runInstall catch
    // is the second. Because all three wrap the identical function, runProbe's
    // long comment there enumerates exactly what can reach this stream too; not
    // repeated here.
    ctx.stderr.write(`error: ${oneLine(cause)}\n`);
    return 1;
  }
  // Replay first, on both paths, before any decision -- clause 1.
  for (const outcome of probe.outcomes) replayOutcome(outcome, ctx);
  if (probe.status === 1) {
    if (probe.message !== null) {
      ctx.stderr.write(`error: ${probe.message}\n`);
    }
    return 1;
  }
  const facts = probe.facts;

  // `git show ad56569a4c161e7b122967442e2b026eeb6395f6:scripts/update:9-10::identity_state=`. Guards the PROBE-derived value only, matching
  // src/commands/install.ts's identical guard at `git show ad56569a4c161e7b122967442e2b026eeb6395f6:scripts/install:19-20::identity_state=$(spw_probe_field`: a
  // probe that reports no identity state at all is a different failure from
  // one that reports an unrecognised one, and requireNoLegacyState("") would
  // otherwise reach its "unknown" arm and print a symptom rather than the
  // actual cause.
  if (facts.identityState.length === 0) {
    ctx.stderr.write("error: probe did not report adapter identity state\n");
    return 1;
  }

  // `git show ad56569a4c161e7b122967442e2b026eeb6395f6:scripts/update:11::spw_require_no_legacy_state`.
  const legacy = requireNoLegacyState(facts.identityState);
  if (legacy.kind === "blocked") {
    // `git show ad56569a4c161e7b122967442e2b026eeb6395f6:scripts/core/lifecycle.sh:50-53::'Legacy superpowers-wrapper Codex state is`
    // is a single printf writing three bare lines to stderr, no `error: `
    // prefix; :54 is the `return 1` that follows it, reached without spw_die.
    for (const line of legacy.lines) ctx.stderr.write(`${line}\n`);
    return 1;
  }
  if (legacy.kind === "unknown") {
    ctx.stderr.write(`error: ${legacy.message}\n`);
    return 1;
  }

  // `git show ad56569a4c161e7b122967442e2b026eeb6395f6:scripts/update:13-14::update_control=`. install checks only identity_state
  // (`git show ad56569a4c161e7b122967442e2b026eeb6395f6:scripts/install:20::report`); update checks update_control too -- the first of
  // §4.4's two corrections. Both emptiness checks run before the switch, not
  // just one.
  if (facts.updateControl.length === 0) {
    ctx.stderr.write(
      "error: probe did not report adapter update-control capability\n",
    );
    return 1;
  }

  // `git show ad56569a4c161e7b122967442e2b026eeb6395f6:scripts/update:16-34::case`, the four-way switch.
  if (facts.status === "current") {
    // `git show ad56569a4c161e7b122967442e2b026eeb6395f6:scripts/update:18::spw_require_managed_update_control` -- gated BEFORE printing anything. §4.4's second
    // correction: an update that printed "manager is current" under an
    // unsupported adapter would be asserting managed control it had not
    // verified.
    const managed = requireManagedUpdateControl(facts.updateControl);
    if (!managed.ok) {
      ctx.stderr.write(`error: ${managed.message}\n`);
      return 1;
    }
    // `git show ad56569a4c161e7b122967442e2b026eeb6395f6:scripts/update:19-20::printf`. Unlike install, which never lets the porcelain
    // reach the terminal on a successful run (`git show ad56569a4c161e7b122967442e2b026eeb6395f6:scripts/install:18::porcelain`'s
    // probe_output=$(...) capture), update prints it here.
    ctx.stdout.write(formatPorcelain(facts));
    ctx.stdout.write("manager is current\n");
    return 0;
  }
  if (facts.status === "needs prepare") {
    // Called as a FUNCTION: a failure propagates as a status, never through
    // `set -eu`. runPrepare has already replayed its own outcomes and
    // written its own diagnostics by the time it returns, so nothing further
    // is written here on that path.
    const prepareStatus = await runPrepare([], ctx);
    if (prepareStatus !== 0) return prepareStatus;
    return await runInstall([], ctx);
  }
  if (facts.status === "needs install") {
    return await runInstall([], ctx);
  }
  renderUnknownProbeStatus(facts, ctx);
  return 1;
}
