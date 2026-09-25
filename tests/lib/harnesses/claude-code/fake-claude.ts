import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  failureResult,
  successResult,
} from "../../../../src/adapter-result.ts";
import type { RunClaude } from "../../../../src/harnesses/claude-code/native.ts";

interface FakePlugin {
  id: string;
  version: string;
  scope: string;
  enabled: boolean;
  installPath: string;
  errors?: string[];
}

interface FakeMarketplace {
  name: string;
  source: string;
  path?: string;
}

export interface FakeClaude {
  readonly run: RunClaude;
  readonly calls: string[];
  plugins: FakePlugin[];
  marketplaces: FakeMarketplace[];
  // Fails every command whose joined argv starts with this prefix.
  failOn: string | null;
}

const ID = "superpowers@superpowers-manager";

function manifestVersion(pluginRoot: string): string {
  return (
    JSON.parse(
      readFileSync(join(pluginRoot, ".claude-plugin", "plugin.json"), "utf8"),
    ) as { version: string }
  ).version;
}

export function mutationCalls(fake: FakeClaude): string[] {
  return fake.calls.filter((call) => !call.endsWith("list --json"));
}

export function fakeClaude(): FakeClaude {
  const failed = () =>
    failureResult(
      "claude-code-command",
      "nonzero-exit",
      "Claude Code command exited with status 1",
      [],
      [],
    );
  const ok = (stdout: string) =>
    successResult("claude-code-command", { stdout }, []);
  const fake: FakeClaude = {
    calls: [],
    plugins: [],
    marketplaces: [],
    failOn: null,
    run: async (args) => {
      const command = args.join(" ");
      fake.calls.push(command);
      if (fake.failOn !== null && command.startsWith(fake.failOn))
        return failed();
      if (command === "plugin list --json")
        return ok(JSON.stringify(fake.plugins));
      if (command === "plugin marketplace list --json")
        return ok(JSON.stringify(fake.marketplaces));
      if (args.length === 4 && command.startsWith("plugin marketplace add ")) {
        if (!fake.marketplaces.some((m) => m.name === "superpowers-manager"))
          fake.marketplaces.push({
            name: "superpowers-manager",
            source: "directory",
            path: args[3]!,
          });
        return ok("");
      }
      if (command === "plugin marketplace remove superpowers-manager") {
        fake.marketplaces = fake.marketplaces.filter(
          (m) => m.name !== "superpowers-manager",
        );
        fake.plugins = fake.plugins.filter((p) => p.id !== ID);
        return ok("");
      }
      const market = fake.marketplaces.find(
        (m) => m.name === "superpowers-manager",
      );
      const pluginRoot =
        market?.path === undefined
          ? ""
          : join(market.path, "plugins", "superpowers");
      const existing = fake.plugins.find((p) => p.id === ID);
      if (command === `plugin install ${ID} --scope user` && market) {
        if (existing === undefined)
          fake.plugins.push({
            id: ID,
            version: manifestVersion(pluginRoot),
            scope: "user",
            enabled: true,
            installPath: join(
              pluginRoot,
              "..",
              "native-cache",
              manifestVersion(pluginRoot),
            ),
          });
        return ok("");
      }
      if (existing === undefined) return failed();
      if (command === `plugin update ${ID} --scope user`) {
        existing.version = manifestVersion(pluginRoot);
        existing.installPath = join(
          pluginRoot,
          "..",
          "native-cache",
          existing.version,
        );
        return ok("");
      }
      if (command === `plugin enable ${ID} --scope user`) {
        existing.enabled = true;
        return ok("");
      }
      if (command === `plugin disable ${ID} --scope user`) {
        existing.enabled = false;
        return ok("");
      }
      if (command === `plugin uninstall ${ID} --scope user`) {
        fake.plugins = fake.plugins.filter((p) => p !== existing);
        return ok("");
      }
      return failed();
    },
  };
  return fake;
}
