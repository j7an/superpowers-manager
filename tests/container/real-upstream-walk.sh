#!/bin/sh
# Sourced by an isolated harness walk; callers invoke its functions as plain statements.

walk_fail() { echo "error: real-upstream $SPW_WALK_HARNESS: $*" >&2; exit 1; }
run_manager() { timeout 60 node /workspace/src/cli.ts "$@"; }

walk_setup() {
  mkdir -p "$root/walk"
  GIT_CONFIG_NOSYSTEM=1
  GIT_CONFIG_GLOBAL="$root/walk/gitconfig"
  export GIT_CONFIG_NOSYSTEM GIT_CONFIG_GLOBAL
  cat >"$GIT_CONFIG_GLOBAL" <<'CONFIG'
[safe]
  directory = /opt/spw-upstream/superpowers
[url "/opt/spw-upstream/superpowers"]
  insteadOf = https://github.com/obra/superpowers
[protocol "https"]
  allow = never
CONFIG
  unset SUPERPOWERS_UPSTREAM_URL
  git ls-remote https://github.com/obra/superpowers >"$root/walk/remote-raw" 2>/dev/null \
    || walk_fail "mirror does not match tests/container/upstream-refs"
  sed '/\^{}$/d' "$root/walk/remote-raw" | LC_ALL=C sort >"$root/walk/remote"
  walk_newest=$(sed -n '1p' /workspace/tests/container/upstream-refs)
  walk_commit=$(git -C /opt/spw-upstream/superpowers rev-parse "$walk_newest^{commit}") \
    || walk_fail "mirror does not match tests/container/upstream-refs"
  printf '%s\t%s\n' "$walk_commit" HEAD "$walk_commit" refs/heads/main >"$root/walk/expected-refs"
  while IFS= read -r walk_ref; do
    walk_object=$(git -C /opt/spw-upstream/superpowers rev-parse "$walk_ref") \
      || walk_fail "mirror does not match tests/container/upstream-refs"
    printf '%s\trefs/tags/%s\n' "$walk_object" "$walk_ref" >>"$root/walk/expected-refs"
  done </workspace/tests/container/upstream-refs
  LC_ALL=C sort "$root/walk/expected-refs" >"$root/walk/expected-refs-sorted"
  cmp -s "$root/walk/expected-refs-sorted" "$root/walk/remote" \
    || walk_fail "mirror does not match tests/container/upstream-refs"
}

expected_names() {
  git -C /opt/spw-upstream/superpowers ls-tree -r --name-only "$1" -- skills \
    >"$root/walk/tree" || walk_fail "cannot inspect upstream skills at $1"
  sed -n 's|^skills/\([^/]*\)/SKILL\.md$|\1|p' "$root/walk/tree" | LC_ALL=C sort -u
}

walk_snapshot() {
  find "$root" -path "$root/walk" -prune -o -type f -exec sha256sum {} + \
    >"$root/walk/snapshot-raw" || walk_fail "cannot snapshot harness state"
  LC_ALL=C sort "$root/walk/snapshot-raw"
}

