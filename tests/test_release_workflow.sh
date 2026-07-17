#!/bin/sh
set -eu

root=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)
wf=${1:-"$root/.github/workflows/release.yml"}

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

def step_run(job, name)
  steps = fetch(job, "steps", "job.steps")
  step = steps.find { |candidate| candidate["name"] == name }
  raise "missing step #{name.inspect}" unless step

  fetch(step, "run", "step #{name}.run")
end

def action_steps(job, prefix)
  fetch(job, "steps", "job.steps").select do |step|
    step.fetch("uses", "").start_with?(prefix)
  end
end

workflow = expect_hash(workflow, "workflow")
expect_equal(fetch(workflow, "name", "name"), "Release 0.1.3 Recovery", "name")

# Psych implements YAML 1.1, where an unquoted GitHub `on` key becomes true.
on_keys = ["on", true].select { |key| workflow.key?(key) }
raise "expected exactly one active on mapping" unless on_keys.length == 1

on_config = expect_hash(fetch(workflow, on_keys.fetch(0), "on"), "on")
expect_equal(on_config.keys, ["push"], "on keys")
push = expect_hash(fetch(on_config, "push", "on.push"), "on.push")
expect_equal(push.keys, ["tags"], "on.push keys")
expect_equal(fetch(push, "tags", "on.push.tags"), ["v0.1.3"], "on.push.tags")

expect_equal(fetch(workflow, "permissions", "permissions"), {}, "permissions")
concurrency = expect_hash(fetch(workflow, "concurrency", "concurrency"), "concurrency")
expect_equal(
  fetch(concurrency, "group", "concurrency.group"),
  "manager-bootstrap-${{ github.ref }}",
  "concurrency.group",
)
expect_equal(fetch(concurrency, "cancel-in-progress", "concurrency.cancel-in-progress"), false, "concurrency.cancel-in-progress")

jobs = expect_hash(fetch(workflow, "jobs", "jobs"), "jobs")
expect_equal(jobs.keys.sort, ["build", "github-release", "publish"], "jobs")
build = expect_hash(fetch(jobs, "build", "jobs.build"), "jobs.build")
publish = expect_hash(fetch(jobs, "publish", "jobs.publish"), "jobs.publish")
github_release = expect_hash(fetch(jobs, "github-release", "jobs.github-release"), "jobs.github-release")

expect_equal(fetch(build, "permissions", "jobs.build.permissions"), { "contents" => "read" }, "jobs.build.permissions")
expect_equal(
  fetch(publish, "permissions", "jobs.publish.permissions"),
  { "contents" => "read", "id-token" => "write" },
  "jobs.publish.permissions",
)
expect_equal(
  fetch(github_release, "permissions", "jobs.github-release.permissions"),
  { "contents" => "write" },
  "jobs.github-release.permissions",
)
expect_equal(fetch(publish, "environment", "jobs.publish.environment"), "npm-bootstrap", "jobs.publish.environment")
raise "build must not use an environment" if build.key?("environment")
raise "github-release must not use an environment" if github_release.key?("environment")

expected_actions = {
  "step-security/harden-runner" => "step-security/harden-runner@9af89fc71515a100421586dfdb3dc9c984fbf411",
  "actions/checkout" => "actions/checkout@9c091bb21b7c1c1d1991bb908d89e4e9dddfe3e0",
  "actions/setup-node" => "actions/setup-node@48b55a011bda9f5d6aeb4c2d9c7362e8dae4041e",
  "actions/upload-artifact" => "actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a",
  "actions/download-artifact" => "actions/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c",
}
expected_action_comments = {
  expected_actions.fetch("step-security/harden-runner") => "v2.19.4",
  expected_actions.fetch("actions/checkout") => "v7.0.0",
  expected_actions.fetch("actions/setup-node") => "v6.4.0",
  expected_actions.fetch("actions/upload-artifact") => "v7.0.1",
  expected_actions.fetch("actions/download-artifact") => "v8.0.1",
}
jobs.each_value do |job|
  next unless job["steps"]

  job["steps"].each do |step|
    uses = step["uses"]
    next unless uses

    prefix = expected_actions.keys.find { |candidate| uses.start_with?("#{candidate}@") }
    next unless prefix

    expect_equal(uses, expected_actions.fetch(prefix), "action pin for #{prefix}")
  end
