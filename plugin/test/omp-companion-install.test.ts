import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs, { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
// @ts-expect-error plain ESM installer script has no type declarations
import * as installerModule from "../scripts/install-omp-companion.mjs";
import { COMPANION_INSTALL_NAME, LEGACY_COMPANION_NAME, companionInstallStatus, ompExtensionDir } from "../server/harness/omp/companion-install.js";
import { ompAdapter } from "../server/harness/omp/adapter.js";
import { COMPANION_SHA256 } from "../server/harness/omp/companion-hash.js";
import { createHash } from "node:crypto";

type Env = Record<string, string | undefined>;
interface Installer {
  resolveOmpExtensionDir(env: Env, home: string): string;
  main(argv: string[], env: Env, home: string): number;
}
const installer = installerModule as unknown as Installer;

const MARKER = "// paseo4herdr OMP input companion.";
const LEGACY_MARKER = "// paseo-herdr OMP input companion.";
const LEGACY_SOURCE = `${LEGACY_MARKER} Installed by the pre-rename plugin.\nexport default function legacy() {}\n`;
const SOURCE = readFileSync(fileURLToPath(new URL("../harness-extension/omp.ts", import.meta.url)), "utf8");
const FOREIGN = "export default function other() {}\n";

let root: string;
let home: string;
let agentDir: string;
let extDir: string;
let target: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "paseo-omp-companion-"));
  home = path.join(root, "home");
  agentDir = path.join(home, ".omp", "agent");
  extDir = path.join(agentDir, "extensions");
  target = path.join(extDir, COMPANION_INSTALL_NAME);
  await mkdir(home);
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
});

/** Runs the installer against the temp home only; console output is captured, not printed. */
function run(argv: string[], env: Env = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const log = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => { out.push(args.join(" ")); });
  const error = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => { err.push(args.join(" ")); });
  try {
    const code = installer.main(argv, env, home);
    return { code, out: out.join("\n"), err: err.join("\n") };
  } finally {
    log.mockRestore();
    error.mockRestore();
  }
}

describe("extension directory resolution", () => {
  const cases: Array<[string, Env, (h: string) => string]> = [
    ["PI_CODING_AGENT_DIR absolute", { PI_CODING_AGENT_DIR: "/srv/omp" }, () => "/srv/omp/extensions"],
    ["PI_CODING_AGENT_DIR with leading ~/", { PI_CODING_AGENT_DIR: "~/alt" }, (h) => path.join(h, "alt", "extensions")],
    ["PI_CODING_AGENT_DIR of bare ~", { PI_CODING_AGENT_DIR: "~" }, (h) => path.join(h, "extensions")],
    ["PI_CODING_AGENT_DIR wins over PI_CONFIG_DIR", { PI_CODING_AGENT_DIR: "/srv/omp", PI_CONFIG_DIR: ".pi-alt" }, () => "/srv/omp/extensions"],
    ["PI_CONFIG_DIR only", { PI_CONFIG_DIR: ".pi-alt" }, (h) => path.join(h, ".pi-alt", "agent", "extensions")],
    ["neither set", {}, (h) => path.join(h, ".omp", "agent", "extensions")],
    ["both empty", { PI_CODING_AGENT_DIR: "", PI_CONFIG_DIR: "" }, (h) => path.join(h, ".omp", "agent", "extensions")],
  ];
  it.each(cases)("%s resolves identically in the script and the TS module", (_name, env, expected) => {
    expect(installer.resolveOmpExtensionDir(env, home)).toBe(expected(home));
    expect(ompExtensionDir(env, home)).toBe(expected(home));
  });
});

