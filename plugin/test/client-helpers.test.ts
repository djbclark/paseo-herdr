import { describe, expect, it } from "vitest";
import { archiveDuplicatesLabel, companionBanner, duplicateChatsToArchive, folderFieldValue, needsHomeExpansion, agentLabel, describeTarget, pathTail, statusLabel, statusTone, validateFolder } from "../client/helpers.js";

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
  it("shows no companion banner when current or when OMP is off", () => {
    expect(companionBanner({ state: "current", path: "/e/paseo4herdr-input.ts" }, true)).toBeNull();
    expect(companionBanner({ state: "missing", path: "/e/paseo4herdr-input.ts" }, false)).toBeNull();
  });
  it("words the companion banner per state and names the fix command", () => {
    const fix = "paseo plugin update herdr-harness";
    const script = "node scripts/install-omp-companion.mjs";
    const missing = companionBanner({ state: "missing", path: "/e/paseo4herdr-input.ts" }, true)!;
    expect(missing).toContain("isn't installed");
    expect(missing).toContain(fix);
    expect(missing).toContain(script);
    const outdated = companionBanner({ state: "outdated", path: "/e/paseo4herdr-input.ts" }, true)!;
    expect(outdated).toContain("is outdated (/e/paseo4herdr-input.ts)");
    expect(outdated).toContain(fix);
    const foreign = companionBanner({ state: "foreign", path: "/e/paseo4herdr-input.ts" }, true)!;
    expect(foreign).toContain("/e/paseo4herdr-input.ts");
    expect(foreign).toContain(`${script} --force`);
    expect(companionBanner({ state: "unknown" }, true)).toContain("Couldn't check");
  });
  it("explains the two-companion outdated case that points at the legacy file", () => {
    const text = companionBanner({ state: "outdated", path: "/e/paseo-herdr-input.ts" }, true)!;
    expect(text).toContain("old OMP input companion paseo-herdr-input.ts (/e/paseo-herdr-input.ts)");
    expect(text).toContain("paseo4herdr-input.ts");
    expect(text).toContain("paseo plugin update herdr-harness");
    expect(text).not.toContain("is outdated");
  });
});
