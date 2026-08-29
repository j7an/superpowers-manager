import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import {
  COMMIT_INPUT_RE,
  compareStable,
  parseStableTag,
} from "./domain/refs.js";
import type { StableVersion } from "./domain/refs.js";
import { runGit } from "./git.js";
import type { GitResult } from "./git.js";
import { SafetyError } from "./safety-error.js";
import { displaySource } from "./selection.js";
import type { ResolutionKind } from "./upstream-version.js";
import { withWorkspace } from "./workspace.js";

const UNAVAILABLE_OBJECT_RE =
  /not our ref|unadvertised object|couldn't find remote ref/;

export interface LsRemoteEntry {
  readonly sha: string;
  readonly ref: string;
}

export interface LatestRelease {
  readonly tag: string;
  readonly sha: string;
}

export interface Resolution {
  readonly kind: ResolutionKind;
  readonly ref: string;
  readonly commit: string;
}

function upstreamError(message: string): SafetyError {
  return new SafetyError("upstream", message);
}

// Mirrors
// `git show ad56569a4c161e7b122967442e2b026eeb6395f6:scripts/core/upstream.sh:6-13::spw_config_ref`:
// SUPERPOWERS_REF wins; otherwise the first line of config/upstream-ref with
// trailing whitespace stripped.
// The diagnostic names the path and does not interpolate the caught cause.
export async function readConfigRef(
  root: string,
  env: NodeJS.ProcessEnv,
): Promise<string> {
  if (env.SUPERPOWERS_REF) return env.SUPERPOWERS_REF;
  const path = join(root, "config", "upstream-ref");
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch {
    throw upstreamError(`cannot read packaged upstream ref ${path}`);
  }
  return (text.split("\n")[0] ?? "").replace(/\s+$/, "");
}

// Signal termination carries `status: null`, and `null !== 0`, so this one
// comparison covers both non-zero exits and killed children.
function failed(result: GitResult): boolean {
  return result.status !== 0;
}

function combined(result: GitResult): string {
  return `${result.stdout}${result.stderr}`.replace(/\n+$/, "");
}

// Mirrors `[ -d "$repository/.git" ]`: a regular file, a broken symlink, or
// an unreadable path is *not* a directory, so the cache is re-initialized.
async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

export function parseLsRemote(output: string): LsRemoteEntry[] {
  const entries: LsRemoteEntry[] = [];
  for (const line of output.split("\n")) {
    const fields = line.split(/[ \t]+/).filter((field) => field !== "");
    if (fields.length < 2) continue;
    entries.push({ sha: fields[0], ref: fields[1] });
  }
  return entries;
}

export function selectLatestRelease(
  entries: readonly LsRemoteEntry[],
): LatestRelease | null {
  interface Candidate {
    readonly tag: string;
    sha: string;
    readonly version: StableVersion;
  }
  const candidates = new Map<string, Candidate>();
  for (const entry of entries) {
    if (!entry.ref.startsWith("refs/tags/")) continue;
    let tag = entry.ref.slice("refs/tags/".length);
    let peeled = false;
    if (tag.endsWith("^{}")) {
      peeled = true;
      tag = tag.slice(0, -3);
    }
    const version = parseStableTag(tag);
    if (version === null) continue;
    const existing = candidates.get(tag);
    if (existing === undefined) {
      candidates.set(tag, { tag, sha: entry.sha, version });
    } else if (peeled) {
      existing.sha = entry.sha;
    }
  }
  let best: Candidate | null = null;
  for (const candidate of candidates.values()) {
    if (best === null || compareStable(candidate.version, best.version) > 0) {
      best = candidate;
    }
  }
  return best === null ? null : { tag: best.tag, sha: best.sha };
}

export function gitSafeSource(source: string): string {
  if (
    source.startsWith("/") ||
    source.startsWith("~") ||
    source.includes("://") ||
    source.includes(":")
  ) {
    return source;
  }
  return `${process.cwd()}/${source}`;
}

export async function resolveRef(
  upstreamUrl: string,
  requestedRef: string,
): Promise<Resolution> {
  const querySource = gitSafeSource(upstreamUrl);

  if (requestedRef === "latest-release") {
    const listed = await runGit([
      "ls-remote",
      "--tags",
      "--",
      querySource,
      "refs/tags/v*",
    ]);
    if (failed(listed)) {
      throw upstreamError(
        `cannot query upstream tags from ${upstreamUrl}: ${combined(listed)}`,
      );
    }
    const selected = selectLatestRelease(parseLsRemote(listed.stdout));
    if (selected === null) {
      throw upstreamError("no stable semver tag found for latest-release");
    }
    return { kind: "latest-release", ref: selected.tag, commit: selected.sha };
  }

  if (COMMIT_INPUT_RE.test(requestedRef)) {
    return { kind: "raw-commit", ref: requestedRef, commit: requestedRef };
  }

  const wanted = `refs/tags/${requestedRef}`;
  const tagged = await runGit([
    "ls-remote",
    "--tags",
    "--",
    querySource,
    wanted,
    `${wanted}^{}`,
  ]);
  if (failed(tagged)) {
    throw upstreamError(
      `cannot query upstream tag ${requestedRef} from ${upstreamUrl}: ${combined(tagged)}`,
    );
  }
  let tagSha = "";
  for (const entry of parseLsRemote(tagged.stdout)) {
    if (entry.ref === wanted || entry.ref === `${wanted}^{}`) {
      tagSha = entry.sha;
    }
  }
  if (tagSha !== "") {
    return { kind: "tag", ref: requestedRef, commit: tagSha };
  }

  const generic = await runGit(["ls-remote", "--", querySource, requestedRef]);
  if (failed(generic)) {
    throw upstreamError(
      `cannot query upstream ref ${requestedRef} from ${upstreamUrl}: ${combined(generic)}`,
    );
  }
  const first = parseLsRemote(generic.stdout)[0];
  if (first !== undefined) {
    return { kind: "ref", ref: requestedRef, commit: first.sha };
  }

  throw upstreamError(`cannot resolve upstream ref: ${requestedRef}`);
}

