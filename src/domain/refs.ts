export const TAG_RE =
  /^v(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:-(?:(?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*))*))?$/;
export const COMMIT_RE = /^[0-9a-f]{40}$/;
export const COMMIT_INPUT_RE = /^[0-9A-Fa-f]{40}$/;

export function isTagRef(value: string): boolean {
  return TAG_RE.test(value);
}

export function isCommit(value: string): boolean {
  return COMMIT_RE.test(value);
}

export function normalizeCommitInput(value: string): string | null {
  return COMMIT_INPUT_RE.test(value) ? value.toLowerCase() : null;
}
