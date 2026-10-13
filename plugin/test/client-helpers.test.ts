import { describe, expect, it } from "vitest";
import { agentLabel, describeTarget, pathTail, statusLabel, statusTone, validateFolder } from "../client/helpers.js";

describe("client helpers", () => {
  it("labels and tones statuses", () => {
    expect(statusLabel("blocked")).toBe("Blocked");
    expect(statusTone("working")).toBe("accent");
    expect(statusTone("unknown")).toBe("muted");
  });
  it("validates folder", () => {
    expect(validateFolder("  ")).toBe("Enter a folder path");
    expect(validateFolder("/tmp")).toBeNull();
  });
  it("describes target", () => {
    const lines = describeTarget({
      socketPath: "/s", herdrSession: null, source: "default", autoStart: false, autoStartDisabledReason: "x",
    });
    expect(lines).toEqual(["Socket: /s", "Session: default", "Auto-start: off"]);
  });
  it("pathTail", () => {
    expect(pathTail("/a/b/")).toBe("b");
  });
});

describe("agentLabel", () => {
  const base = { title: null, name: null, kind: "omp", terminalId: "term_1" };
  it("prefers the terminal title without its prompt glyph", () => {
    expect(agentLabel({ ...base, title: "π > What can you do" })).toBe("What can you do");
  });
  it("falls back to name, kind, then terminal id", () => {
    expect(agentLabel({ ...base, title: "π > ", name: "paseo-abc123" })).toBe("paseo-abc123");
    expect(agentLabel(base)).toBe("omp");
    expect(agentLabel({ ...base, kind: null })).toBe("term_1");
  });
});
