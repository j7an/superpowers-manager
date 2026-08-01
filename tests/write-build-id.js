// @ts-check
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { computeBuildId } from "./build-id.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
writeFileSync(join(root, "dist", ".build-id"), computeBuildId(root), "utf8");
