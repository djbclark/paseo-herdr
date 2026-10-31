import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { decodePluginPersistence, herdrChats, registerManagementRpcs, type ManagementDeps } from "../server/rpc.js";
import { persistenceOf } from "../server/binding.js";
import { createResolver } from "../server/harness/resolve.js";
import { ompAdapter } from "../server/harness/omp/adapter.js";
import { makeFakeAdapter } from "./fake-harness.js";
import { herdrAgentRestartRpc, herdrDiagnosticsRpc, herdrOverviewRpc, herdrTargetRpc, herdrWorkspaceCreateRpc, type HerdrTarget } from "../shared/rpc.js";
import { FakeHerdr } from "./fake-herdr.js";
import { HerdrClient } from "../server/herdr/client.js";

let fake: FakeHerdr;
let dir: string;
beforeEach(async () => { fake = await FakeHerdr.create(); dir = await mkdtemp(join(tmpdir(), "rpc-test-")); });
afterEach(async () => { await fake.close(); await rm(dir, { recursive: true, force: true }); });

const target = (socketPath: string, herdrSession: string | null = "work"): HerdrTarget => ({ socketPath, herdrSession, source: "settingSession", autoStart: false, autoStartDisabledReason: null });

type Handler = (input: any, ctx: any) => Promise<any> | any;
function setup(overrides: Partial<ManagementDeps> = {}) {
  const handlers = new Map<string, Handler>();
  const t = target(fake.socketPath);
  registerManagementRpcs({ handle: ((contract: { name: string }, handler: Handler) => { handlers.set(contract.name, handler); }) as never }, {
    readTarget: async () => ({ target: t, ompEnabled: true }),
    ensureReady: async (x) => ({ target: x, version: "0.9.3", autoStarted: false }),
    harnesses: [ompAdapter],
    companionStatus: async () => ({ state: "current", path: "/fake/ext/paseo4herdr-input.ts" }),
    ...overrides,
  });
  return { t, call: (rpc: { name: string }, input: unknown, paseo: unknown = {}) => handlers.get(rpc.name)!(input, { paseo }) };
}

const pane = (id: string, tab: string, cwd: string) => ({ pane_id: id, terminal_id: `t-${id}`, workspace_id: "w1", tab_id: tab, focused: false, cwd, agent_status: "idle", revision: 1 });
const agent = (id: string, tab: string, kind: string | null, name: string | null) => ({ terminal_id: `t-${id}`, name, agent: kind, agent_status: "working", workspace_id: "w1", tab_id: tab, pane_id: id, focused: false, cwd: "/a", revision: 1 });

function seed() {
  fake.reply("workspace.list", { type: "workspace_list", workspaces: [{ workspace_id: "w1", number: 1, label: "proj", focused: true, pane_count: 3, tab_count: 2, active_tab_id: "tab1", agent_status: "working" }] });
  fake.reply("tab.list", { type: "tab_list", tabs: [
    { tab_id: "tab2", workspace_id: "w1", number: 2, label: "two", focused: false, pane_count: 1, agent_status: "idle" },
    { tab_id: "tab1", workspace_id: "w1", number: 1, label: "one", focused: true, pane_count: 2, agent_status: "working" },
  ] });
  fake.reply("pane.list", { type: "pane_list", panes: [pane("p2", "tab2", "/second"), pane("p1", "tab1", "/first")] });
  fake.reply("agent.list", { type: "agent_list", agents: [agent("p1", "tab1", "omp", "paseo-abc"), agent("p2", "tab2", "claude", null)] });
}

const paseoAgent = (id: string, provider: string, terminalId: string, herdrSession: string | null, extra: object = {}) => ({
  id, provider, archivedAt: null,
  title: id, cwd: "/a", status: "idle", updatedAt: "2026-10-13T10:00:00Z", lastUserMessageAt: null,
  persistence: { provider, sessionId: "x", metadata: { pluginProviderPersistence: persistenceOf({ harness: "omp", herdrSession, terminalId, agentName: null, sessionRef: null, cwd: "/a", submittedMessages: {} }) } },
  ...extra,
});
const list = (entries: unknown[], pages?: unknown[][]) => {
  const all = pages ?? [entries];
  let i = 0;
  return { agents: { list: async () => { const e = all[i++]; return { entries: e.map((agent) => ({ agent })), pageInfo: { hasMore: i < all.length, nextCursor: i < all.length ? `c${i}` : null, prevCursor: null } }; } } };
};

