import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";

/** Injectable seams so tests never spawn a process or read /proc. */
export interface ProcessIdentityDeps {
  execFile: (file: string, args: string[], options: { timeout: number; env: NodeJS.ProcessEnv }) => Promise<{ stdout: string }>;
  readFile: (path: string, encoding: "utf8") => Promise<string>;
  platform: NodeJS.Platform;
}

const PS_TIMEOUT_MS = 2000;
const execFileAsync = promisify(execFile);

const defaultDeps: ProcessIdentityDeps = {
  execFile: async (file, args, options) => {
    const { stdout } = await execFileAsync(file, args, { ...options, encoding: "utf8" });
    return { stdout };
  },
  readFile: (path, encoding) => readFile(path, encoding),
  platform: process.platform,
};

/** `/proc/<pid>/stat` field 22 (starttime, clock ticks since boot). `comm` (field 2) is parenthesised and may hold spaces or parens. */
function linuxStartTime(stat: string): string {
  const close = stat.lastIndexOf(")");
  if (close < 0) throw new Error("malformed /proc stat: no comm terminator");
  // After the comm field: state is field 3, so starttime (field 22) is index 19.
  const fields = stat.slice(close + 1).trim().split(/\s+/);
  const start = fields[19];
  if (!start || !/^\d+$/.test(start)) throw new Error("malformed /proc stat: no start time");
  return start;
}

/**
 * Identity of one process instance: `"<pid>@<start>"`. A reused pid has a different start time, so the id differs.
 * Throws on any failure or empty answer; an id is never guessed.
 */
export async function processInstanceId(pid: number, deps: Partial<ProcessIdentityDeps> = {}): Promise<string> {
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error(`invalid pid: ${pid}`);
  const { execFile: run, readFile: read, platform } = { ...defaultDeps, ...deps };
  let start: string;
  if (platform === "linux") {
    start = linuxStartTime(await read(`/proc/${pid}/stat`, "utf8"));
  } else {
    const { stdout } = await run("ps", ["-o", "lstart=", "-p", String(pid)], { timeout: PS_TIMEOUT_MS, env: { ...process.env, LC_ALL: "C" } });
    start = stdout.trim();
    if (!start) throw new Error(`ps returned no start time for pid ${pid}`);
  }
  return `${pid}@${start}`;
}
