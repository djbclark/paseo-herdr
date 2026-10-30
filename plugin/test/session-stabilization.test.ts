import { afterEach, expect, it, vi } from "vitest";
import type { ProviderEvent, ProviderPrompt } from "@getpaseo/plugin/server/provider";
import { HerdrHarnessSession, type SessionDeps } from "../server/session.js";
import { bindingOf, persistenceOf } from "../server/binding.js";
import { HerdrError, type SubscriptionEventEnvelope } from "../server/herdr/client.js";
import { classifyHerdrPrompt, type PromptExpectation } from "../server/prompt.js";
import type { AgentInfo } from "../server/herdr/schema.js";
import { FakeTranscript, makeFakeAdapter } from "./fake-harness.js";

const config = { cwd: "/work", env: {}, mcpServers: {}, settings: {}, persist: true };
function makeAgent(): AgentInfo {
  return { terminal_id: "terminal", pane_id: "pane", agent: "fake", name: "demo", agent_status: "idle",
    agent_session: { source: "herdr:fake", agent: "fake", kind: "id", value: "fake-session-1" },
    workspace_id: "w", tab_id: "t", focused: true, screen_detection_skipped: false,
    state_labels: {}, tokens: {}, launch_pending: false, interactive_ready: true,
    state_change_seq: 0, completion_seq: null, cwd: "/work", revision: 0 };
}
const sessions: HerdrHarnessSession[] = [];
afterEach(() => { for (const session of sessions.splice(0)) session.close(); vi.useRealTimers(); });
const prompt = (id: string, text = "hello"): ProviderPrompt => ({ clientMessageId: id,
  delivery: "auto", input: { type: "message", content: [{ type: "text", text }] } });
const turns = (events: ProviderEvent[]) => events.filter((event) => event.type === "session.turn");

async function setup(overrides: Partial<SessionDeps> = {}) {
  const agent = makeAgent();
  const store = new FakeTranscript();
  store.set([{ id: "old-user", kind: "user", text: "old question" }, { id: "old-end", kind: "assistant", text: "old answer" }]);
  const adapter = makeFakeAdapter(store);
  const events: ProviderEvent[] = [];
  const delivered: Array<{ method: string; params?: Record<string, unknown> }> = [];
  let pid = 100;
  let promptError: unknown = null;
  const session = new HerdrHarnessSession("local", bindingOf(agent, adapter, null), {
    adapter, listAgents: async () => [agent],
    request: async (method, params) => {
      if (method === "pane.process_info") return { type: "pane_process_info", process_info: {
        pane_id: agent.pane_id, foreground_process_group_id: pid, tty: "/dev/pts/fake",
        foreground_processes: [{ pid, name: "fake" }],
      } };
      delivered.push({ method, params });
      if (method === "agent.prompt" && promptError) throw promptError;
      return { type: "agent_prompted", agent };
    },
    subscribe: async () => ({ [Symbol.asyncIterator]: async function* () {}, close() {} }),
    emit: (event) => events.push(event), ...overrides,
  });
  sessions.push(session);
  await session.open(config, "skip");
  await session.live.reconcile();
  return { session, store, agent, adapter, events, delivered, replacePid: (next: number) => { pid = next; },
    setPromptError: (error: unknown) => { promptError = error; } };
}

it("admits one concurrent prompt before asynchronous preflight", async () => {
  let release!: () => void;
  let blocked = false;
  const agent = makeAgent();
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const { session, events, delivered } = await setup({ listAgents: async () => { if (blocked) await gate; return [agent]; } });
  blocked = true;
  const first = session.prompt(prompt("one"));
  const second = session.prompt(prompt("two"));
  release();
  await Promise.all([first, second]);
  expect(delivered.map((request) => request.method)).toEqual(["agent.prompt"]);
  expect(events.filter((event) => event.type === "session.prompt_result" && event.clientMessageId === "two"))
    .toMatchObject([{ result: { type: "failed" } }]);
});

it("rejects a fresh unfinished native turn despite stale idle status", async () => {
  const { session, store, delivered, events } = await setup();
  store.append({ id: "new-user", kind: "user", text: "terminal question" });
  await session.prompt(prompt("paseo"));
  expect(delivered).toEqual([]);
  expect(events.filter((event) => event.type === "session.prompt_result")).toMatchObject([{ result: { type: "failed" } }]);
});

