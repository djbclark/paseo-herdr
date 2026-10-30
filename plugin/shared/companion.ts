/** Installed file names of the OMP input companion (mirrors scripts/install-omp-companion.mjs). */
export const COMPANION_INSTALL_NAME = "paseo4herdr-input.ts";
/** Pre-rename (paseo-herdr) companion; the installer migrates it away. */
export const LEGACY_COMPANION_NAME = "paseo-herdr-input.ts";

/**
 * How to install or repair the OMP input companion, worded once for every user-facing message.
 * `paseo plugin update` reruns the plugin's install step, which is `scripts/install-omp-companion.mjs`;
 * a Git install has no `npm run` script to point at.
 */
export const COMPANION_INSTALL_STEP =
  "run `paseo plugin update herdr-harness` (its install step reinstalls the companion), or run `node scripts/install-omp-companion.mjs` from the installed plugin directory (from `plugin/` in a clone)";
