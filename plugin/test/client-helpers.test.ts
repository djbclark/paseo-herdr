import { describe, expect, it } from "vitest";
import { agentLabel, attentionLabel, describeTarget, pathTail, timeAgo, statusLabel, statusTone, validateFolder } from "../client/helpers.js";

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

describe("timeAgo and attentionLabel", () => {
  const now = Date.parse("2026-10-13T12:00:00Z");
  it("formats compact relative times", () => {
    expect(timeAgo("2026-10-13T11:59:40Z", now)).toBe("now");
    expect(timeAgo("2026-10-13T11:55:00Z", now)).toBe("5m ago");
    expect(timeAgo("2026-10-13T09:00:00Z", now)).toBe("3h ago");
    expect(timeAgo("2026-10-11T12:00:00Z", now)).toBe("2d ago");
    expect(timeAgo("not a date", now)).toBe("");
  });
  it("labels attention reasons", () => {
    expect(attentionLabel("permission")).toBe("Needs approval");
    expect(attentionLabel(null)).toBeNull();
  });
});