it("cannot finish a new Paseo turn using the previous assistant outcome", async () => {
  const { session, store, events } = await setup();
  await session.prompt(prompt("paseo"));
  await session.live.reconcile();
  expect(turns(events).map((event) => event.state)).toEqual(["started"]);
  store.append({ id: "new-user", kind: "user", text: "hello" });
  await session.live.reconcile();
  expect(turns(events).map((event) => event.state)).toEqual(["started"]);
  store.append({ id: "new-end", kind: "assistant", text: "new answer" });
  await session.live.reconcile();
  expect(turns(events).map((event) => event.state)).toEqual(["started", "completed"]);
  expect(events.filter((event) => event.type === "timeline.item" && event.item.type === "user_message"))
    .toMatchObject([{ item: { text: "hello", clientMessageId: "paseo" } }]);
  await session.live.reconcile();
  expect(turns(events).map((event) => event.state)).toEqual(["started", "completed"]);
});

it("catches a terminal turn that completed between status observations without Paseo correlation", async () => {
  const { session, store, events } = await setup();
  store.append({ id: "terminal-user", kind: "user", text: "from terminal" });
  store.append({ id: "terminal-end", kind: "assistant", text: "terminal answer" });
  await session.live.reconcile();
  expect(turns(events).map((event) => event.state)).toEqual(["started", "completed"]);
  const user = events.find((event) => event.type === "timeline.item" && event.item.type === "user_message");
  expect(user).toMatchObject({ item: { text: "from terminal" } });
  expect(user && "item" in user && "clientMessageId" in user.item).toBe(false);
});

it("freezes the old native identity and rejects input after /new without mixing new history", async () => {
  const { session, agent, store, delivered, events } = await setup();
  const old = persistenceOf(session.state.binding);
  agent.agent_session = { source: "herdr:fake", agent: "fake", kind: "id", value: "next-session" };
  store.set([{ id: "other-user", kind: "user", text: "new-session text" }]);
  await session.live.reconcile();
  await session.prompt(prompt("paseo"));
  expect(delivered).toEqual([]);
  expect(session.state.binding.sessionRef).toEqual({ kind: "id", value: "fake-session-1" });
  expect(persistenceOf(session.state.binding)).toEqual(old);
  expect(events.filter((event) => event.type === "timeline.item")).toEqual([]);
  expect(events.filter((event) => event.type === "session.notice")).toMatchObject([
    { notice: { title: "The native session changed", description: expect.stringContaining("Import session") } },
  ]);
});

it("rejects prompt and interrupt on same-harness same-ref process replacement", async () => {
  const { session, replacePid, delivered, events } = await setup();
  await session.prompt(prompt("first"));
  replacePid(101);
  await session.interrupt("stop");
  await session.prompt(prompt("replacement"));
  expect(delivered.map((request) => request.method)).toEqual(["agent.prompt"]);
  expect(turns(events).map((event) => event.state)).toEqual(["started", "failed"]);
  expect(events.filter((event) => event.type === "session.prompt_result" && event.clientMessageId === "replacement"))
    .toMatchObject([{ result: { type: "failed" } }]);
});

it("validates process-local nonce even if a process replacement reuses its PID", async () => {
  const { session, adapter, delivered } = await setup();
  adapter.inspectInput = async ({ pid }) => ({ pid, instanceId: "replacement-instance" });
  await session.prompt(prompt("replacement"));
  expect(delivered).toEqual([]);
  expect(session.state.outcome).toBe("readonly");
});

it("keeps the independent harness interrupt key and waits for native abort", async () => {
  const { session, store, delivered, events } = await setup();
  await session.prompt(prompt("first"));
  await session.interrupt("stop");
  expect(delivered.at(-1)).toEqual({ method: "pane.send_keys", params: { pane_id: "pane", keys: ["ctrl+c"] } });
  expect(turns(events).map((event) => event.state)).toEqual(["started"]);
  store.append({ id: "new-user", kind: "user", text: "hello" });
  store.append({ id: "abort", kind: "assistant", text: "partial", end: "aborted" });
  await session.live.reconcile();
  expect(turns(events).map((event) => event.state)).toEqual(["started", "canceled"]);
});

/** `listAgents` that parks every call until the test resolves it, so overlapping validations finish in a chosen order. */
function gatedList(agent: AgentInfo) {
  const gates: Array<() => void> = [];
  let gated = false;
  const listAgents = async () => {
    if (!gated) return [agent];
    const parked = Promise.withResolvers<void>();
    gates.push(parked.resolve);
    await parked.promise;
    return [agent];
  };
  return { listAgents, gates, gate: () => { gated = true; }, ungate: () => { gated = false; } };
}

