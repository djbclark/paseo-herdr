import { describe, expect, it, vi } from "vitest";
import { processInstanceId, type ProcessIdentityDeps } from "../server/harness/process-identity.js";

const psDeps = (stdout: string) => {
  const execFile = vi.fn<ProcessIdentityDeps["execFile"]>(async () => ({ stdout }));
  return { execFile, deps: { execFile, platform: "darwin" as const } };
};

/** Build a /proc stat line: pid (comm) state then fields 4..52, with starttime at field 22. */
const statLine = (pid: number, comm: string, starttime: string) => {
  const rest = Array.from({ length: 50 }, (_, i) => String(i + 4)); // fields 4..53
  rest[22 - 4] = starttime;
  return `${pid} (${comm}) S ${rest.join(" ")}\n`;
};

describe("processInstanceId", () => {
  it("returns pid@lstart, trimmed, from ps", async () => {
    const { deps } = psDeps("Thu Oct 30 22:13:44 2026\n");
    expect(await processInstanceId(4242, deps)).toBe("4242@Thu Oct 30 22:13:44 2026");
  });

  it("runs ps as an argv list with a 2 s timeout and LC_ALL=C, no shell", async () => {
    const { execFile, deps } = psDeps("Thu Oct 30 22:13:44 2026\n");
    await processInstanceId(77, deps);
    expect(execFile).toHaveBeenCalledTimes(1);
    const [file, args, options] = execFile.mock.calls[0]!;
    expect(file).toBe("/bin/ps");
    expect(args).toEqual(["-o", "lstart=", "-p", "77"]);
    expect(options.timeout).toBe(2000);
    expect(options.env.LC_ALL).toBe("C");
    expect(options).not.toHaveProperty("shell");
  });

  it("different start times give different ids for the same pid", async () => {
    const a = await processInstanceId(9, psDeps("Thu Oct 30 22:13:44 2026").deps);
    const b = await processInstanceId(9, psDeps("Fri Oct 31 01:00:00 2026").deps);
    expect(a).not.toBe(b);
  });

  it("throws when ps fails", async () => {
    const deps = { execFile: async () => { throw new Error("ps exited 1"); }, platform: "darwin" as const };
    await expect(processInstanceId(9, deps)).rejects.toThrow(/ps exited 1/);
  });

  it("throws on empty or blank ps output", async () => {
    await expect(processInstanceId(9, psDeps("").deps)).rejects.toThrow(/no start time/);
    await expect(processInstanceId(9, psDeps("  \n").deps)).rejects.toThrow(/no start time/);
  });

  it("accepts a space-padded day of month", async () => {
    expect(await processInstanceId(9, psDeps("Sat Nov  7 03:04:05 2026\n").deps)).toBe("9@Sat Nov  7 03:04:05 2026");
  });

  it("throws on ps's `?` placeholder for a process it cannot inspect, so no shared id is returned", async () => {
    await expect(processInstanceId(1, psDeps("?\n").deps)).rejects.toThrow(/unrecognised start time/);
  });

  it("throws on any other non-lstart text", async () => {
    for (const text of ["garbage", "Thu Oct 30 22:13:44", "Thu Oct 30 22:13:44 2026 extra", "Thu Okt 30 22:13:44 2026", "jeu. oct. 30 22:13:44 2026", "ps: no such process"]) {
      await expect(processInstanceId(9, psDeps(text).deps), text).rejects.toThrow(/unrecognised start time/);
    }
  });

  it("rejects a non-positive or fractional pid without spawning", async () => {
    const { execFile, deps } = psDeps("x");
    for (const pid of [0, -1, 1.5, NaN]) await expect(processInstanceId(pid, deps)).rejects.toThrow(/invalid pid/);
    expect(execFile).not.toHaveBeenCalled();
  });

  describe("linux /proc", () => {
    const linux = (stat: string | Error) => {
      const readFile = vi.fn<ProcessIdentityDeps["readFile"]>(async () => { if (stat instanceof Error) throw stat; return stat; });
      const execFile = vi.fn<ProcessIdentityDeps["execFile"]>(async () => ({ stdout: "unused" }));
      return { readFile, execFile, deps: { readFile, execFile, platform: "linux" as const } };
    };

    it("reads field 22 of /proc/<pid>/stat and never runs ps", async () => {
      const { readFile, execFile, deps } = linux(statLine(321, "node", "123456789"));
      expect(await processInstanceId(321, deps)).toBe("321@123456789");
      expect(readFile.mock.calls[0]![0]).toBe("/proc/321/stat");
      expect(execFile).not.toHaveBeenCalled();
    });

    it("survives a comm with spaces and parentheses", async () => {
      const { deps } = linux(statLine(5, "my (weird) proc )x", "987"));
      expect(await processInstanceId(5, deps)).toBe("5@987");
    });

    it("throws when /proc cannot be read", async () => {
      await expect(processInstanceId(5, linux(new Error("ENOENT")).deps)).rejects.toThrow(/ENOENT/);
    });

    it("throws on a truncated or non-numeric stat", async () => {
      await expect(processInstanceId(5, linux("5 (node) S 1 2 3\n").deps)).rejects.toThrow(/malformed/);
      await expect(processInstanceId(5, linux("garbage").deps)).rejects.toThrow(/malformed/);
      await expect(processInstanceId(5, linux("").deps)).rejects.toThrow(/malformed/);
    });
  });
});
