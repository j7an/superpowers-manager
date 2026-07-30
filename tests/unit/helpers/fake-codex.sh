#!/bin/sh
# Fake Codex CLI for adapter unit tests.
#
# Records every invocation in $FAKE_CODEX_LOG, then answers the two listing
# commands from $FAKE_CODEX_PLUGIN_LIST / $FAKE_CODEX_MARKETPLACE_LIST. The
# token @@BAD@@ inside either payload is emitted as the raw byte 0xff, which no
# UTF-8 decoder accepts: that is how a test feeds invalid UTF-8 through the
# real adapter listing call sites. Everything around the token stays valid
# JSON, so a lossy decode would still parse -- the point is that only a strict
# byte-level reader rejects the payload.
#
# $FAKE_CODEX_LOCK_DIR, when set, is made read-only on every invocation so the
# adapter's own workspace cleanup fails afterwards. Re-applying the mode is
# idempotent, so repeated calls are harmless. Note this is a no-op as root,
# where the case it supports fails loudly rather than passing silently.
set -eu

printf '%s\n' "$*" >> "$FAKE_CODEX_LOG"

if [ -n "${FAKE_CODEX_LOCK_DIR:-}" ]; then
  chmod 500 "$FAKE_CODEX_LOCK_DIR"
fi

emit() {
  before=${1%%@@BAD@@*}
  if [ "$before" = "$1" ]; then
    printf '%s\n' "$1"
    return 0
  fi
  # Only the first @@BAD@@ is spliced; a payload carrying two would emit the
  # second one literally. No caller does, and one bad byte is what the strict
  # reader is being tested against.
  after=${1#*@@BAD@@}
  printf '%s\377%s\n' "$before" "$after"
}

case "$*" in
  "plugin list --json")
    emit "${FAKE_CODEX_PLUGIN_LIST:?}"
    ;;
  "plugin marketplace list --json")
    emit "${FAKE_CODEX_MARKETPLACE_LIST:?}"
    ;;
  "plugin add "* | "plugin remove "* | "plugin marketplace add "* | \
    "plugin marketplace remove "*)
    ;;
  *)
    echo "unexpected fake Codex command: $*" >&2
    exit 99
    ;;
esac
exit 0
