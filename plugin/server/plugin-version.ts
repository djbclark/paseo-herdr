// Mirrors "version" in package.json. Paseo bundles server code as CommonJS, so the server can't read
// package.json at runtime (see scripts/sync-companion-hash.mjs); test/diagnostics.test.ts fails on drift.
export const PLUGIN_VERSION = "0.1.0-alpha.1";
