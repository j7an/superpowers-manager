#!/bin/sh
set -eu

root=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)
wf="$root/.github/workflows/ci.yml"

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

workflow = expect_hash(workflow, "workflow")
expect_equal(fetch(workflow, "name", "name"), "CI", "name")

# Psych implements YAML 1.1, where an unquoted GitHub `on` key becomes true.
on_keys = ["on", true].select { |key| workflow.key?(key) }
raise "expected exactly one active on mapping" unless on_keys.length == 1

on_config = expect_hash(fetch(workflow, on_keys.fetch(0), "on"), "on")
raise "missing on.pull_request" unless on_config.key?("pull_request")

jobs = expect_hash(fetch(workflow, "jobs", "jobs"), "jobs")
test_job = expect_hash(fetch(jobs, "test", "jobs.test"), "jobs.test")
steps = fetch(test_job, "steps", "jobs.test.steps")
raise "expected sequence at jobs.test.steps, got #{steps.class}" unless steps.is_a?(Array)

hermetic_index = steps.index { |step| step["name"] == "Run hermetic test suite" }
raise "missing step \"Run hermetic test suite\"" unless hermetic_index
expect_equal(
  fetch(steps.fetch(hermetic_index), "run", "Run hermetic test suite.run"),
  "sh tests/run.sh",
  "Run hermetic test suite.run",
)

acceptance_index = steps.index { |step| step["name"] == "Run isolated acceptance suite" }
raise "missing step \"Run isolated acceptance suite\"" unless acceptance_index
expect_equal(
  fetch(steps.fetch(acceptance_index), "run", "Run isolated acceptance suite.run"),
  "sh tests/container.sh",
  "Run isolated acceptance suite.run",
)
raise "isolated acceptance suite must run after hermetic test suite" unless acceptance_index > hermetic_index
RUBY

echo "test_ci_workflow: OK"