it("herdr.target returns readTarget", async () => {
  const { call, t } = setup();
  expect(await call(herdrTargetRpc, {})).toEqual({ target: t, ompEnabled: true });
});

it("overview builds workspaces/tabs/agents with provider, cwd and paseo binding", async () => {
  seed();
  const { call } = setup();
  const result = await call(herdrOverviewRpc, {}, list([
    paseoAgent("pa1", "herdr-omp", "t-p1", "work"),
    paseoAgent("pa2", "herdr-omp", "t-p2", "other"),
  ]));
  expect(result.connection).toEqual({ status: "connected", version: "0.9.3", autoStarted: false });
  const [ws] = result.workspaces;
  expect(ws.cwd).toBe("/first");
  expect(ws.tabs.map((x: any) => x.tabId)).toEqual(["tab1", "tab2"]);
  const [a1] = ws.tabs[0].agents;
  expect(a1).toMatchObject({ terminalId: "t-p1", name: "paseo-abc", kind: "omp", provider: "herdr-omp", paseoAgentId: "pa1", status: "working" });
  expect(a1.attachCommand).toContain("agent attach");
  expect(a1.attachCommand).toContain("paseo-abc");
  expect(ws.tabs[1].agents[0]).toMatchObject({ kind: "claude", provider: null, paseoAgentId: null });
});

it("overview survives paseo.agents.list failure", async () => {
  seed();
  const { call } = setup();
  const result = await call(herdrOverviewRpc, {}, { agents: { list: async () => { throw new Error("boom"); } } });
  expect(result.workspaces[0].tabs[0].agents[0].paseoAgentId).toBeNull();
  expect(result.chatError).toBe("boom");
});

it("overview reports unavailable instead of throwing", async () => {
  const { call } = setup({ ensureReady: async () => { throw new Error("Herdr is not running"); } });
  const result = await call(herdrOverviewRpc, {});
  expect(result.connection).toEqual({ status: "unavailable", error: "Herdr is not running" });
  expect(result.workspaces).toEqual([]);
  expect(fake.requests).toHaveLength(0);
});

it("herdrChats skips archived, foreign providers, bad persistence; follows pages; reads sessionId fallback", async () => {
  const p = persistenceOf({ harness: "omp", herdrSession: null, terminalId: "tx", agentName: null, sessionRef: null, cwd: "", submittedMessages: {} });
  const chats = await herdrChats(list([], [
    [paseoAgent("a", "herdr-omp", "t1", "work", { archivedAt: "2026-01-01" }), paseoAgent("b", "claude", "t2", "work"), { id: "c", provider: "herdr-omp", persistence: { provider: "herdr-omp", sessionId: "junk" } }],
    [{ id: "d", provider: "herdr-omp", archivedAt: null, persistence: { provider: "herdr-omp", sessionId: `plugin:${JSON.stringify(p)}` } }],
  ]) as never, [ompAdapter]);
  expect(chats.map((chat) => [chat.agentId, chat.terminalId, chat.harnessId])).toEqual([["d", "tx", "omp"]]);
});

it("decodePluginPersistence handles metadata, sessionId and garbage", () => {
  const p = { version: 1, data: { a: 1 } };
  expect(decodePluginPersistence({ sessionId: "s", metadata: { pluginProviderPersistence: p } })).toEqual(p);
  expect(decodePluginPersistence({ sessionId: `plugin:${JSON.stringify(p)}` })).toEqual(p);
  expect(decodePluginPersistence({ sessionId: "plugin:{bad" })).toBeNull();
  expect(decodePluginPersistence({ sessionId: "nope" })).toBeNull();
  expect(decodePluginPersistence(null)).toBeNull();
});

