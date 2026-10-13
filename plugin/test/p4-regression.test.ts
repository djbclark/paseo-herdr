import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ProviderEventSchema, type ProviderConnection, type ProviderEvent, type ProviderPersistence, type ProviderPrompt, type ProviderSessionConfig,
} from "@getpaseo/plugin/server/provider";
import { HerdrHarnessSession, pendingBinding, type SessionDeps } from "../server/session.js";
import { bindingOf, parseBinding, persistenceOf } from "../server/binding.js";
import { createHerdrProvider } from "../server/provider.js";
import { BoundSessions } from "../server/bound-sessions.js";
import { HERDR_BIND_OPTION } from "../shared/model.js";
import type { SubscriptionDescriptor, SubscriptionEventEnvelope, HerdrSubscription } from "../server/herdr/client.js";
import type { AgentInfo } from "../server/herdr/schema.js";
import type { LaunchResult } from "../server/launch.js";
import { FakeHerdr } from "./fake-herdr.js";
import { FakeTranscript, makeFakeAdapter, type FakeTranscriptEntry } from "./fake-harness.js";

/**
 * P4 release regression: the P2.5 move / reconnect / reload / changed-session contracts, proven for all three ways
 * a session starts: import (persistence), create (launch) and bind (attach to a running agent).
 * Session-level tests (4A, 4B, /new) drive one HerdrHarnessSession over a scripted world; provider-level tests (4C)
 * go through createHerdrProvider and a real fake Herdr socket, the way Paseo reopens a chat after a reload.
 */
type Entry = "import" | "create" | "bind";
const ALL: Entry[] = ["import", "create", "bind"];
const NEW_ONLY: Entry[] = ["create", "bind"];
const config: ProviderSessionConfig = { cwd: "/work", env: {}, mcpServers: {}, settings: {}, persist: true };
const HISTORY: FakeTranscriptEntry[] = [{ id: "old-user", kind: "user", text: "old question" }, { id: "old-end", kind: "assistant", text: "old answer" }];
const REF = { kind: "id" as const, value: "fake-session-1" };

const makeAgent = (): AgentInfo => ({ terminal_id: "terminal", pane_id: "pane", agent: "fake", name: "demo", agent_status: "idle",
  agent_session: { source: "herdr:fake", agent: "fake", ...REF }, workspace_id: "w", tab_id: "t", focused: true,
  screen_detection_skipped: false, state_labels: {}, tokens: {}, launch_pending: false, interactive_ready: true,
  state_change_seq: 0, completion_seq: null, cwd: "/work", revision: 0 });
const prompt = (id: string, text = "hello"): ProviderPrompt => ({ clientMessageId: id, delivery: "auto", input: { type: "message", content: [{ type: "text", text }] } });
const launchOf = (agent: AgentInfo): LaunchResult => ({ agentName: agent.name ?? "demo", terminalId: agent.terminal_id, paneId: agent.pane_id,
  tabId: agent.tab_id, workspaceId: agent.workspace_id, createdWorkspace: false, cwd: "/work", sessionRef: agent.agent_session ? { kind: agent.agent_session.kind, value: agent.agent_session.value } : null });

const timelineIds = (events: ProviderEvent[]) => events.flatMap((event) => event.type === "timeline.item" ? [event.item.id] : []);
const turnStates = (events: ProviderEvent[]) => events.flatMap((event) => event.type === "session.turn" ? [event.state] : []);
const noticeTitles = (events: ProviderEvent[]) => events.flatMap((event) => event.type === "session.notice" ? [event.notice.title] : []);
const failedPrompts = (events: ProviderEvent[]) => events.flatMap((event) =>
  event.type === "session.prompt_result" && event.result.type === "failed" ? [{ id: event.clientMessageId, message: event.result.error.message }] : []);
const latestPersistence = (events: ProviderEvent[], sessionId?: string): ProviderPersistence => {
  for (const event of [...events].reverse()) {
    if (sessionId && "sessionId" in event && event.sessionId !== sessionId) continue;
    if ((event.type === "session.persistence" || event.type === "session.opened") && event.persistence) return event.persistence;
  }
  throw new Error("no persistence emitted");
};
const persistenceCount = (events: ProviderEvent[]) => events.filter((event) => event.type === "session.persistence").length;

