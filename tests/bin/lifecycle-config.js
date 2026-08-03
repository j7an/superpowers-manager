// @ts-check
// Declarative fake-behaviour schemas, shared by lifecycle-fixture.js (which
// validates eagerly at case creation) and by both fake executables (which
// re-validate as defence in depth). Flat string enums only — no nesting, no
// functions — so PR 11.5 has a small stable surface to keep working.

/** @typedef {"boolean" | "integer" | string[]} Rule */

/** @type {Record<string, Rule>} */
export const UNINSTALL_SCHEMA = {
  updateControl: ["managed", "unsupported"],
  pluginRemove: ["ok", "noop", "missing-installed"],
  marketplaceRemove: ["ok", "fail"],
  pluginListRc: "integer",
  marketplaceListRc: "integer",
  spuriousMutation: "boolean",
};

export const UNINSTALL_DEFAULTS = {
  updateControl: "managed",
  pluginRemove: "ok",
  marketplaceRemove: "ok",
  pluginListRc: 0,
  marketplaceListRc: 0,
  spuriousMutation: false,
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
