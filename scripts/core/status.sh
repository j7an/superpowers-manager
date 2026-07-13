#!/bin/sh
# Sourced module; callers own set -eu.

spw_commit_matches() {
  desired="$1"
  observed="$2"
  short=$(printf '%s' "$desired" | cut -c 1-7)
  [ -n "$observed" ] && { [ "$observed" = "$desired" ] || [ "$observed" = "$short" ]; }
}

spw_status_for_commits() {
  desired="$1"
  generated="$2"
  installed="$3"

  if [ -z "$generated" ]; then
    printf '%s\n' "needs prepare"
  elif ! spw_commit_matches "$desired" "$generated"; then
    printf '%s\n' "needs prepare"
  elif [ -z "$installed" ]; then
    printf '%s\n' "needs install"
  elif ! spw_commit_matches "$desired" "$installed"; then
    printf '%s\n' "needs install"
  else
    printf '%s\n' "current"
  fi
}
