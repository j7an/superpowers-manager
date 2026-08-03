// @ts-check
// Declarative fake-behaviour schemas, shared by lifecycle-fixture.js (which
// validates eagerly at case creation) and by both fake executables (which
// re-validate as defence in depth). Flat string enums only — no nesting, no
// functions — so PR 11.5 has a small stable surface to keep working.

/** @typedef {"boolean" | "integer" | string[]} Rule */

/** @type {Record<string, Rule>} */
export const UNINSTALL_SCHEMA = {
  updateControl: ["managed", "unsupported"],
  pluginRemove: ["ok", "missing-installed"],
  marketplaceRemove: ["ok", "fail"],
  pluginListRc: "integer",
  marketplaceListRc: "integer",
  spuriousMutation: "boolean",
  // `removesMutateState: false` ports the shell driver's `remove_noop` marker,
  // which is deliberately GLOBAL: tests/test_uninstall_commands.sh:71 gates the
  // marketplace mutation on the same marker as the plugin mutation, and :399
  // comments it "removes are logged but do not mutate the fixtures" — plural.
  // It is a separate key precisely so the global scope is visible at the call
  // site; folding it back into `pluginRemove` would read plugin-specific while
  // behaving globally.
  removesMutateState: "boolean",
};

export const UNINSTALL_DEFAULTS = {
  updateControl: "managed",
  pluginRemove: "ok",
  marketplaceRemove: "ok",
  pluginListRc: 0,
  marketplaceListRc: 0,
  spuriousMutation: false,
  removesMutateState: true,
};

/** @type {Record<string, Rule>} */
export const INSTALL_SCHEMA = {
  updateControl: [
    "managed",
    "unsupported",
    "malformed",
    "failure",
    "managed-then-unsupported",
  ],
  marketplaceAdd: ["ok", "fail"],
  pluginAdd: ["ok", "fail", "noop", "stale"],
  fingerprintInspect: ["ok", "fail", "malformed"],
  pluginListRc: "integer",
  marketplaceListRc: "integer",
  spuriousMutation: "boolean",
};

export const INSTALL_DEFAULTS = {
  updateControl: "managed",
  marketplaceAdd: "ok",
  pluginAdd: "ok",
  fingerprintInspect: "ok",
  pluginListRc: 0,
  marketplaceListRc: 0,
  spuriousMutation: false,
};

/**
 * @param {"install" | "uninstall"} kind
 * @returns {{ schema: Record<string, Rule>, defaults: Record<string, unknown> }}
 */
export function schemaFor(kind) {
  if (kind === "install") {
    return { schema: INSTALL_SCHEMA, defaults: INSTALL_DEFAULTS };
  }
  if (kind === "uninstall") {
    return { schema: UNINSTALL_SCHEMA, defaults: UNINSTALL_DEFAULTS };
  }
  throw new Error(`unknown fixture kind: ${String(kind)}`);
}

/**
 * Throws on an unknown key or an invalid value. This is the property the 16
 * marker files it replaces could not have: today a typo'd
 * `: > "$state/plugin_add_stail"` yields a passing test.
 * @param {"install" | "uninstall"} kind
 * @param {Record<string, unknown>} config
 * @returns {void}
 */
export function validateConfig(kind, config) {
  const { schema } = schemaFor(kind);
  for (const [key, value] of Object.entries(config)) {
    const rule = schema[key];
    if (rule === undefined) {
      throw new Error(`unknown fixture config key: ${key}`);
    }
    const ok =
      rule === "boolean"
        ? typeof value === "boolean"
        : rule === "integer"
          ? Number.isInteger(value)
          : rule.includes(/** @type {string} */ (value));
    if (!ok) {
      throw new Error(`invalid value for ${key}: ${String(value)}`);
    }
  }
}
