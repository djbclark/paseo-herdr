import { describe, expect, it, vi } from "vitest";
import { bindHerdrChat, createHerdrChat } from "../client/actions.js";
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
  it("resolves a ~ folder through the daemon and passes the absolute path to workspaces.open", async () => {
    const open = vi.fn(async () => ({ agents: { create: async () => ({ id: "chat-2" }) } }));
    const resolve = vi.fn(async () => "/home/me/proj");
    expect(await createHerdrChat({ workspaces: { open } } as never, " ~/proj ", resolve)).toBe("chat-2");
    expect(resolve).toHaveBeenCalledWith("~/proj");
    expect(open).toHaveBeenCalledExactlyOnceWith("/home/me/proj");
    await expect(createHerdrChat({ workspaces: { open } } as never, "~/x", async () => null)).rejects.toThrow("absolute");
    expect(open).toHaveBeenCalledTimes(1);
  });
  it("refuses an empty folder before opening a workspace and propagates a folder failure", async () => {
    const open = vi.fn(async () => { throw new Error("Folder unavailable"); });
    const paseo = { workspaces: { open } } as never;
    await expect(createHerdrChat(paseo, "  ")).rejects.toThrow("Enter a folder path");
    expect(open).not.toHaveBeenCalled();
    await expect(createHerdrChat(paseo, "/gone")).rejects.toThrow("Folder unavailable");
  });
});

describe("bindHerdrChat", () => {
  const agent = { terminalId: "term-1", paneId: "w1:p2", provider: "herdr-omp", cwd: "/repo" };
  it("creates a chat bound to the running agent in its folder's workspace, then asks for its history", async () => {
    const createAgent = vi.fn(async () => ({ id: "chat-2" }));
    const openProject = vi.fn(async () => ({ workspace: { id: "folder-workspace", workspaceDirectory: "/repo" } }));
    const ready = vi.fn(async () => ({ flushed: 1 }));
    const paseo = createPaseoApi({ openProject, createAgent } as never);
    try {
      expect(await bindHerdrChat(paseo, ready, agent, "Fix tests")).toBe("chat-2");
      expect(createAgent).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
        workspaceId: "folder-workspace",
        config: expect.objectContaining({ provider: "herdr-omp", model: "native-default", cwd: "/repo", title: "Fix tests",
          providerOptions: { herdrBind: { terminalId: "term-1", paneId: "w1:p2" } } }),
      }));
      expect(ready).toHaveBeenCalledExactlyOnceWith({ terminalId: "term-1" });
      expect(ready.mock.invocationCallOrder[0]).toBeGreaterThan(createAgent.mock.invocationCallOrder[0]);
    } finally { await paseo.dispose(); }
  });

  it("still opens the chat when the history request fails, and refuses an agent without a provider", async () => {
    const paseo = createPaseoApi({
      openProject: async () => ({ workspace: { id: "w", workspaceDirectory: "/repo" } }),
      createAgent: async () => ({ id: "chat-3" }),
    } as never);
    try {
      expect(await bindHerdrChat(paseo, async () => { throw new Error("offline"); }, agent, "x")).toBe("chat-3");
      await expect(bindHerdrChat(paseo, async () => ({}), { ...agent, provider: null }, "x")).rejects.toThrow(/can't be opened/);
    } finally { await paseo.dispose(); }
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