describe("installer main", () => {
  it("refuses when the OMP agent directory is missing and creates nothing", () => {
    const result = run([]);
    expect(result.code).toBe(1);
    expect(result.err).toBe(`OMP agent directory not found at ${agentDir}; run omp once first`);
    expect(existsSync(path.join(home, ".omp"))).toBe(false);
  });

  it("prints the target path without requiring the agent directory", () => {
    const result = run(["--print-path"]);
    expect(result.code).toBe(0);
    expect(result.out).toBe(target);
  });

  it("rejects unknown arguments", () => {
    expect(run(["--bogus"]).code).toBe(1);
  });

  it("installs, reports already current on rerun, and prints the restart notice", async () => {
    await mkdir(agentDir, { recursive: true });
    const first = run([]);
    expect(first.code).toBe(0);
    expect(first.out).toContain(`Writing the paseo4herdr OMP input companion ${COMPANION_INSTALL_NAME} to ${extDir}`);
    expect(first.out).toContain(`installed: ${target}`);
    expect(first.out).toContain("Restart running OMP agents: OMP loads extensions only at startup. Do not also pass this file with -e.");
    expect(await readFile(target, "utf8")).toBe(SOURCE);
    expect(await readdir(extDir)).toEqual([COMPANION_INSTALL_NAME]);

    const second = run([]);
    expect(second.code).toBe(0);
    expect(second.out).toContain("already current");
  });

  it("updates a marked stale copy", async () => {
    await mkdir(extDir, { recursive: true });
    await writeFile(target, `${SOURCE}\n// stale local copy\n`);
    const result = run([]);
    expect(result.code).toBe(0);
    expect(result.out).toContain(`updated: ${target}`);
    expect(await readFile(target, "utf8")).toBe(SOURCE);
  });

  it("refuses to overwrite a foreign file without --force", async () => {
    await mkdir(extDir, { recursive: true });
    await writeFile(target, FOREIGN);
    const result = run([]);
    expect(result.code).toBe(1);
    expect(result.err).toContain("--force");
    expect(await readFile(target, "utf8")).toBe(FOREIGN);
  });

  it("replaces a foreign file with --force", async () => {
    await mkdir(extDir, { recursive: true });
    await writeFile(target, FOREIGN);
    const result = run(["--force"]);
    expect(result.code).toBe(0);
    expect(result.out).toContain(`replaced: ${target}`);
    expect(await readFile(target, "utf8")).toBe(SOURCE);
  });

  it("uninstall removes a marked companion only", async () => {
    await mkdir(agentDir, { recursive: true });
    run([]);
    expect(run(["--uninstall"]).code).toBe(0);
    expect(existsSync(target)).toBe(false);

    await mkdir(extDir, { recursive: true });
    await writeFile(target, FOREIGN);
    const refused = run(["--uninstall"]);
    expect(refused.code).toBe(1);
    expect(await readFile(target, "utf8")).toBe(FOREIGN);
  });

  it("uninstall with nothing installed is a no-op", () => {
    const result = run(["--uninstall"]);
    expect(result.code).toBe(0);
    expect(result.out).toContain("not installed");
  });

  describe("pre-rename companion migration", () => {
    let legacyTarget: string;
    beforeEach(async () => {
      legacyTarget = path.join(extDir, LEGACY_COMPANION_NAME);
      await mkdir(extDir, { recursive: true });
    });

    it("install removes a legacy companion we wrote and reports it", async () => {
      await writeFile(legacyTarget, LEGACY_SOURCE);
      const result = run([]);
      expect(result.code).toBe(0);
      expect(result.out).toContain(`installed: ${target}`);
      expect(result.out).toContain(`removed legacy: ${legacyTarget}`);
      expect(await readdir(extDir)).toEqual([COMPANION_INSTALL_NAME]);
    });

    it("install leaves a legacy-named file that lacks the legacy marker alone", async () => {
      await writeFile(legacyTarget, FOREIGN);
      const result = run([]);
      expect(result.code).toBe(0);
      expect(result.out).not.toContain("removed legacy");
      expect(result.out).toContain(`left ${legacyTarget}: not a paseo-herdr companion`);
      expect(await readFile(legacyTarget, "utf8")).toBe(FOREIGN);
      expect(await readFile(target, "utf8")).toBe(SOURCE);
    });

    it("install cleans the legacy file even when the new one is already current", async () => {
      await writeFile(target, SOURCE);
      await writeFile(legacyTarget, LEGACY_SOURCE);
      const result = run([]);
      expect(result.code).toBe(0);
      expect(result.out).toContain("already current");
      expect(result.out).toContain(`removed legacy: ${legacyTarget}`);
      expect(existsSync(legacyTarget)).toBe(false);
      expect(await readFile(target, "utf8")).toBe(SOURCE);
    });

    it("a refused install (foreign file at the new path) does not touch the legacy file", async () => {
      await writeFile(target, FOREIGN);
      await writeFile(legacyTarget, LEGACY_SOURCE);
      expect(run([]).code).toBe(1);
      expect(await readFile(legacyTarget, "utf8")).toBe(LEGACY_SOURCE);
    });

    it("uninstall removes both the new and the legacy companion", async () => {
      await writeFile(target, SOURCE);
      await writeFile(legacyTarget, LEGACY_SOURCE);
      const result = run(["--uninstall"]);
      expect(result.code).toBe(0);
      expect(result.out).toContain(`removed: ${target}`);
      expect(result.out).toContain(`removed legacy: ${legacyTarget}`);
      expect(await readdir(extDir)).toEqual([]);
    });

    it("uninstall removes a lone legacy companion instead of reporting not installed", async () => {
      await writeFile(legacyTarget, LEGACY_SOURCE);
      const result = run(["--uninstall"]);
      expect(result.code).toBe(0);
      expect(result.out).not.toContain("not installed");
      expect(existsSync(legacyTarget)).toBe(false);
    });

    it("uninstall refuses a foreign file at the legacy path and keeps it", async () => {
      await writeFile(legacyTarget, FOREIGN);
      const result = run(["--uninstall"]);
      expect(result.code).toBe(1);
      expect(result.err).toContain(legacyTarget);
      expect(await readFile(legacyTarget, "utf8")).toBe(FOREIGN);
    });

    it("--print-path still prints the new path when a legacy file exists", async () => {
      await writeFile(legacyTarget, LEGACY_SOURCE);
      expect(run(["--print-path"]).out).toBe(target);
    });

    it("install ignores an unreadable legacy path (a directory) with a warning and still writes the new companion", async () => {
      await mkdir(legacyTarget);
      const result = run([]);
      expect(result.code).toBe(0);
      expect(result.out).toContain(`installed: ${target}`);
      expect(result.err).toContain(`ignoring legacy path ${legacyTarget}: EISDIR`);
      expect(await readFile(target, "utf8")).toBe(SOURCE);
    });

    it("uninstall ignores an unreadable legacy path and still removes the new companion", async () => {
      await writeFile(target, SOURCE);
      await mkdir(legacyTarget);
      const result = run(["--uninstall"]);
      expect(result.code).toBe(0);
      expect(result.out).toContain(`removed: ${target}`);
      expect(existsSync(target)).toBe(false);
      expect(existsSync(legacyTarget)).toBe(true);
    });

    // Removing a file as a non-root user cannot be made to fail portably, so the failure is injected by stubbing fs.rmSync for the legacy path only.
    const hint = `could not remove legacy companion ${"LEGACY"}: EACCES; remove it by hand, OMP will load both`;
    function failLegacyRemoval<T>(body: () => T): T {
      const real = fs.rmSync;
      const spy = vi.spyOn(fs, "rmSync").mockImplementation((file, options) => {
        if (String(file).endsWith(LEGACY_COMPANION_NAME)) throw Object.assign(new Error("denied"), { code: "EACCES" });
        return real(file, options);
      });
      try { return body(); } finally { spy.mockRestore(); }
    }

    it("install keeps going when the legacy file cannot be removed: success lines and restart hint, then exit 1", async () => {
      await writeFile(legacyTarget, LEGACY_SOURCE);
      const result = failLegacyRemoval(() => run([]));
      expect(result.code).toBe(1);
      expect(result.out).toContain(`installed: ${target}`);
      expect(result.out).toContain("Restart running OMP agents");
      expect(result.err).toContain(hint.replace("LEGACY", legacyTarget));
      expect(await readFile(target, "utf8")).toBe(SOURCE);
      expect(existsSync(legacyTarget)).toBe(true);
    });

    it("install exits 1 when the new file is already current but the legacy file cannot be removed", async () => {
      await writeFile(target, SOURCE);
      await writeFile(legacyTarget, LEGACY_SOURCE);
      const result = failLegacyRemoval(() => run([]));
      expect(result.code).toBe(1);
      expect(result.out).toContain("already current");
      expect(result.err).toContain(hint.replace("LEGACY", legacyTarget));
    });

    it("uninstall removes the new companion, reports an unremovable legacy file and exits 1", async () => {
      await writeFile(target, SOURCE);
      await writeFile(legacyTarget, LEGACY_SOURCE);
      const result = failLegacyRemoval(() => run(["--uninstall"]));
      expect(result.code).toBe(1);
      expect(result.out).toContain(`removed: ${target}`);
      expect(result.err).toContain(hint.replace("LEGACY", legacyTarget));
      expect(existsSync(target)).toBe(false);
    });
  });

  it("honours PI_CODING_AGENT_DIR for the target directory", async () => {
    const custom = path.join(root, "custom-agent");
    await mkdir(custom);
    const env = { PI_CODING_AGENT_DIR: custom };
    expect(run(["--print-path"], env).out).toBe(path.join(custom, "extensions", COMPANION_INSTALL_NAME));
    expect(run([], env).code).toBe(0);
    expect(await readFile(path.join(custom, "extensions", COMPANION_INSTALL_NAME), "utf8")).toBe(SOURCE);
  });
});

