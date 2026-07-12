#!/bin/sh
set -eu

root=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)
dockerfile="$root/tests/container/Dockerfile"
runner="$root/tests/container.sh"
tools="$root/tests/container/package.json"
probe="$root/tests/container/codex-offline-probe.sh"

test -f "$dockerfile"
test -x "$runner"
test -f "$tools"
test -x "$probe"
test -f "$root/.dockerignore"

grep -Fq 'node:24.18.0-bookworm-slim@sha256:cb4e8f7c443347358b7875e717c29e27bf9befc8f5a26cf18af3c3dec80e58c5' "$dockerfile"
grep -Fq '"@openai/codex": "0.144.1"' "$tools"
grep -Fq '"typescript": "7.0.2"' "$tools"
grep -Fq '"@types/node": "24.13.3"' "$tools"
grep -Fq -- '--network none' "$runner"
grep -Fq -- '--read-only' "$runner"
grep -Fq -- '--tmpfs /home/spw:rw,nosuid,size=128m,uid=10001,gid=10001' "$runner"
grep -Fq 'codex-spike)' "$runner"
grep -Fxq '.superpowers/' "$root/.dockerignore"

ruby - "$runner" <<'RUBY'
runner = File.read(ARGV.fetch(0))
suite = /suite\)\s+sh tests\/run\.sh\s+exec sh tests\/container\/codex-offline-probe\.sh\s+;;/
raise "suite mode must run the inner suite and then the offline Codex probe" unless runner.match?(suite)
RUBY

ruby - "$probe" <<'RUBY'
probe = File.read(ARGV.fetch(0))
commits = probe.scan(/^commit_([ab])=([0-9a-f]{40})$/).to_h
raise "offline probe must define distinct A and B commits" unless commits.keys.sort == ["a", "b"] && commits["a"] != commits["b"]
raise "offline probe Codex calls must use the timeout wrapper" if probe.match?(/^\s*codex\s+plugin\s+/)
raise "offline probe must assert marketplace B registration" unless probe.include?('assert_marketplace_root "$moved"')
raise "offline probe must assert installed B provenance" unless probe.include?('assert_installed_commit "$commit_b"')
RUBY

echo "test_container_contract: OK"