it("an overlapping reconcile that commits first does not fail the prompt of the older validation", async () => {
  const agent = makeAgent();
  const list = gatedList(agent);
  const { session, delivered, events } = await setup({ listAgents: list.listAgents });
  list.gate();
  const sending = session.prompt(prompt("one"));
  await vi.waitFor(() => expect(list.gates).toHaveLength(1));
  const polling = session.live.reconcile();
  await vi.waitFor(() => expect(list.gates).toHaveLength(2));
  list.gates[1]!();
  await polling;
  list.ungate();
  list.gates[0]!();
  await sending;
  expect(delivered.map((request) => request.method)).toEqual(["agent.prompt"]);
  expect(events.filter((event) => event.type === "session.prompt_result")).toMatchObject([{ result: { type: "turn" } }]);
});

it("an overlapping reconcile that commits first does not drop the Stop key of the older validation", async () => {
  const agent = makeAgent();
  const list = gatedList(agent);
  const { session, delivered } = await setup({ listAgents: list.listAgents });
  await session.prompt(prompt("first"));
  list.gate();
  const stopping = session.interrupt("stop");
  await vi.waitFor(() => expect(list.gates).toHaveLength(1));
  const polling = session.live.reconcile();
  await vi.waitFor(() => expect(list.gates).toHaveLength(2));
  list.gates[1]!();
  await polling;
  list.ungate();
  list.gates[0]!();
  await stopping;
  expect(delivered.at(-1)).toEqual({ method: "pane.send_keys", params: { pane_id: "pane", keys: ["ctrl+c"] } });
});

it("rebinds the moved pane only when retained native and occupant identity match", async () => {
  const { session, agent, delivered } = await setup();
  agent.pane_id = "moved-pane";
  agent.workspace_id = "new-workspace";
  await session.prompt(prompt("moved"));
  expect(delivered).toMatchObject([{ method: "agent.prompt", params: { target: "moved-pane", text: "hello" } }]);
  expect(session.state.binding.terminalId).toBe("terminal");
});

it("does not mark recovery ready before delayed validation and transcript reconciliation", async () => {
  const native = makeAgent();
  let release!: () => void;
  let block = false;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let push!: (event: SubscriptionEventEnvelope) => void;
  const queue: SubscriptionEventEnvelope[] = [];
  let wake: (() => void) | undefined;
  let closed = false;
  const { session, events, delivered } = await setup({
    listAgents: async () => { if (block) await gate; return [native]; },
    subscribe: async () => ({
      [Symbol.asyncIterator]: async function* () {
        while (!closed) {
          if (!queue.length) await new Promise<void>((resolve) => { wake = resolve; });
          if (closed) return;
          const event = queue.shift();
          if (event) yield event;
        }
      },
      close() { closed = true; wake?.(); },
    }),
  });
  push = (event) => { queue.push(event); wake?.(); };
  push({ event: "observer.disconnected", data: undefined });
  await vi.waitFor(() => expect(session.state.connected).toBe(false));
  block = true;
  push({ event: "observer.connected", data: undefined });
  await session.prompt(prompt("during-loss"));
  expect(delivered).toEqual([]);
  expect(events.filter((event) => event.type === "session.notice" && event.notice.id === "connectivity" && event.notice.dismissed)).toEqual([]);
  release();
  await vi.waitFor(() => expect(session.state.connected).toBe(true));
  expect(events.filter((event) => event.type === "session.notice" && event.notice.id === "connectivity" && event.notice.dismissed))
    .toMatchObject([{ notice: { dismissed: true } }]);
});

it("recovers a rejected transcript read without poisoning later reads", async () => {
  const { session, store, events } = await setup();
  const reader = session.state.reader!;
  const snapshot = reader.snapshot.bind(reader);
  let fail = true;
  reader.snapshot = async () => { if (fail) throw new Error("temporarily unreadable"); return snapshot(); };
  await session.live.reconcile();
  expect(session.state.connected).toBe(false);
  fail = false;
  store.append({ id: "terminal-user", kind: "user", text: "after recovery" });
  store.append({ id: "terminal-end", kind: "assistant", text: "recovered answer" });
  await session.live.reconcile();
  expect(session.state.connected).toBe(true);
  expect(turns(events).map((event) => event.state)).toEqual(["started", "completed"]);
});