end

raise "build must harden the runner" unless action_steps(build, "step-security/harden-runner@").length == 1
raise "build must checkout once" unless action_steps(build, "actions/checkout@").length == 1
raise "build must upload npm-dist once" unless action_steps(build, "actions/upload-artifact@").length == 1
raise "publish must checkout once" unless action_steps(publish, "actions/checkout@").length == 1
raise "publish must download npm-dist once" unless action_steps(publish, "actions/download-artifact@").length == 1
raise "github-release must download npm-dist once" unless action_steps(github_release, "actions/download-artifact@").length == 1

setup_steps = jobs.values.flat_map { |job| action_steps(job, "actions/setup-node@") }
raise "expected setup-node in build and publish only" unless setup_steps.length == 2
setup_steps.each do |step|
  expect_equal(fetch(step, "with", "setup-node.with").fetch("node-version"), 24, "setup-node node-version")
end

source_check = step_run(build, "Verify frozen release source")
[
  'test "$GITHUB_REF" = "refs/tags/v0.1.3"',
  'origin/release/0.1.3-manager',
  'test "$branch_sha" = "$GITHUB_SHA"',
  'git merge-base --is-ancestor v0.1.2 "$GITHUB_SHA"',
  'test "$(git rev-parse "$GITHUB_SHA^")" = "$(git rev-parse v0.1.2)"',
].each do |needle|
  raise "source check missing #{needle.inspect}" unless source_check.include?(needle)
end
source_lines = source_check.lines.map(&:strip)
[
  "assert.equal(pkg.name, 'superpowers-manager');",
  "assert.equal(pkg.version, '0.1.3');",
].each do |line|
  raise "source check missing exact assertion line #{line.inspect}" unless source_lines.include?(line)
end
expected_repository_assertion = <<~'NODE'.strip
  assert.equal(
    pkg.repository.url,
    'git+https://github.com/j7an/superpowers-manager.git',
  );
NODE
unless source_check.include?(expected_repository_assertion)
  raise "source check missing exact repository assertion"
end

expect_equal(step_run(build, "Run isolated acceptance suite").strip, "sh tests/container.sh", "container test command")

all_runs = jobs.values.flat_map { |job| job.fetch("steps", []).map { |step| step["run"] }.compact }.join("\n")
expected_npm_setup = <<~'SH'.strip
  npm install --global "npm@11.16.0"
  test "$(npm --version)" = "11.16.0"
SH
expect_equal(
  step_run(build, "Ensure npm provenance support").strip,
  expected_npm_setup,
  "build exact npm setup",
)
expect_equal(
  step_run(publish, "Ensure npm provenance support").strip,
  expected_npm_setup,
  "publish exact npm setup",
)

global_npm_installs = all_runs.lines.map do |line|
  stripped = line.strip
  stripped if stripped.match?(/\bnpm\s+install\s+--global\b/)
end.compact
unless global_npm_installs == Array.new(2, 'npm install --global "npm@11.16.0"')
  warn "npm install --global must occur exactly once in each named npm setup step; ranges, alternate quoting, alternate versions, and extra installers are forbidden"
end
expect_equal(
  global_npm_installs,
  Array.new(2, 'npm install --global "npm@11.16.0"'),
  "all global npm installer commands",
)
raise "workflow must run npm pack --json exactly once" unless all_runs.scan(/npm pack --json/).length == 1
pack = step_run(build, "Pack and assert artifact")
[
  "npm pack --json",
  "sh tests/assert_pack_contents.sh",
  'test "$filename" = "superpowers-manager-0.1.3.tgz"',
  'filename=',
  'integrity=',
  'GITHUB_OUTPUT',
].each do |needle|
  raise "pack step missing #{needle.inspect}" unless pack.include?(needle)
