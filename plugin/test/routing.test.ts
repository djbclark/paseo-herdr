import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createHerdrProvider } from "../server/provider.js";
import { registerManagementRpcs } from "../server/rpc.js";
import { createResolver } from "../server/harness/resolve.js";
import { ompAdapter } from "../server/harness/omp/adapter.js";
import { makeFakeAdapter } from "./fake-harness.js";
import { FakeHerdr } from "./fake-herdr.js";
import { HERDR_BIND_OPTION } from "../shared/model.js";
import { herdrOverviewRpc, type HerdrTarget } from "../shared/rpc.js";
import { ProviderEventSchema, type ProviderConnection, type ProviderEvent, type ProviderSessionConfig } from "@getpaseo/plugin/server/provider";

/**
 * F3 routing with two providers over one FakeHerdr: a specific adapter claiming kind "fake"
 * and a fallback ("any") adapter that cannot launch and needs no Herdr integration.
 */
const config: ProviderSessionConfig = { cwd: "/work", env: {}, mcpServers: {}, settings: {}, persist: true };

const paneAgent = (terminalId: string, paneId: string, kind: string | null, agentSession: { kind: "id"; value: string } | null) => ({
  terminal_id: terminalId, pane_id: paneId, agent: kind, name: null, cwd: "/work",
  agent_status: "idle" as const, screen_detection_skipped: false, state_labels: {}, tokens: {},
  ...(agentSession ? { agent_session: { source: `herdr:${kind}`, agent: kind ?? "", ...agentSession } } : { agent_session: null }),
  workspace_id: "w1", tab_id: "tab1", focused: false, launch_pending: false, interactive_ready: true,
  state_change_seq: 0, completion_seq: null, revision: 0,
});

let fake: FakeHerdr;
const connections: ProviderConnection[] = [];
beforeEach(async () => {
  fake = await FakeHerdr.create();
  const agents = [
    paneAgent("term-fake", "pane-fake", "fake", { kind: "id", value: "fake-session-1" }),
    paneAgent("term-other", "pane-other", "other", { kind: "id", value: "other-session-1" }),
    paneAgent("term-null", "pane-null", null, null),
  ];
  fake.reply("ping", { type: "pong", version: "0.9.3", protocol: 22 });
  fake.reply("agent.list", { type: "agent_list", agents });
  fake.reply("integration.list", { type: "integration_list", integrations: [{ target: "fake", label: "Fake", command: "fake", available: true, state: "current" }] });
  fake.handle("pane.process_info", (request, stream) => {
    const paneId = (request.params as { pane_id?: string }).pane_id ?? "pane-fake";
    stream.end(JSON.stringify({ id: request.id, result: { type: "pane_process_info", process_info: {
      pane_id: paneId, foreground_process_group_id: 77, tty: "/dev/pts/fake", foreground_processes: [{ pid: 77, name: "fake" }] } } }) + "\n");
  });
});
afterEach(async () => {
  for (const connection of connections.splice(0)) await connection.close();
  await fake.close();
});

const specific = makeFakeAdapter(undefined, { id: "fake", nativeKinds: ["fake"] });
const generic: typeof specific = makeFakeAdapter(undefined, { id: "generic", nativeKinds: "any", launch: null, herdrIntegration: null });
const resolver = createResolver([specific, generic]);

async function connect(adapter: typeof specific): Promise<{ connection: ProviderConnection; events: ProviderEvent[] }> {
  const provider = createHerdrProvider(adapter, async () => fake.socketPath, { resolver });
  const connection = await provider.connect({ versions: [1], capabilities: ["session.list", "session.persistence", "prompt.message"] });
  connections.push(connection);
  const events: ProviderEvent[] = [];
  connection.onEvent((event) => events.push(ProviderEventSchema.parse(event)));
  return { connection, events };
}

const sessionList = async (events: ProviderEvent[], requestId: string): Promise<string[]> => {
  await vi.waitFor(() => expect(events.some((event) => event.type === "sessions" && event.requestId === requestId)).toBe(true));
  const listing = events.find((event) => event.type === "sessions" && event.requestId === requestId);
  if (!listing || listing.type !== "sessions") throw new Error(`Missing session list ${requestId}`);
  return listing.sessions.map((summary) => (summary.persistence.data as { terminalId: string }).terminalId);
};

it("two providers list disjoint panes: the specific kind beats the fallback for new work", async () => {
  const specificSide = await connect(specific);
  const genericSide = await connect(generic);
  await specificSide.connection.send({ type: "sessions", requestId: "specific" });
  await genericSide.connection.send({ type: "sessions", requestId: "generic" });
  const specificTerminals = await sessionList(specificSide.events, "specific");
  const genericTerminals = await sessionList(genericSide.events, "generic");
  expect(specificTerminals).toEqual(["term-fake"]);
  expect(genericTerminals).toEqual(["term-other", "term-null"]);
  expect(specificTerminals.filter((terminalId) => genericTerminals.includes(terminalId))).toEqual([]);
});