it("workspace.create validates the path and creates once", async () => {
  fake.handle("workspace.create", (req, s) => s.end(JSON.stringify({ id: req.id, result: { type: "workspace_created", workspace: { workspace_id: "w9" }, tab: { tab_id: "t9" }, root_pane: { pane_id: "p", terminal_id: "tt", workspace_id: "w9", tab_id: "t9" } } }) + "\n"));
  const { call } = setup();
  await expect(call(herdrWorkspaceCreateRpc, { cwd: "relative" })).rejects.toThrow(/absolute/);
  await expect(call(herdrWorkspaceCreateRpc, { cwd: join(dir, "missing") })).rejects.toThrow(/existing folder/);
  await writeFile(join(dir, "file"), "x");
  await expect(call(herdrWorkspaceCreateRpc, { cwd: join(dir, "file") })).rejects.toThrow(/existing folder/);
  expect(fake.requestsFor("workspace.create")).toHaveLength(0);
  await mkdir(join(dir, "proj"));
  const out = await call(herdrWorkspaceCreateRpc, { cwd: join(dir, "proj") });
  expect(out).toMatchObject({ workspaceId: "w9", label: "proj" });
  const [req] = fake.requestsFor("workspace.create");
  expect(req.params).toMatchObject({ label: "proj", focus: false });
  expect(await call(herdrWorkspaceCreateRpc, { cwd: join(dir, "proj"), label: "Custom" })).toMatchObject({ label: "Custom" });
});

it("workspace.create propagates readiness failure and does not retry a Herdr error", async () => {
  const { call } = setup({ ensureReady: async () => { throw new Error("target down"); }, checkDirectory: async (p) => p });
  await expect(call(herdrWorkspaceCreateRpc, { cwd: "/x" })).rejects.toThrow("target down");
  expect(fake.requests).toHaveLength(0);
  fake.replyError("workspace.create", "boom");
  const ok = setup({ checkDirectory: async (p) => p });
  await expect(ok.call(herdrWorkspaceCreateRpc, { cwd: "/x" })).rejects.toThrow();
  expect(fake.requestsFor("workspace.create")).toHaveLength(1);
});

it("overview offers a shell-free attach only when `herdr --session` reaches the target socket", async () => {
  const env = { HOME: "/home/u", XDG_CONFIG_HOME: undefined, PATH: "/bin" };
  const named = "/home/u/.config/herdr/sessions/work/herdr.sock";
  const overview = async (socketPath: string, findHerdr: () => Promise<string | null>) => {
    seed();
    const { call } = setup({ readTarget: async () => ({ target: target(socketPath), ompEnabled: true }), env, findHerdr,
      request: (_socket, method, params) => new HerdrClient(fake.socketPath).request(method, params ?? {}) });
    return (await call(herdrOverviewRpc, {}, list([]))).workspaces[0].tabs[0].agents[0];
  };
  expect((await overview(named, async () => "/usr/bin/herdr")).attach).toEqual({ command: "/usr/bin/herdr", args: ["--session", "work", "agent", "attach", "paseo-abc"] });
  expect((await overview("/tmp/isolated/herdr.sock", async () => "/usr/bin/herdr")).attach).toBeNull();
  expect((await overview(named, async () => null)).attach).toBeNull();
});

it("attaches an unnamed agent by pane id, since herdr agent attach can't resolve terminal ids", async () => {
  seed();
  const { call } = setup({ env: { HOME: "/home/u", PATH: "/bin" }, findHerdr: async () => "/usr/bin/herdr",
    readTarget: async () => ({ target: target("/home/u/.config/herdr/sessions/work/herdr.sock"), ompEnabled: true }),
    request: (_socket, method, params) => new HerdrClient(fake.socketPath).request(method, params ?? {}) });
  const unnamed = (await call(herdrOverviewRpc, {}, list([]))).workspaces[0].tabs[1].agents[0];
  expect(unnamed.attachCommand).toBe("herdr --session work agent attach p2");
  expect(unnamed.attach.args).toEqual(["--session", "work", "agent", "attach", "p2"]);
});

