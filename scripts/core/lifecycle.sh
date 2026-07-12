#!/bin/sh
# Sourced module; callers own set -eu.

# Replace the live tree with a single atomic rename, keeping a backup so a
# failed swap restores the previous working generated tree. candidate and
# live_root must be same-filesystem siblings for atomic renames.
spw_replace_generated_tree() {
  candidate="$1"
  live_root="$2"
  parent=$(dirname "$live_root")
  backup="$parent/.superpowers.bak.$$"

  rm -rf "$backup"
  if [ -e "$live_root" ]; then
    mv "$live_root" "$backup"
  fi
  if mv "$candidate" "$live_root"; then
    rm -rf "$backup"
  else
    if [ -e "$backup" ]; then
      mv "$backup" "$live_root"
    fi
    rm -rf "$candidate"
    spw_die "failed to install generated tree into $live_root; previous tree restored"
  fi
}