/** Scriptable event stream standing in for one `events.subscribe` handle (honours the abort signal like the real client). */
class Sub {
  readonly queue: SubscriptionEventEnvelope[] = [];
  error: Error | null = null;
  closed = false;
  private wake: (() => void) | undefined;
  constructor(readonly descriptors: SubscriptionDescriptor[], signal?: AbortSignal) { signal?.addEventListener("abort", () => this.close(), { once: true }); }
  push(event: string, extra: Partial<SubscriptionEventEnvelope> = {}): void { this.queue.push({ event, data: undefined, ...extra }); this.wake?.(); }
  fail(error: Error): void { this.error = error; this.wake?.(); }
  close(): void { this.closed = true; this.wake?.(); }
  handle(): HerdrSubscription {
    const self = this;
    return {
      close: () => this.close(),
      [Symbol.asyncIterator]: async function* () {
        for (;;) {
          if (self.error) throw self.error;
          const next = self.queue.shift();
          if (next) { yield next; continue; }
          if (self.closed) return;
          await new Promise<void>((resolve) => { self.wake = resolve; });
        }
      },
    };
  }
}

/** The Herdr side of one session test: the agent as Herdr lists it, its foreground process, the transcript, and outage switches. */
class World {
  agent = makeAgent();
  extraAgents: AgentInfo[] = [];
  gone = false;
  pid = 100;
  tty = "/dev/pts/fake";
  instance = "fake-instance";
  down: Error | null = null;
  store = new FakeTranscript();
  readonly subs: Sub[] = [];
  readonly delivered: Array<{ method: string; params?: Record<string, unknown> }> = [];
  readonly adapter = makeFakeAdapter(this.store);
  constructor(entry: Entry) {
    if (entry !== "create") this.store.set(HISTORY);
    this.adapter.inspectInput = async ({ pid }) => ({ pid, instanceId: this.instance });
  }
  get sub(): Sub { return this.subs[this.subs.length - 1]; }
  prompts(): Array<Record<string, unknown> | undefined> { return this.delivered.filter((r) => r.method === "agent.prompt").map((r) => r.params); }
  keys(): unknown[] { return this.delivered.filter((r) => r.method === "pane.send_keys"); }
  deps(emit: (event: ProviderEvent) => void): SessionDeps {
    return {
      adapter: this.adapter,
      listAgents: async () => { if (this.down) throw this.down; return this.gone ? [...this.extraAgents] : [this.agent, ...this.extraAgents]; },
      request: async (method, params) => {
        if (this.down) throw this.down;
        if (method === "pane.process_info") return { type: "pane_process_info", process_info: {
          pane_id: this.agent.pane_id, foreground_process_group_id: this.pid, tty: this.tty, foreground_processes: [{ pid: this.pid, name: "fake" }] } };
        this.delivered.push({ method, params });
        return { type: "agent_prompted", agent: this.agent };
      },
      subscribe: async (descriptors, options) => { const sub = new Sub(descriptors, options?.signal); this.subs.push(sub); return sub.handle(); },
      emit, getHerdrSession: () => null, bindHistoryDelayMs: 60_000,
      launch: async () => launchOf(this.agent),
    };
  }
  /** One full Paseo turn: prompt, then the harness commits the user and assistant rows. */
  async turn(session: HerdrHarnessSession, id: string, text = "hello"): Promise<void> {
    await session.prompt(prompt(id, text));
    this.store.append({ id: `u-${id}`, kind: "user", text });
    this.store.append({ id: `a-${id}`, kind: "assistant", text: `answer to ${text}` });
    await session.live.reconcile();
  }
}

const sessions: HerdrHarnessSession[] = [];
afterEach(() => { for (const session of sessions.splice(0)) session.close(); });