describe("companionInstallStatus", () => {
  const env: Env = {};

  it("reports missing, current, outdated, and foreign", async () => {
    expect(await companionInstallStatus(env, home)).toEqual({ state: "missing", path: target });

    await mkdir(agentDir, { recursive: true });
    run([]);
    expect(await companionInstallStatus(env, home)).toEqual({ state: "current", path: target });

    await writeFile(target, `${SOURCE}\n// stale\n`);
    expect((await companionInstallStatus(env, home)).state).toBe("outdated");

    await writeFile(target, FOREIGN);
    expect((await companionInstallStatus(env, home)).state).toBe("foreign");
  });

  it("reports a legacy-only companion as outdated at the legacy path, so the installer is rerun", async () => {
    const legacyPath = path.join(extDir, LEGACY_COMPANION_NAME);
    await mkdir(extDir, { recursive: true });
    await writeFile(legacyPath, LEGACY_SOURCE);
    expect(await companionInstallStatus(env, home)).toEqual({ state: "outdated", path: legacyPath });
  });

  it("ignores a foreign legacy-named file", async () => {
    await mkdir(extDir, { recursive: true });
    await writeFile(path.join(extDir, LEGACY_COMPANION_NAME), FOREIGN);
    expect(await companionInstallStatus(env, home)).toEqual({ state: "missing", path: target });
  });

  it("downgrades a current new file to outdated at the legacy path while a legacy companion is still present", async () => {
    await mkdir(extDir, { recursive: true });
    const legacyPath = path.join(extDir, LEGACY_COMPANION_NAME);
    await writeFile(legacyPath, LEGACY_SOURCE);
    await writeFile(target, SOURCE);
    expect(await companionInstallStatus(env, home)).toEqual({ state: "outdated", path: legacyPath });
  });

  it("keeps the new file's own state when it is not current and a legacy companion also exists", async () => {
    await mkdir(extDir, { recursive: true });
    await writeFile(path.join(extDir, LEGACY_COMPANION_NAME), LEGACY_SOURCE);
    await writeFile(target, FOREIGN);
    expect(await companionInstallStatus(env, home)).toEqual({ state: "foreign", path: target });
  });

  it("treats an unreadable legacy path (a directory) as no legacy file", async () => {
    await mkdir(path.join(extDir, LEGACY_COMPANION_NAME), { recursive: true });
    expect(await companionInstallStatus(env, home)).toEqual({ state: "missing", path: target });
    await writeFile(target, SOURCE);
    expect(await companionInstallStatus(env, home)).toEqual({ state: "current", path: target });
  });

  it("uses PI_CODING_AGENT_DIR when set", async () => {
    const custom = path.join(root, "custom-agent");
    await mkdir(path.join(custom, "extensions"), { recursive: true });
    await writeFile(path.join(custom, "extensions", COMPANION_INSTALL_NAME), SOURCE);
    expect(await companionInstallStatus({ PI_CODING_AGENT_DIR: custom }, home)).toEqual({
      state: "current",
      path: path.join(custom, "extensions", COMPANION_INSTALL_NAME),
    });
  });
});

