#!/bin/sh
set -eu

test_dir=$(CDPATH= cd -- "$(dirname "$0")" && pwd)
. "$test_dir/lib/harness.sh"
. "$test_dir/lib/action-pin-assertions.sh"
spw_test_root

workflow_checks_rb=$(cat <<'RUBY'
require "yaml"

def expect_hash(value, path)
  raise "expected mapping at #{path}, got #{value.class}" unless value.is_a?(Hash)
  value
end

def fetch(mapping, key, path)
  raise "missing #{path}" unless mapping.key?(key)
  mapping.fetch(key)
end

def expect_equal(actual, expected, path)
  return if actual == expected
  raise "unexpected #{path}: #{actual.inspect} (expected #{expected.inspect})"
end

def uses_target(value, path)
  raise "expected string at #{path}, got #{value.class}" unless value.is_a?(String)
  value.split("@", 2).fetch(0)
end

def unique_step_target_index(steps, target)
  matches = steps.each_index.select do |index|
    step = steps.fetch(index)
    step.is_a?(Hash) &&
      step["uses"].is_a?(String) &&
      uses_target(step.fetch("uses"), "steps[#{index}].uses") == target
  end
  unless matches.length == 1
    raise "expected exactly one step using #{target.inspect}, found #{matches.length}"
  end
  matches.fetch(0)
end

def check_ci(workflow)
  workflow = expect_hash(workflow, "workflow")
  expect_equal(fetch(workflow, "permissions", "permissions"), {}, "permissions")

  jobs = expect_hash(fetch(workflow, "jobs", "jobs"), "jobs")
  expect_equal(jobs.keys, ["test"], "jobs keys")

  test_job = expect_hash(fetch(jobs, "test", "jobs.test"), "jobs.test")
  raise "jobs.test must not use continue-on-error" if test_job.key?("continue-on-error")
  expect_equal(fetch(test_job, "runs-on", "jobs.test.runs-on"), "ubuntu-latest", "jobs.test.runs-on")
  expect_equal(
    fetch(
      expect_hash(fetch(test_job, "permissions", "jobs.test.permissions"), "jobs.test.permissions"),
      "contents",
      "jobs.test.permissions.contents",
    ),
    "read",
    "jobs.test.permissions.contents",
  )

  steps = fetch(test_job, "steps", "jobs.test.steps")
  raise "expected jobs.test.steps to be an array" unless steps.is_a?(Array)

  harden_index = unique_step_target_index(steps, "step-security/harden-runner")
  checkout_index = unique_step_target_index(steps, "actions/checkout")

  container_invocations = []
  steps.each_with_index do |step, index|
    next unless step.is_a?(Hash) && step["run"].is_a?(String)
    step.fetch("run").each_line do |line|
      words = line.strip.split
      next unless words.fetch(0, nil) == "sh" && words.fetch(1, nil) == "tests/container.sh"
      container_invocations << { index: index, command: words.join(" ") }
    end
  end

  if container_invocations.any? { |entry| entry.fetch(:command) == "sh tests/container.sh codex-spike" }
    raise "retired codex-spike container invocation is forbidden"
  end
  unless container_invocations.length == 1
    raise "expected exactly one tests/container.sh invocation, found #{container_invocations.length}"
  end

  acceptance_invocation = container_invocations.fetch(0)
  expect_equal(acceptance_invocation.fetch(:command), "sh tests/container.sh", "container acceptance command")
  acceptance_index = acceptance_invocation.fetch(:index)
  unless harden_index < checkout_index && checkout_index < acceptance_index
    raise "expected harden runner, checkout, and container acceptance steps in that order"
  end

  harden = expect_hash(steps.fetch(harden_index), "harden runner step")
  expect_equal(
    fetch(
      expect_hash(fetch(harden, "with", "harden runner step.with"), "harden runner step.with"),
      "egress-policy",
      "harden runner step.with.egress-policy",
    ),
    "audit",
    "harden runner step.with.egress-policy",
  )

  checkout = expect_hash(steps.fetch(checkout_index), "checkout step")
  expect_equal(
    fetch(
      expect_hash(fetch(checkout, "with", "checkout step.with"), "checkout step.with"),
      "persist-credentials",
      "checkout step.with.persist-credentials",
    ),
    false,
    "checkout step.with.persist-credentials",
  )

  acceptance = expect_hash(steps.fetch(acceptance_index), "container acceptance step")
  raise "container acceptance step must not use continue-on-error" if acceptance.key?("continue-on-error")
end

def assert_no_forbidden(value, path = "workflow")
  forbidden = /--provenance|npm_config_provenance|npm(?:[_ -]?token)|node_auth_token|npm-bootstrap|superpowers-wrapper|npm publish|--tag next/i
  case value
  when Hash
    value.each do |key, child|
      assert_no_forbidden(key.to_s, "#{path}.<key>")
      assert_no_forbidden(child, "#{path}.#{key}")
    end
  when Array
    value.each_with_index { |child, index| assert_no_forbidden(child, "#{path}[#{index}]") }
  when String
    raise "forbidden publish configuration at #{path}: #{value.inspect}" if value.match?(forbidden)
  end
end

def collect_external_targets(value, path, targets)
  case value
  when Hash
    value.each do |key, child|
      if key == "uses"
        unless child.is_a?(String)
          raise "expected string at #{path}.uses, got #{child.class}"
        end
        targets << uses_target(child, "#{path}.uses") unless child.start_with?("./")
      end
      collect_external_targets(child, "#{path}.#{key}", targets)
    end
  when Array
    value.each_with_index do |child, index|
      collect_external_targets(child, "#{path}[#{index}]", targets)
    end
  end
  targets
end

def load_expected_external_pins(path)
  pairs = File.readlines(path, chomp: true).map.with_index(1) do |line, line_number|
    fields = line.split("\t", -1)
    unless fields.length == 2 && fields.none?(&:empty?)
      raise "malformed external-pin manifest line #{line_number}: #{line.inspect}"
    end
    fields
  end
  raise "duplicate external-pin manifest entry" unless pairs.uniq.length == pairs.length
  pairs
end

def check_inventory(root, manifest_path, workflow_paths)
  prefix = "#{root}/"
  actual = workflow_paths.flat_map do |path|
    raise "workflow path outside root: #{path}" unless path.start_with?(prefix)
    relative_path = path[prefix.length..]
    workflow = YAML.load_file(path)
    collect_external_targets(workflow, relative_path, []).map do |target|
      [relative_path, target]
    end
  end
  expected = load_expected_external_pins(manifest_path)
  expect_equal(actual.sort, expected.sort, "external uses inventory")
end

def check_release(workflow)
  workflow = expect_hash(workflow, "workflow")
  on_keys = ["on", true].select { |key| workflow.key?(key) }
  raise "expected exactly one active on mapping" unless on_keys.length == 1

  on_config = expect_hash(fetch(workflow, on_keys.fetch(0), "on"), "on")
  push = expect_hash(fetch(on_config, "push", "on.push"), "on.push")
  expect_equal(fetch(push, "tags", "on.push.tags"), ["v*.*.*"], "on.push.tags")

  jobs = expect_hash(fetch(workflow, "jobs", "jobs"), "jobs")
  publish = expect_hash(fetch(jobs, "publish", "jobs.publish"), "jobs.publish")
  publish_uses = fetch(publish, "uses", "jobs.publish.uses")
  expect_equal(
    uses_target(publish_uses, "jobs.publish.uses"),
    "j7an/shared-workflows/.github/workflows/publish-npm.yml",
    "jobs.publish.uses target",
  )

  permissions = expect_hash(fetch(publish, "permissions", "jobs.publish.permissions"), "jobs.publish.permissions")
  expect_equal(fetch(permissions, "contents", "jobs.publish.permissions.contents"), "write", "jobs.publish.permissions.contents")
  expect_equal(fetch(permissions, "id-token", "jobs.publish.permissions.id-token"), "write", "jobs.publish.permissions.id-token")

  with = expect_hash(fetch(publish, "with", "jobs.publish.with"), "jobs.publish.with")
  expected_verify_command = <<~'SH'
    attempt=1
    for delay in 0 30 60 90 120 150; do
      if [ "$delay" -gt 0 ]; then
        echo "npx verification attempt ${attempt}/6: sleeping ${delay}s"
        sleep "$delay"
      else
        echo "npx verification attempt ${attempt}/6: checking before sleep"
      fi
      cache="${RUNNER_TEMP:-/tmp}/superpowers-manager-npx-${GITHUB_RUN_ID:-local}-${GITHUB_RUN_ATTEMPT:-1}-${attempt}"
      if actual=$(npm_config_cache="$cache" npx --yes "${PACKAGE}@${VERSION}" --version); then
        if [ "$actual" = "$VERSION" ]; then
          echo "npx resolved ${PACKAGE}@${VERSION}"
          exit 0
        fi
        echo "::error::npx resolved ${PACKAGE}@${VERSION} with unexpected version ${actual}" >&2
        exit 1
      fi
      attempt=$((attempt + 1))
    done
    echo "::error::npx verification failed after 6 attempts" >&2
    exit 1
  SH
  expected_with = {
    "tag" => "${{ github.ref_name }}",
    "package-name" => "superpowers-manager",
    "test-command" => "sh tests/container.sh",
    "pack-contents-script" => "tests/assert_pack_contents.sh",
    "verify-command" => expected_verify_command,
  }
  expected_with.each do |key, expected|
    expect_equal(fetch(with, key, "jobs.publish.with.#{key}"), expected, "jobs.publish.with.#{key}")
  end
  assert_no_forbidden(workflow)
end

domain = ARGV.shift
case domain
when "inventory"
  root = ARGV.shift
  manifest_path = ARGV.shift
  raise "missing inventory root" if root.nil?
  raise "missing inventory manifest" if manifest_path.nil?
  check_inventory(root, manifest_path, ARGV)
when "ci", "release"
  path = ARGV.shift
  raise "missing workflow path for #{domain}" if path.nil?
  raise "unexpected arguments for #{domain}: #{ARGV.inspect}" unless ARGV.empty?
  workflow = YAML.load_file(path)
  domain == "ci" ? check_ci(workflow) : check_release(workflow)
else
  raise "unknown workflow assertion domain: #{domain}"
end
RUBY
)

