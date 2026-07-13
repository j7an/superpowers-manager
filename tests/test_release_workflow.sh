#!/bin/sh
set -eu

root=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)
wf="$root/.github/workflows/release.yml"

[ -f "$wf" ] || { echo "missing $wf" >&2; exit 1; }

ruby - "$wf" <<'RUBY'
require "yaml"

path = ARGV.fetch(0)
workflow = YAML.load_file(path)

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

def assert_no_forbidden(value, path = "workflow")
  forbidden = /--provenance|npm_config_provenance|npm(?:[_ -]?token)|node_auth_token/i

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

workflow = expect_hash(workflow, "workflow")

# Psych implements YAML 1.1, where an unquoted GitHub `on` key becomes true.
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
expected_with = {
  "tag" => "${{ github.ref_name }}",
  "package-name" => "superpowers-wrapper",
  "test-command" => "sh tests/container.sh",
  "pack-contents-script" => "tests/assert_pack_contents.sh",
  "verify-command" => "test \"$(npx --yes \"${PACKAGE}@${VERSION}\" --version)\" = \"$VERSION\"",
}
expected_with.each do |key, expected|
  expect_equal(fetch(with, key, "jobs.publish.with.#{key}"), expected, "jobs.publish.with.#{key}")
end

assert_no_forbidden(workflow)
RUBY

echo "test_release_workflow: OK"
