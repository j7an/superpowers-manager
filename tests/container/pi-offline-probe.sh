#!/bin/sh
set -eu

if [ "${SPW_CONTAINER:-}" != 1 ] || [ "$(id -u)" != 10001 ]; then
  echo "error: Pi acceptance requires the isolated UID 10001 container" >&2
  exit 1
fi
if [ "${1:-}" != --isolated ]; then
  exec env -i PATH="$PATH" HOME=/home/spw SPW_CONTAINER=1 \
    PI_OFFLINE=1 PI_SKIP_VERSION_CHECK=1 sh "$0" --isolated
fi

root=$(mktemp -d /tmp/spw-pi-XXXXXX)
trap 'rm -rf "$root"' EXIT HUP INT TERM
HOME="$root/home"
SPW_PI_PROBE_ROOT="$HOME"
PI_CODING_AGENT_DIR="$HOME/.pi/agent"
SUPERPOWERS_CONFIG_DIR="$root/config"
SUPERPOWERS_CACHE_DIR="$root/cache"
SUPERPOWERS_UPSTREAM_URL="$root/upstream"
SUPERPOWERS_PI=pi
GIT_CONFIG_GLOBAL=/dev/null
GIT_CONFIG_NOSYSTEM=1
export HOME SPW_PI_PROBE_ROOT PI_CODING_AGENT_DIR SUPERPOWERS_CONFIG_DIR \
  SUPERPOWERS_CACHE_DIR SUPERPOWERS_UPSTREAM_URL SUPERPOWERS_PI \
  GIT_CONFIG_GLOBAL GIT_CONFIG_NOSYSTEM
mkdir -p "$HOME" "$PI_CODING_AGENT_DIR" "$root/cwd"
cd "$root/cwd"
prepared="$PI_CODING_AGENT_DIR/superpowers-manager/prepared"
installed="$PI_CODING_AGENT_DIR/superpowers-manager/installed"
pi_package=/opt/spw-test-tools/node_modules/@earendil-works/pi-coding-agent
observer=/workspace/tests/container/pi-resource-probe.ts

run_manager() {
  timeout 60 node /workspace/src/cli.ts "$@"
}
observe() {
  timeout 60 node "$observer" "$2" "$pi_package" "$3" "$4" "$1"
}
fixture_git() {
  git -C "$SUPERPOWERS_UPSTREAM_URL" -c user.name=fixture \
    -c user.email=fixture@example.invalid -c core.hooksPath=/dev/null \
    -c init.templateDir= "$@"
}

# Materialize only the inert, licensed source fixture into this invocation's tmpfs.
python3 -S - "$SUPERPOWERS_UPSTREAM_URL" "$HOME" <<'PY'
import json
from pathlib import Path
import shutil
import sys

upstream, home = map(Path, sys.argv[1:])
fixtures = Path('/workspace/tests/fixtures/pi-native')
for source, destination in [
    ('bootstrap.ts.txt', '.pi/extensions/superpowers.ts'),
    ('package.json.txt', 'package.json'),
    ('SKILL.md.txt', 'skills/using-superpowers/SKILL.md'),
    ('LICENSE.txt', 'LICENSE'),
]:
    target = upstream / destination
    target.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(fixtures / source, target)
skill = upstream / 'skills/snapshot-probe/SKILL.md'
skill.parent.mkdir(parents=True)
skill.write_text('---\nname: snapshot-probe\ndescription: Observe snapshot lifecycle\n---\nSnapshot phase A.\n')
survivor = home / 'unrelated-provider'
survivor.mkdir()
(survivor / 'package.json').write_text(json.dumps({'name': 'unrelated-provider', 'version': '1.0.0', 'pi': {'skills': []}}))
(survivor / 'preserved.txt').write_text('unrelated package bytes\n')
settings = {'packages': [str(survivor)], 'theme': 'dark', 'spwProbeSetting': {'retained': True}}
(home / '.pi/agent/settings.json').write_text(json.dumps(settings))
PY

fixture_git init -q
fixture_git add .
fixture_git commit -qm 'native fixture A'
commit_a=$(fixture_git rev-parse HEAD)
run_manager pin "$commit_a"
run_manager prepare --harness pi
observe prepared "$prepared" "$commit_a" A
cp "$PI_CODING_AGENT_DIR/settings.json" "$root/settings.before.json"
if run_manager install --harness pi >"$root/refused.stdout" 2>"$root/refused.stderr"; then
  echo "error: custom native fixture installed without experimental opt-in" >&2
  exit 1
fi
cmp "$PI_CODING_AGENT_DIR/settings.json" "$root/settings.before.json"
observe absent "$installed" none none
run_manager install --harness pi --allow-experimental
digest_a=$(observe installed "$installed" "$commit_a" A)
observe events "$installed" "$commit_a" A

# Docker still has --network none. Pi's offline flag skips local updates too.
timeout 60 env PI_OFFLINE=0 pi update --extensions --no-approve
test "$(observe installed "$installed" "$commit_a" A)" = "$digest_a"

python3 -S - "$SUPERPOWERS_UPSTREAM_URL/skills/snapshot-probe/SKILL.md" <<'PY'
from pathlib import Path
import sys
path = Path(sys.argv[1])
path.write_text(path.read_text().replace('Snapshot phase A.', 'Snapshot phase B.'))
PY
fixture_git add .
fixture_git commit -qm 'native fixture B'
commit_b=$(fixture_git rev-parse HEAD)
test "$commit_a" != "$commit_b"
run_manager pin "$commit_b"
run_manager prepare --harness pi
observe prepared "$prepared" "$commit_b" B
test "$(observe installed "$installed" "$commit_a" A)" = "$digest_a"
observe events "$installed" "$commit_a" A
run_manager update --harness pi --allow-experimental
digest_b=$(observe installed "$installed" "$commit_b" B)
test "$digest_a" != "$digest_b"
observe events "$installed" "$commit_b" B
actual_uninstall_stdout="$root/actual-uninstall.stdout"
actual_uninstall_stderr="$root/actual-uninstall.stderr"
run_manager uninstall --harness pi >"$actual_uninstall_stdout" 2>"$actual_uninstall_stderr"
cat "$actual_uninstall_stdout"
cat "$actual_uninstall_stderr" >&2
grep -Fxq \
  "Removed the managed Superpowers Pi installation. Restart Pi to load the resulting state." \
  "$actual_uninstall_stdout"
test ! -s "$actual_uninstall_stderr"
observe absent "$installed" none none
noop_uninstall_stdout="$root/noop-uninstall.stdout"
noop_uninstall_stderr="$root/noop-uninstall.stderr"
run_manager uninstall --harness pi >"$noop_uninstall_stdout" 2>"$noop_uninstall_stderr"
cat "$noop_uninstall_stdout"
cat "$noop_uninstall_stderr" >&2
grep -Fxq "No managed Superpowers Pi installation is present." \
  "$noop_uninstall_stdout"
if grep -Fqi "restart" "$noop_uninstall_stdout"; then
  echo "error: idempotent Pi uninstall must not request a restart" >&2
  exit 1
fi
test ! -s "$noop_uninstall_stderr"
observe absent "$installed" none none
echo "pi harness integration: complete status=0"