it("reports Herdr unavailable without failing the overview", async () => {
  const { call } = setup({ ensureReady: async () => { throw new Error("Herdr is not running"); } });
  const result = herdrOverviewRpc.output.parse(await call(herdrOverviewRpc, {}, list([paseoAgent("pa1", "herdr-omp", "t-p1", "work")])));
  expect(result).toMatchObject({ connection: { status: "unavailable", error: "Herdr is not running" }, workspaces: [], chatError: null });
});

it("an overview asked not to auto-start hands ensureReady a connect-only target, and a normal one keeps the target's auto-start", async () => {
  seed();
  const seen: boolean[] = [];
  const { call } = setup({
    readTarget: async () => ({ target: { ...target(fake.socketPath), autoStart: true }, ompEnabled: true }),
    ensureReady: async (x) => { seen.push(x.autoStart); return { target: x, version: "0.9.3", autoStarted: false }; },
  });
  await call(herdrOverviewRpc, {}, list([]));
  await call(herdrOverviewRpc, { noAutoStart: true }, list([]));
  expect(seen).toEqual([true, false]);
});

it("parses an overview row and a diagnostics report from a daemon that lacks duplicateChatIds / autoStarted, filling safe defaults", () => {
  const { duplicateChatIds: _dupes, ...oldRow } = {
    terminalId: "t", paneId: "p", name: null, title: null, kind: null, harness: null, provider: null, status: "idle", cwd: null,
    paseoAgentId: "a", duplicateChatIds: ["x"], attachCommand: "herdr", attach: null, inputReady: null, canRestart: false,
  };
  const overview = herdrOverviewRpc.output.parse({
    target: { socketPath: "/s", herdrSession: null, source: "default", autoStart: false, autoStartDisabledReason: null }, ompEnabled: true,
    connection: { status: "connected", version: "0.9.3", autoStarted: false }, chatError: null,
    workspaces: [{ workspaceId: "w", number: 1, label: "w", focused: true, cwd: null, status: "idle", tabs: [{ tabId: "t", number: 1, label: "t", focused: true, status: "idle", agents: [oldRow] }] }],
  });
  expect(overview.workspaces[0]!.tabs[0]!.agents[0]!.duplicateChatIds).toEqual([]);
  const diagnostics = herdrDiagnosticsRpc.output.parse({
    pluginVersion: "1", target: { socketPath: "/s", herdrSession: null, source: "default", autoStart: false }, ompEnabled: true,
    herdr: { connected: true, version: "0.9.3", error: null }, companion: { state: "current" }, agents: [], counts: { agents: 0, inputReady: 0, readOnly: 0, unknown: 0 },
  });
  expect(diagnostics.herdr.autoStarted).toBe(false);
});

it("reports Herdr unavailable if it disconnects after readiness", async () => {
  seed();
  fake.replyError("agent.list", "unavailable", "Herdr disconnected");
  const { call } = setup();
  const result = await call(herdrOverviewRpc, {}, list([]));
  expect(result.connection).toEqual({ status: "unavailable", error: "Herdr disconnected" });
  expect(herdrOverviewRpc.output.safeParse(result).success).toBe(true);
});

it("offers Open chat for the current native conversation when older chats share its terminal", async () => {
  seed();
  const nativeRef = { kind: "path", value: "/sessions/new.jsonl" };
  fake.reply("agent.list", { type: "agent_list", agents: [{ ...agent("p1", "tab1", "omp", null), agent_session: { ...nativeRef, source: "herdr:omp", agent: "omp" } }] });
  const withRef = (id: string, value: string) => paseoAgent(id, "herdr-omp", "t-p1", "work", {
    persistence: { sessionId: "x", metadata: { pluginProviderPersistence: persistenceOf({ harness: "omp", herdrSession: "work", terminalId: "t-p1", agentName: null, cwd: "/a", sessionRef: { kind: "path", value }, submittedMessages: {} }) } },
  });
  const { call } = setup();
  const result = await call(herdrOverviewRpc, {}, list([withRef("current", nativeRef.value), withRef("old", "/sessions/old.jsonl")]));
  expect(result.workspaces[0].tabs[0].agents[0].paseoAgentId).toBe("current");
});