async function start(entry: Entry) {
  const world = new World(entry);
  const events: ProviderEvent[] = [];
  const deps = world.deps((event) => events.push(event));
  const session = new HerdrHarnessSession("s", entry === "create" ? pendingBinding(world.adapter, null, "/work") : bindingOf(world.agent, world.adapter, null), deps);
  sessions.push(session);
  if (entry === "create") await session.create(config, "skip", "req");
  else if (entry === "bind") { await session.bind(config, "req"); session.flushHistory(); }
  else await session.open(config, "skip", "req");
  await session.live.reconcile();
  return { world, events, session };
}
/** Wait for the observer to notice a lost event stream or an unreachable Herdr. */
const disconnected = (session: HerdrHarnessSession) => vi.waitFor(() => expect(session.state.connected).toBe(false));
const connected = (session: HerdrHarnessSession) => vi.waitFor(() => expect(session.state.connected).toBe(true));

describe.each(ALL)("4A pane moves: %s", (entry) => {
  it("rebinds a pane.moved to another workspace by terminal and process identity, re-subscribes, re-persists and prompts the new pane", async () => {
    const { world, events, session } = await start(entry);
    const pid = session.state.binding.occupant?.pid;
    const persisted = persistenceCount(events);
    expect(world.subs).toHaveLength(1);
    world.agent.pane_id = "pane-2"; world.agent.workspace_id = "w2"; world.agent.tab_id = "t2";
    world.sub.push("pane.moved");
    await vi.waitFor(() => expect(session.state.paneId).toBe("pane-2"));
    expect(world.subs).toHaveLength(2);
    expect(world.subs[0].closed).toBe(true);
    expect(world.sub.descriptors).toContainEqual({ type: "pane.agent_status_changed", pane_id: "pane-2" });
    expect(persistenceCount(events)).toBe(persisted + 1);
    expect(latestPersistence(events)).toEqual(persistenceOf(session.state.binding));
    expect(latestPersistence(events)).toMatchObject({ data: { terminalId: "terminal", sessionRef: REF, occupant: { pid } } });
    expect(session.state.outcome).toBe("active");
    await session.prompt(prompt("moved"));
    expect(world.prompts()).toMatchObject([{ target: "pane-2", text: "hello" }]);
    expect(failedPrompts(events)).toEqual([]);
  });

  it("delivers to the new pane from a bare agent.list change with no event at all", async () => {
    if (entry === "import") return; // covered by session-stabilization "rebinds the moved pane only when retained native and occupant identity match"
    const { world, session } = await start(entry);
    world.agent.pane_id = "pane-3";
    await session.prompt(prompt("moved"));
    expect(world.prompts()).toMatchObject([{ target: "pane-3" }]);
    expect(session.state.binding.terminalId).toBe("terminal");
    expect(session.state.paneId).toBe("pane-3");
  });

  it("freezes read-only and sends nothing when a different process now owns the moved pane", async () => {
    const { world, events, session } = await start(entry);
    const before = persistenceOf(session.state.binding);
    const rows = timelineIds(events).length;
    world.agent.pane_id = "pane-2"; world.pid = 101;
    world.sub.push("pane.moved");
    await vi.waitFor(() => expect(session.state.outcome).toBe("readonly"));
    expect(noticeTitles(events)).toContain("The bound agent was replaced");
    await session.prompt(prompt("replacement"));
    await session.interrupt("stop");
    expect(world.delivered.filter((r) => r.method === "agent.prompt" || r.method === "pane.send_keys")).toEqual([]);
    expect(failedPrompts(events)).toMatchObject([{ id: "replacement", message: expect.stringContaining("read-only") }]);
    expect(persistenceOf(session.state.binding)).toEqual(before);
    expect(timelineIds(events)).toHaveLength(rows);
  });

  it("freezes when the moved pane now runs a different harness or a replaced process-local identity", async () => {
    const { world, session } = await start(entry);
    world.instance = "other-instance"; // same pid reused by a new process
    await session.prompt(prompt("reused-pid"));
    expect(session.state.outcome).toBe("readonly");
    expect(world.prompts()).toEqual([]);
    const second = await start(entry);
    second.world.agent.agent = "other";
    await second.session.prompt(prompt("other-harness"));
    expect(second.session.state.outcome).toBe("readonly");
    expect(second.world.prompts()).toEqual([]);
  });

  it("follows a re-keyed terminal only through retained process evidence, and refuses an ambiguous match", async () => {
    const { world, events, session } = await start(entry);
    world.agent.terminal_id = "terminal-2";
    await session.live.reconcile();
    expect(session.state.binding.terminalId).toBe("terminal-2");
    expect(latestPersistence(events)).toMatchObject({ data: { terminalId: "terminal-2" } });
    await session.prompt(prompt("rekeyed"));
    expect(world.prompts()).toHaveLength(1);

    const twin = await start(entry);
    twin.world.agent.terminal_id = "terminal-2";
    twin.world.extraAgents = [{ ...makeAgent(), terminal_id: "terminal-3", pane_id: "pane-9" }];
    await twin.session.live.reconcile();
    expect(twin.session.state.outcome).toBe("readonly");
    await twin.session.prompt(prompt("ambiguous"));
    expect(twin.world.prompts()).toEqual([]);
  });
});

