// Ports scripts/core/status.sh in full. Both functions are pure: no I/O, no
// environment. The three status strings are operator-facing and frozen.

// FROZEN CITATIONS: `scripts/…:NN` references below resolve against the tree at
// ad56569a4c161e7b122967442e2b026eeb6395f6, the last commit in which those paths existed. They are unmaintained
// and will not be re-derived. Resolve one with:
//   git show ad56569a4c161e7b122967442e2b026eeb6395f6:scripts/core/status.sh

// scripts/core/status.sh:4-9. The `[ -n "$observed" ]` guard comes first and
// is load-bearing: an empty observed commit must never match, or an absent
// generated tree reads as current.
export function commitMatches(desired: string, observed: string): boolean {
  if (observed.length === 0) return false;
  return observed === desired || observed === desired.slice(0, 7);
}

// scripts/core/status.sh:11-27. Branch order is part of the contract: a stale
// generated tree outranks a null installed fingerprint, so the operator is
// told to prepare before being told to install.
export function statusForCommits(
  desired: string,
  generated: string,
  installed: string,
): string {
  if (generated.length === 0 || !commitMatches(desired, generated)) {
    return "needs prepare";
  }
  if (installed.length === 0 || !commitMatches(desired, installed)) {
    return "needs install";
  }
  return "current";
}