it("counts an arriving reply as recent activity and compares dates across time zones", async () => {
  const chats = await herdrChats(list([paseoAgent("a", "herdr-omp", "t1", "work", {
    lastUserMessageAt: "2026-10-13T09:00:00Z", updatedAt: "2026-10-13T10:00:00Z",
  })]) as never, [ompAdapter]);
  expect(chats[0].lastActivityAt).toBe("2026-10-13T10:00:00Z");
});

it("flags agents without an input endpoint and offers an in-place restart", async () => {
  seed();
  fake.reply("pane.process_info", { type: "pane_process_info", process_info: { pane_id: "p1", foreground_process_group_id: 41, foreground_processes: [{ pid: 41, name: "omp" }] } });
  fake.reply("agent.list", { type: "agent_list", agents: [{ ...agent("p1", "tab1", "omp", null), agent_session: { source: "herdr:omp", agent: "omp", kind: "path", value: "/s.jsonl" } }] });
  const adapter = { ...ompAdapter, inputReachable: async (pid: number) => pid !== 41 };
  const { call } = setup({ harnesses: [adapter] });
  const [row] = (await call(herdrOverviewRpc, {}, list([]))).workspaces[0].tabs[0].agents;
  expect(row).toMatchObject({ inputReady: false, canRestart: true });
});

it("restarts through the injected routine and refuses an agent that is gone", async () => {
  seed();
  const { call } = setup({ restart: async (_deps, adapter) => { expect(adapter.id).toBe("omp"); return { pid: 99 }; } });
  expect(await call(herdrAgentRestartRpc, { terminalId: "t-p1", paneId: "p1" }, list([]))).toEqual({ pid: 99 });
  await expect(call(herdrAgentRestartRpc, { terminalId: "t-gone", paneId: "p9" }, list([]))).rejects.toThrow(/no longer running/);
});

// --- F3 routing + F4 duplicates -----------------------------------------------------------------------------
const chatWith = (id: string, harnessId: string, terminalId: string, extra: object = {}) => ({
  id, provider: `herdr-${harnessId}`, archivedAt: null,
  title: id, cwd: "/a", status: "idle", updatedAt: "2026-10-13T10:00:00Z", lastUserMessageAt: null,
  persistence: { provider: `herdr-${harnessId}`, sessionId: "x", metadata: { pluginProviderPersistence: persistenceOf({ harness: harnessId, herdrSession: "work", terminalId, agentName: null, sessionRef: null, cwd: "/a", submittedMessages: {} }) } },
  ...extra,
});

it("two live chats on one terminal keep the newest as paseoAgentId and report the older as duplicate", async () => {
  seed();
  const { call } = setup();
  const result = await call(herdrOverviewRpc, {}, list([
    chatWith("older", "omp", "t-p1", { updatedAt: "2026-10-13T09:00:00Z" }),
    chatWith("newer", "omp", "t-p1", { updatedAt: "2026-10-13T10:00:00Z" }),
  ]));
  const [row] = result.workspaces[0].tabs[0].agents;
  expect(row.paseoAgentId).toBe("newer");
  expect(row.duplicateChatIds).toEqual(["older"]);
  expect(herdrOverviewRpc.output.safeParse(result).success).toBe(true);
});

it("a saved fallback chat keeps its provider after the pane is detected as a specific kind", async () => {
  seed();
  fake.reply("agent.list", { type: "agent_list", agents: [agent("p1", "tab1", "fake", null)] });
  const generic = makeFakeAdapter(undefined, { id: "generic", nativeKinds: "any" });
  const specific = makeFakeAdapter(undefined, { id: "fake", nativeKinds: ["fake"] });
  const { call } = setup({ harnesses: [generic, specific], resolver: createResolver([generic, specific]) });
  const [row] = (await call(herdrOverviewRpc, {}, list([chatWith("saved", "generic", "t-p1")]))).workspaces[0].tabs[0].agents;
  expect(row.paseoAgentId).toBe("saved");
  expect(row.provider).toBe("herdr-generic");
});

