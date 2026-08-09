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
  // `orphan` registers the plugin as installed without materialising its
  // cached tree, which is the only lever that makes the REAL adapter's
  // fingerprint inspection fail (src/adapter.ts:815-828). It exists so the
  // failed-inspection case can assert the subject's own diagnostic instead of
  // intercepting the adapter — see install-commands.test.js's
  // "a failed fingerprint inspection is reported as an inspection failure".
  pluginAdd: ["ok", "fail", "noop", "stale", "orphan"],
  // No `fail`: the failed-inspection case is driven from the fake Codex by
  // `pluginAdd: "orphan"` instead, so the enum carries only the protocol-level
  // fault the real adapter cannot produce.
  fingerprintInspect: ["ok", "malformed"],
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
 * Probe's fake needs only the two listing return codes: probe performs no
 * mutation, and its malformed-evidence cases are driven by writing malformed
 * JSON into plugin_list.json rather than by a config toggle.
 * @type {Record<string, Rule>}
 */
export const PROBE_SCHEMA = {
  pluginListRc: "integer",
  marketplaceListRc: "integer",
};

export const PROBE_DEFAULTS = {
  pluginListRc: 0,
  marketplaceListRc: 0,
};

/**
 * @param {"install" | "uninstall" | "probe"} kind
 * @returns {{ schema: Record<string, Rule>, defaults: Record<string, unknown> }}
 */
export function schemaFor(kind) {
  if (kind === "install") {
    return { schema: INSTALL_SCHEMA, defaults: INSTALL_DEFAULTS };
  }
  if (kind === "uninstall") {
    return { schema: UNINSTALL_SCHEMA, defaults: UNINSTALL_DEFAULTS };
  }
  if (kind === "probe") {
    return { schema: PROBE_SCHEMA, defaults: PROBE_DEFAULTS };
  }
  throw new Error(`unknown fixture kind: ${String(kind)}`);
}

/**
 * Throws on an unknown key or an invalid value. This is the property the 16
 * marker files it replaces could not have: today a typo'd
 * `: > "$state/plugin_add_stail"` yields a passing test.
 * @param {"install" | "uninstall" | "probe"} kind
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
