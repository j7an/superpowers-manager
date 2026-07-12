#!/bin/sh
set -eu

root=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)
wf="$root/.github/workflows/ci.yml"
compatibility_wf="$root/.github/workflows/codex-compatibility.yml"

[ -f "$wf" ] || { echo "missing $wf" >&2; exit 1; }
[ ! -e "$compatibility_wf" ] || { echo "blocking mode must not create $compatibility_wf" >&2; exit 1; }

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

def unique_step_index(steps, key, value)
  matches = steps.each_index.select do |index|
    step = steps.fetch(index)
    step.is_a?(Hash) && step[key] == value
  end
  raise "expected exactly one step with #{key}=#{value.inspect}, found #{matches.length}" unless matches.length == 1

  matches.fetch(0)
end

workflow = expect_hash(workflow, "workflow")
expect_equal(fetch(workflow, "permissions", "permissions"), {}, "permissions")

jobs = expect_hash(fetch(workflow, "jobs", "jobs"), "jobs")
expect_equal(jobs.keys, ["test"], "jobs keys")

test_job = expect_hash(fetch(jobs, "test", "jobs.test"), "jobs.test")
raise "jobs.test must not use continue-on-error" if test_job.key?("continue-on-error")
expect_equal(fetch(test_job, "runs-on", "jobs.test.runs-on"), "ubuntu-latest", "jobs.test.runs-on")
expect_equal(
  fetch(expect_hash(fetch(test_job, "permissions", "jobs.test.permissions"), "jobs.test.permissions"), "contents", "jobs.test.permissions.contents"),
  "read",
  "jobs.test.permissions.contents",
)

steps = fetch(test_job, "steps", "jobs.test.steps")
raise "expected jobs.test.steps to be an array" unless steps.is_a?(Array)

harden_uses = "step-security/harden-runner@9af89fc71515a100421586dfdb3dc9c984fbf411"
checkout_uses = "actions/checkout@9c091bb21b7c1c1d1991bb908d89e4e9dddfe3e0"
harden_index = unique_step_index(steps, "uses", harden_uses)
checkout_index = unique_step_index(steps, "uses", checkout_uses)
acceptance_index = unique_step_index(steps, "run", "sh tests/container.sh")

unless harden_index < checkout_index && checkout_index < acceptance_index
  raise "expected harden runner, checkout, and container acceptance steps in that order"
end

harden = expect_hash(steps.fetch(harden_index), "harden runner step")
expect_equal(
  fetch(expect_hash(fetch(harden, "with", "harden runner step.with"), "harden runner step.with"), "egress-policy", "harden runner step.with.egress-policy"),
  "audit",
  "harden runner step.with.egress-policy",
)

checkout = expect_hash(steps.fetch(checkout_index), "checkout step")
expect_equal(
  fetch(expect_hash(fetch(checkout, "with", "checkout step.with"), "checkout step.with"), "persist-credentials", "checkout step.with.persist-credentials"),
  false,
  "checkout step.with.persist-credentials",
)

acceptance = expect_hash(steps.fetch(acceptance_index), "container acceptance step")
raise "container acceptance step must not use continue-on-error" if acceptance.key?("continue-on-error")
RUBY

echo "test_ci_workflow: OK"