it("a pane-mode chat with a null session ref still counts as live", async () => {
  seed();
  fake.reply("agent.list", { type: "agent_list", agents: [{ ...agent("p1", "tab1", "panefake", null), agent_session: { source: "herdr:panefake", agent: "panefake", kind: "id", value: "s-1" } }] });
  const paneAdapter = makeFakeAdapter(undefined, { id: "panefake", nativeKinds: ["panefake"], binding: "pane" });
  const { call } = setup({ harnesses: [paneAdapter], resolver: createResolver([paneAdapter]) });
  const [row] = (await call(herdrOverviewRpc, {}, list([chatWith("pane-chat", "panefake", "t-p1")]))).workspaces[0].tabs[0].agents;
  expect(row.paseoAgentId).toBe("pane-chat");
});

it("the restart RPC refuses an adapter that cannot launch, before touching the pane", async () => {
  seed();
  const generic = makeFakeAdapter(undefined, { id: "generic", nativeKinds: "any", launch: null });
  const { call } = setup({ harnesses: [generic], resolver: createResolver([generic]) });
  await expect(call(herdrAgentRestartRpc, { terminalId: "t-p1", paneId: "p1" }, list([]))).rejects.toThrow(/can't be restarted from Paseo/);
  expect(fake.requestsFor("agent.start")).toHaveLength(0);
  expect(fake.requestsFor("pane.process_info")).toHaveLength(0);
});

it("the restart RPC refuses a disabled adapter before restarting anything", async () => {
  seed();
  let restarted = false;
  const { call } = setup({
    readTarget: async () => ({ target: target(fake.socketPath), ompEnabled: false, enabled: (adapterId: string) => adapterId !== "omp" }),
    restart: async () => { restarted = true; return { pid: 1 }; },
  });
  await expect(call(herdrAgentRestartRpc, { terminalId: "t-p1", paneId: "p1" }, list([]))).rejects.toThrow(/turned off in the Herdr plugin settings/);
  expect(restarted).toBe(false);
});

it("the restart RPC refuses to guess the owner adapter when the chat list fails", async () => {
  seed();
  let restarted = false;
  const { call } = setup({ restart: async () => { restarted = true; return { pid: 1 }; } });
  const failing = { agents: { list: async () => { throw new Error("paseo offline"); } } };
  await expect(call(herdrAgentRestartRpc, { terminalId: "t-p1", paneId: "p1" }, failing)).rejects.toThrow(/chat list is unavailable \(paseo offline\)/);
  expect(restarted).toBe(false);
});

// --- B6: pane-mode liveness follows the process, not just the terminal ---------------------------------------
const paneChat = (id: string, occupant: { pid: number; tty: string | null } | null, extra: object = {}) => ({
  id, provider: "herdr-panefake", archivedAt: null,
  title: id, cwd: "/a", status: "idle", updatedAt: "2026-10-13T10:00:00Z", lastUserMessageAt: null,
  persistence: { provider: "herdr-panefake", sessionId: "x", metadata: { pluginProviderPersistence: persistenceOf({
    harness: "panefake", herdrSession: "work", terminalId: "t-p1", agentName: null, sessionRef: null, cwd: "/a", submittedMessages: {},
    ...(occupant ? { occupant: { ...occupant, instanceId: "fake-instance" } } : {}),
  }) } },
  ...extra,
});
function paneRow(foreground: { pid: number; tty?: string } | "unreadable") {
  seed();
  fake.reply("agent.list", { type: "agent_list", agents: [agent("p1", "tab1", "panefake", null)] });
  if (foreground === "unreadable") fake.replyError("pane.process_info", "pane_not_found");
  else fake.reply("pane.process_info", { type: "pane_process_info", process_info: { pane_id: "p1", foreground_process_group_id: foreground.pid, tty: foreground.tty ?? "/dev/pts/1", foreground_processes: [{ pid: foreground.pid, name: "panefake" }] } });
  const paneAdapter = makeFakeAdapter(undefined, { id: "panefake", nativeKinds: ["panefake"], binding: "pane" });
  const { call } = setup({ harnesses: [paneAdapter], resolver: createResolver([paneAdapter]) });
  return async (chats: unknown[]) => (await call(herdrOverviewRpc, {}, list(chats))).workspaces[0].tabs[0].agents[0];
}

it("a pane-mode chat whose agent was replaced in the terminal no longer owns the row, nor is reported as a duplicate", async () => {
  const row = await paneRow({ pid: 99 })([
    paneChat("replaced", { pid: 41, tty: "/dev/pts/1" }, { updatedAt: "2026-10-13T11:00:00Z" }),
    paneChat("current", { pid: 99, tty: "/dev/pts/1" }, { updatedAt: "2026-10-13T09:00:00Z" }),
  ]);
  // The newest chat is the frozen one: it must neither win "Open chat" nor push the live chat into duplicates.
  expect(row.paseoAgentId).toBe("current");
  expect(row.duplicateChatIds).toEqual([]);
});

it("a terminal whose pane-mode chats were all replaced offers a fresh bind instead of a frozen chat", async () => {
  const row = await paneRow({ pid: 99 })([paneChat("replaced", { pid: 41, tty: "/dev/pts/1" })]);
  expect(row.paseoAgentId).toBeNull();
  expect(row.provider).toBe("herdr-panefake");
});

it("a pane-mode chat is replaced by a different tty even at the same pid", async () => {
  const row = await paneRow({ pid: 41, tty: "/dev/pts/9" })([paneChat("old", { pid: 41, tty: "/dev/pts/1" })]);
  expect(row.paseoAgentId).toBeNull();
});

it("a pane-mode chat stays live when the process cannot be read", async () => {
  const row = await paneRow("unreadable")([paneChat("bound", { pid: 41, tty: "/dev/pts/1" })]);
  expect(row.paseoAgentId).toBe("bound");
});

it("a pane-mode chat that never bound a process stays live and costs no process read", async () => {
  const row = await paneRow({ pid: 99 })([paneChat("never-validated", null)]);
  expect(row.paseoAgentId).toBe("never-validated");
  expect(fake.requestsFor("pane.process_info")).toHaveLength(0);
});

it("overview reports the companion state, including when the check fails or Herdr is unavailable", async () => {
  seed();
  const states = [
    { state: "missing", path: "/fake/ext/paseo4herdr-input.ts" },
    { state: "outdated", path: "/fake/ext/paseo-herdr-input.ts" },
    { state: "foreign", path: "/fake/ext/paseo4herdr-input.ts" },
  ] as const;
  for (const status of states) {
    const { call } = setup({ companionStatus: async () => status });
    const result = herdrOverviewRpc.output.parse(await call(herdrOverviewRpc, {}, list([])));
    expect(result.companion).toEqual(status);
  }
  const failing = setup({ companionStatus: async () => { throw new Error("EACCES: /secret/dir"); } });
  const broken = herdrOverviewRpc.output.parse(await failing.call(herdrOverviewRpc, {}, list([])));
  expect(broken.companion).toEqual({ state: "unknown" });
  expect(broken.workspaces).toHaveLength(1);
  const offline = setup({ ensureReady: async () => { throw new Error("Herdr is not running"); }, companionStatus: async () => states[0] });
  expect(herdrOverviewRpc.output.parse(await offline.call(herdrOverviewRpc, {}, list([]))).companion).toEqual(states[0]);
});

it("overview schema requires a known companion state when one is sent, and accepts a response from a daemon that sends none", () => {
  const base = { target: target("/s"), ompEnabled: true, connection: { status: "unavailable", error: "x" }, workspaces: [], chatError: null };
  expect(herdrOverviewRpc.output.safeParse({ ...base, companion: { state: "current" } }).success).toBe(true);
  expect(herdrOverviewRpc.output.safeParse({ ...base, companion: { state: "broken" } }).success).toBe(false);
  expect(herdrOverviewRpc.output.safeParse(base).success).toBe(true);
});

it("the server always sends the companion state in the overview", async () => {
  const { call } = setup();
  expect(herdrOverviewRpc.output.parse(await call(herdrOverviewRpc, {}, list([]))).companion).toBeDefined();
});