end
expect_equal(
  fetch(build, "outputs", "jobs.build.outputs"),
  {
    "filename" => "${{ steps.pack.outputs.filename }}",
    "integrity" => "${{ steps.pack.outputs.integrity }}",
  },
  "jobs.build.outputs",
)

upload = action_steps(build, "actions/upload-artifact@").fetch(0)
expect_equal(fetch(upload, "with", "upload.with").fetch("name"), "npm-dist", "upload artifact name")
expect_equal(fetch(upload, "with", "upload.with").fetch("path"), "${{ steps.pack.outputs.filename }}", "upload artifact path")

publish_run = step_run(publish, "Publish exact tarball idempotently")
[
  'if npm view "${PACKAGE}@${VERSION}" dist.integrity > "$lookup_file" 2>&1; then',
  'test -n "$existing_integrity"',
  'test "$existing_integrity" = "$EXPECTED_INTEGRITY"',
  'immutable registry version has different integrity',
  'lookup_status=$?',
  '*E404*) ;;',
  '*"${PACKAGE}@${VERSION}"*) ;;',
  'npm lookup failed with status',
  'npm publish "$TARBALL" --access public --provenance',
].each do |needle|
  raise "publish step missing #{needle.inspect}" unless publish_run.include?(needle)
end
raise "publish lookup must not suppress npm failures" if publish_run.include?("|| true")
e404_check = publish_run.index('*E404*) ;;')
exact_spec_check = publish_run.index('*"${PACKAGE}@${VERSION}"*) ;;')
publish_command = publish_run.index('npm publish "$TARBALL" --access public --provenance')
unless e404_check && exact_spec_check && publish_command &&
    e404_check < publish_command && exact_spec_check < publish_command
  raise "npm publish must occur only after exact E404 and package/version checks"
end
publish_step = fetch(publish, "steps", "jobs.publish.steps").find { |step| step["name"] == "Publish exact tarball idempotently" }
publish_env = fetch(publish_step, "env", "publish step env")
expect_equal(fetch(publish_env, "PACKAGE", "publish PACKAGE"), "superpowers-manager", "publish PACKAGE")
expect_equal(fetch(publish_env, "VERSION", "publish VERSION"), "0.1.3", "publish VERSION")
expect_equal(
  fetch(publish_env, "TARBALL", "publish TARBALL"),
  "dist/${{ needs.build.outputs.filename }}",
  "publish TARBALL",
)
expect_equal(
  fetch(publish_env, "NODE_AUTH_TOKEN", "publish NODE_AUTH_TOKEN"),
  "${{ secrets.NPM_BOOTSTRAP_TOKEN }}",
  "publish token",
)
jobs.each_value do |job|
  job.fetch("steps", []).each do |step|
    next if step.equal?(publish_step)

    raise "NODE_AUTH_TOKEN must exist only on publish step" if step.fetch("env", {}).key?("NODE_AUTH_TOKEN")
  end
end

poll = step_run(publish, "Wait for registry integrity")
raise "registry polling must be bounded" unless poll.include?('while [ "$attempt" -le 30 ]') && poll.include?("sleep 10")
raise "registry polling must verify integrity" unless poll.include?('test "$observed_integrity" = "$EXPECTED_INTEGRITY"')
raise "registry polling must not suppress npm failures" if poll.include?("|| true")
raise "registry polling must fail on non-E404 lookup errors" unless poll.include?("registry lookup failed with status")
poll_step = fetch(publish, "steps", "jobs.publish.steps").find { |step| step["name"] == "Wait for registry integrity" }
poll_env = fetch(poll_step, "env", "poll step env")
expect_equal(fetch(poll_env, "VERSION", "poll VERSION"), "0.1.3", "poll VERSION")

npx = step_run(publish, "Verify clean npx execution")
raise "npx check must use a new temporary cache" unless npx.include?('NPM_CONFIG_CACHE=$(mktemp -d)')
raise "missing exact npx check" unless npx.include?('test "$(npx --yes superpowers-manager@0.1.3 --version)" = "0.1.3"')