describe.each(ALL)("4B Herdr restart / event loss: %s", (entry) => {
  it("events_lost suspends input until reconcile, then catches up once with the same PID and no duplicate rows", async () => {
    const { world, events, session } = await start(entry);
    const pid = session.state.binding.occupant?.pid;
    world.sub.push("events_lost", { eventsLost: true });
    await disconnected(session);
    world.store.append({ id: "t-user", kind: "user", text: "typed in terminal" });
    world.store.append({ id: "t-end", kind: "assistant", text: "terminal answer" });
    await session.prompt(prompt("during-loss"));
    expect(world.prompts()).toEqual([]);
    expect(failedPrompts(events)).toMatchObject([{ id: "during-loss", message: expect.stringContaining("suspended") }]);
    expect(timelineIds(events)).not.toContainEqual(expect.stringContaining("t-user"));
    world.sub.push("observer.connected");
    await connected(session);
    await vi.waitFor(() => expect(turnStates(events)).toEqual(["started", "completed"]));
    await session.live.reconcile();
    await session.live.reconcile();
    const ids = timelineIds(events);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.filter((id) => id.includes("t-user") || id.includes("t-end"))).toHaveLength(2);
    expect(turnStates(events)).toEqual(["started", "completed"]);
    expect(session.state.binding.occupant?.pid).toBe(pid);
    await session.prompt(prompt("after-recovery"));
    expect(world.prompts()).toHaveLength(1);
  });

  it("a dropped subscription suspends input; the next reconcile restores it without a second launch or a new PID", async () => {
    const { world, events, session } = await start(entry);
    const pid = session.state.binding.occupant?.pid;
    const persisted = persistenceCount(events);
    world.sub.fail(new Error("socket dropped"));
    await disconnected(session);
    await session.prompt(prompt("dropped"));
    expect(world.prompts()).toEqual([]);
    await session.live.reconcile();
    expect(session.state.connected).toBe(true);
    await session.prompt(prompt("restored"));
    expect(world.prompts()).toHaveLength(1);
    expect(session.state.binding.occupant?.pid).toBe(pid);
    expect(persistenceCount(events)).toBe(persisted);
    expect(world.delivered.filter((r) => r.method === "agent.start" || r.method === "workspace.create")).toEqual([]);
  });

  it("Herdr unreachable never admits input, never marks the agent failed, and recovers when it is back", async () => {
    const { world, events, session } = await start(entry);
    world.down = new Error("connect ECONNREFUSED");
    await session.prompt(prompt("raced")); // connectivity still looks fine; preflight must refuse
    await session.live.reconcile();
    expect(session.state.connected).toBe(false);
    await session.prompt(prompt("down"));
    expect(world.prompts()).toEqual([]);
    expect(failedPrompts(events).map((p) => p.id)).toEqual(["raced", "down"]);
    expect(session.state.outcome).toBe("active");
    expect(turnStates(events)).not.toContain("failed");
    world.down = null;
    await session.live.reconcile();
    expect(session.state.connected).toBe(true);
    await session.prompt(prompt("back"));
    expect(world.prompts()).toHaveLength(1);
    expect(session.state.tracker.isUncertain).toBe(false);
  });

  it("loss while the pane moved recovers at the new pane after reconcile", async () => {
    const { world, session } = await start(entry);
    world.sub.push("observer.disconnected");
    await disconnected(session);
    world.agent.pane_id = "pane-4";
    await session.prompt(prompt("uncertain"));
    expect(world.prompts()).toEqual([]);
    world.sub.push("observer.connected");
    await connected(session);
    expect(session.state.paneId).toBe("pane-4");
    expect(world.sub.descriptors).toContainEqual({ type: "pane.agent_status_changed", pane_id: "pane-4" });
    await session.prompt(prompt("recovered"));
    expect(world.prompts()).toMatchObject([{ target: "pane-4" }]);
  });

  it("loss while the process was replaced stays frozen: reconcile finds a different PID and input is never admitted", async () => {
    const { world, events, session } = await start(entry);
    const before = persistenceOf(session.state.binding);
    world.sub.push("events_lost", { eventsLost: true });
    await disconnected(session);
    world.pid = 555;
    world.sub.push("observer.connected");
    await vi.waitFor(() => expect(session.state.outcome).toBe("readonly"));
    expect(session.state.connected).toBe(false);
    await session.prompt(prompt("replacement"));
    expect(world.prompts()).toEqual([]);
    expect(failedPrompts(events).map((p) => p.id)).toEqual(["replacement"]);
    expect(persistenceOf(session.state.binding)).toEqual(before);
  });

  it("a Herdr restart that no longer lists the agent leaves the chat read-only with its history", async () => {
    const { world, events, session } = await start(entry);
    const rows = timelineIds(events).length;
    world.gone = true;
    world.sub.push("observer.disconnected");
    await disconnected(session);
    world.sub.push("observer.connected");
    await vi.waitFor(() => expect(session.state.outcome).toBe("readonly"));
    expect(noticeTitles(events)).toContain("Fake agent unavailable");
    await session.prompt(prompt("gone"));
    expect(world.prompts()).toEqual([]);
    expect(timelineIds(events)).toHaveLength(rows);
  });
});