describe("OMP adapter inputCompanionStatus", () => {
  beforeEach(() => {
    // os.homedir() reads HOME on POSIX; an empty PI_* value counts as unset.
    vi.stubEnv("HOME", home);
    vi.stubEnv("PI_CODING_AGENT_DIR", "");
    vi.stubEnv("PI_CONFIG_DIR", "");
  });

  it("reports a missing companion with the install instruction", async () => {
    expect(await ompAdapter.inputCompanionStatus?.()).toEqual({
      ok: false,
      diagnostic: "OMP input companion is not installed; imported agents are read-only. Run `npm run install:omp-companion` in paseo4herdr/plugin, then restart OMP agents.",
    });
  });

  it("reports ok once the companion is current", async () => {
    await mkdir(agentDir, { recursive: true });
    run([]);
    expect(await ompAdapter.inputCompanionStatus?.()).toEqual({ ok: true });
  });

  it("reports outdated and foreign copies", async () => {
    await mkdir(extDir, { recursive: true });
    await writeFile(target, `${SOURCE}\n// stale\n`);
    expect(await ompAdapter.inputCompanionStatus?.()).toEqual({
      ok: false,
      diagnostic: "OMP input companion is outdated. Rerun `npm run install:omp-companion` in paseo4herdr/plugin, then restart OMP agents.",
    });
    await writeFile(target, FOREIGN);
    expect(await ompAdapter.inputCompanionStatus?.()).toEqual({
      ok: false,
      diagnostic: `A different file exists at ${target}. Rerun the installer with --force to replace it.`,
    });
  });
});

it("marker is the prefix the source file starts with", () => {
  expect(SOURCE.startsWith(MARKER)).toBe(true);
});

it("keeps the generated companion hash in step with harness-extension/omp.ts (run npm run sync:companion-hash)", () => {
  expect(createHash("sha256").update(SOURCE).digest("hex")).toBe(COMPANION_SHA256);
});
