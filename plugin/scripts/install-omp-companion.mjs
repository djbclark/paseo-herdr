#!/usr/bin/env node
// Installs the OMP input companion (harness-extension/omp.ts) into OMP's extensions directory.
// Resolution mirrors Herdr's omp_extension_dir (herdr/src/integration/env.rs); keep them in sync.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";

export const COMPANION_NAME = "paseo-herdr-input.ts";
const MARKER = "// paseo-herdr OMP input companion.";
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
  if (argv.includes("--print-path")) {
    console.log(target);
    return 0;
  }
  const current = readIfExists(target);
  if (argv.includes("--uninstall")) {
    if (current === null) {
      console.log(`not installed: ${target}`);
      return 0;
    }
    if (!current.startsWith(MARKER)) {
      console.error(`Refusing to remove ${target}: it is not a paseo-herdr companion.`);
      return 1;
    }
    fs.rmSync(target);
    console.log(`removed: ${target}`);
    return 0;
  }
  const agentDir = path.dirname(extensionDir);
  if (!fs.existsSync(agentDir)) {
    console.error(`OMP agent directory not found at ${agentDir}; run omp once first`);
    return 1;
  }
  const source = fs.readFileSync(SOURCE, "utf8");
  if (current === source) {
    console.log(`already current: ${target}`);
    return 0;
  }
  let label = "installed";
  if (current !== null) {
    if (current.startsWith(MARKER)) label = "updated";
    else if (argv.includes("--force")) label = "replaced";
    else {
      console.error(`Refusing to overwrite ${target}: it is not a paseo-herdr companion. Rerun with --force to replace it.`);
      return 1;
    }
  }
  fs.mkdirSync(extensionDir, { recursive: true });
  writeAtomic(target, source);
  console.log(`${label}: ${target}`);
  console.log("Restart running OMP agents: OMP loads extensions only at startup. Do not also pass this file with -e.");
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2), process.env, os.homedir());
}
