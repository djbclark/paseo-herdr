import { describe, expect, it } from "vitest";
import { archiveDuplicatesLabel, companionBanner, duplicateArchiveSkippedMessage, duplicateChatsToArchive, freshDuplicatesToArchive, folderFieldValue, needsHomeExpansion, agentLabel, describeTarget, pathTail, statusLabel, statusTone, validateFolder } from "../client/helpers.js";

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
  describe("fresh duplicate re-check before archiving", () => {
    interface Row { terminalId: string; paneId: string; paseoAgentId: string | null; duplicateChatIds: string[] }
    const row = (over: Partial<Row> = {}): Row =>
      ({ terminalId: "t1", paneId: "p1", paseoAgentId: "owner", duplicateChatIds: ["dupA", "dupB"], ...over });
    const overview = (...agents: Row[]) => [{ tabs: [{ agents: [row({ terminalId: "other", paneId: "px", duplicateChatIds: ["dupA"] })] }, { agents }] }];
    it("archives every shown duplicate when the fresh row is unchanged", () => {
      expect(freshDuplicatesToArchive(row(), overview(row()))).toEqual({ skip: null, archive: ["dupA", "dupB"] });
    });
    it("archives nothing when the owner changed, even if the shown ids are still listed or one is the new owner", () => {
      expect(freshDuplicatesToArchive(row(), overview(row({ paseoAgentId: "dupB", duplicateChatIds: ["owner", "dupA"] })))).toEqual({ skip: "owner-changed", archive: [] });
      expect(freshDuplicatesToArchive(row(), overview(row({ paseoAgentId: null })))).toEqual({ skip: "owner-changed", archive: [] });
    });
    it("skips a duplicate that is no longer listed and never adds one the user wasn't shown", () => {
      expect(freshDuplicatesToArchive(row(), overview(row({ duplicateChatIds: ["dupB", "dupNew"] })))).toEqual({ skip: null, archive: ["dupB"] });
    });
    it("archives nothing when no shown duplicate is left", () => {
      expect(freshDuplicatesToArchive(row(), overview(row({ duplicateChatIds: [] })))).toEqual({ skip: "none-left", archive: [] });
      expect(freshDuplicatesToArchive(row(), overview(row({ duplicateChatIds: ["dupNew"] })))).toEqual({ skip: "none-left", archive: [] });
    });
    it("archives nothing when the agent row is gone or the pane is not the same one", () => {
      expect(freshDuplicatesToArchive(row(), [])).toEqual({ skip: "agent-gone", archive: [] });
      expect(freshDuplicatesToArchive(row(), overview(row({ terminalId: "t2" })))).toEqual({ skip: "agent-gone", archive: [] });
      expect(freshDuplicatesToArchive(row(), overview(row({ paneId: "p2" })))).toEqual({ skip: "agent-gone", archive: [] });
    });
    it("finds the row in any workspace and tab, and never uses another agent's duplicates", () => {
      const workspaces = [{ tabs: [{ agents: [row({ terminalId: "t0", paneId: "p0", duplicateChatIds: ["dupA", "dupB"] })] }] }, { tabs: [{ agents: [] }, { agents: [row({ duplicateChatIds: ["dupB"] })] }] }];
      expect(freshDuplicatesToArchive(row(), workspaces)).toEqual({ skip: null, archive: ["dupB"] });
    });
    it("words each reason to skip", () => {
      expect(duplicateArchiveSkippedMessage("owner-changed")).toContain("chat changed");
      expect(duplicateArchiveSkippedMessage("agent-gone")).toContain("no longer listed");
      expect(duplicateArchiveSkippedMessage("none-left")).toContain("already gone");
    });
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
