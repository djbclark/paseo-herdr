import { describe, expect, it, vi } from "vitest";
import { createHerdrChat } from "../client/actions.js";
import { registerHerdrHome } from "../client/home.js";
import { createPaseoApi } from "@getpaseo/client";

describe("createHerdrChat", () => {
  it("creates in the folder's existing workspace without a second agent launch", async () => {
    // Exercise the real SDK: mocking workspace.agents.create hid its provider/model validation.
    const createAgent = vi.fn(async () => ({ id: "chat-1" }));
    const openProject = vi.fn(async () => ({ workspace: { id: "folder-workspace", workspaceDirectory: "/repo" } }));
    const paseo = createPaseoApi({ openProject, createAgent } as never);
    try {
      expect(await createHerdrChat(paseo, " /repo ")).toBe("chat-1");
      expect(openProject).toHaveBeenCalledExactlyOnceWith("/repo", undefined);
      expect(createAgent).toHaveBeenCalledExactlyOnceWith({
        workspaceId: "folder-workspace",
        config: { provider: "herdr-omp", model: "native-default", cwd: "/repo" },
      });
    } finally { await paseo.dispose(); }
  });
  it("refuses an empty folder before opening a workspace and propagates a folder failure", async () => {
    const open = vi.fn(async () => { throw new Error("Folder unavailable"); });
    const paseo = { workspaces: { open } } as never;
    await expect(createHerdrChat(paseo, "  ")).rejects.toThrow("Enter a folder path");
    expect(open).not.toHaveBeenCalled();
    await expect(createHerdrChat(paseo, "/gone")).rejects.toThrow("Folder unavailable");
  });
});

function home() {
  let observer: { snapshot(input: any): void; update(input: any): void };
  const subscribe = vi.fn((value: typeof observer) => { observer = value; });
  const list = vi.fn(async (_options: unknown) => ({ subscription: { subscribe } }));
  const buttons: { remove: ReturnType<typeof vi.fn>; input: any }[] = [];
  const addComposerPill = vi.fn((input: any) => {
    const remove = vi.fn();
    buttons.push({ input, remove });
    return { update: vi.fn(), remove };
  });
  const openScreen = vi.fn();
  const cleanup = registerHerdrHome({ paseo: { agents: { list } }, addComposerPill, openScreen } as never);
  return { list, subscribe, buttons, addComposerPill, openScreen, cleanup,
    snapshot: (agents: object[], pageInfo = { hasMore: false, nextCursor: null as string | null }) => observer.snapshot({ entries: agents.map((agent) => ({ agent })), pageInfo }),
    update: (payload: object) => observer.update({ type: "agent_update", payload }),
  };
}
const agent = (id: string, extra: object = {}) => ({ id, provider: "herdr-omp", workspaceId: "w1", archivedAt: null, ...extra });

describe("Herdr home buttons", () => {
  it("only adds buttons to Herdr chats and opens the global home", async () => {
    const h = home();
    await vi.waitFor(() => expect(h.subscribe).toHaveBeenCalledOnce());
    h.snapshot([agent("a"), agent("b", { provider: "codex" }), agent("c", { archivedAt: "today" }), agent("d", { workspaceId: null })]);
    expect(h.addComposerPill).toHaveBeenCalledOnce();
    expect(h.buttons[0].input).toMatchObject({ agentId: "a", workspaceId: "w1" });
    h.buttons[0].input.button.behavior.onPress();
    expect(h.openScreen).toHaveBeenCalledExactlyOnceWith({ screenId: "herdr-overview" });
    h.cleanup();
  });
  it("handles moves, archive, deletion, reconnect and cleanup without duplicate registrations", async () => {
    const h = home();
    await vi.waitFor(() => expect(h.subscribe).toHaveBeenCalledOnce());
    h.snapshot([agent("a")]);
    h.update({ kind: "upsert", agent: agent("a") });
    expect(h.addComposerPill).toHaveBeenCalledTimes(1);
    h.update({ kind: "upsert", agent: agent("a", { workspaceId: "w2" }) });
    expect(h.buttons[0].remove).toHaveBeenCalledOnce();
    expect(h.buttons[1].input.workspaceId).toBe("w2");
    h.snapshot([agent("b")]);
    expect(h.buttons[1].remove).toHaveBeenCalledOnce();
    h.update({ kind: "remove", agentId: "b" });
    expect(h.buttons[2].remove).toHaveBeenCalledOnce();
    h.update({ kind: "upsert", agent: agent("c") });
    h.update({ kind: "upsert", agent: agent("c", { archivedAt: "today" }) });
    expect(h.buttons[3].remove).toHaveBeenCalledOnce();
    h.update({ kind: "upsert", agent: agent("d") });
    h.cleanup();
    expect((h.list.mock.calls[0][0] as { signal: AbortSignal }).signal.aborted).toBe(true);
    expect(h.buttons[4].remove).toHaveBeenCalledOnce();
    h.update({ kind: "upsert", agent: agent("e") });
    expect(h.addComposerPill).toHaveBeenCalledTimes(5);
    h.cleanup();
    expect(h.buttons[4].remove).toHaveBeenCalledOnce();
  });
  it("does not register a late subscription after cleanup", async () => {
    const h = home();
    h.cleanup();
    await Promise.resolve();
    expect(h.subscribe).not.toHaveBeenCalled();
  });
  it("includes older pages while respecting a newer archive update", async () => {
    const h = home();
    await vi.waitFor(() => expect(h.subscribe).toHaveBeenCalledOnce());
    h.list.mockResolvedValueOnce({ entries: [{ agent: agent("older") }, { agent: agent("archived") }], pageInfo: { hasMore: false, nextCursor: null } } as never);
    h.snapshot([agent("a")], { hasMore: true, nextCursor: "page-2" });
    h.update({ kind: "upsert", agent: agent("archived", { archivedAt: "today" }) });
    await vi.waitFor(() => expect(h.addComposerPill).toHaveBeenCalledTimes(2));
    expect(h.buttons.map((b) => b.input.agentId)).toEqual(["a", "older"]);
    h.cleanup();
  });
});
