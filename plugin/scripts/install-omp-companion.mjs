#!/usr/bin/env node
// Installs the OMP input companion (harness-extension/omp.ts) into OMP's extensions directory.
// Resolution mirrors Herdr's omp_extension_dir (herdr/src/integration/env.rs); keep them in sync.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";

export const COMPANION_NAME = "paseo4herdr-input.ts";
const MARKER = "// paseo4herdr OMP input companion.";
// Pre-rename (paseo-herdr) companion. OMP loads every file in the extensions directory, so install/update
// removes a legacy file we wrote, and uninstall removes it too. Mirrors server/harness/omp/companion-install.ts.
export const LEGACY_COMPANION_NAME = "paseo-herdr-input.ts";
const LEGACY_MARKER = "// paseo-herdr OMP input companion.";
const SOURCE = fileURLToPath(new URL("../harness-extension/omp.ts", import.meta.url));

function expandTilde(value, home) {
  if (value === "~") return home;
  if (value.startsWith("~/")) return path.join(home, value.slice(2));
  if (value.startsWith("~")) return path.join(home, value.slice(1));
  return value;
}

/** Herdr rule: PI_CODING_AGENT_DIR wins (leading ~ expanded), else <home>/<PI_CONFIG_DIR or .omp>/agent. */
export function resolveOmpExtensionDir(env, home) {
  if (env.PI_CODING_AGENT_DIR) return path.join(expandTilde(env.PI_CODING_AGENT_DIR, home), "extensions");
  return path.join(home, env.PI_CONFIG_DIR || ".omp", "agent", "extensions");
}

function readIfExists(file) {
  try { return fs.readFileSync(file, "utf8"); }
  catch (error) { if (error.code === "ENOENT" || error.code === "ENOTDIR") return null; throw error; }
}

/** Legacy path read that never throws: any error means "not ours, ignore" (a directory or unreadable file must not block the new companion). */
function readLegacy(file) {
  try { return readIfExists(file); }
  catch (error) {
    console.error(`ignoring legacy path ${file}: ${error.code ?? error.message}`);
    return null;
  }
}

/** Removes the legacy companion; returns false (after telling the operator) when it cannot be removed. */
function removeLegacyFile(file) {
  try {
    fs.rmSync(file);
    console.log(`removed legacy: ${file}`);
    return true;
  } catch (error) {
    console.error(`could not remove legacy companion ${file}: ${error.code ?? error.message}; remove it by hand, OMP will load both`);
    return false;
  }
}

/** Write to a temp file in the same directory, then rename over the target. */
function writeAtomic(target, content) {
  const temp = `${target}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  try {
    fs.writeFileSync(temp, content);
    fs.renameSync(temp, target);
  } catch (error) {
    fs.rmSync(temp, { force: true });
    throw error;
  }
}

export function main(argv, env, home) {
  const known = new Set(["--force", "--uninstall", "--print-path"]);
  const unknown = argv.find((arg) => !known.has(arg));
  if (unknown !== undefined) {
    console.error(`Unknown argument: ${unknown}. Usage: install-omp-companion [--force] [--uninstall] [--print-path]`);
    return 1;
  }
  const extensionDir = resolveOmpExtensionDir(env, home);
  const target = path.join(extensionDir, COMPANION_NAME);
  const legacyTarget = path.join(extensionDir, LEGACY_COMPANION_NAME);
  if (argv.includes("--print-path")) {
    console.log(target);
    return 0;
  }
  const current = readIfExists(target);
  const legacy = readLegacy(legacyTarget);
  const legacyOurs = legacy !== null && legacy.startsWith(LEGACY_MARKER);
  if (argv.includes("--uninstall")) {
    if (current === null && legacy === null) {
      console.log(`not installed: ${target}`);
      return 0;
    }
    let code = 0;
    if (current !== null) {
      if (current.startsWith(MARKER)) {
        fs.rmSync(target);
        console.log(`removed: ${target}`);
      } else {
        console.error(`Refusing to remove ${target}: it is not a paseo4herdr companion.`);
        code = 1;
      }
    }
    if (legacy !== null) {
      if (legacyOurs) {
        if (!removeLegacyFile(legacyTarget)) code = 1;
      } else {
        console.error(`Refusing to remove ${legacyTarget}: it is not a paseo-herdr companion.`);
        code = 1;
      }
    }
    return code;
  }
  const agentDir = path.dirname(extensionDir);
  if (!fs.existsSync(agentDir)) {
    console.error(`OMP agent directory not found at ${agentDir}; run omp once first`);
    return 1;
  }
  const source = fs.readFileSync(SOURCE, "utf8");
  let legacyFailed = false;
  const removeLegacy = () => {
    if (legacy !== null && !legacyOurs) console.log(`left ${legacyTarget}: not a paseo-herdr companion`);
    if (legacyOurs && !removeLegacyFile(legacyTarget)) legacyFailed = true;
  };
  if (current === source) {
    console.log(`already current: ${target}`);
    removeLegacy();
    return legacyFailed ? 1 : 0;
  }
  let label = "installed";
  if (current !== null) {
    if (current.startsWith(MARKER)) label = "updated";
    else if (argv.includes("--force")) label = "replaced";
    else {
      console.error(`Refusing to overwrite ${target}: it is not a paseo4herdr companion. Rerun with --force to replace it.`);
      return 1;
    }
  }
  console.log(`Writing the paseo4herdr OMP input companion ${COMPANION_NAME} to ${extensionDir}`);
  fs.mkdirSync(extensionDir, { recursive: true });
  writeAtomic(target, source);
  console.log(`${label}: ${target}`);
  removeLegacy();
  console.log("Restart running OMP agents: OMP loads extensions only at startup. Do not also pass this file with -e.");
  console.log("On Paseo's Herdr screen, Restart to enable input restarts an idle agent in place.");
  return legacyFailed ? 1 : 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2), process.env, os.homedir());
}