it("settles an uncertain prompt once native idle holds past the window, then admits the next prompt", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  const { session, setPromptError, delivered, events } = await setup();
  setPromptError(new HerdrError("agent_prompt_stalled", "stall"));
  await session.prompt(prompt("first"));
  setPromptError(null);
  expect(session.state.tracker.isUncertain).toBe(true);
  vi.setSystemTime(Date.now() + 10_000);
  await session.live.reconcile();
  await session.prompt(prompt("refused"));
  expect(events.filter((event) => event.type === "session.prompt_result" && event.clientMessageId === "refused"))
    .toMatchObject([{ result: { type: "failed", error: { message: "Agent is already working" } } }]);
  expect(turns(events)).toEqual([]);
  // F6: the settle clock starts at the first idle evidence (+10 s), not at the uncertainty, so
  // 16 s after the report is not enough; 15 s of continuous idle is.
  vi.setSystemTime(Date.now() + 6_000);
  await session.live.reconcile();
  expect(turns(events)).toEqual([]);
  vi.setSystemTime(Date.now() + 9_000);
  await session.live.reconcile();
  expect(turns(events).map((event) => event.state)).toEqual(["started", "failed"]);
  expect(session.state.tracker.activeTurn).toBeNull();
  await session.prompt(prompt("second"));
  expect(delivered.filter((request) => request.method === "agent.prompt")).toHaveLength(2);
  expect(events.filter((event) => event.type === "session.prompt_result" && event.clientMessageId === "second"))
    .toMatchObject([{ result: { type: "turn" } }]);
  expect(events.filter((event) => event.type === "session.prompt_result" && event.clientMessageId === "first"))
    .toMatchObject([{ result: { type: "turn" } }]);
});

it("settles an uncertain prompt on a foreign terminal entry and starts an autonomous turn", async () => {
  const { session, store, setPromptError, events } = await setup();
  setPromptError(new HerdrError("agent_prompt_stalled", "stall"));
  await session.prompt(prompt("paseo"));
  setPromptError(null);
  store.append({ id: "terminal-user", kind: "user", text: "from terminal" });
  await session.live.reconcile();
  expect(turns(events).map((event) => event.state)).toEqual(["started", "failed", "started"]);
  expect(turns(events)[1]).toMatchObject({ error: { message: expect.stringContaining("was not resent") } });
  expect(session.state.tracker.isActive).toBe(true);
  store.append({ id: "terminal-end", kind: "assistant", text: "terminal answer" });
  await session.live.reconcile();
  expect(turns(events).map((event) => event.state)).toEqual(["started", "failed", "started", "completed"]);
  expect(events.filter((event) => event.type === "session.prompt_result")).toMatchObject([{ clientMessageId: "paseo", result: { type: "turn" } }]);
});

it("classifies definite Herdr rejection separately from potentially delivered errors and mismatched replies", () => {
  const expectation: PromptExpectation = { terminalId: "terminal", sessionRef: { kind: "id", value: "fake-session-1" }, accepts: (kind) => kind === "fake" };
  expect(classifyHerdrPrompt(undefined, new HerdrError("agent_blocked", "blocked"), expectation)).toEqual({ type: "rejected", message: "blocked" });
  expect(classifyHerdrPrompt(undefined, new HerdrError("agent_prompt_stalled", "stall"), expectation)).toEqual({ type: "uncertain", message: "stall" });
  expect(classifyHerdrPrompt(undefined, new HerdrError("agent_prompt_failed", "write may be partial"), expectation)).toEqual({ type: "uncertain", message: "write may be partial" });
  expect(classifyHerdrPrompt({ type: "agent_prompted", agent: { ...makeAgent(), terminal_id: "other" } }, undefined, expectation).type).toBe("uncertain");
  expect(classifyHerdrPrompt({ type: "agent_prompted", agent: makeAgent() }, undefined, expectation)).toEqual({ type: "accepted" });
  // The adapter decides which Herdr kinds are its own; a reply naming another kind is not confirmation.
  expect(classifyHerdrPrompt({ type: "agent_prompted", agent: { ...makeAgent(), agent: "other" } }, undefined, expectation).type).toBe("uncertain");
  expect(classifyHerdrPrompt({ type: "agent_prompted", agent: { ...makeAgent(), agent: null } }, undefined, { ...expectation, accepts: () => true })).toEqual({ type: "accepted" });
  // A native-ref binding requires the same ref; a pane binding (null ref) takes whatever ref the agent reports.
  expect(classifyHerdrPrompt({ type: "agent_prompted", agent: { ...makeAgent(), agent_session: null } }, undefined, expectation).type).toBe("uncertain");
  expect(classifyHerdrPrompt({ type: "agent_prompted", agent: makeAgent() }, undefined, { ...expectation, sessionRef: null })).toEqual({ type: "accepted" });
  expect(classifyHerdrPrompt({ type: "agent_prompted", agent: { ...makeAgent(), agent_session: null } }, undefined, { ...expectation, sessionRef: null })).toEqual({ type: "accepted" });
});