describe.each(NEW_ONLY)("changed native session (/new): %s", (entry) => {
  it("freezes the old conversation with the handoff notice, keeps its history and correlation, and leaks no new rows", async () => {
    const { world, events, session } = await start(entry);
    await world.turn(session, "m1", "first");
    const old = persistenceOf(session.state.binding);
    const rows = timelineIds(events);
    expect(Object.values((old.data as { submittedMessages: Record<string, string> }).submittedMessages)).toEqual(["m1"]);
    world.agent.agent_session = { source: "herdr:fake", agent: "fake", kind: "id", value: "next-session" };
    world.store.set([{ id: "other-user", kind: "user", text: "new-session text" }]);
    world.store.notify();
    await vi.waitFor(() => expect(session.state.outcome).toBe("readonly"));
    await session.prompt(prompt("after-new"));
    expect(world.prompts()).toHaveLength(1); // only the pre-/new prompt
    expect(timelineIds(events)).toEqual(rows);
    expect(persistenceOf(session.state.binding)).toEqual(old);
    expect(session.state.binding.sessionRef).toEqual(REF);
    expect(events.filter((event) => event.type === "session.notice" && event.notice.title === "The native session changed"))
      .toMatchObject([{ notice: { description: expect.stringContaining("Import session") } }]);
    expect(failedPrompts(events)).toMatchObject([{ id: "after-new" }]);
    expect(events.filter((event) => event.type === "session.closed")).toEqual([]);
  });
});

// --- 4C: reload / refresh through the provider, reopening with the persistence last emitted -----------------

let fake: FakeHerdr | undefined;
const connections: ProviderConnection[] = [];
afterEach(async () => {
  for (const connection of connections.splice(0)) await connection.close();
  await fake?.close();
  fake = undefined;
});

