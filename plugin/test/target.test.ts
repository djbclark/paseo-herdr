import { describe, expect, it, vi } from "vitest";
import { HerdrError } from "../server/herdr/client.js";
import { TargetReadiness, TargetUnavailableError, resolveTarget, type TargetReadinessDeps } from "../server/herdr/target.js";

const base = { XDG_CONFIG_HOME: "/cfg" };
const none = { herdrSocketPath: "", herdrSession: "" };
const errno = (code: string) => Object.assign(new Error(code), { code });

describe("resolveTarget", () => {
  it("setting path wins over everything and never auto-starts", () => {
    const t = resolveTarget({ herdrSocketPath: "/x.sock", herdrSession: "paseo" }, { ...base, HERDR_SOCKET_PATH: "/e.sock", HERDR_SESSION: "env" });
    expect(t).toMatchObject({ socketPath: "/x.sock", source: "settingPath", herdrSession: null, autoStart: false });
    expect(t.autoStartDisabledReason).toMatch(/settings/);
  });
  it("env path beats session setting", () => {
    const t = resolveTarget({ ...none, herdrSession: "paseo" }, { ...base, HERDR_SOCKET_PATH: "/cfg/herdr/sessions/foo/herdr.sock" });
    expect(t).toMatchObject({ socketPath: "/cfg/herdr/sessions/foo/herdr.sock", source: "envPath", herdrSession: "foo", autoStart: false });
    expect(t.autoStartDisabledReason).toMatch(/HERDR_SOCKET_PATH/);
  });
  it("session setting auto-starts and beats HERDR_SESSION", () => {
    const t = resolveTarget({ ...none, herdrSession: "paseo" }, { ...base, HERDR_SESSION: "env" });
    expect(t).toEqual({ socketPath: "/cfg/herdr/sessions/paseo/herdr.sock", herdrSession: "paseo", source: "settingSession", autoStart: true, autoStartDisabledReason: null });
  });
  it("session setting named default is the default session and connect-only", () => {
    const t = resolveTarget({ ...none, herdrSession: "default" }, { ...base, HERDR_SESSION: "env" });
    expect(t).toMatchObject({ socketPath: "/cfg/herdr/herdr.sock", herdrSession: null, source: "settingSession", autoStart: false });
    expect(t.autoStartDisabledReason).toMatch(/default/);
  });
  it("env session is connect-only", () => {
    const t = resolveTarget(none, { ...base, HERDR_SESSION: "env" });
    expect(t).toMatchObject({ socketPath: "/cfg/herdr/sessions/env/herdr.sock", herdrSession: "env", source: "envSession", autoStart: false });
    expect(t.autoStartDisabledReason).toMatch(/HERDR_SESSION/);
  });
  it("falls back to the default session", () => {
    expect(resolveTarget(none, base)).toMatchObject({ socketPath: "/cfg/herdr/herdr.sock", herdrSession: null, source: "default", autoStart: false });
  });
});

describe("TargetReadiness", () => {
  const named = resolveTarget({ ...none, herdrSession: "paseo" }, base);
  function rig(ping: (n: number) => Promise<string>, extra: Partial<TargetReadinessDeps> = {}) {
    let t = 0, pings = 0;
    const spawnServer = vi.fn();
    const deps: TargetReadinessDeps = { ping: () => ping(pings++), spawnServer, now: () => t, sleep: async (ms) => { t += ms; },
      env: () => ({ HERDR_SOCKET_PATH: "/z", HERDR_SESSION: "z", HOME: "/h" }), ...extra };
    return { ready: new TargetReadiness(deps), spawnServer, pings: () => pings };
  }

  it("returns without starting when the ping succeeds", async () => {
    const { ready, spawnServer } = rig(async () => "0.9.3");
    await expect(ready.ensureReady(named)).resolves.toMatchObject({ version: "0.9.3", autoStarted: false });
    expect(spawnServer).not.toHaveBeenCalled();
    expect(ready.startedHere(named.socketPath)).toBe(false);
  });
  it("starts on ENOENT with a neutralised env, re-pings, and records it", async () => {
    const { ready, spawnServer } = rig(async (n) => { if (n < 3) throw errno("ENOENT"); return "0.9.4"; });
    await expect(ready.ensureReady(named)).resolves.toMatchObject({ version: "0.9.4", autoStarted: true });
    expect(spawnServer).toHaveBeenCalledOnce();
    expect(spawnServer).toHaveBeenCalledWith("paseo", { HOME: "/h" });
    expect(ready.startedHere(named.socketPath)).toBe(true);
  });
  it("forgets an earlier start when a later ping finds the endpoint absent, so autoStarted follows the current Herdr", async () => {
    let phase: "start" | "down" | "shell" = "start";
    const { ready } = rig(async (n) => {
      if (phase === "start") { if (n < 2) throw errno("ENOENT"); return "0.9.4"; }
      if (phase === "down") throw errno("ECONNREFUSED");
      return "0.9.4";
    });
    const connectOnly = { ...named, autoStart: false, autoStartDisabledReason: "Auto-start is off for this target" };
    await expect(ready.ensureReady(named)).resolves.toMatchObject({ autoStarted: true });
    phase = "down";
    await expect(ready.ensureReady(connectOnly)).rejects.toBeInstanceOf(TargetUnavailableError);
    expect(ready.startedHere(named.socketPath)).toBe(false);
    phase = "shell";
    await expect(ready.ensureReady(connectOnly)).resolves.toMatchObject({ version: "0.9.4", autoStarted: false });
  });
  it("coalesces concurrent calls into one start", async () => {
    const { ready, spawnServer } = rig(async (n) => { if (n < 3) throw errno("ECONNREFUSED"); return "0.9.3"; });
    await Promise.all([ready.ensureReady(named), ready.ensureReady(named), ready.ensureReady(named)]);
    expect(spawnServer).toHaveBeenCalledOnce();
  });
  it("never starts on permission, protocol or version errors", async () => {
    for (const error of [errno("EACCES"), new HerdrError("bad_request", "nope"), new Error("herdr request timed out")]) {
      const { ready, spawnServer } = rig(async () => { throw error; });
      await expect(ready.ensureReady(named)).rejects.toBeInstanceOf(TargetUnavailableError);
      expect(spawnServer).not.toHaveBeenCalled();
    }
    const old = rig(async () => "0.9.2");
    await expect(old.ready.ensureReady(named)).rejects.toThrow(/0\.9\.3 or newer/);
    expect(old.spawnServer).not.toHaveBeenCalled();
  });
  it("never starts when auto-start is off and names the socket and error", async () => {
    const target = resolveTarget(none, base);
    const { ready, spawnServer } = rig(async () => { throw errno("ENOENT"); });
    const error = await ready.ensureReady(target).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TargetUnavailableError);
    expect((error as Error).message).toContain(target.socketPath);
    expect((error as Error).message).toContain("ENOENT");
    expect(spawnServer).not.toHaveBeenCalled();
  });
  it("gives up after the bounded deadline", async () => {
    const { ready, spawnServer, pings } = rig(async () => { throw errno("ENOENT"); });
    await expect(ready.ensureReady(named)).rejects.toThrow(/did not answer in time/);
    expect(spawnServer).toHaveBeenCalledOnce();
    expect(pings()).toBeLessThan(60);
  });
  it("reports a spawn failure as unavailable", async () => {
    const { ready } = rig(async () => { throw errno("ENOENT"); }, { spawnServer: () => { throw new Error("no herdr"); } });
    await expect(ready.ensureReady(named)).rejects.toThrow(/no herdr/);
    expect(ready.startedHere(named.socketPath)).toBe(false);
  });
});
