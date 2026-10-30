import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { COMPANION_INSTALL_NAME, LEGACY_COMPANION_NAME } from "../../../shared/companion.js";
import { COMPANION_SHA256 } from "./companion-hash.js";

// Mirrors scripts/install-omp-companion.mjs; keep the two in sync.
export { COMPANION_INSTALL_NAME, LEGACY_COMPANION_NAME };
const COMPANION_MARKER = "// paseo4herdr OMP input companion.";
// Pre-rename (paseo-herdr) companion (LEGACY_COMPANION_NAME); the installer migrates it away.
const LEGACY_MARKER = "// paseo-herdr OMP input companion.";

function expandTilde(value: string, home: string): string {
  if (value === "~") return home;
  if (value.startsWith("~/")) return path.join(home, value.slice(2));
  if (value.startsWith("~")) return path.join(home, value.slice(1));
  return value;
}

/** Herdr rule: PI_CODING_AGENT_DIR wins (leading ~ expanded), else <home>/<PI_CONFIG_DIR or .omp>/agent. */
export function ompExtensionDir(env: NodeJS.ProcessEnv, home: string): string {
  if (env.PI_CODING_AGENT_DIR) return path.join(expandTilde(env.PI_CODING_AGENT_DIR, home), "extensions");
  return path.join(home, env.PI_CONFIG_DIR || ".omp", "agent", "extensions");
}

async function readIfExists(file: string): Promise<string | null> {
  return fs.readFile(file, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT" || error.code === "ENOTDIR") return null;
    throw error;
  });
}

export async function companionInstallStatus(
  env: NodeJS.ProcessEnv = process.env,
  home: string = os.homedir(),
): Promise<{ state: "current" | "outdated" | "missing" | "foreign"; path: string }> {
  const dir = ompExtensionDir(env, home);
  const target = path.join(dir, COMPANION_INSTALL_NAME);
  const installed = await readIfExists(target);
  const legacyPath = path.join(dir, LEGACY_COMPANION_NAME);
  // Any legacy read error (EISDIR, EACCES, ...) counts as no legacy file.
  const legacy = await readIfExists(legacyPath).catch(() => null);
  const legacyOurs = legacy !== null && legacy.startsWith(LEGACY_MARKER);
  if (installed === null) {
    // Only the pre-rename companion is installed: report it outdated so the diagnostic points at the installer, which migrates it.
    if (legacyOurs) return { state: "outdated", path: legacyPath };
    return { state: "missing", path: target };
  }
  if (createHash("sha256").update(installed).digest("hex") === COMPANION_SHA256) {
    // OMP loads every file in the extensions directory: a leftover legacy companion means two are active, so not current.
    if (legacyOurs) return { state: "outdated", path: legacyPath };
    return { state: "current", path: target };
  }
  return { state: installed.startsWith(COMPANION_MARKER) ? "outdated" : "foreign", path: target };
}
