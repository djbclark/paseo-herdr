import { setImmediate } from "node:timers/promises";
import { afterEach, expect, it, vi } from "vitest";
import { ProviderEventSchema, type ProviderConnection, type ProviderEvent, type ProviderRegistration, type ProviderSessionConfig } from "@getpaseo/plugin/server/provider";
import { createHerdrProvider, type ProviderHooks } from "../server/provider.js";
import { bindingOf, persistenceOf } from "../server/binding.js";
import { BoundSessions } from "../server/bound-sessions.js";
import type { HarnessAdapter } from "../server/harness/types.js";
import type { AgentInfo } from "../server/herdr/schema.js";
import type { LaunchResult } from "../server/launch.js";
import { HerdrHarnessSession } from "../server/session.js";
import { HERDR_BIND_OPTION } from "../shared/model.js";
import { FakeTranscript, makeFakeAdapter } from "./fake-harness.js";
import { FakeHerdr } from "./fake-herdr.js";

const config: ProviderSessionConfig = { cwd: "/work", env: {}, mcpServers: {}, settings: {}, persist: true };
const connections: ProviderConnection[] = [];
const servers: FakeHerdr[] = [];
afterEach(async () => {
  for (const connection of connections.splice(0)) await connection.close();
  for (const server of servers.splice(0)) await server.close();
  vi.restoreAllMocks();
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

async function rig() {
  const fake = await FakeHerdr.create();
  servers.push(fake);
  const agent: AgentInfo = { terminal_id: "term-live", pane_id: "pane-live", agent: "fake", name: "demo", cwd: "/work", foreground_cwd: "/work",
    title: null, terminal_title: null, terminal_title_stripped: null, display_agent: "fake",
    agent_status: "idle", screen_detection_skipped: false, state_labels: {}, tokens: {},
    agent_session: { source: "herdr:fake", agent: "fake", kind: "id", value: "fake-session-1" },
    workspace_id: "w1", tab_id: "t1", focused: true, launch_pending: false, interactive_ready: true,
    state_change_seq: 0, completion_seq: null, revision: 0 };
  fake.reply("agent.list", { type: "agent_list", agents: [agent] });
  fake.reply("pane.process_info", { type: "pane_process_info", process_info: {
    pane_id: "pane-live", foreground_process_group_id: 77, tty: "/dev/pts/fake", foreground_processes: [{ pid: 77, name: "fake" }] } });
  const transcript = new FakeTranscript();
  transcript.set([{ id: "a1", kind: "assistant", text: "Hello" }]);
  const adapter = makeFakeAdapter(transcript);
  const boundSessions = new BoundSessions();
  const launched: LaunchResult = { agentName: "demo", terminalId: "term-live", paneId: "pane-live",
    tabId: "t1", workspaceId: "w1", createdWorkspace: false, cwd: "/work", sessionRef: { kind: "id", value: "fake-session-1" } };
  const launch = vi.fn(async () => launched);
  const provider = (options: { adapter?: HarnessAdapter; socket?: () => Promise<string>; hooks?: ProviderHooks } = {}) =>
    createHerdrProvider(options.adapter ?? adapter, options.socket ?? (async () => fake.socketPath), {
      getHerdrSession: () => "work", boundSessions, bindHistoryDelayMs: 60_000, launch, ...options.hooks,
    });
  const connect = async (registration: ProviderRegistration = provider()) => {
    const connection = await registration.connect({ versions: [1], capabilities: ["session.list", "session.persistence", "prompt.message"] });
    connections.push(connection);
    const events: ProviderEvent[] = [];
    connection.onEvent((event) => events.push(ProviderEventSchema.parse(event)));
    const ready = (requestId: string) => vi.waitFor(() =>
      expect(events.some((event) => event.type === "session.ready" && event.requestId === requestId)).toBe(true));
    const failure = async (requestId: string) => {
      await vi.waitFor(() => expect(events.some((event) => event.type === "request.failed" && event.requestId === requestId)).toBe(true));
      return events.find((event) => event.type === "request.failed" && event.requestId === requestId);
    };
    return { connection, events, ready, failure };
  };
  const persistence = persistenceOf(bindingOf(agent, adapter, "work"));
  const open = (connection: ProviderConnection, sessionId: string, entry: "bind" | "import" | "create" = "bind") =>
    connection.send({ type: "session.open", requestId: sessionId, sessionId, history: "skip",
      config: entry === "bind" ? { ...config, providerOptions: { [HERDR_BIND_OPTION]: { terminalId: agent.terminal_id } } } : config,
      ...(entry === "import" ? { persistence } : {}),
    });
  return { fake, adapter, transcript, boundSessions, launched, launch, provider, connect, open, persistence };
}

it.each(["bind", "import", "create"] as const)("abandons a %s waiting for its pinned socket when the connection closes", async (entry) => {
  const world = await rig();
  const gate = deferred<string>();
  const socket = vi.fn(() => gate.promise);
  const added = vi.spyOn(world.boundSessions, "add");
  const opened = vi.spyOn(HerdrHarnessSession.prototype, "open");
  const closed = vi.spyOn(HerdrHarnessSession.prototype, "close");
  const client = await world.connect(world.provider({ socket }));
  await world.open(client.connection, "pending", entry);
  await vi.waitFor(() => expect(socket).toHaveBeenCalledOnce());
  await client.connection.close();
  gate.resolve(world.fake.socketPath);
  await setImmediate();
  await client.connection.close();
  expect(added).not.toHaveBeenCalled();
  expect(opened).not.toHaveBeenCalled();
  expect(closed).not.toHaveBeenCalled();
  expect(world.launch).not.toHaveBeenCalled();
  expect(world.fake.requests).toEqual([]);
  expect(client.events).toEqual([]);
});

it("drops queued opens when the connection closes before dispatch", async () => {
  const world = await rig();
  const socket = vi.fn(async () => world.fake.socketPath);
  const client = await world.connect(world.provider({ socket }));
  const sent = world.open(client.connection, "queued");
  await client.connection.close();
  await sent;
  await setImmediate();
  expect(socket).not.toHaveBeenCalled();
  expect(world.fake.requests).toEqual([]);
});

it.each(["enabled", "companion"] as const)("abandons a create waiting for the %s check when the connection closes", async (check) => {
  const world = await rig();
  const gate = deferred<boolean>();
  const pending = vi.fn(() => gate.promise);
  const socket = vi.fn(async () => world.fake.socketPath);
  const client = await world.connect(world.provider({ socket,
    ...(check === "enabled" ? { hooks: { isEnabled: pending } } :
      { adapter: { ...world.adapter, inputCompanionStatus: async () => ({ ok: await pending() }) } }),
  }));
  await world.open(client.connection, "pending", "create");
  await vi.waitFor(() => expect(pending).toHaveBeenCalledOnce());
  await client.connection.close();
  gate.resolve(true);
  await setImmediate();
  expect(socket).not.toHaveBeenCalled();
  expect(world.launch).not.toHaveBeenCalled();
  expect(client.events).toEqual([]);
});

it("aborts pending bind discovery on connection close without registering a session", async () => {
  const world = await rig();
  const disconnected = deferred<void>();
  world.fake.handle("agent.list", (_request, socket) => { socket.on("close", () => disconnected.resolve()); });
  const added = vi.spyOn(world.boundSessions, "add");
  const opened = vi.spyOn(world.adapter, "openTranscript");
  const client = await world.connect();
  await world.open(client.connection, "pending");
  await vi.waitFor(() => expect(world.fake.requestsFor("agent.list")).toHaveLength(1));
  await client.connection.close();
  await disconnected.promise;
  await setImmediate();
  expect(added).not.toHaveBeenCalled();
  expect(opened).not.toHaveBeenCalled();
  expect(client.events).toEqual([]);
});

it("closes an opening bound session and releases its claim before a delayed transcript resolves", async () => {
  const world = await rig();
  const locator = await world.adapter.resolveTranscript(world.transcript.ref(), { cwd: "/work" });
  const gate = deferred<typeof locator>();
  vi.spyOn(world.adapter, "resolveTranscript").mockImplementationOnce(() => gate.promise);
  const added = vi.spyOn(world.boundSessions, "add");
  const removed = vi.spyOn(world.boundSessions, "delete");
  const opened = vi.spyOn(world.adapter, "openTranscript");
  const first = await world.connect();
  await world.open(first.connection, "pending");
  await vi.waitFor(() => expect(added).toHaveBeenCalledOnce());
  const session = added.mock.calls[0][0];
  await first.connection.close();
  expect(session.isAborted).toBe(true);
  expect(removed).toHaveBeenCalledWith(session);
  const second = await world.connect();
  await world.open(second.connection, "replacement");
  await second.ready("replacement");
  const readers = opened.mock.calls.length;
  gate.resolve(locator);
  await setImmediate();
  expect(opened).toHaveBeenCalledTimes(readers);
  await vi.waitFor(() => expect(world.fake.requestsFor("events.subscribe")).toHaveLength(1));
  expect(first.events).toEqual([]);
});

it.each(["session.close", "connection.close", "failure"] as const)("removes bound sessions and releases claims on %s", async (ending) => {
  const world = await rig();
  const added = vi.spyOn(world.boundSessions, "add");
  const removed = vi.spyOn(world.boundSessions, "delete");
  if (ending === "failure") vi.spyOn(world.adapter, "resolveTranscript").mockRejectedValueOnce(new Error("unreadable"));
  const first = await world.connect();
  await world.open(first.connection, "first");
  if (ending === "failure") await first.failure("first");
  else {
    await first.ready("first");
    if (ending === "connection.close") await first.connection.close();
    else {
      await first.connection.send({ type: "session.close", requestId: "close", sessionId: "first" });
      await vi.waitFor(() => expect(first.events.some((event) => event.type === "request.completed" && event.requestId === "close")).toBe(true));
    }
  }
  const session = added.mock.calls[0][0];
  expect(session.isAborted).toBe(true);
  expect(removed).toHaveBeenCalledExactlyOnceWith(session);
  expect(world.boundSessions.flushHistory("work", "term-live")).toBe(0);
  const second = await world.connect();
  await world.open(second.connection, "replacement");
  await second.ready("replacement");
});

it.each(["bind", "import", "create"] as const)("refuses a competing %s across providers, including while the first open is pending", async (entry) => {
  const world = await rig();
  const locator = await world.adapter.resolveTranscript(world.transcript.ref(), { cwd: "/work" });
  const gate = deferred<typeof locator>();
  const resolving = vi.spyOn(world.adapter, "resolveTranscript").mockImplementationOnce(() => gate.promise);
  const first = await world.connect();
  const second = await world.connect();
  await world.open(first.connection, "first");
  await vi.waitFor(() => expect(resolving).toHaveBeenCalledOnce());
  await world.open(second.connection, "second", entry);
  expect(await second.failure("second")).toMatchObject({ error: { message: "This Fake agent is already open in another conversation" } });
  expect(second.events.some((event) => event.type === "session.opened")).toBe(false);
  gate.resolve(locator);
  await first.ready("first");
  await first.connection.close();
  await world.open(second.connection, "replacement", entry);
  await second.ready("replacement");
});

it("shares claims between connections of one provider and between different harness providers", async () => {
  const world = await rig();
  const provider = world.provider();
  const first = await world.connect(provider);
  const second = await world.connect(provider);
  await world.open(first.connection, "first");
  await first.ready("first");
  await world.open(second.connection, "second", "import");
  expect(await second.failure("second")).toMatchObject({ error: { message: "This Fake agent is already open in another conversation" } });
  const other = await world.connect(world.provider({ adapter: { ...world.adapter, id: "other", label: "Other" } }));
  await other.connection.send({ type: "session.open", requestId: "other", sessionId: "other", config, history: "skip",
    persistence: { ...world.persistence, data: { ...(world.persistence.data as Record<string, unknown>), harness: "other" } } });
  expect(await other.failure("other")).toMatchObject({ error: { message: "This Other agent is already open in another conversation" } });
});

it("does not acquire a late launch's claim after connection close", async () => {
  const world = await rig();
  const gate = deferred<LaunchResult>();
  const launch = vi.fn((_config: ProviderSessionConfig, signal: AbortSignal) => { expect(signal.aborted).toBe(false); return gate.promise; });
  const first = await world.connect(world.provider({ hooks: { launch } }));
  await world.open(first.connection, "pending", "create");
  await vi.waitFor(() => expect(launch).toHaveBeenCalledOnce());
  await first.connection.close();
  expect(launch.mock.calls[0][1].aborted).toBe(true);
  const second = await world.connect();
  await world.open(second.connection, "replacement");
  await second.ready("replacement");
  gate.resolve(world.launched);
  await setImmediate();
  expect(first.events).toEqual([]);
  const third = await world.connect();
  await world.open(third.connection, "third");
  expect(await third.failure("third")).toMatchObject({ error: { message: "This Fake agent is already open in another conversation" } });
});

it("allows a fresh bind over read-only history without letting the old close release the new claim", async () => {
  const world = await rig();
  const added = vi.spyOn(world.boundSessions, "add");
  const first = await world.connect();
  await world.open(first.connection, "first");
  await first.ready("first");
  added.mock.calls[0][0].freeze("Unavailable", "The old occupant is gone");
  const second = await world.connect();
  await world.open(second.connection, "replacement");
  await second.ready("replacement");
  await first.connection.close();
  const third = await world.connect();
  await world.open(third.connection, "third");
  expect(await third.failure("third")).toMatchObject({ error: { message: "This Fake agent is already open in another conversation" } });
});

it("keeps identical terminal IDs independent on different pinned Herdr targets", async () => {
  const world = await rig();
  const first = await world.connect();
  await world.open(first.connection, "first");
  await first.ready("first");
  const otherSession = await world.connect(world.provider({ hooks: { getHerdrSession: () => "other" } }));
  await world.open(otherSession.connection, "other-session");
  await otherSession.ready("other-session");
  const otherSocket = await rig();
  const other = await otherSocket.connect();
  await otherSocket.open(other.connection, "other-socket");
  await other.ready("other-socket");
});
