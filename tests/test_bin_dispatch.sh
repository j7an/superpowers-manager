#!/bin/sh
set -eu

root=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)
tmpdir=$(mktemp -d)
trap 'rm -rf "$tmpdir"' EXIT INT TERM

command -v node >/dev/null 2>&1 || { echo "error: node is required for this test" >&2; exit 1; }
node_bin=$(command -v node)

# --- Fake package root: real bin, fake scripts that log and exit ---
pkg="$tmpdir/pkg"
mkdir -p "$pkg/bin" "$pkg/scripts"
cp "$root/bin/superpowers-wrapper.js" "$pkg/bin/"
printf '{ "name": "superpowers-wrapper", "version": "9.9.9-test", "type": "module" }\n' > "$pkg/package.json"
log="$tmpdir/dispatch.log"
for cmd in prepare probe install update uninstall; do
  cat > "$pkg/scripts/$cmd" <<EOF
#!/bin/sh
printf '%s\n' "$cmd \$* ref=\${SUPERPOWERS_REF:-}" >> "$log"
if [ -n "\${SUPERPOWERS_VALIDATOR:-}" ]; then
  printf '%s\n' "$cmd validator=\${SUPERPOWERS_VALIDATOR}" >> "$log"
fi
exit 0
EOF
  chmod +x "$pkg/scripts/$cmd"
done

# --- Fake tool PATH: everything the preflight looks for, nothing else ---
fakebin="$tmpdir/fakebin"
mkdir -p "$fakebin"
for tool in git python3 codex; do
  printf '#!/bin/sh\nexit 0\n' > "$fakebin/$tool"
  chmod +x "$fakebin/$tool"
done
ln -s /bin/sh "$fakebin/sh"
ln -s "$node_bin" "$fakebin/node"

run_bin() {
  PATH="$fakebin" "$fakebin/node" "$pkg/bin/superpowers-wrapper.js" "$@"
}

# --- Routing: each subcommand reaches its script with its args ---
: > "$log"
run_bin probe --porcelain >/dev/null
grep -Fqx "probe --porcelain ref=" "$log"

: > "$log"
run_bin prepare --ref test >/dev/null
grep -Fqx "prepare --ref test ref=" "$log"

: > "$log"
run_bin install --dry-run >/dev/null
grep -Fqx "install --dry-run ref=" "$log"

: > "$log"
run_bin uninstall --purge >/dev/null
grep -Fqx "uninstall --purge ref=" "$log"

# --- Bare invocation runs update ---
: > "$log"
run_bin >/dev/null
grep -Fqx "update  ref=" "$log"

# --- Unknown subcommand: usage + exit 2, nothing dispatched ---
: > "$log"
if run_bin bogus >"$tmpdir/out" 2>&1; then
  echo "unknown subcommand must fail" >&2; exit 1
fi
rc=0; run_bin bogus >/dev/null 2>"$tmpdir/err" || rc=$?
[ "$rc" -eq 2 ] || { echo "expected exit 2 for unknown subcommand, got $rc" >&2; exit 1; }
grep -Fq "unknown subcommand: bogus" "$tmpdir/err"
grep -Fq "usage:" "$tmpdir/err"
[ ! -s "$log" ] || { echo "unknown subcommand must not dispatch" >&2; exit 1; }

# --- A stray flag must not fall through to update ---
: > "$log"
rc=0; run_bin --porcelain >"$tmpdir/out" 2>"$tmpdir/err" || rc=$?
[ "$rc" -eq 2 ] || { echo "expected exit 2 for stray flag, got $rc" >&2; exit 1; }
grep -Fq "unknown subcommand: --porcelain" "$tmpdir/err"
grep -Fq "usage:" "$tmpdir/err"
[ ! -s "$log" ]

# --- --help and --version ---
rc=0; run_bin --help >"$tmpdir/help" 2>"$tmpdir/help-err" || rc=$?
[ "$rc" -eq 0 ] || { echo "expected exit 0 for --help, got $rc" >&2; exit 1; }
grep -Fq "usage:" "$tmpdir/help"
[ ! -s "$tmpdir/help-err" ]
version_out=$(run_bin --version)
[ "$version_out" = "9.9.9-test" ] || { echo "unexpected --version output: $version_out" >&2; exit 1; }

# npm/npx invoke bins through links; the ESM direct-entry gate must resolve it.
bin_link="$tmpdir/superpowers-wrapper"
ln -s "$pkg/bin/superpowers-wrapper.js" "$bin_link"
version_out=$(PATH="$fakebin" "$fakebin/node" "$bin_link" --version)
[ "$version_out" = "9.9.9-test" ] || { echo "unexpected symlinked --version output: $version_out" >&2; exit 1; }

# --- Exit-code propagation ---
cat > "$pkg/scripts/probe" <<EOF
#!/bin/sh
exit 42
EOF
chmod +x "$pkg/scripts/probe"
rc=0; run_bin probe >/dev/null 2>&1 || rc=$?
[ "$rc" -eq 42 ] || { echo "expected exit 42 propagated, got $rc" >&2; exit 1; }

# --- Env passthrough: SUPERPOWERS_* reaches the script ---
: > "$log"
PATH="$fakebin" \
SUPERPOWERS_REF=abc123 \
SUPERPOWERS_VALIDATOR=/tmp/custom-validator.py \
"$fakebin/node" "$pkg/bin/superpowers-wrapper.js" update >/dev/null
grep -Fqx "update  ref=abc123" "$log"
grep -Fqx "update validator=/tmp/custom-validator.py" "$log"

# --- Preflight: missing git fails before any dispatch, names the tool ---
rm "$fakebin/git"
: > "$log"
rc=0; run_bin install >/dev/null 2>"$tmpdir/err" || rc=$?
[ "$rc" -eq 1 ] || { echo "expected exit 1 on missing git, got $rc" >&2; exit 1; }
grep -Fq "required command not found: git" "$tmpdir/err"
[ ! -s "$log" ] || { echo "preflight failure must not dispatch" >&2; exit 1; }
printf '#!/bin/sh\nexit 0\n' > "$fakebin/git" && chmod +x "$fakebin/git"

# --- codex required for install, not for probe ---
rm "$fakebin/codex"
: > "$log"
cat > "$pkg/scripts/probe" <<EOF
#!/bin/sh
printf 'probe ran\n' >> "$log"
exit 0
EOF
chmod +x "$pkg/scripts/probe"
run_bin probe >/dev/null
grep -Fq "probe ran" "$log"
: > "$log"
rc=0; run_bin install >/dev/null 2>"$tmpdir/err" || rc=$?
[ "$rc" -eq 1 ]
grep -Fq "required command not found: codex" "$tmpdir/err"
[ ! -s "$log" ] || { echo "missing codex must not dispatch" >&2; exit 1; }
printf '#!/bin/sh\nexit 0\n' > "$fakebin/codex" && chmod +x "$fakebin/codex"

# --- Missing script file: diagnostic, non-zero ---
rm "$pkg/scripts/uninstall"
rc=0; run_bin uninstall >/dev/null 2>"$tmpdir/err" || rc=$?
[ "$rc" -eq 1 ]
grep -Fq "missing script" "$tmpdir/err"

echo "test_bin_dispatch: OK"
