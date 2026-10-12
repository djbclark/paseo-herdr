import { describe, expect, it } from "vitest";
import { herdrSessionName, resolveSocketPath } from "../server/herdr/socket-path.js";

const env = (overrides: Record<string, string | undefined> = {}) =>
  ({ XDG_CONFIG_HOME: undefined, HOME: "/home/u", APPDATA: undefined, USERPROFILE: undefined, ...overrides });

describe("resolveSocketPath", () => {
  it("prefers an explicit path over the environment", () => {
    expect(resolveSocketPath({ path: "/explicit/herdr.sock", env: env({ HERDR_SOCKET_PATH: "/env/herdr.sock" }) }))
      .toBe("/explicit/herdr.sock");
  });

  it("falls back to HERDR_SOCKET_PATH", () => {
    expect(resolveSocketPath({ env: env({ HERDR_SOCKET_PATH: "/env/herdr.sock" }) })).toBe("/env/herdr.sock");
  });

  it("resolves a named session under sessions/<name>/herdr.sock", () => {
    expect(resolveSocketPath({ session: "paseo-spike-c", env: env() }))
      .toBe("/home/u/.config/herdr/sessions/paseo-spike-c/herdr.sock");
  });

  it("maps the default session to the root herdr.sock", () => {
    expect(resolveSocketPath({ session: "default", env: env() })).toBe("/home/u/.config/herdr/herdr.sock");
  });

  it("resolves the default session when no session is given", () => {
    expect(resolveSocketPath({ env: env() })).toBe("/home/u/.config/herdr/herdr.sock");
  });

  it("honours XDG_CONFIG_HOME", () => {
    expect(resolveSocketPath({ session: "spike", env: env({ XDG_CONFIG_HOME: "/xdg" }) }))
      .toBe("/xdg/herdr/sessions/spike/herdr.sock");
  });

  it("honours HERDR_SESSION from the environment", () => {
    expect(resolveSocketPath({ env: env({ HERDR_SESSION: "spike" }) }))
      .toBe("/home/u/.config/herdr/sessions/spike/herdr.sock");
  });

  it("uses the debug app dir name when requested", () => {
    expect(resolveSocketPath({ appDirName: "herdr-dev", env: env() }))
      .toBe("/home/u/.config/herdr-dev/herdr.sock");
  });

  it("wraps paths as Windows named pipes", () => {
    expect(resolveSocketPath({ platform: "win32", env: env({ APPDATA: "C:\\Users\\u\\AppData\\Roaming" }) }))
      .toBe("\\\\.\\pipe\\C:\\Users\\u\\AppData\\Roaming\\herdr\\herdr.sock");
  });

  it("does not double-wrap an existing named pipe path", () => {
    expect(resolveSocketPath({ platform: "win32", path: "\\\\.\\pipe\\herdr\\herdr.sock", env: env() }))
      .toBe("\\\\.\\pipe\\herdr\\herdr.sock");
  });
});

describe("herdrSessionName", () => {
  it("treats \"default\" as the default session", () => {
    expect(herdrSessionName({ setting: "default" })).toBeNull();
    expect(herdrSessionName({ env: { HERDR_SESSION: "default" } })).toBeNull();
  });
  it("prefers the configured setting over HERDR_SESSION and the socket path", () => {
    expect(herdrSessionName({ setting: "work", env: env({ HERDR_SESSION: "env" }), socketPath: "/x/sessions/paseo-spike-e/herdr.sock" }))
      .toBe("work");
  });

  it("falls back to HERDR_SESSION when the setting is empty", () => {
    expect(herdrSessionName({ setting: "", env: env({ HERDR_SESSION: "spike" }), socketPath: "/home/u/.config/herdr/herdr.sock" }))
      .toBe("spike");
  });

  it("derives the name from a sessions/<name>/herdr.sock socket path", () => {
    expect(herdrSessionName({ env: env(), socketPath: "/x/sessions/paseo-spike-e/herdr.sock" })).toBe("paseo-spike-e");
  });

  it("derives the name from a Windows named pipe wrapping a session socket", () => {
    expect(herdrSessionName({ env: env(), socketPath: "\\\\.\\pipe\\C:\\Users\\u\\AppData\\Roaming\\herdr\\sessions\\spike\\herdr.sock" }))
      .toBe("spike");
  });

  it("returns null for the default socket path", () => {
    expect(herdrSessionName({ env: env(), socketPath: resolveSocketPath({ env: env() }) })).toBeNull();
  });

  it("ignores empty strings", () => {
    expect(herdrSessionName({ setting: "", env: env({ HERDR_SESSION: "" }), socketPath: resolveSocketPath({ env: env() }) })).toBeNull();
    expect(herdrSessionName({ setting: "", env: env({ HERDR_SESSION: "" }), socketPath: "/x/sessions/spike/herdr.sock" })).toBe("spike");
  });
});
