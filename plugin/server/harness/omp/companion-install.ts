import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Mirrors scripts/install-omp-companion.mjs; keep the two in sync.
export const COMPANION_INSTALL_NAME = "paseo-herdr-input.ts";
const COMPANION_MARKER = "// paseo-herdr OMP input companion.";
const COMPANION_SOURCE = fileURLToPath(new URL("../../../harness-extension/omp.ts", import.meta.url));

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

export async function companionInstallStatus(
  env: NodeJS.ProcessEnv = process.env,
  home: string = os.homedir(),
): Promise<{ state: "current" | "outdated" | "missing" | "foreign"; path: string }> {
  const target = path.join(ompExtensionDir(env, home), COMPANION_INSTALL_NAME);
  const installed = await fs.readFile(target, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT" || error.code === "ENOTDIR") return null;
    throw error;
  });
  if (installed === null) return { state: "missing", path: target };
  const source = await fs.readFile(COMPANION_SOURCE, "utf8");
  if (installed === source) return { state: "current", path: target };
  return { state: installed.startsWith(COMPANION_MARKER) ? "outdated" : "foreign", path: target };
}