assert_rejected_action_pin() {
  _block=$1
  _target=$2
  if action_pin_pair "$_block" "$_target" >/dev/null 2>&1; then
    printf 'expected action pin rejection for %s:\n%s\n' "$_target" "$_block" >&2
    return 1
  fi
}

test_action_pin_helper() {
  sha_one=$(printf '%040d' 1)
  sha_two=$(printf '%040d' 2)
  short_sha=$(printf '%039d' 1)
  long_sha=$(printf '%041d' 1)
  uppercase_sha=$(printf '%040d' 0 | tr 0 A)
  target=github/codeql-action/analyze

  block=$(printf '        uses: %s@%s # v4.99.0' "$target" "$sha_one")
  expected_pair=$(printf '%s\t%s' "$sha_one" "v4.99.0")
  actual_pair=$(action_pin_pair "$block" "$target")
  if [ "$actual_pair" != "$expected_pair" ]; then
    printf 'action pin pair mismatch for %s: got %s, expected %s\n' \
      "$target" "$actual_pair" "$expected_pair" >&2
    return 1
  fi
  assert_action_pin "$block" "$target"

  block=$(printf "        uses: '%s@%s' # v4.99.0" "$target" "$sha_one")
  assert_action_pin "$block" "$target"
  block=$(printf '        uses: "%s@%s" # v4.99.0' "$target" "$sha_one")
  assert_action_pin "$block" "$target"

  assert_rejected_action_pin \
    "        uses: $target@v4.99.0 # v4.99.0" "$target"
  assert_rejected_action_pin \
    "        uses: $target@$uppercase_sha # v4.99.0" "$target"
  assert_rejected_action_pin \
    "        uses: $target@$short_sha # v4.99.0" "$target"
  assert_rejected_action_pin \
    "        uses: $target@$long_sha # v4.99.0" "$target"
  assert_rejected_action_pin \
    "        uses: $target@$sha_one" "$target"
  assert_rejected_action_pin \
    "        uses: $target@$sha_one # v4" "$target"

  near_target=google/osv-scanner-action/Xgithub/workflows/osv-scanner-reusableXyml
  exact_target=google/osv-scanner-action/.github/workflows/osv-scanner-reusable.yml
  assert_rejected_action_pin \
    "        uses: $near_target@$sha_one # v2.99.0" "$exact_target"

  block=$(printf '%s\n%s\n' \
    "        uses: actions/checkout@$sha_one # v7.0.0" \
    "        uses: actions/checkout@$sha_two # v7.1.0")
  assert_rejected_action_pin "$block" "actions/checkout"

  block=$(printf '%s\n%s\n' \
    "        uses: actions/checkout@$sha_one # v7.0.0" \
    "        uses: actions/checkout@v7 # v7.0.0")
  assert_rejected_action_pin "$block" "actions/checkout"

  block=$(printf '%s\n%s\n' \
    "        uses: actions/checkout@$sha_one # v7.0.0" \
    "        uses: 'actions/checkout@v7' # v7.0.0")
  assert_rejected_action_pin "$block" "actions/checkout"

  block=$(printf '%s\n%s\n' \
    "        uses: actions/checkout@$sha_one # v7.0.0" \
    '        uses: "actions/checkout@v7" # v7.0.0')
  assert_rejected_action_pin "$block" "actions/checkout"

  echo "test_action_pin_helper: OK"
}

