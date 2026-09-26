#!/bin/sh
set -eu

root=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)
cd "$root"

require_package_node=0
if [ "${1:-}" = "--require-package-node" ]; then
  shift
  SPW_REQUIRE_PACKAGE_NODE=1
  export SPW_REQUIRE_PACKAGE_NODE
  require_package_node=1
fi

failed=0
if [ "$require_package_node" = 1 ] && ! node --input-type=module -e '
import { readFileSync } from "node:fs";
import { resolvePackageNode } from "./tests/lib/package-runtime.ts";
const manifest = JSON.parse(readFileSync("./package.json", "utf8"));
resolvePackageNode(process.env, true, manifest.engines.node);
'; then
  failed=1
fi

# Discovery and execution share one list, so a file on disk cannot be skipped.
# node --test exits 0 when given nothing to run; an empty list is a failure here.
if [ "$failed" = 0 ]; then
  if files=$(find tests/bin tests/unit tests/baseline -name '*.test.ts' -type f) && [ -n "$files" ]; then
    # Unquoted on purpose: one argument per path; test paths contain no whitespace.
    node --import ./tests/assert-matcher-gate.ts --test "$@" $files || failed=1
  else
    echo "error: test discovery failed or found no test files" >&2
    failed=1
  fi
fi

# Emitted on every path, pass or fail. Absence means this script was killed.
echo "tests/run.sh: complete failed=$failed"
exit $failed
