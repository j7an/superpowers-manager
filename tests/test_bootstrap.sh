#!/bin/sh
set -eu

root=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)

assert_file() {
  path="$1"
  if [ ! -f "$root/$path" ]; then
    echo "missing file: $path" >&2
    exit 1
  fi
}

assert_contains() {
  path="$1"
  text="$2"
  if ! grep -Fq "$text" "$root/$path"; then
    echo "missing text in $path: $text" >&2
    exit 1
  fi
}

assert_not_contains() {
  path="$1"
  text="$2"
  if grep -Fq "$text" "$root/$path"; then
    echo "unexpected text in $path: $text" >&2
    exit 1
  fi
}

assert_file ".gitignore"
assert_file "config/upstream-ref"
assert_file ".agents/plugins/marketplace.json"
assert_file "plugins/superpowers/.codex-plugin/plugin.template.json"
assert_file "scripts/adapters/codex/adapter"
assert_file "scripts/adapters/codex/validate-generated-plugin.py"
assert_file "scripts/core/validate-adapter-response.py"

assert_contains "package.json" '"type": "module"'
assert_not_contains "bin/superpowers-wrapper.js" "import.meta.main"
assert_contains "config/upstream-ref" "latest-release"
assert_contains ".agents/plugins/marketplace.json" '"name": "superpowers-wrapper"'
assert_contains ".agents/plugins/marketplace.json" '"products": ["CODEX"]'
assert_contains ".gitignore" "plugins/superpowers/.codex-plugin/plugin.json"
assert_contains ".gitignore" "plugins/.superpowers.prepare.*/"
assert_not_contains ".gitignore" "plugins/.superpowers.tmp.*/"
assert_contains "plugins/superpowers/.codex-plugin/plugin.template.json" '"name": "superpowers"'
assert_contains "plugins/superpowers/.codex-plugin/plugin.template.json" '"skills": "./skills/"'
assert_contains "AGENTS.md" 'Run `sh tests/container.sh` before declaring a change complete.'
assert_contains "AGENTS.md" "no mutation of the developer's or runner's real Codex state"
assert_contains "README.md" "sh tests/container.sh"
assert_contains "README.md" "Layers 1-3 stay offline and hermetic"
assert_contains "README.md" "Layer 4 is the Docker acceptance path"
assert_contains "README.md" "no public harness selector"
assert_contains "RELEASING.md" 'Ensure `main` is green (`sh tests/container.sh`)'
assert_contains "RELEASING.md" "sh tests/container.sh"
assert_contains "tests/manual/codex-behavior-probe.sh" "Optional native-only Codex compatibility probe"
assert_not_contains "README.md" "The automated suite is fully hermetic: it uses a fake local upstream repo and a"
