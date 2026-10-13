import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { boundAgents, decodePluginPersistence, herdrChats, recentChats, registerManagementRpcs, type HerdrChat, type ManagementDeps } from "../server/rpc.js";
import { persistenceOf } from "../server/binding.js";
import { ompAdapter } from "../server/harness/omp/adapter.js";
import { herdrOverviewRpc, herdrTargetRpc, herdrWorkspaceCreateRpc, type HerdrTarget } from "../shared/rpc.js";
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

it("boundAgents skips archived, foreign providers, bad persistence; follows pages; reads sessionId fallback", async () => {
  const p = persistenceOf({ harness: "omp", herdrSession: null, terminalId: "tx", agentName: null, sessionRef: null, cwd: "", submittedMessages: {} });
  const result = await boundAgents(list([], [
    [paseoAgent("a", "herdr-omp", "t1", "work", { archivedAt: "2026-01-01" }), paseoAgent("b", "claude", "t2", "work"), { id: "c", provider: "herdr-omp", persistence: { provider: "herdr-omp", sessionId: "junk" } }],
    [{ id: "d", provider: "herdr-omp", archivedAt: null, persistence: { provider: "herdr-omp", sessionId: `plugin:${JSON.stringify(p)}` } }],
  ]) as never, [ompAdapter]);
  expect([...result]).toEqual([["\0tx", "d"]]);
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

const chat = (agentId: string, terminalId: string, lastActivityAt: string, herdrSession: string | null = "work"): HerdrChat => ({
  agentId, terminalId, herdrSession, harness: "OMP", harnessId: "omp", sessionRef: null, title: `π > ${agentId}`, cwd: "/a", status: "idle", lastActivityAt, attention: null });

it("lists recent chats newest first and links each to its live pane on the current target", () => {
  const live = [agent("p1", "tab1", "omp", null)];
  const result = recentChats([
    chat("old", "t-p1", "2026-10-12T10:00:00Z"),
    chat("new", "t-gone", "2026-10-13T10:00:00Z"),
    chat("elsewhere", "t-p1", "2026-10-11T10:00:00Z", null),
  ], live as never, target("/s"));
  expect(result.map((c) => c.paseoAgentId)).toEqual(["new", "old", "elsewhere"]);
  expect(result[0].pane).toBeNull();
  expect(result[1].pane).toEqual({ paneId: "p1", status: "working" });
  // Same terminal id in another Herdr session is a different agent.
  expect(result[2]).toMatchObject({ pane: null, herdrSession: null });
});

it("keeps at most 20 recent chats", () => {
  const many = Array.from({ length: 25 }, (_, i) => chat(`c${i}`, `t${i}`, `2026-10-13T10:${String(i).padStart(2, "0")}:00Z`));
  expect(recentChats(many, [], target("/s"))).toHaveLength(20);
});

it("still lists chats when Herdr is unavailable", async () => {
  const { call } = setup({ ensureReady: async () => { throw new Error("Herdr is not running"); } });
  const result = await call(herdrOverviewRpc, {}, list([paseoAgent("pa1", "herdr-omp", "t-p1", "work", { cwd: "/a", status: "idle", updatedAt: "2026-10-13T10:00:00Z", lastUserMessageAt: null, title: "Fix tests" })]));
  expect(result.connection.status).toBe("unavailable");
  expect(result.chats).toEqual([expect.objectContaining({ paseoAgentId: "pa1", title: "Fix tests", pane: null, harness: "OMP" })]);
  expect(herdrOverviewRpc.output.parse(result).chatError).toBeNull();
});

it("keeps recent chats if Herdr disconnects after readiness", async () => {
  seed();
  fake.replyError("agent.list", "unavailable", "Herdr disconnected");
  const { call } = setup();
  const result = await call(herdrOverviewRpc, {}, list([paseoAgent("pa1", "herdr-omp", "t-p1", "work")]));
  expect(result.connection).toEqual({ status: "unavailable", error: "Herdr disconnected" });
  expect(result.workspaces).toEqual([]);
  expect(result.chats[0]).toMatchObject({ paseoAgentId: "pa1", pane: null });
  expect(herdrOverviewRpc.output.safeParse(result).success).toBe(true);
});

it("does not associate an older conversation with a pane after /new or a harness change", () => {
  const ref = { kind: "path" as const, value: "/sessions/new.jsonl" };
  const current = { ...agent("p1", "tab1", "omp", null), agent_session: ref };
  const chats = [
    { ...chat("old", "t-p1", "2026-10-12T10:00:00Z"), sessionRef: { ...ref, value: "/sessions/old.jsonl" } },
    { ...chat("new", "t-p1", "2026-10-13T10:00:00Z"), sessionRef: ref },
  ];
  expect(recentChats(chats, [current] as never, target("/s")).map((c) => c.pane?.paneId ?? null)).toEqual(["p1", null]);
  expect(recentChats(chats, [{ ...current, agent: "claude" }] as never, target("/s")).every((c) => c.pane === null)).toBe(true);
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
  expect(recentChats([chat("a", "t1", "2026-10-13T11:00:00+02:00"), chat("b", "t2", "2026-10-13T10:00:00Z")], [], target("/s"))[0].paseoAgentId).toBe("b");
});