export async function resolveExactTag(
  source: string,
  ref: string,
): Promise<string> {
  const display = displaySource(source);
  const querySource = gitSafeSource(source);
  const wanted = `refs/tags/${ref}`;
  const listed = await runGit([
    "ls-remote",
    "--tags",
    "--",
    querySource,
    wanted,
    `${wanted}^{}`,
  ]);
  if (failed(listed)) {
    throw upstreamError(
      `cannot query exact upstream tag ${ref} from ${display}: ${combined(listed)}`,
    );
  }
  let direct = "";
  let peeled = "";
  for (const entry of parseLsRemote(listed.stdout)) {
    if (entry.ref === wanted) direct = entry.sha;
    if (entry.ref === `${wanted}^{}`) peeled = entry.sha;
  }
  const commit = peeled !== "" ? peeled : direct;
  if (commit === "") throw upstreamError(`upstream tag not found: ${ref}`);
  return commit;
}

async function inWorkspace<T>(
  parent: string,
  prefix: string,
  creationMessage: string,
  fn: (workspace: string) => Promise<T>,
): Promise<T> {
  try {
    return await withWorkspace(parent, prefix, fn);
  } catch (cause) {
    if (
      cause instanceof SafetyError &&
      cause.module === "workspace" &&
      cause.message === "cannot create workspace"
    ) {
      throw upstreamError(creationMessage);
    }
    throw cause;
  }
}

async function proveCommit(
  workspace: string,
  fetchSource: string,
  commit: string,
  display: string,
  initMessage: string,
): Promise<void> {
  const init = await runGit(["init", workspace]);
  if (failed(init)) {
    throw upstreamError(`${initMessage}: ${combined(init)}`);
  }
  const fetched = await runGit([
    "-C",
    workspace,
    "fetch",
    "--no-tags",
    "--",
    fetchSource,
    commit,
  ]);
  if (failed(fetched)) {
    if (UNAVAILABLE_OBJECT_RE.test(combined(fetched))) {
      throw upstreamError(`source cannot supply requested commit: ${commit}`);
    }
    throw upstreamError(`cannot fetch requested commit from ${display}`);
  }
  const typed = await runGit(["-C", workspace, "cat-file", "-t", commit]);
  if (failed(typed) || typed.stdout.trim() !== "commit") {
    throw upstreamError(`requested object is not a commit: ${commit}`);
  }
}

export async function verifyRawCommit(
  source: string,
  rawCommit: string,
  workspaceParent: string,
): Promise<string> {
  const commit = rawCommit.toLowerCase();
  const display = displaySource(source);
  const fetchSource = gitSafeSource(source);
  await inWorkspace(
    workspaceParent,
    "superpowers-manager.commit.",
    `cannot create raw-commit verification workspace under ${workspaceParent}`,
    async (workspace) => {
      await proveCommit(
        workspace,
        fetchSource,
        commit,
        display,
        "cannot initialize raw-commit verification workspace",
      );
    },
  );
  return commit;
}

export async function fetchExactCommit(
  source: string,
  commit: string,
  repository: string,
  workspaceParent: string,
): Promise<void> {
  const display = displaySource(source);
  const fetchSource = gitSafeSource(source);
  await inWorkspace(
    workspaceParent,
    "superpowers-manager.fetch.",
    `cannot create exact-commit fetch workspace under ${workspaceParent}`,
    async (workspace) => {
      await proveCommit(
        workspace,
        fetchSource,
        commit,
        display,
        "cannot initialize exact-commit fetch workspace",
      );
      if (!(await isDirectory(`${repository}/.git`))) {
        const init = await runGit(["init", repository]);
        if (failed(init)) {
          throw upstreamError(
            `cannot initialize upstream cache repository: ${combined(init)}`,
          );
        }
      }
      const transfer = await runGit([
        "-C",
        repository,
        "fetch",
        "--no-tags",
        "--",
        workspace,
        commit,
      ]);
      if (failed(transfer)) {
        throw upstreamError(
          `cannot transfer requested commit into upstream cache: ${combined(transfer)}`,
        );
      }
      const typed = await runGit(["-C", repository, "cat-file", "-t", commit]);
      if (failed(typed) || typed.stdout.trim() !== "commit") {
        throw upstreamError(
          `cannot verify requested commit in upstream cache: ${commit}`,
        );
      }
    },
  );
}
