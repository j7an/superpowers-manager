#!/bin/sh
set -eu

test_dir=$(CDPATH= cd -- "$(dirname "$0")" && pwd)
. "$test_dir/lib/harness.sh"
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

def unique_step_index(steps, key, value)
  matches = steps.each_index.select do |index|
    step = steps.fetch(index)
    step.is_a?(Hash) && step[key] == value
  end
  unless matches.length == 1
    raise "expected exactly one step with #{key}=#{value.inspect}, found #{matches.length}"
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

  harden_uses = "step-security/harden-runner@9af89fc71515a100421586dfdb3dc9c984fbf411"
  checkout_uses = "actions/checkout@9c091bb21b7c1c1d1991bb908d89e4e9dddfe3e0"
  harden_index = unique_step_index(steps, "uses", harden_uses)
  checkout_index = unique_step_index(steps, "uses", checkout_uses)

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

def check_release(workflow)
  workflow = expect_hash(workflow, "workflow")
  on_keys = ["on", true].select { |key| workflow.key?(key) }
  raise "expected exactly one active on mapping" unless on_keys.length == 1

  on_config = expect_hash(fetch(workflow, on_keys.fetch(0), "on"), "on")
  push = expect_hash(fetch(on_config, "push", "on.push"), "on.push")
  expect_equal(fetch(push, "tags", "on.push.tags"), ["v*.*.*"], "on.push.tags")

  jobs = expect_hash(fetch(workflow, "jobs", "jobs"), "jobs")
  publish = expect_hash(fetch(jobs, "publish", "jobs.publish"), "jobs.publish")
  expect_equal(
    fetch(publish, "uses", "jobs.publish.uses"),
    "j7an/shared-workflows/.github/workflows/publish-npm.yml@dc9105acf09a4ad43bad2e4a86f4c65f553fe3c0",
    "jobs.publish.uses",
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

domain = ARGV.fetch(0)
path = ARGV.fetch(1)
workflow = YAML.load_file(path)
case domain
when "ci"
  check_ci(workflow)
when "release"
  check_release(workflow)
else
  raise "unknown workflow assertion domain: #{domain}"
end
RUBY
)

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
grep -Fq 'uses: j7an/shared-workflows/.github/workflows/tag-release.yml@dc9105acf09a4ad43bad2e4a86f4c65f553fe3c0 # v4.2.2' "$wf"
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
spw_section test_ci_workflow test_ci_workflow
spw_section test_release_workflow test_release_workflow
spw_section test_tag_release_workflow test_tag_release_workflow
[ "$failed" -eq 0 ] || exit "$failed"
