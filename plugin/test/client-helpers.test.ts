import { describe, expect, it } from "vitest";
import { archiveDuplicatesLabel, duplicateChatsToArchive, folderFieldValue, needsHomeExpansion, agentLabel, describeTarget, pathTail, statusLabel, statusTone, validateFolder } from "../client/helpers.js";

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
  it("accepts ~ folders and detects when the daemon must expand them", () => {
    expect(validateFolder("~/code")).toBeNull();
    expect(needsHomeExpansion(" ~ ")).toBe(true);
    expect(needsHomeExpansion("~/code")).toBe(true);
    expect(needsHomeExpansion("~user/code")).toBe(false);
    expect(needsHomeExpansion("/abs/~")).toBe(false);
  });
  it("picked folders get one trailing slash", () => {
    expect(folderFieldValue("/a/b")).toBe("/a/b/");
    expect(folderFieldValue("/a/b/")).toBe("/a/b/");
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
  it("archives only the duplicates, never the row's primary chat", () => {
    expect(duplicateChatsToArchive({ paseoAgentId: "new", duplicateChatIds: ["old1", "old2"] })).toEqual(["old1", "old2"]);
    expect(duplicateChatsToArchive({ paseoAgentId: "new", duplicateChatIds: ["old1", "new", "old1", ""] })).toEqual(["old1"]);
    expect(duplicateChatsToArchive({ paseoAgentId: null, duplicateChatIds: [] })).toEqual([]);
  });
  it("words the archive-duplicates action by count", () => {
    expect(archiveDuplicatesLabel(1)).toBe("Archive 1 duplicate chat");
    expect(archiveDuplicatesLabel(3)).toBe("Archive 3 duplicate chats");
  });
});
