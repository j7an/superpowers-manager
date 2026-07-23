#!/bin/sh
set -eu

script_dir=$(CDPATH= cd -- "$(dirname "$0")" && pwd)
. "$script_dir/../lib/harness.sh"

usage() {
  printf '%s\n' \
    'usage: baseline-scenario.sh COMMAND DESTINATION' \
    'commands: git-release-repo broken-symlink escaping-symlink permission-denied interrupted-prepare-state interrupted-install-state' >&2
  exit 2
}

require_absent_destination() {
  destination=$1
  case "$destination" in
    /*) ;;
    *)
      printf '%s\n' "error: destination must be absolute: $destination" >&2
      exit 2
      ;;
  esac
  if [ -e "$destination" ] || [ -L "$destination" ]; then
    printf '%s\n' "error: destination already exists: $destination" >&2
    exit 1
  fi
  mkdir -p "$(dirname "$destination")"
}

[ "$#" -eq 2 ] || usage
command_name=$1
destination=$2

case "$command_name" in
  git-release-repo)
    require_absent_destination "$destination"
    git init "$destination" >/dev/null
    git -C "$destination" config user.email superpowers-manager@example.invalid
    git -C "$destination" config user.name superpowers-manager
    git -C "$destination" config commit.gpgsign false
    git -C "$destination" config tag.gpgsign false
    git -C "$destination" branch -M main

    mkdir -p "$destination/skills/brainstorming" \
      "$destination/.codex-plugin"
    cat > "$destination/skills/brainstorming/SKILL.md" <<'EOF'
---
name: brainstorming
description: Baseline upstream skill
---
# Brainstorming
EOF
    cat > "$destination/.codex-plugin/plugin.json" <<'EOF'
{
  "name": "superpowers",
  "version": "1.0.0",
  "description": "Baseline upstream manifest",
  "skills": "./skills/",
  "hooks": {}
}
EOF
    printf '%s\n' 'baseline license' > "$destination/LICENSE"
    printf '%s\n' 'baseline readme' > "$destination/README.md"
    printf '%s\n' 'baseline conduct' > "$destination/CODE_OF_CONDUCT.md"
    git -C "$destination" add .
    spw_git_commit "$destination" 'baseline v1.0.0'
    base_commit=$(git -C "$destination" rev-parse HEAD)
    spw_git_tag "$destination" v1.0.0 'baseline v1.0.0'

    printf '%s\n' 'prerelease' > "$destination/skills/brainstorming/RELEASE"
    git -C "$destination" add skills/brainstorming/RELEASE
    spw_git_commit "$destination" 'baseline v1.1.0-rc.1'
    prerelease_commit=$(git -C "$destination" rev-parse HEAD)
    spw_git_tag "$destination" v1.1.0-rc.1 'baseline v1.1.0-rc.1'

    printf '%s\n' 'stable' > "$destination/skills/brainstorming/RELEASE"
    git -C "$destination" add skills/brainstorming/RELEASE
    spw_git_commit "$destination" 'baseline v1.1.0'
    stable_commit=$(git -C "$destination" rev-parse HEAD)
    spw_git_tag "$destination" v1.1.0 'baseline v1.1.0'

    printf '%s\n' 'raw' > "$destination/skills/brainstorming/RAW"
    git -C "$destination" add skills/brainstorming/RAW
    spw_git_commit "$destination" 'baseline raw commit'
    raw_commit=$(git -C "$destination" rev-parse HEAD)

    printf 'REPO=%s\nBASE_COMMIT=%s\nSTABLE_COMMIT=%s\nPRERELEASE_COMMIT=%s\nRAW_COMMIT=%s\n' \
      "$destination" "$base_commit" "$stable_commit" "$prerelease_commit" \
      "$raw_commit"
    ;;
  broken-symlink)
    require_absent_destination "$destination"
    mkdir "$destination"
    ln -s missing-target "$destination/target"
    printf 'ROOT=%s\nTARGET=%s\n' "$destination" "$destination/target"
    ;;
  escaping-symlink)
    require_absent_destination "$destination"
    outside="$(dirname "$destination")/$(basename "$destination").outside"
    if [ -e "$outside" ] || [ -L "$outside" ]; then
      printf '%s\n' "error: scenario outside path already exists: $outside" >&2
      exit 1
    fi
    mkdir "$destination" "$outside"
    printf '%s\n' 'outside target' > "$outside/target"
    ln -s "../$(basename "$outside")/target" "$destination/target"
    printf 'ROOT=%s\nTARGET=%s\nOUTSIDE=%s\n' \
      "$destination" "$destination/target" "$outside"
    ;;
  permission-denied)
    require_absent_destination "$destination"
    mkdir -p "$destination/locked"
    printf '%s\n' 'permission denied target' > "$destination/locked/target"
    chmod 000 "$destination/locked"
    printf 'ROOT=%s\nTARGET=%s\n' "$destination" "$destination/locked/target"
    ;;
  interrupted-prepare-state)
    require_absent_destination "$destination"
    previous_tree="$destination/plugins/superpowers"
    prepare_staging="$destination/plugins/.superpowers.prepare.interrupted/superpowers"
    sibling="$destination/sibling"
    mkdir -p "$previous_tree/.codex-plugin" \
      "$previous_tree/skills/brainstorming" \
      "$prepare_staging" "$sibling"
    cat > "$previous_tree/.codex-plugin/plugin.json" <<'EOF'
{
  "name": "superpowers",
  "version": "1.0.0+manager.0123456",
  "description": "Previously accepted baseline plugin",
  "skills": "./skills/"
}
EOF
    cat > "$previous_tree/skills/brainstorming/SKILL.md" <<'EOF'
---
name: brainstorming
description: Previously accepted baseline skill
---
# Brainstorming
EOF
    printf '%s\n' 'previous license' > "$previous_tree/LICENSE"
    printf '%s\n' 'previous readme' > "$previous_tree/README.md"
    printf '%s\n' 'previous conduct' > "$previous_tree/CODE_OF_CONDUCT.md"
    cat > "$previous_tree/.superpowers-upstream.json" <<'EOF'
{
  "source": "https://example.invalid/baseline",
  "requested_ref": "v1.1.0",
  "resolved_ref": "v1.1.0",
  "commit": "0123456789abcdef0123456789abcdef01234567",
  "upstream_manifest_version": "1.1.0"
}
EOF
    printf '%s\n' 'interrupted candidate' > "$prepare_staging/incomplete"
    printf '%s\n' 'retained sibling' > "$sibling/keep"
    printf 'ROOT=%s\nPREVIOUS_TREE=%s\nPREPARE_STAGING=%s\nSIBLING=%s\n' \
      "$destination" "$previous_tree" "$prepare_staging" "$sibling"
    ;;
  interrupted-install-state)
    require_absent_destination "$destination"
    manager_state="$destination/manager-state"
    legacy_state="$destination/legacy-state"
    operation_marker="$destination/adapter-operation.incomplete"
    mkdir -p "$manager_state" "$legacy_state"
    printf '%s\n' 'retained manager state' > "$manager_state/keep"
    printf '%s\n' 'retained legacy state' > "$legacy_state/keep"
    printf '%s\n' 'install interrupted before verification' > "$operation_marker"
    printf 'ROOT=%s\nMANAGER_STATE=%s\nLEGACY_STATE=%s\nOPERATION_MARKER=%s\n' \
      "$destination" "$manager_state" "$legacy_state" "$operation_marker"
    ;;
  *) usage ;;
esac
