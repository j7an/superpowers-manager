#!/bin/sh
set -eu

test_dir=$(CDPATH= cd -- "$(dirname "$0")" && pwd)
. "$test_dir/lib/harness.sh"
spw_test_root
. "$root/scripts/core/common.sh"

spw_test_tmpdir

# A missing script must produce the caller's frozen label.
mkdir -p "$tmpdir/empty-root/dist"
if spw_node_cli "$tmpdir/empty-root" selection-state-cli.js \
    'selection state helper' 2>"$tmpdir/missing.err"; then
  echo "expected a missing helper to fail" >&2
  exit 1
fi
grep -Fqx 'error: selection state helper missing' "$tmpdir/missing.err"

if spw_node_cli "$tmpdir/empty-root" upstream-cli.js \
    'upstream helper' 2>"$tmpdir/missing-upstream.err"; then
  echo "expected a missing upstream helper to fail" >&2
  exit 1
fi
grep -Fqx 'error: upstream helper missing' "$tmpdir/missing-upstream.err"

# The subshell must scrub NODE_OPTIONS and NODE_PATH.
mkdir -p "$tmpdir/probe-root/dist"
cat > "$tmpdir/probe-root/dist/probe-cli.js" <<'JS'
process.stdout.write(`${process.env.NODE_OPTIONS ?? "unset"}\n`);
process.stdout.write(`${process.env.NODE_PATH ?? "unset"}\n`);
JS
cat > "$tmpdir/preload.cjs" <<'JS'
console.error("INJECTED");
JS
observed=$(
  NODE_OPTIONS="--require $tmpdir/preload.cjs" NODE_PATH="$tmpdir" \
    spw_node_cli "$tmpdir/probe-root" probe-cli.js 'probe helper' \
    2>"$tmpdir/probe.err"
)
test "$observed" = "unset
unset"
if grep -Fq INJECTED "$tmpdir/probe.err"; then
  echo "NODE_OPTIONS preload was not scrubbed" >&2
  exit 1
fi

# A missing helper must be catchable, not fatal: this script is still running.
echo "test_node_cli_helper: OK"