provenance = step_run(publish, "Verify npm provenance")
[
  "node tests/verify_npm_provenance.mjs",
  "superpowers-manager",
  "0.1.3",
  "https://github.com/j7an/superpowers-manager",
  "refs/tags/v0.1.3",
  ".github/workflows/release.yml",
  "${{ github.sha }}",
  "${{ needs.build.outputs.integrity }}",
].each do |needle|
  raise "provenance step missing #{needle.inspect}" unless provenance.include?(needle)
end

release_run = step_run(github_release, "Create or verify GitHub release")
[
  "TAG=v0.1.3",
  "${{ needs.build.outputs.filename }}",
  "gh release create",
  '--title "Superpowers Manager 0.1.3"',
  'test "$(jq -r \'.name\' "$release_json")" = "Superpowers Manager 0.1.3"',
  'release_lookup_status=$?',
  '*"HTTP 404"*) ;;',
  "GitHub release lookup failed with status",
  "existing_digest",
  "expected_digest",
  "existing release is missing the expected asset",
  "existing release asset has different digest",
].each do |needle|
  raise "GitHub release step missing #{needle.inspect}" unless release_run.include?(needle)
end
raise "existing GitHub releases must be verification-only" if release_run.include?("gh release upload")
release_404_check = release_run.index('*"HTTP 404"*) ;;')
release_create = release_run.index("gh release create")
unless release_404_check && release_create && release_404_check < release_create
  raise "GitHub release creation must occur only after confirmed HTTP 404"
end
if release_run.include?("--clobber")
  comparison = release_run.index('test "$existing_digest" = "$expected_digest"')
  clobber = release_run.index("--clobber")
  raise "asset digest must be compared before clobber" unless comparison && comparison < clobber
end

serialized = File.read(path)
expected_action_comments.each do |action, version|
  raise "missing readable version comment for #{action}" unless serialized.include?("#{action} # #{version}")
end
raise "normal reusable publisher is forbidden" if serialized.match?(%r{shared-workflows/.github/workflows/publish-npm})
raise "wildcard release tags are forbidden" if serialized.match?(/tags:\s*\n\s*-\s*["']?v[^\n]*\*/)
raise "old package publish target is forbidden" if serialized.include?("superpowers-wrapper")
raise "dist-tag mutations are forbidden" if serialized.match?(/npm\s+dist-tag|--tag\s+(?:latest|next|beta|rc)|prerelease/i)
RUBY

if [ "${SPM_SKIP_WORKFLOW_MUTANTS:-0}" != "1" ]; then
  mutant_dir=$(mktemp -d)
  trap 'rm -rf "$mutant_dir"' EXIT HUP INT TERM

  assert_mutant_rejected() {
    label=$1
    old=$2
    new=$3
    mutant="$mutant_dir/$label.yml"
    ruby - "$wf" "$mutant" "$old" "$new" <<'RUBY'
source, destination, old, replacement = ARGV
text = File.read(source)
raise "mutation target absent: #{old.inspect}" unless text.include?(old)
File.write(destination, text.sub(old, replacement))
RUBY
    if SPM_SKIP_WORKFLOW_MUTANTS=1 sh "$0" "$mutant" \
      >"$mutant_dir/$label.out" 2>&1; then
      echo "workflow contract accepted mutant: $label" >&2
      cat "$mutant_dir/$label.out" >&2
      exit 1
    fi
  }

  assert_mutant_rejected \
    npm-non-404 \
    '*E404*) ;;' \
    '*E404*|*E500*) ;;'
  assert_mutant_rejected \
    github-non-404 \
    '*"HTTP 404"*) ;;' \
    '*"HTTP 404"*|*"HTTP 500"*) ;;'
  assert_mutant_rejected \
    wrong-release-title \
    'test "$(jq -r '\''.name'\'' "$release_json")" = "Superpowers Manager 0.1.3"' \
    'test "$(jq -r '\''.name'\'' "$release_json")" = "Wrong title"'
fi

echo "test_release_workflow: OK"