it("herdrBind of a specifically-claimed pane through the fallback provider is rejected", async () => {
  const { connection, events } = await connect(generic);
  await connection.send({ type: "session.open", requestId: "bind", sessionId: "s1", history: "skip",
    config: { ...config, providerOptions: { [HERDR_BIND_OPTION]: { terminalId: "term-fake" } } } });
  await vi.waitFor(() => expect(events.some((event) => event.type === "request.failed" && event.requestId === "bind")).toBe(true));
  expect(events.find((event) => event.type === "request.failed" && event.requestId === "bind")).toMatchObject({
    error: { message: "The Herdr agent in terminal term-fake is not a Fake agent" },
  });
});

it("a provider whose adapter has no launch spec refuses to create, with no Herdr I/O", async () => {
  const { connection, events } = await connect(generic);
  await connection.send({ type: "session.open", requestId: "create", sessionId: "s1", config, history: "replay" });
  await vi.waitFor(() => expect(events.some((event) => event.type === "request.failed" && event.requestId === "create")).toBe(true));
  expect(events.find((event) => event.type === "request.failed" && event.requestId === "create")).toMatchObject({
    error: { message: expect.stringMatching(/Fake agents can't be started from Paseo/) },
  });
  expect(fake.requestsFor("agent.start")).toHaveLength(0);
  expect(fake.requestsFor("workspace.create")).toHaveLength(0);
  expect(fake.requestsFor("pane.process_info")).toHaveLength(0);
});

it("status() checks the integration only for adapters that require one", async () => {
  const providerGeneric = createHerdrProvider(generic, async () => fake.socketPath, { resolver });
  expect(await providerGeneric.status?.({})).toEqual({ available: true });
  expect(fake.requestsFor("integration.list")).toHaveLength(0);
  const providerSpecific = createHerdrProvider(specific, async () => fake.socketPath, { resolver });
  expect(await providerSpecific.status?.({})).toEqual({ available: true });
  expect(fake.requestsFor("integration.list")).toHaveLength(1);
});

it("enableOmp=false hides only herdr-omp from the overview", async () => {
  fake.reply("workspace.list", { type: "workspace_list", workspaces: [{ workspace_id: "w1", number: 1, label: "proj", focused: true, pane_count: 1, tab_count: 1, active_tab_id: "tab1", agent_status: "idle" }] });
  fake.reply("tab.list", { type: "tab_list", tabs: [{ tab_id: "tab1", workspace_id: "w1", number: 1, label: "one", focused: false, pane_count: 1, agent_status: "idle" }] });
  fake.reply("pane.list", { type: "pane_list", panes: [] });
  fake.reply("agent.list", { type: "agent_list", agents: [paneAgent("term-omp", "pane-omp", "omp", null), paneAgent("term-fk", "pane-fk", "fakekind", null)] });
  const fakeKind = makeFakeAdapter(undefined, { id: "fakekind", nativeKinds: ["fakekind"] });
  const handlers = new Map<string, (input: any, ctx: any) => Promise<any>>();
  const target: HerdrTarget = { socketPath: fake.socketPath, herdrSession: null, source: "default", autoStart: false, autoStartDisabledReason: null };
  registerManagementRpcs({ handle: ((contract: { name: string }, handler: (input: any, ctx: any) => Promise<any>) => { handlers.set(contract.name, handler); }) as never }, {
    readTarget: async () => ({ target, ompEnabled: false, enabled: (adapterId: string) => adapterId !== "omp" }),
    ensureReady: async (t) => ({ target: t, version: "0.9.3", autoStarted: false }),
    harnesses: [ompAdapter, fakeKind],
    resolver: createResolver([ompAdapter, fakeKind]),
    env: { PATH: "/nonexistent" },
    findHerdr: async () => null,
  });
  const result = await handlers.get(herdrOverviewRpc.name)!({}, { paseo: { agents: { list: async () => ({ entries: [], pageInfo: { hasMore: false, nextCursor: null, prevCursor: null } }) } } });
  expect(result.ompEnabled).toBe(false);
  const [ompRow, fakeKindRow] = result.workspaces[0].tabs[0].agents;
  expect(ompRow).toMatchObject({ kind: "omp", harness: null, provider: null, canRestart: false, duplicateChatIds: [] });
  expect(fakeKindRow).toMatchObject({ kind: "fakekind", harness: "Fake", provider: "herdr-fakekind" });
  // A hidden adapter's row is not probed for its input endpoint either.
  expect(fake.requestsFor("pane.process_info")).toHaveLength(0);
});
