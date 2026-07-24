#!/usr/bin/env node
// @ts-check

import { existsSync } from "node:fs";

const cliUrl = new URL("../dist/cli.js", import.meta.url);

if (!existsSync(cliUrl)) {
  console.error(
    "dist/ not built — run `pnpm install --frozen-lockfile && pnpm run build`",
  );
  process.exit(1);
}

const { main } = await import(cliUrl.href);
main();