write_expected_external_pins() {
  cat >"$1" <<'PINS'
.github/workflows/ci.yml	step-security/harden-runner
.github/workflows/ci.yml	actions/checkout
.github/workflows/dependency-safety.yml	j7an/shared-workflows/.github/workflows/dependency-safety.yml
.github/workflows/dependency-safety-non-bot-gate.yml	j7an/shared-workflows/.github/workflows/dependency-safety-non-bot-gate.yml
.github/workflows/release.yml	j7an/shared-workflows/.github/workflows/publish-npm.yml
.github/workflows/security.yml	j7an/shared-workflows/.github/workflows/security-scan.yml
.github/workflows/tag-release.yml	j7an/shared-workflows/.github/workflows/tag-release.yml
PINS
}

test_workflow_pin_contracts() {
  spw_test_tmpdir
  checker="$tmpdir/workflow_checks.rb"
  manifest="$tmpdir/external-pins.tsv"
  printf '%s\n' "$workflow_checks_rb" >"$checker"
  write_expected_external_pins "$manifest"

  set --
  for workflow_path in \
    "$root"/.github/workflows/*.yml \
    "$root"/.github/workflows/*.yaml
  do
    [ -f "$workflow_path" ] || continue
    set -- "$@" "$workflow_path"
  done
  ruby "$checker" inventory "$root" "$manifest" "$@"

  pin_count=0
  shared_count=0
  shared_pair=
  while IFS="$(printf '\t')" read -r relative_path target
  do
    block=$(cat "$root/$relative_path")
    pair=$(action_pin_pair "$block" "$target")
    pin_count=$((pin_count + 1))
    case "$target" in
      j7an/shared-workflows/*)
        shared_count=$((shared_count + 1))
        if [ -z "$shared_pair" ]; then
          shared_pair=$pair
        elif [ "$pair" != "$shared_pair" ]; then
          printf 'shared-workflows pin disagreement: %s has %s, expected %s\n' \
            "$relative_path" "$pair" "$shared_pair" >&2
          return 1
        fi
        ;;
    esac
  done <"$manifest"

  if [ "$pin_count" -ne 7 ]; then
    printf 'workflow pin inventory count mismatch: got %d, expected 7\n' \
      "$pin_count" >&2
    return 1
  fi
  if [ "$shared_count" -ne 5 ]; then
    printf 'shared-workflows pin count mismatch: got %d, expected 5\n' \
      "$shared_count" >&2
    return 1
  fi
  echo "test_workflow_pin_contracts: OK"
}

test_literal_action_pin_detector() {
  spw_test_tmpdir
  source_file="$tmpdir/literal-pins.sh"
  negative_file="$tmpdir/non-literal-pins.sh"
  sha=$(printf '%040d' 1)
  short_sha=$(printf '%039d' 1)
  long_sha=$(printf '%041d' 1)

  plain=$(printf 'assert_contains "$block" "actions/checkout@%s"' "$sha")
  full=$(printf 'uses: actions/checkout@%s # v7.0.0' "$sha")
  single=$(printf "uses: 'actions/checkout@%s' # v7.0.0" "$sha")
  double=$(printf 'uses: "actions/checkout@%s" # v7.0.0' "$sha")
  escaped=$(printf 'block="uses: \\"actions/checkout@%s\\" # v7.0.0"' "$sha")
  parenthesis=$(printf 'pin=(actions/checkout@%s)' "$sha")
  backtick=$(printf 'pin=`actions/checkout@%s`' "$sha")
  semicolon=$(printf 'pin=actions/checkout@%s;' "$sha")
  printf '%s\n' \
    "$plain" "$full" "$single" "$double" "$escaped" \
    "$parenthesis" "$backtick" "$semicolon" \
    >"$source_file"

  expected=$(printf '%s:%d:%s\n%s:%d:%s\n%s:%d:%s\n%s:%d:%s\n%s:%d:%s\n%s:%d:%s\n%s:%d:%s\n%s:%d:%s' \
    "$source_file" 1 "$plain" \
    "$source_file" 2 "$full" \
    "$source_file" 3 "$single" \
    "$source_file" 4 "$double" \
    "$source_file" 5 "$escaped" \
    "$source_file" 6 "$parenthesis" \
    "$source_file" 7 "$backtick" \
    "$source_file" 8 "$semicolon")
  actual=$(find_literal_action_pin_snapshots "$source_file")
  if [ "$actual" != "$expected" ]; then
    printf 'literal action pin detector output mismatch:\nexpected:\n%s\nactual:\n%s\n' \
      "$expected" "$actual" >&2
    return 1
  fi

  printf '%s\n' \
    "HEAD_SHA=$sha" \
    "uses: actions/checkout@$short_sha # v7.0.0" \
    "uses: actions/checkout@$long_sha # v7.0.0" \
    "uses: actions/checkout@v7 # v7.0.0" \
    >"$negative_file"
  actual=$(find_literal_action_pin_snapshots "$negative_file")
  if [ -n "$actual" ]; then
    printf 'literal action pin detector accepted negative fixtures:\n%s\n' \
      "$actual" >&2
    return 1
  fi

  echo "test_literal_action_pin_detector: OK"
}

test_workflow_pin_source_policy() {
  violations=$(find_literal_action_pin_snapshots \
    "$root"/tests/*.sh \
    "$root"/tests/*.py \
    "$root"/tests/lib/*.sh \
    "$root"/tests/lib/*.py)
  if [ -n "$violations" ]; then
    printf 'literal workflow pin snapshots found:\n%s\n' "$violations" >&2
    return 1
  fi
  echo "test_workflow_pin_source_policy: OK"
}

test_ci_workflow() {
  spw_test_tmpdir
  wf="$root/.github/workflows/ci.yml"
  compatibility_wf="$root/.github/workflows/codex-compatibility.yml"

  [ -f "$wf" ] || { echo "missing $wf" >&2; exit 1; }
  [ ! -e "$compatibility_wf" ] || {
    echo "blocking mode must not create $compatibility_wf" >&2
    exit 1
  }

  printf '%s\n' "$workflow_checks_rb" > "$tmpdir/workflow_checks.rb"
  ruby "$tmpdir/workflow_checks.rb" ci "$root/.github/workflows/ci.yml"

  echo "test_ci_workflow: OK"
}

test_release_workflow() {
  spw_test_tmpdir
  wf="$root/.github/workflows/release.yml"

  [ -f "$wf" ] || { echo "missing $wf" >&2; exit 1; }

  printf '%s\n' "$workflow_checks_rb" > "$tmpdir/workflow_checks.rb"
  ruby "$tmpdir/workflow_checks.rb" release "$root/.github/workflows/release.yml"

  echo "test_release_workflow: OK"
}

test_tag_release_workflow() {
wf="$root/.github/workflows/tag-release.yml"
bump="$root/.version-bump.json"
package="$root/package.json"

[ -f "$wf" ] || { echo "missing $wf" >&2; exit 1; }
[ -f "$bump" ] || { echo "missing $bump" >&2; exit 1; }
[ -f "$package" ] || { echo "missing $package" >&2; exit 1; }

grep -q 'workflow_dispatch:' "$wf"
grep -Fq 'bump: ${{ inputs.bump }}' "$wf"
grep -q 'tag-prefix: "v"' "$wf"
grep -q 'RELEASE_BOT_PRIVATE_KEY: ${{ secrets.RELEASE_BOT_PRIVATE_KEY }}' "$wf"

python3 - "$wf" "$bump" "$package" <<'PY'
import json
import re
import sys

workflow_path, path, package_path = sys.argv[1:]
with open(workflow_path, encoding="utf-8") as fh:
    workflow = fh.read()
with open(path, encoding="utf-8") as fh:
    actual = json.load(fh)

expected = {"files": [{"path": "package.json", "field": "version"}]}
if actual != expected:
    raise SystemExit(f"unexpected {path}: {actual!r}")


def extract_bump_options(document):
    expected_path = ["on", "workflow_dispatch", "inputs", "bump", "options"]
    key_path = []
    key_indents = []
    options = None
    options_indent = None

    for line in document.splitlines():
        if not line.strip() or line.lstrip().startswith("#"):
            continue
        indent = len(line) - len(line.lstrip(" "))
        content = line[indent:]
        key_match = re.fullmatch(r"([A-Za-z0-9_-]+):(?:\s*#.*)?", content)
        if key_match is not None:
            while key_indents and indent <= key_indents[-1]:
                key_indents.pop()
                key_path.pop()
            key_path.append(key_match[1])
            key_indents.append(indent)
            if key_path == expected_path:
                if options is not None:
                    raise ValueError("Tag Release bump options are duplicated")
                options = []
                options_indent = indent
            continue

        option_match = re.fullmatch(r"-\s+(.+)", content)
        if (
            option_match is not None
            and key_path == expected_path
            and indent == options_indent + 2
        ):
            options.append(option_match[1])

    if options is None:
        raise ValueError("Tag Release bump options are missing")
    return options


def assert_supported_bump_options(document):
    options = extract_bump_options(document)
    expected_options = ["auto", "patch", "minor", "major"]
    if options != expected_options:
        raise ValueError(
            "Tag Release bump options must be exactly "
            f"{expected_options!r}, got {options!r}"
        )


try:
    assert_supported_bump_options(workflow)
except ValueError as exc:
    raise SystemExit(str(exc)) from exc

unsupported_option_fixture = """\
on:
  workflow_dispatch:
    inputs:
      unrelated:
        type: choice
        options:
          - auto
          - patch
          - minor
          - major
      bump:
        type: choice
        options:
          - auto
          - patch
          - minor
          - major
          - prerelease
"""
try:
    assert_supported_bump_options(unsupported_option_fixture)
except ValueError:
    pass
else:
    raise SystemExit(
        "internal bump-option regression: unsupported prerelease option accepted"
    )

with open(package_path, encoding="utf-8") as fh:
    package = json.load(fh)

stable_semver = re.compile(
    r"^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$"
)


def parse_stable_semver(value, label):
    if not isinstance(value, str):
        raise ValueError(f"{label} is not a stable semver string: {value!r}")
    match = stable_semver.fullmatch(value)
    if match is None:
        raise ValueError(f"{label} is not stable semver: {value!r}")
    return tuple(int(part) for part in match.groups())

try:
    parse_stable_semver("1.2.3-beta.1", "test version")
except ValueError:
    pass
else:
    raise SystemExit("internal version-contract regression: prerelease accepted")

if package.get("name") != "superpowers-manager":
    raise SystemExit(
        f"unexpected package name in {package_path}: {package.get('name')!r}"
    )

try:
    parse_stable_semver(package.get("version"), "package.json version")
except ValueError as exc:
    raise SystemExit(str(exc)) from exc
PY

echo "test_tag_release_workflow: OK"
}

failed=0
spw_section test_action_pin_helper test_action_pin_helper
spw_section test_literal_action_pin_detector test_literal_action_pin_detector
spw_section test_workflow_pin_source_policy test_workflow_pin_source_policy
spw_section test_workflow_pin_contracts test_workflow_pin_contracts
spw_section test_ci_workflow test_ci_workflow
spw_section test_release_workflow test_release_workflow
spw_section test_tag_release_workflow test_tag_release_workflow
[ "$failed" -eq 0 ] || exit "$failed"
