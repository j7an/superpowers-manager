const SEMVER_BASE_SOURCE =
  "(?:0|[1-9][0-9]*)\\.(?:0|[1-9][0-9]*)\\.(?:0|[1-9][0-9]*)" +
  "(?:-(?:(?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*)" +
  "(?:\\.(?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*))*))?";

export const SEMVER_BASE_RE = new RegExp(`^${SEMVER_BASE_SOURCE}$`);
export const TAG_RE = new RegExp(`^v${SEMVER_BASE_SOURCE}$`);
export const COMMIT_RE = /^[0-9a-f]{40}$/;
export const COMMIT_INPUT_RE = /^[0-9A-Fa-f]{40}$/;

export interface StableVersion {
  readonly major: bigint;
  readonly minor: bigint;
  readonly patch: bigint;
}

export function isTagRef(value: string): boolean {
  return TAG_RE.test(value);
}

export function isCommit(value: string): boolean {
  return COMMIT_RE.test(value);
}

export function normalizeCommitInput(value: string): string | null {
  return COMMIT_INPUT_RE.test(value) ? value.toLowerCase() : null;
}

export function parseStableTag(tag: string): StableVersion | null {
  if (!TAG_RE.test(tag)) return null;
  const core = tag.slice(1);
  // Prerelease filter. Sound only because TAG_RE already matched: the numeric
  // components cannot contain "-", so the sole way one reaches `core` is a
  // prerelease suffix. Stable-tag selection must exclude those.
  if (core.includes("-")) return null;
  const [major, minor, patch] = core.split(".");
  return { major: BigInt(major), minor: BigInt(minor), patch: BigInt(patch) };
}

export function compareStable(a: StableVersion, b: StableVersion): number {
  if (a.major !== b.major) return a.major < b.major ? -1 : 1;
  if (a.minor !== b.minor) return a.minor < b.minor ? -1 : 1;
  if (a.patch !== b.patch) return a.patch < b.patch ? -1 : 1;
  return 0;
}
