#!/bin/sh
set -eu

test_dir=$(CDPATH= cd -- "$(dirname "$0")" && pwd)
. "$test_dir/lib/harness.sh"
spw_test_root
dockerfile="$root/tests/container/Dockerfile"
runner="$root/tests/container.sh"
tools="$root/tests/container/package.json"
probe="$root/tests/container/codex-offline-probe.sh"
hooks_rpc="$root/tests/container/hooks-list-rpc.py"
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
grep -Fq '"@openai/codex": "0.144.6"' "$tools"
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

test -f "$hooks_rpc"
if [ -x "$hooks_rpc" ]; then
  echo "hooks/list RPC helper must remain non-executable" >&2
  exit 1
fi
grep -Fxq 'from __future__ import annotations' "$hooks_rpc"
python3 -S - "$hooks_rpc" <<'PY'
import ast
from pathlib import Path
import sys

ast.parse(Path(sys.argv[1]).read_text(encoding="utf-8"), filename=sys.argv[1])
PY

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

ruby - "$probe" "$hooks_rpc" <<'RUBY'
def function_body(probe, name)
  function = probe.match(/^#{Regexp.escape(name)}\(\) \{\n/)
  raise "offline probe must define #{name}" unless function
  body = +''
  heredoc = nil
  probe[function.end(0)..].each_line do |raw|
    if heredoc
      body << raw
      heredoc = nil if raw.strip == heredoc
      next
    end
    return body if raw.match?(/^}\s*$/)
    body << raw
    delimiter = raw.match(/<<['"]?(?<delimiter>[A-Za-z_][A-Za-z0-9_]*)['"]?/)
    heredoc = delimiter[:delimiter] if delimiter
  end
  raise "offline probe has unterminated function #{name}"
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

def require_ordered_source(source, expected, error)
  cursor = -1
  expected.each do |statement|
    index = source.index(statement, cursor + 1)
    raise error unless index
    cursor = index
  end
end

def validate_hooks_rpc!(hooks_rpc)
  required = [
    'if process.poll() is not None or process.stdin is None:',
    'fail(f"could not send request: {exc}")',
    'def reject_constant(constant: str) -> None:',
    'raise ValueError(f"non-standard numeric constant: {constant}")',
    'parse_constant=reject_constant',
    'fail(f"malformed JSONL response: {exc}")',
    'deadline = time.monotonic() + 25',
    'remaining = deadline - time.monotonic()',
    'if remaining <= 0 or not selector.select(remaining):',
    'fail("timed out waiting for app-server output")',
    'fail("app-server stdout is unavailable")',
    'chunk = os.read(process.stdout.fileno(), 65536)',
    'if not chunk:',
    'fail("EOF before the required response")',
    'if not isinstance(message, dict):',
    'id_value = message.get("id")',
    'if type(id_value) is not int or id_value != expected_id:',
    'if "error" in message:',
    'if "result" not in message:',
    'fail(f"response id {expected_id} has no result")',
    '["codex", "app-server"]',
    'stdin=subprocess.PIPE',
    'stdout=subprocess.PIPE',
    'fail("app-server stdout pipe was not created")',
    'selector.register(process.stdout, selectors.EVENT_READ)',
  ]
  required.each { |text| raise "RPC helper missing protocol gate: #{text}" unless hooks_rpc.include?(text) }

  handshake = [
    '"id": 0,',
    '"method": "initialize",',
    'receive(process, selector, 0)',
    'send(process, {"method": "initialized"})',
    'send(process, {"id": 1, "method": "hooks/list", "params": {"cwds": [cwd]}})',
    'response = receive(process, selector, 1)',
    'Path(response_name).write_text(',
  ]
  require_ordered_source(
    hooks_rpc,
    handshake,
    "RPC helper must keep the staged initialize and hooks/list handshake"
  )
end

def validate_hook_response_assertion!(probe, name, terminal)
  body = function_body(probe, name)
  required_gate = [
    'with Path(response_name).open(encoding="utf-8") as handle:',
    'response = json.load(handle)',
    'if not isinstance(response, dict) or response.get("id") != 1:',
    'if "error" in response:',
    'result = response.get("result")',
    'if not isinstance(result, dict):',
    'data = result.get("data")',
    'if not isinstance(data, list):',
    'manager_hooks = [',
    terminal,
  ]
  require_ordered_source(
    body,
    required_gate,
    "#{name} must gate hook assertions on a successful id == 1 response"
  )
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


  schema_generation = 'run_codex app-server generate-json-schema --out "$schema_root"'
  rpc_invocation = '"$package/tests/container/hooks-list-rpc.py"'
  raise "offline probe must generate the app-server schema" unless probe.include?(schema_generation)
  unless probe.include?('"$timeout_bin" 30 python3 -S \\') && probe.include?(rpc_invocation)
    raise "offline probe must invoke the bounded hooks/list helper"
  end

  hook_contract = [
    'schema_root="$root/app-server-schema"',
    'Codex 0.144.6 hooks/list protocol changed',
    'ClientRequest.json',
    'v2/HooksListResponse.json',
    '"hooks/list"',
    '"source"',
    '"enabled"',
    '"isManaged"',
    '"trustStatus"',
    '"pluginId"',
    '"plugin"',
    '"untrusted"',
    '"hooks": {}',
    '"hooks": "./hooks/hooks-codex.json"',
    'sh \"${PLUGIN_ROOT}/hooks/session-start-codex\"',
    '/tmp/superpowers-manager-hook-sentinel',
    '$HOME/.codex/hooks.state',
    '$HOME/.codex/requirements.toml',
  ]
  hook_contract.each { |text| raise "missing hook acceptance contract: #{text}" unless probe.include?(text) }
  raise "offline probe must resolve its real working directory" unless probe.include?('probe_cwd=$(pwd -P)')
  raise "offline probe must not invoke the synthetic hook" if probe.match?(/(?:^|\s)session-start-codex(?:\s|$)/)
  raise "offline probe must not enable hook trust bypasses" if probe.include?('--dangerously-bypass-hook-trust')
  raise "offline probe must not make model calls" if probe.match?(/\brun_codex\s+(?:e|exec)\b/)

  validate_hook_response_assertion!(
    probe,
    'assert_manager_hooks_absent',
    'if manager_hooks:'
  )
  validate_hook_response_assertion!(
    probe,
    'assert_manager_hook_active',
    'if len(manager_hooks) != 1:'
  )
  active_body = function_body(probe, 'assert_manager_hook_active')
  active_fields = [
    '"source": "plugin",',
    '"pluginId": "superpowers@superpowers-manager",',
    '"trustStatus": "untrusted",',
    'if actual.get("enabled") is not True:',
    'if actual.get("isManaged") is not False:',
  ]
  active_fields.each { |text| raise "active hook assertion missing exact metadata: #{text}" unless active_body.include?(text) }

  schema_body = function_body(probe, 'assert_hooks_schema_compatible')
  schema_gates = [
    'if "pluginId" not in properties:',
    'if "pluginId" in required:',
    'fail("HookMetadata pluginId unexpectedly became required")',
    'plugin_id_types = allowed_types(hooks_response, properties["pluginId"])',
    'if plugin_id_types != {"string", "null"}:',
  ]
  require_ordered_source(
    schema_body,
    schema_gates,
    "schema preflight must require optional, exact string-or-null pluginId"
  )

  top_level = top_level_shell_lines(probe)
  manager_mutations = [
    'run_manager track-latest',
    'run_manager install',
    'run_manager update',
    'run_manager uninstall',
  ]
  manager_mutations.each do |mutation|
    indices = top_level.each_index.select { |index| top_level[index] == mutation }
    raise "manager mutation must execute exactly once: #{mutation}" unless indices.length == 1
    index = indices.fetch(0)
    unless top_level[index - 1] == 'hook_state_before=$(snapshot_hook_state)' &&
           top_level[index + 1] == 'hook_state_after=$(snapshot_hook_state)'
      raise "manager mutation must be immediately bracketed by hook-state snapshots: #{mutation}"
    end
  end
  unless top_level.count('assert_hook_state_unchanged "$hook_state_before" "$hook_state_after"') == manager_mutations.length
    raise "every manager mutation must compare hook-state snapshots"
  end
  unless top_level.count('assert_requirements_unchanged') >= manager_mutations.length
    raise "requirements.toml must remain unchanged across manager mutations"
  end
  unless top_level.count('assert_sentinel_absent') >= 5
    raise "synthetic hook sentinel must be checked after every acceptance phase"
  end

  lifecycle = [
    'chmod +x "$package/bin/superpowers-manager.js"',
    'commit_a=$(git -C "$upstream" rev-parse HEAD)',
    'short_a=$(printf \'%s\' "$commit_a" | cut -c 1-7)',
    'version_a="1.0.0+manager.$short_a"',
    'hook_state_before=$(snapshot_hook_state)',
    'run_manager track-latest',
    'hook_state_after=$(snapshot_hook_state)',
    'assert_hook_state_unchanged "$hook_state_before" "$hook_state_after"',
    'assert_requirements_unchanged',
    'hook_state_before=$(snapshot_hook_state)',
    'run_manager install',
    'hook_state_after=$(snapshot_hook_state)',
    'assert_hook_state_unchanged "$hook_state_before" "$hook_state_after"',
    'assert_requirements_unchanged',
    'assert_sentinel_absent',
    'initial_listing=$(run_codex plugin list --json)',
    'assert_marketplace_root "$package"',
    'assert_active_installed_commit "$initial_listing" "$version_a" "$commit_a" ""',
    'assert_exact_empty_hooks_fixture "$initial_listing" "$version_a"',
    'run_codex app-server generate-json-schema --out "$schema_root"',
    'assert_hooks_schema_compatible',
    'capture_hooks_response',
    'assert_manager_hooks_absent "$hooks_response"',
    'assert_sentinel_absent',
    'commit_b=$(git -C "$upstream" rev-parse HEAD)',
    'short_b=$(printf \'%s\' "$commit_b" | cut -c 1-7)',
    'version_b="1.1.0+manager.$short_b"',
    'reload_listing=$(run_codex plugin list --json)',
    'printf \'%s\\n\' "$reload_listing" | grep -Fq \'superpowers@superpowers-manager\'',
    'assert_marketplace_root "$package"',
    'assert_active_installed_commit "$reload_listing" "$version_a" "$commit_a" "$commit_b"',
    'hook_state_before=$(snapshot_hook_state)',
    'run_manager update',
    'hook_state_after=$(snapshot_hook_state)',
    'assert_hook_state_unchanged "$hook_state_before" "$hook_state_after"',
    'assert_requirements_unchanged',
    'assert_sentinel_absent',
    'updated_listing=$(run_codex plugin list --json)',
    'assert_active_installed_commit "$updated_listing" "$version_b" "$commit_b" "$commit_a"',
    'assert_active_hooks_fixture "$updated_listing" "$version_b"',
    'capture_hooks_response',
    'assert_manager_hook_active "$hooks_response"',
    'assert_sentinel_absent',
    'hook_state_before=$(snapshot_hook_state)',
    'run_manager uninstall',
    'hook_state_after=$(snapshot_hook_state)',
    'assert_hook_state_unchanged "$hook_state_before" "$hook_state_after"',
    'assert_requirements_unchanged',
    'assert_sentinel_absent',
    'final_plugins=$(run_codex plugin list --json)',
    'final_marketplaces=$(run_codex plugin marketplace list --json)',
  ]
  require_ordered_lifecycle(probe, lifecycle)
end

probe = File.read(ARGV.fetch(0))
hooks_rpc = File.read(ARGV.fetch(1))
validate_probe!(probe)
validate_hooks_rpc!(hooks_rpc)

mutations = {
  'no-op run_manager' => probe.sub(
    /^run_manager\(\) \{\n.*?^\}\n/m,
    "run_manager() {\n  :\n}\n"
  ),
  'unbracketed install lifecycle' => probe.sub(
    "hook_state_before=$(snapshot_hook_state)\nrun_manager install\nhook_state_after=$(snapshot_hook_state)",
    "run_manager install"
  ),
  'unbound fingerprint root' => probe.sub(
    'expected_root="$HOME/.codex/plugins/cache/superpowers-manager/superpowers/$expected_version"',
    'expected_root="/tmp/unbound-manager-cache"'
  ),
  'unbound Codex listing version' => probe.sub(
    'if matches[0].get("version") != expected_version:',
    'if expected_version != expected_version:'
  ),
  'required pluginId accepted' => probe.sub(
    'if "pluginId" in required:',
    'if False:'
  ),
  'additional pluginId types accepted' => probe.sub(
    'if plugin_id_types != {"string", "null"}:',
    'if not {"string", "null"}.issubset(plugin_id_types):'
  ),
  'non-boolean enabled accepted' => probe.sub(
    'if actual.get("enabled") is not True:',
    'if actual.get("enabled") != True:'
  ),
  'non-boolean isManaged accepted' => probe.sub(
    'if actual.get("isManaged") is not False:',
    'if actual.get("isManaged") != False:'
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


rpc_mutations = {
  'missing pre-send process check' => hooks_rpc.sub(
    'if process.poll() is not None or process.stdin is None:',
    'if False:'
  ),
  'missing send failure gate' => hooks_rpc.sub(
    'fail(f"could not send request: {exc}")',
    'pass'
  ),
  'missing malformed JSON gate' => hooks_rpc.sub(
    'fail(f"malformed JSONL response: {exc}")',
    'pass'
  ),
  'missing non-standard constant parser' => hooks_rpc.sub(
    ', parse_constant=reject_constant',
    ''
  ),
  'weakened non-standard constant rejection' => hooks_rpc.sub(
    'raise ValueError(f"non-standard numeric constant: {constant}")',
    'return None'
  ),
  'removed deadline' => hooks_rpc.sub(
    'deadline = time.monotonic() + 25',
    'deadline = float("inf")'
  ),
  'unbounded selector wait' => hooks_rpc.sub(
    'if remaining <= 0 or not selector.select(remaining):',
    'if not selector.select():'
  ),
  'missing EOF failure' => hooks_rpc.sub(
    'fail("EOF before the required response")',
    'return {}'
  ),
  'missing stream availability gate' => hooks_rpc.sub(
    'fail("app-server stdout is unavailable")',
    'pass'
  ),
  'missing JSON object check' => hooks_rpc.sub(
    'if not isinstance(message, dict):',
    'if False:'
  ),
  'missing response id gate' => hooks_rpc.sub(
    'if type(id_value) is not int or id_value != expected_id:',
    'if False:'
  ),
  'weakened exact response id type' => hooks_rpc.sub(
    'if type(id_value) is not int or id_value != expected_id:',
    'if id_value != expected_id:'
  ),
  'missing RPC error gate' => hooks_rpc.sub(
    'if "error" in message:',
    'if False:'
  ),
  'skipped initialize request' => hooks_rpc.sub(
    '"method": "initialize",',
    '"method": "not-initialize",'
  ),
  'missing app-server pipe gate' => hooks_rpc.sub(
    'fail("app-server stdout pipe was not created")',
    'pass'
  ),
  'skipped initialize response' => hooks_rpc.sub(
    'receive(process, selector, 0)',
    'pass'
  ),
  'skipped initialized notification' => hooks_rpc.sub(
    'send(process, {"method": "initialized"})',
    'pass'
  ),
  'skipped hooks request' => hooks_rpc.sub(
    'send(process, {"id": 1, "method": "hooks/list", "params": {"cwds": [cwd]}})',
    'pass'
  ),
  'missing hooks response presence gate' => hooks_rpc.sub(
    'response = receive(process, selector, 1)',
    'response = {"id": 1, "result": {"data": []}}'
  ),
  'missing result gate' => hooks_rpc.sub(
    'if "result" not in message:',
    'if False:'
  ),
}
rpc_mutations.each do |name, mutation|
  raise "semantic RPC mutation fixture made no change: #{name}" if mutation == hooks_rpc
  begin
    validate_hooks_rpc!(mutation)
  rescue RuntimeError
    next
  end
  raise "semantic RPC source contract accepted invalid mutation: #{name}"
end
RUBY

echo "test_container_contract: OK"
