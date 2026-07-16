#!/bin/sh
set -eu

root=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)
dockerfile="$root/tests/container/Dockerfile"
runner="$root/tests/container.sh"
tools="$root/tests/container/package.json"
probe="$root/tests/container/codex-offline-probe.sh"
tsconfig="$root/tests/tsconfig.json"

test -f "$dockerfile"
test -x "$runner"
test -f "$tools"
test -x "$probe"
test -f "$tsconfig"
test -f "$root/.dockerignore"

grep -Fxq 'FROM node:24-bookworm-slim' "$dockerfile"
grep -Fxq 'RUN useradd --create-home --uid 10001 spw' "$dockerfile"
grep -Fxq 'USER spw' "$dockerfile"
grep -Fq '"@openai/codex": "0.144.1"' "$tools"
grep -Fq '"typescript": "7.0.2"' "$tools"
grep -Fq '"@types/node": "24.13.3"' "$tools"
grep -Fq '"module": "NodeNext"' "$tsconfig"
grep -Fq '"moduleResolution": "NodeNext"' "$tsconfig"
if grep -Fq '"Node16"' "$tsconfig"; then
  echo "tsconfig must model the declared Node 24+ runtime with NodeNext" >&2
  exit 1
fi
grep -Fq -- '--network none' "$runner"
grep -Fq -- '--read-only' "$runner"
grep -Fq 'docker build --pull ' "$runner"
grep -Fq -- '--tmpfs /home/spw:rw,nosuid,size=128m,uid=10001,gid=10001' "$runner"
grep -Fq 'codex-spike)' "$runner"
grep -Fq 'actual_uid=$(id -u)' "$runner"
grep -Fq 'container acceptance suite must run as UID 10001' "$runner"
grep -Fxq 'plugins/.superpowers.tmp.*/' "$root/.gitignore"
grep -Fxq 'plugins/.superpowers.bak.*/' "$root/.gitignore"
grep -Fxq '.superpowers/' "$root/.dockerignore"
grep -Fxq '.worktrees/' "$root/.dockerignore"
grep -Fxq 'plugins/.superpowers.tmp.*/' "$root/.dockerignore"
grep -Fxq 'plugins/.superpowers.bak.*/' "$root/.dockerignore"

ruby - "$runner" <<'RUBY'
runner = File.read(ARGV.fetch(0))
inside = runner.match(/^if \[ "\$\{1:-\}" = "--inside" \]; then\n(?<body>.*?)^fi\n\nmode="\$\{1:-suite\}"/m)
raise "runner must define the --inside branch before host-side mode dispatch" unless inside
inside_lines = inside[:body].lines.map(&:rstrip)
uid_guard = [
  '  actual_uid=$(id -u)',
  '  if [ "$actual_uid" != 10001 ]; then',
  '    echo "error: container acceptance suite must run as UID 10001 (got $actual_uid)" >&2',
  '    exit 1',
  '  fi',
]
guard_index = inside_lines.each_cons(uid_guard.length).find_index { |lines| lines == uid_guard }
mode_index = inside_lines.index('  mode="${2:-suite}"')
dispatch_index = inside_lines.index('  case "$mode" in')
unless guard_index && mode_index && dispatch_index && guard_index < mode_index && mode_index < dispatch_index
  raise "--inside must reject UIDs other than 10001 before selecting or dispatching the acceptance mode"
end
suite = /suite\)\s+sh tests\/run\.sh\s+exec sh tests\/container\/codex-offline-probe\.sh\s+;;/
raise "suite mode must run the inner suite and then the offline Codex probe" unless runner.match?(suite)
RUBY

ruby - "$probe" <<'RUBY'
probe = File.read(ARGV.fetch(0))
commits = probe.scan(/^commit_([ab])=([0-9a-f]{40})$/).to_h
raise "offline probe must define distinct A and B commits" unless commits.keys.sort == ["a", "b"] && commits["a"] != commits["b"]
raise "offline probe Codex calls must use the timeout wrapper" if probe.match?(/^\s*codex\s+plugin\s+/)
run_codex = probe.match(/^run_codex\(\) \{\n(?<body>.*?)^\}\n/m)
raise "offline probe must define run_codex" unless run_codex
run_codex_lines = run_codex[:body].lines.map(&:strip).reject(&:empty?)
unless run_codex_lines == ['"$timeout_bin" 30 codex "$@"']
  raise "run_codex must route through the selected timeout binary"
end
raise "offline probe must assert marketplace B registration" unless probe.include?('assert_marketplace_root "$moved"')
unless probe.include?('install_plugin_and_assert_active "$version_b" "$commit_b" "$commit_a"')
  raise "offline probe must assert the CLI-selected B cache root and reject stale A provenance"
end
raise "offline probe must not accept provenance from an arbitrary cache path" if probe.include?("search_root.rglob")
unless probe.match?(/final_plugins=\$\(run_codex plugin list --json\).*final_marketplaces=\$\(run_codex plugin marketplace list --json\)/m)
  raise "offline probe must capture both final listings before absence assertions"
end
RUBY

echo "test_container_contract: OK"