async function providerRig(entry: Entry, options: { sessionRef?: boolean } = {}) {
  fake = await FakeHerdr.create();
  const store = new FakeTranscript();
  if (entry !== "create") store.set(HISTORY);
  const world = { agent: makeAgent(), pid: 77 };
  if (options.sessionRef === false) delete world.agent.agent_session;
  const wire: Array<{ method: string; params: Record<string, unknown> }> = [];
  const reply = (method: string, result: () => unknown) => fake!.handle(method, (request, stream) => {
    wire.push({ method, params: request.params });
    stream.end(JSON.stringify({ id: request.id, result: result() }) + "\n");
  });
  reply("agent.list", () => ({ type: "agent_list", agents: [world.agent] }));
  reply("agent.prompt", () => ({ type: "agent_prompted", agent: world.agent }));
  reply("pane.process_info", () => ({ type: "pane_process_info", process_info: {
    pane_id: world.agent.pane_id, foreground_process_group_id: world.pid, tty: "/dev/pts/fake", foreground_processes: [{ pid: world.pid, name: "fake" }] } }));
  let launches = 0;
  const boundSessions = new BoundSessions();
  const adapter = makeFakeAdapter(store);
  const provider = createHerdrProvider(adapter, async () => fake!.socketPath, {
    getHerdrSession: () => null, bindHistoryDelayMs: 60_000, boundSessions,
    launch: async () => { launches++; return launchOf(world.agent); },
  });
  const connection = await provider.connect({ versions: [1], capabilities: ["session.list", "session.persistence", "prompt.message"] });
  connections.push(connection);
  const events: ProviderEvent[] = [];
  connection.onEvent((event) => events.push(ProviderEventSchema.parse(event)));
  const ready = (sessionId: string) => vi.waitFor(() => expect(events.some((event) => event.type === "session.ready" && event.sessionId === sessionId)).toBe(true));
  const rowsOf = (sessionId: string) => events.filter((event) => event.type === "timeline.item" && event.sessionId === sessionId);
  const idsOf = (sessionId: string) => rowsOf(sessionId).flatMap((event) => event.type === "timeline.item" ? [event.item.id] : []);
  const open = async (sessionId: string, how: Entry | "reopen", persistence?: ProviderPersistence) => {
    const requestId = `open-${sessionId}`;
    if (how === "reopen") await connection.send({ type: "session.open", requestId, sessionId, config, persistence, history: "replay" });
    else if (how === "import") await connection.send({ type: "session.open", requestId, sessionId, config, history: "replay",
      persistence: persistenceOf(bindingOf(world.agent, adapter, null)) });
    else if (how === "create") await connection.send({ type: "session.open", requestId, sessionId, config, history: "skip" });
    else await connection.send({ type: "session.open", requestId, sessionId, history: "skip",
      config: { ...config, providerOptions: { [HERDR_BIND_OPTION]: { terminalId: "terminal", paneId: "pane" } } } });
  };
  const fresh = async (sessionId: string, entry: Entry) => {
    await open(sessionId, entry);
    await ready(sessionId);
    if (entry === "bind") boundSessions.flushHistory(null, "terminal");
  };
  const close = async (sessionId: string) => {
    await connection.send({ type: "session.close", sessionId, requestId: `close-${sessionId}` });
    await vi.waitFor(() => expect(events.some((event) => event.type === "request.completed" && event.requestId === `close-${sessionId}`)).toBe(true));
  };
  const send = (sessionId: string, id: string, text: string) => connection.send({ type: "session.prompt", sessionId, prompt: prompt(id, text) });
  /** The harness commits the user and assistant rows for a Paseo prompt, and the live session catches up. */
  const commit = async (sessionId: string, id: string, text: string) => {
    const sent = wire.filter((r) => r.method === "agent.prompt").length;
    await send(sessionId, id, text);
    await vi.waitFor(() => expect(wire.filter((r) => r.method === "agent.prompt").length).toBe(sent + 1));
    store.append({ id: `u-${id}`, kind: "user", text });
    store.append({ id: `a-${id}`, kind: "assistant", text: `answer to ${text}` });
    store.notify();
    await vi.waitFor(() => expect(Object.values((latestPersistence(events, sessionId).data as { submittedMessages: Record<string, string> }).submittedMessages)).toContain(id));
    await vi.waitFor(() => expect(events.some((event) => event.type === "session.turn" && event.sessionId === sessionId && event.state === "completed")).toBe(true));
  };
  return { connection, events, store, world, wire, boundSessions, launches: () => launches, ready, rowsOf, idsOf, open, fresh, close, send, commit,
    prompts: () => wire.filter((r) => r.method === "agent.prompt") };
}
const userRow = (events: ProviderEvent[], sessionId: string, itemId: string) => events.find((event) =>
  event.type === "timeline.item" && event.sessionId === sessionId && event.item.id === itemId);

