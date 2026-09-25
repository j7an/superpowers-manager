#!/bin/sh
set -eu

if [ "${SPW_CONTAINER:-}" != 1 ] || [ "$(id -u)" != 10001 ]; then
  echo "error: Claude Code acceptance requires the isolated UID 10001 container" >&2
  exit 1
fi
if [ "${1:-}" != --isolated ]; then
  exec env -i PATH="$PATH" HOME=/home/spw SPW_CONTAINER=1 sh "$0" --isolated
fi

root=$(mktemp -d /tmp/spw-claude-code-XXXXXX)
trap 'rm -rf "$root"' EXIT HUP INT TERM
HOME="$root/home"
CLAUDE_CONFIG_DIR="$root/claude"
CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1
DISABLE_AUTOUPDATER=1
SUPERPOWERS_CONFIG_DIR="$root/config"
SUPERPOWERS_CACHE_DIR="$root/cache"
SUPERPOWERS_UPSTREAM_URL="$root/upstream"
SUPERPOWERS_CLAUDE_CODE=claude
GIT_CONFIG_GLOBAL=/dev/null
GIT_CONFIG_NOSYSTEM=1
export HOME CLAUDE_CONFIG_DIR CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC \
  DISABLE_AUTOUPDATER SUPERPOWERS_CONFIG_DIR SUPERPOWERS_CACHE_DIR \
  SUPERPOWERS_UPSTREAM_URL SUPERPOWERS_CLAUDE_CODE GIT_CONFIG_GLOBAL \
  GIT_CONFIG_NOSYSTEM
upstream=$SUPERPOWERS_UPSTREAM_URL
mkdir -p "$HOME" "$CLAUDE_CONFIG_DIR" "$root/cwd" \
  "$upstream/.claude-plugin" "$upstream/skills/using-superpowers"
cd "$root/cwd"
marketplace="$CLAUDE_CONFIG_DIR/superpowers-manager/marketplace"
plugin_root="$marketplace/plugins/superpowers"

fail() { echo "error: $*" >&2; exit 1; }
run_manager() { timeout 60 node /workspace/src/cli.ts "$@"; }
claude_cli() { timeout 60 claude "$@"; }
fixture_git() {
  git -C "$upstream" -c user.name=fixture -c user.email=fixture@example.invalid \
    -c core.hooksPath=/dev/null -c init.templateDir= "$@"
}
snapshot() { find "$CLAUDE_CONFIG_DIR" "$HOME" -type f -exec sha256sum {} + | sort; }
listed() {
  claude_cli plugin list --json | node -e '
    let s = ""; process.stdin.on("data", (d) => (s += d)).on("end", () => {
      const e = JSON.parse(s).find((p) => p.id === "superpowers@superpowers-manager");
      process.stdout.write(e ? String(e[process.argv[1]]) : "");
    });' "$1"
}

cp /workspace/tests/fixtures/claude-code-native/plugin.json.txt "$upstream/.claude-plugin/plugin.json"
cp /workspace/tests/fixtures/pi-native/SKILL.md.txt "$upstream/skills/using-superpowers/SKILL.md"
cp /workspace/tests/fixtures/pi-native/LICENSE.txt "$upstream/LICENSE"
fixture_git init -q
fixture_git add .
fixture_git commit -qm 'native fixture A'
commit_a=$(fixture_git rev-parse HEAD)
run_manager pin "$commit_a"
run_manager prepare --harness claude-code

# An enabled Superpowers from another marketplace refuses install before mutation.
other="$root/other-market"
mkdir -p "$other/.claude-plugin"
cp -R "$upstream" "$other/sp"
rm -rf "$other/sp/.git"
printf '%s\n' '{"name":"other-market","owner":{"name":"fixture"},"plugins":[{"name":"superpowers","source":"./sp"}]}' \
  >"$other/.claude-plugin/marketplace.json"
claude_cli plugin marketplace add "$other"
claude_cli plugin install superpowers@other-market --scope user
snapshot >"$root/before-refusal"
if run_manager install --harness claude-code >"$root/refused.out" 2>"$root/refused.err"; then
  fail "install succeeded despite an enabled conflicting Superpowers plugin"
fi
grep -Fq "claude plugin disable superpowers@other-market" "$root/refused.err" \
  || fail "refusal did not print the disable command"
snapshot >"$root/after-refusal"
cmp "$root/before-refusal" "$root/after-refusal" || fail "refused install mutated state"
claude_cli plugin marketplace remove other-market

run_manager install --harness claude-code
short_a=$(printf %s "$commit_a" | cut -c1-7)
case "$(listed version)" in *"+manager.$short_a") ;; *) fail "listed version does not carry commit A" ;; esac
snapshot >"$root/before-probe"
run_manager probe --harness claude-code --porcelain >"$root/probe.out"
snapshot >"$root/after-probe"
cmp "$root/before-probe" "$root/after-probe" || fail "probe mutated Claude Code state"
grep -Fxq "status=current" "$root/probe.out" || fail "probe did not report current"

mkdir -p "$upstream/skills/snapshot-probe"
printf -- '---\nname: snapshot-probe\ndescription: Use when verifying a Claude Code snapshot refresh\n---\nphase B\n' \
  >"$upstream/skills/snapshot-probe/SKILL.md"
fixture_git add .
fixture_git commit -qm 'native fixture B'
commit_b=$(fixture_git rev-parse HEAD)
run_manager pin "$commit_b"
run_manager prepare --harness claude-code
case "$(listed version)" in *"+manager.$short_a") ;; *) fail "preparing B changed the active plugin" ;; esac
test ! -e "$plugin_root/skills/snapshot-probe" || fail "preparing B touched the installed snapshot"

run_manager update --harness claude-code
short_b=$(printf %s "$commit_b" | cut -c1-7)
case "$(listed version)" in *"+manager.$short_b") ;; *) fail "listed version does not carry commit B" ;; esac
claude_cli plugin details superpowers >"$root/details.out"
grep -Fq snapshot-probe "$root/details.out" || fail "Claude Code did not load snapshot B"

run_manager uninstall --harness claude-code
if claude_cli plugin list --json | grep -Fq 'superpowers@superpowers-manager'; then
  fail "plugin still listed after uninstall"
fi
test ! -e "$marketplace" || fail "marketplace directory remains after uninstall"
run_manager uninstall --harness claude-code >"$root/noop.out"
grep -Fxq "No managed Superpowers Claude Code installation is present." "$root/noop.out" \
  || fail "second uninstall was not idempotent"
echo "claude-code harness integration: complete status=0"