walk_check() {
  walk_tag=$1
  walk_commit=$(git -C /opt/spw-upstream/superpowers rev-parse "$walk_tag^{commit}")
  walk_snapshot >"$root/walk/before"
  run_manager probe --harness "$SPW_WALK_HARNESS" --porcelain >"$root/walk/probe"
  walk_snapshot >"$root/walk/after"
  cmp -s "$root/walk/before" "$root/walk/after" || walk_fail "probe mutated state at $walk_tag"
  grep -Fxq status=current "$root/walk/probe" || walk_fail "probe status is not current at $walk_tag"
  grep -Fxq installation_state=current "$root/walk/probe" || walk_fail "installation is not current at $walk_tag"
  grep -Fxq "desired_commit=$walk_commit" "$root/walk/probe" || walk_fail "desired commit differs at $walk_tag"
  case "$SPW_WALK_HARNESS" in
    pi|opencode) grep -Fxq compatibility=supported "$root/walk/probe" || walk_fail "unsupported compatibility at $walk_tag" ;;
  esac
  # ponytail: Names-only discovery cannot detect stale content under unchanged names;
  # add per-skill digests if an update ever ships that failure.
  expected_names "$walk_tag" >"$root/walk/expected-names"
  discovered_names >"$root/walk/discovered-names" || walk_fail "skill discovery failed at $walk_tag"
  if ! cmp -s "$root/walk/expected-names" "$root/walk/discovered-names"; then
    echo "expected skills at $walk_tag:" >&2
    cat "$root/walk/expected-names" >&2
    echo "discovered:" >&2
    cat "$root/walk/discovered-names" >&2
    walk_fail "discovered skills differ at $walk_tag"
  fi
  if command -v listed_version >/dev/null 2>&1; then
    walk_version=$(listed_version) || walk_fail "version discovery failed at $walk_tag"
    walk_short=$(printf '%s' "$walk_commit" | cut -c1-7)
    case "$walk_version" in
      *"+manager.$walk_short") ;;
      *) walk_fail "listed version differs at $walk_tag" ;;
    esac
  fi
  echo "real-upstream $SPW_WALK_HARNESS: $walk_tag verified"
}

walk_main() {
  # ponytail: The window is hand-bumped; automate its bump PR if drift failures become noisy.
  sed '1!G;h;$!d' /workspace/tests/container/upstream-refs >"$root/walk/tags"
  walk_first=1
  while IFS= read -r walk_next_tag; do
    run_manager pin "$walk_next_tag"
    run_manager prepare --harness "$SPW_WALK_HARNESS"
    if [ "$walk_first" = 1 ]; then
      run_manager install --harness "$SPW_WALK_HARNESS"
      walk_first=0
    else
      # ponytail: Stale-skill removal on update is exercised once a window tag removes a skill.
      run_manager update --harness "$SPW_WALK_HARNESS"
    fi
    walk_check "$walk_next_tag"
  done <"$root/walk/tags"
  walk_identity_key=installed_identity
  [ "$SPW_WALK_HARNESS" != codex ] || walk_identity_key=installed_commit
  grep "^$walk_identity_key=" "$root/walk/probe" >"$root/walk/identity-before" \
    || walk_fail "probe omitted installed identity"
  run_manager track-latest
  run_manager update --harness "$SPW_WALK_HARNESS"
  walk_check "$walk_newest"
  grep "^$walk_identity_key=" "$root/walk/probe" >"$root/walk/identity-after" \
    || walk_fail "probe omitted installed identity"
  cmp -s "$root/walk/identity-before" "$root/walk/identity-after" || walk_fail "track-latest update changed installed identity"
  run_manager unpin
  run_manager probe --harness "$SPW_WALK_HARNESS" --porcelain >"$root/walk/unpinned-probe"
  grep -Fxq status=current "$root/walk/unpinned-probe" || walk_fail "unpin probe status is not current"
  walk_commit=$(git -C /opt/spw-upstream/superpowers rev-parse "$walk_newest^{commit}")
  grep -Fxq "desired_commit=$walk_commit" "$root/walk/unpinned-probe" || walk_fail "unpin desired commit differs"
  run_manager uninstall --harness "$SPW_WALK_HARNESS"
  discovered_names >"$root/walk/uninstalled-names" || walk_fail "skill discovery failed after uninstall"
  [ ! -s "$root/walk/uninstalled-names" ] || walk_fail "skills remain after uninstall"
  run_manager uninstall --harness "$SPW_WALK_HARNESS" >"$root/walk/second-uninstall"
  if [ "$SPW_WALK_HARNESS" != codex ]; then
    printf '%s\n' "No managed Superpowers $SPW_WALK_LABEL installation is present." >"$root/walk/expected-uninstall"
    cmp -s "$root/walk/expected-uninstall" "$root/walk/second-uninstall" || walk_fail "second uninstall was not idempotent"
  fi
  echo "real-upstream $SPW_WALK_HARNESS: complete status=0"
}