describe.each(ALL)("4C reload / refresh: %s", (entry) => {
  it("reopening the last emitted persistence keeps timeline ids and message correlation stable and never launches again", async () => {
    const rig = await providerRig(entry);
    await rig.fresh("first", entry);
    await rig.commit("first", "msg-1", "hello");
    const firstIds = rig.idsOf("first");
    const persistence = latestPersistence(rig.events, "first");
    expect(persistence.data).toMatchObject({ terminalId: "terminal", sessionRef: REF, occupant: { pid: 77 } });
    await rig.close("first");
    await rig.open("second", "reopen", persistence);
    await rig.ready("second");
    const replayed = rig.idsOf("second");
    expect(new Set(replayed).size).toBe(replayed.length);
    expect(replayed).toEqual(rig.store.items.map((item) => item.id));
    // Every row Paseo saw before the reload has the same id after it (bind's history re-send included).
    expect([...new Set(firstIds)].sort()).toEqual([...replayed].sort());
    const replayedUser = userRow(rig.events, "second", rig.store.items.find((item) => item.type === "user_message" && item.text === "hello")!.id);
    expect(replayedUser).toMatchObject({ item: { text: "hello", clientMessageId: "msg-1" } });
    expect(rig.launches()).toBe(entry === "create" ? 1 : 0);
    expect(rig.wire.some((r) => r.method === "agent.start")).toBe(false);
    // Reconciling the reopened session adds nothing, and the same PID takes the next prompt.
    rig.store.notify();
    await rig.commit("second", "msg-2", "again");
    expect(latestPersistence(rig.events, "second").data).toMatchObject({ occupant: { pid: 77 }, submittedMessages: expect.any(Object) });
    expect(Object.values((latestPersistence(rig.events, "second").data as { submittedMessages: Record<string, string> }).submittedMessages).sort()).toEqual(["msg-1", "msg-2"]);
    const after = rig.idsOf("second");
    expect(new Set(after).size).toBe(after.length);
    expect(rig.prompts()).toHaveLength(2);
    expect(rig.events.filter((event) => event.type === "request.failed")).toEqual([]);
  });

  it("reopening after the pane moved while closed prompts the new pane; after the process was replaced it is read-only", async () => {
    const rig = await providerRig(entry);
    await rig.fresh("first", entry);
    const persistence = latestPersistence(rig.events, "first");
    await rig.close("first");
    rig.world.agent.pane_id = "pane-moved";
    await rig.open("moved", "reopen", persistence);
    await rig.ready("moved");
    await rig.send("moved", "m1", "go");
    await vi.waitFor(() => expect(rig.prompts()).toMatchObject([{ params: { target: "pane-moved" } }]));
    await rig.close("moved");
    rig.world.pid = 78;
    await rig.open("replaced", "reopen", persistence);
    await rig.ready("replaced");
    await rig.send("replaced", "m2", "go");
    await vi.waitFor(() => expect(rig.events.some((event) => event.type === "session.prompt_result" && event.clientMessageId === "m2" && event.result.type === "failed")).toBe(true));
    expect(rig.prompts()).toHaveLength(1);
    expect(rig.events.some((event) => event.type === "session.notice" && event.sessionId === "replaced" && event.notice.title === "The bound agent was replaced")).toBe(true);
    expect(rig.launches()).toBe(entry === "create" ? 1 : 0);
  });

  it("a conversation reopened this way holds its agent: a second bind of the same agent is refused, then allowed once it is closed", async () => {
    const rig = await providerRig(entry);
    await rig.fresh("first", entry);
    const persistence = latestPersistence(rig.events, "first");
    await rig.close("first");
    await rig.open("again", "reopen", persistence);
    await rig.ready("again");
    await rig.open("dup", "bind");
    await vi.waitFor(() => expect(rig.events.some((event) => event.type === "request.failed" && event.requestId === "open-dup")).toBe(true));
    expect(rig.events.find((event) => event.type === "request.failed" && event.requestId === "open-dup")).toMatchObject({
      error: { message: "This Fake agent is already open in another conversation" } });
    expect(rig.rowsOf("dup")).toEqual([]);
    expect(rig.launches()).toBe(entry === "create" ? 1 : 0);
    await rig.close("again");
    await rig.open("later", "bind");
    await rig.ready("later");
  });
});

