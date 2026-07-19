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
grep -Fxq 'plugins/.superpowers.bak.*/' "$root/.gitignore"
grep -Fxq '.superpowers/' "$root/.dockerignore"
grep -Fxq '.worktrees/' "$root/.dockerignore"
grep -Fxq 'plugins/.superpowers.prepare.*/' "$root/.dockerignore"
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
def function_body(probe, name)
  function = probe.match(/^#{Regexp.escape(name)}\(\) \{\n(?<body>.*?)^\}\n/m)
  raise "offline probe must define #{name}" unless function
  function[:body]
end

def active_lines(source)
  source.lines.map(&:strip).reject { |line| line.empty? || line.start_with?('#') }
end

def top_level_shell_lines(probe)
  lines = []
  in_function = false
  heredoc = nil
  probe.each_line do |raw|
    stripped = raw.strip
    if heredoc
      heredoc = nil if stripped == heredoc
      next
    end
    if in_function
      in_function = false if raw.match?(/^}\s*$/)
      next
    end
    if raw.match?(/^[A-Za-z_][A-Za-z0-9_]*\(\) \{\s*$/)
      in_function = true
      next
    end
    next if stripped.empty? || stripped.start_with?('#')
    lines << stripped
    delimiter = raw.match(/<<['"]?(?<delimiter>[A-Za-z_][A-Za-z0-9_]*)['"]?/)
    heredoc = delimiter[:delimiter] if delimiter
  end
  raise "unterminated top-level heredoc in offline probe" if heredoc
  raise "unterminated function in offline probe" if in_function
  lines
end

def require_ordered_lifecycle(probe, expected)
  actual = top_level_shell_lines(probe)
  cursor = -1
  expected.each do |statement|
    index = actual.each_index.find { |candidate| candidate > cursor && actual[candidate] == statement }
    raise "manager A/B lifecycle is missing or reordered: #{statement}" unless index
    cursor = index
  end
  expected_counts = Hash.new(0)
  expected.each { |statement| expected_counts[statement] += 1 }
  expected_counts.each do |statement, count|
    unless actual.count(statement) == count
      raise "manager A/B lifecycle must execute exactly #{count} time(s): #{statement}"
    end
  end
end

def validate_probe!(probe)
  raise "offline probe Codex calls must use the timeout wrapper" if probe.match?(/^\s*codex\s+plugin\s+/)

  run_codex_lines = active_lines(function_body(probe, 'run_codex'))
  unless run_codex_lines == ['"$timeout_bin" 30 codex "$@"']
    raise "run_codex must route through the selected timeout binary"
  end

  run_manager_lines = active_lines(function_body(probe, 'run_manager'))
  expected_manager_lines = [
    'SUPERPOWERS_CONFIG_DIR="$state/config" \\',
    'SUPERPOWERS_UPSTREAM_URL="$upstream" \\',
    'SUPERPOWERS_CACHE_DIR="$state/cache" \\',
    'SUPERPOWERS_CODEX=codex \\',
    'SUPERPOWERS_INSTALLED_SEARCH_ROOT="$HOME/.codex" \\',
    '"$package/bin/superpowers-manager.js" "$@"',
  ]
  unless run_manager_lines == expected_manager_lines
    raise "run_manager must route through the local package with isolated manager state"
  end

  fingerprint_body = function_body(probe, 'assert_active_installed_commit')
  python_block = fingerprint_body.match(
    /^\s*python3 -S - "\$listing" "\$expected_root" "\$expected_version" "\$expected_commit" "\$unexpected_commit" <<'PY'\n(?<python>.*?)^PY\n?\z/m
  )
  raise "fingerprint helper must pass the active-version root to Python" unless python_block
  prefix = fingerprint_body[0...python_block.begin(0)]
  expected_prefix = [
    'listing="$1"',
    'expected_version="$2"',
    'expected_commit="$3"',
    'unexpected_commit="$4"',
    'expected_root="$HOME/.codex/plugins/cache/superpowers-manager/superpowers/$expected_version"',
  ]
  unless active_lines(prefix) == expected_prefix
    raise "fingerprint helper must derive its exact cache root from expected_version"
  end
  python_lines = active_lines(python_block[:python])
  active_root_line = 'active_root = Path(root_arg).resolve(strict=True)'
  unless python_lines.grep(/\Aactive_root\s*=/) == [active_root_line]
    raise "fingerprint helper must resolve exactly one active root from root_arg"
  end
  provenance_read = 'with (active_root / ".superpowers-upstream.json").open(encoding="utf-8") as handle:'
  manifest_read = 'with (active_root / ".codex-plugin" / "plugin.json").open(encoding="utf-8") as handle:'
  binding_sequence = [
    'data = json.loads(listing)',
    'installed = data.get("installed") if isinstance(data, dict) else None',
    'matches = [',
    'if isinstance(item, dict) and item.get("pluginId") == "superpowers@superpowers-manager"',
    'if len(matches) != 1:',
    'if matches[0].get("version") != expected_version:',
    active_root_line,
    provenance_read,
    manifest_read,
  ]
  cursor = -1
  binding_sequence.each do |statement|
    index = python_lines.each_index.find do |candidate|
      candidate > cursor && python_lines[candidate] == statement
    end
    raise "fingerprint helper must bind active-root reads to Codex's reported version" unless index
    cursor = index
  end
  unless python_lines.grep(/\.superpowers-upstream\.json/) == [provenance_read]
    raise "fingerprint helper must read provenance only from the active root"
  end
  unless python_lines.grep(/plugin\.json/) == [manifest_read]
    raise "fingerprint helper must read the manifest only from the active root"
  end
  if python_lines.any? { |line| line == 'pass' || line.match?(/\Aif\s+(?:False|0)\s*:/) }
    raise "fingerprint helper must not hide active-root checks in a no-op block"
  end

  required = [
    'commit_a=$(git -C "$upstream" rev-parse HEAD)',
    'version_a="1.0.0+manager.$short_a"',
    'commit_b=$(git -C "$upstream" rev-parse HEAD)',
    'version_b="1.1.0+manager.$short_b"',
    'run_manager track-latest',
    'run_manager install',
    'initial_listing=$(run_codex plugin list --json)',
    'assert_active_installed_commit "$initial_listing" "$version_a" "$commit_a" ""',
    'reload_listing=$(run_codex plugin list --json)',
    'assert_active_installed_commit "$reload_listing" "$version_a" "$commit_a" "$commit_b"',
    'run_manager update',
    'updated_listing=$(run_codex plugin list --json)',
    'assert_active_installed_commit "$updated_listing" "$version_b" "$commit_b" "$commit_a"',
    'run_manager uninstall',
    'assert_marketplace_root "$package"',
  ]
  required.each { |text| raise "missing manager A/B step: #{text}" unless probe.include?(text) }
  raise "reload opportunity must use real Codex plugin inspection" unless probe.include?('reload_listing=$(run_codex plugin list --json)')
  raise "offline probe must not sweep retained cache paths" if probe.match?(/find\s+.*(?:superpowers-manager|\.superpowers-upstream\.json)/) || probe.include?('search_root.rglob')
  raise "old generic install helper must be replaced" if probe.include?('install_plugin_and_assert_active')
  raise "old moved-marketplace assertion must be replaced" if probe.include?('assert_marketplace_root "$moved"')
  unless probe.match?(/final_plugins=\$\(run_codex plugin list --json\).*final_marketplaces=\$\(run_codex plugin marketplace list --json\)/m)
    raise "offline probe must capture both final listings before absence assertions"
  end

  lifecycle = [
    'chmod +x "$package/bin/superpowers-manager.js"',
    'commit_a=$(git -C "$upstream" rev-parse HEAD)',
    'short_a=$(printf \'%s\' "$commit_a" | cut -c 1-7)',
    'version_a="1.0.0+manager.$short_a"',
    'run_manager track-latest',
    'run_manager install',
    'initial_listing=$(run_codex plugin list --json)',
    'assert_marketplace_root "$package"',
    'assert_active_installed_commit "$initial_listing" "$version_a" "$commit_a" ""',
    'commit_b=$(git -C "$upstream" rev-parse HEAD)',
    'short_b=$(printf \'%s\' "$commit_b" | cut -c 1-7)',
    'version_b="1.1.0+manager.$short_b"',
    'reload_listing=$(run_codex plugin list --json)',
    'printf \'%s\\n\' "$reload_listing" | grep -Fq \'superpowers@superpowers-manager\'',
    'assert_marketplace_root "$package"',
    'assert_active_installed_commit "$reload_listing" "$version_a" "$commit_a" "$commit_b"',
    'run_manager update',
    'updated_listing=$(run_codex plugin list --json)',
    'assert_active_installed_commit "$updated_listing" "$version_b" "$commit_b" "$commit_a"',
    'run_manager uninstall',
    'final_plugins=$(run_codex plugin list --json)',
    'final_marketplaces=$(run_codex plugin marketplace list --json)',
  ]
  require_ordered_lifecycle(probe, lifecycle)
end

probe = File.read(ARGV.fetch(0))
validate_probe!(probe)

mutations = {
  'no-op run_manager' => probe.sub(
    /^run_manager\(\) \{\n.*?^\}\n/m,
    "run_manager() {\n  :\n}\n"
  ),
  'reordered install lifecycle' => probe.sub(
    "run_manager track-latest\nrun_manager install",
    "run_manager install\nrun_manager track-latest"
  ),
  'unbound fingerprint root' => probe.sub(
    'expected_root="$HOME/.codex/plugins/cache/superpowers-manager/superpowers/$expected_version"',
    'expected_root="/tmp/unbound-manager-cache"'
  ),
  'unbound Codex listing version' => probe.sub(
    'if matches[0].get("version") != expected_version:',
    'if expected_version != expected_version:'
  ),
}
mutations.each do |name, mutation|
  raise "semantic mutation fixture made no change: #{name}" if mutation == probe
  begin
    validate_probe!(mutation)
  rescue RuntimeError
    next
  end
  raise "semantic source contract accepted invalid mutation: #{name}"
end
RUBY

echo "test_container_contract: OK"