describe("4C create: reopening before the first transcript arrives", () => {
  it("file not yet present: reopens without launching, correlates the first prompt, and the next reopen replays the same ids", async () => {
    const rig = await providerRig("create");
    await rig.fresh("first", "create");
    expect(rig.rowsOf("first")).toEqual([]);
    const early = latestPersistence(rig.events, "first");
    expect(early.data).toMatchObject({ sessionRef: REF, terminalId: "terminal", submittedMessages: {} });
    await rig.close("first");
    await rig.open("second", "reopen", early);
    await rig.ready("second");
    expect(rig.launches()).toBe(1);
    expect(rig.rowsOf("second")).toEqual([]);
    expect(rig.events.filter((event) => event.type === "request.failed")).toEqual([]);
    await rig.commit("second", "msg-1", "hello");
    const live = rig.idsOf("second");
    expect(live).toHaveLength(2);
    const later = latestPersistence(rig.events, "second");
    await rig.close("second");
    await rig.open("third", "reopen", later);
    await rig.ready("third");
    expect(rig.idsOf("third")).toEqual(live);
    expect(userRow(rig.events, "third", live[0])).toMatchObject({ item: { clientMessageId: "msg-1" } });
    expect(rig.launches()).toBe(1);
    expect(rig.prompts()).toHaveLength(1);
  });

  it("a prompt in flight when the chat is reloaded is not resent, and its row appears exactly once afterwards", async () => {
    const rig = await providerRig("create");
    await rig.fresh("first", "create");
    await rig.send("first", "msg-1", "hello");
    await vi.waitFor(() => expect(rig.prompts()).toHaveLength(1));
    const persistence = latestPersistence(rig.events, "first");
    await rig.close("first");
    await rig.open("second", "reopen", persistence);
    await rig.ready("second");
    rig.store.append({ id: "u-msg-1", kind: "user", text: "hello" });
    rig.store.append({ id: "a-msg-1", kind: "assistant", text: "answer" });
    rig.store.notify();
    await vi.waitFor(() => expect(rig.idsOf("second")).toHaveLength(2));
    rig.store.notify();
    expect(new Set(rig.idsOf("second")).size).toBe(2);
    expect(rig.prompts()).toHaveLength(1);
    expect(rig.launches()).toBe(1);
  });

  it("no session ref reported yet: the reopened chat stays read-only on the same agent, keeps its persistence, and never launches", async () => {
    const rig = await providerRig("create", { sessionRef: false });
    await rig.fresh("first", "create");
    const early = latestPersistence(rig.events, "first");
    expect(early.data).toMatchObject({ sessionRef: null, terminalId: "terminal" });
    await rig.close("first");
    await rig.open("second", "reopen", early);
    await rig.ready("second");
    expect(latestPersistence(rig.events, "second")).toEqual(early);
    await rig.send("second", "m1", "hello");
    await vi.waitFor(() => expect(rig.events.some((event) => event.type === "session.prompt_result" && event.clientMessageId === "m1" && event.result.type === "failed")).toBe(true));
    expect(rig.prompts()).toEqual([]);
    expect(rig.launches()).toBe(1);
    expect(parseBinding(early, makeFakeAdapter()).sessionRef).toBeNull();
  });
});

describe("4C bind: reopening the bound chat's persistence", () => {
  it("is an ordinary import: history is not re-sent a second time, flushing does nothing, and the chat is live", async () => {
    const rig = await providerRig("bind");
    await rig.fresh("bound", "bind");
    expect(rig.idsOf("bound")).toHaveLength(2); // the bind re-sent the earlier conversation once
    const persistence = latestPersistence(rig.events, "bound");
    await rig.close("bound");
    await rig.open("reopened", "reopen", persistence);
    await rig.ready("reopened");
    const once = rig.idsOf("reopened");
    expect(once).toEqual(rig.store.items.map((item) => item.id));
    expect(rig.boundSessions.flushHistory(null, "terminal")).toBe(0); // an import is not a bound session: nothing to flush
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(rig.idsOf("reopened")).toEqual(once);
    await rig.send("reopened", "m1", "next");
    await vi.waitFor(() => expect(rig.prompts()).toHaveLength(1));
    expect(rig.events.filter((event) => event.type === "session.notice" && event.sessionId === "reopened" && event.notice.id === "attach")).toEqual([]);
  });
});
