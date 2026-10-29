import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProviderEvent, ProviderPrompt } from "@getpaseo/plugin/server/provider";
import { HerdrHarnessSession } from "../server/session.js";
import { bindingOf } from "../server/binding.js";
import type { RestoredPromptOutcome } from "../server/harness/types.js";
import type { AgentInfo, AgentStatus } from "../server/herdr/schema.js";
import { FakeTranscript, makeFakeAdapter } from "./fake-harness.js";

/**
 * V2: Stop sent almost immediately after a prompt. OMP aborts its turn right after writing the user entry, so the
 * transcript shows user + aborted assistant. Whatever point the interrupt lands at (submit still in flight, submit done
 * but no user entry yet, user entry present but no abort yet), the Paseo turn must end exactly once and the next prompt
 * must be admitted once the agent is idle.
 */
const config = { cwd: "/work", env: {}, mcpServers: {}, settings: {}, persist: true };
const agentOf = (status: AgentStatus): AgentInfo => ({ terminal_id: "terminal", pane_id: "pane", agent: "fake", name: "demo", agent_status: status,
  agent_session: { source: "herdr:fake", agent: "fake", kind: "id", value: "fake-session-1" },
  workspace_id: "w", tab_id: "t", focused: true, screen_detection_skipped: false, state_labels: {}, tokens: {},
  launch_pending: false, interactive_ready: true, state_change_seq: 0, completion_seq: null, cwd: "/work", revision: 0 });
const prompt = (id: string, text = "hello"): ProviderPrompt => ({ clientMessageId: id, delivery: "auto", input: { type: "message", content: [{ type: "text", text }] } });
const sessions: HerdrHarnessSession[] = [];
afterEach(() => { for (const session of sessions.splice(0)) session.close(); });

async function setup(discard?: (text: string) => Promise<RestoredPromptOutcome>) {
  const agent = agentOf("idle");
  const store = new FakeTranscript();
  store.set([{ id: "old-user", kind: "user", text: "old" }, { id: "old-end", kind: "assistant", text: "old answer" }]);
  const adapter = makeFakeAdapter(store);
  const discards: string[] = [];
  if (discard) adapter.discardRestoredPrompt = async (_target, text) => { discards.push(text); return discard(text); };
  const events: ProviderEvent[] = [];
  const sent: string[] = [];
  let gate: Promise<void> | null = null;
  const session = new HerdrHarnessSession("s", bindingOf(agent, adapter, null), {
    adapter, listAgents: async () => [structuredClone(agent)],
    request: async (method) => {
      if (method === "pane.process_info") return { type: "pane_process_info", process_info: { pane_id: "pane",
        foreground_process_group_id: 100, tty: "/dev/pts/fake", foreground_processes: [{ pid: 100, name: "fake" }] } };
      sent.push(method);
      if (method === "agent.prompt") await gate;
      return { type: "agent_prompted", agent };
    },
    subscribe: async () => ({ [Symbol.asyncIterator]: async function* () {}, close() {} }),
    emit: (event) => events.push(event),
  });
  sessions.push(session);
  await session.open(config, "skip");
  await session.live.reconcile();
  const hold = () => { let release!: () => void; gate = new Promise<void>((resolve) => { release = resolve; }); return release; };
  return { session, store, agent, events, sent, hold, discards };
}
const turnStates = (events: ProviderEvent[]) => events.flatMap((e) => e.type === "session.turn" ? [e.state] : []);
const results = (events: ProviderEvent[]) => events.flatMap((e) => e.type === "session.prompt_result" ? [`${e.clientMessageId}:${e.result.type}`] : []);
const abortedTurn = (store: FakeTranscript) => {
  store.append({ id: "u1", kind: "user", text: "hello" });
  store.append({ id: "a1", kind: "assistant", text: "", end: "aborted" });
};

describe("V2 early Stop", () => {
  for (const herdrStatus of ["idle", "working", "done"] as const) describe(`herdr status ${herdrStatus}`, () => {
    it("Stop while submit is still in flight ends the turn and keeps input usable", async () => {
      const { session, store, agent, events, sent, hold } = await setup();
      const release = hold();
      const pending = session.prompt(prompt("p1"));
      await new Promise((r) => setTimeout(r, 5));
      const stop = session.interrupt("stop-1"); // tracker is still pending: Stop waits for the delivery
      await new Promise((r) => setTimeout(r, 5));
      expect(sent.filter((m) => m === "pane.send_keys")).toHaveLength(0);
      release();
      await pending;
      await stop;
      // The Stop was applied to the turn it was pressed for, not dropped.
      expect(sent.filter((m) => m === "pane.send_keys")).toHaveLength(1);
      expect(events.some((e) => e.type === "request.completed" && e.requestId === "stop-1")).toBe(true);
      abortedTurn(store);
      agent.agent_status = herdrStatus;
      await session.live.reconcile();
      agent.agent_status = "idle";
      await session.live.reconcile();
      expect(turnStates(events)).toEqual(["started", "canceled"]);
      expect(session.state.tracker.activeTurn).toBeNull();
      await session.prompt(prompt("p2", "again"));
      expect(results(events)).toEqual(["p1:turn", "p2:turn"]);
      expect(sent.filter((m) => m === "agent.prompt")).toHaveLength(2);
    });

    it("Stop after submit resolved but before the user entry appears", async () => {
      const { session, store, agent, events } = await setup();
      await session.prompt(prompt("p1"));
      await session.interrupt("stop-1");
      agent.agent_status = herdrStatus;
      await session.live.reconcile();
      abortedTurn(store);
      agent.agent_status = "idle";
      await session.live.reconcile();
      expect(turnStates(events)).toEqual(["started", "canceled"]);
      await session.prompt(prompt("p2", "again"));
      expect(results(events)).toEqual(["p1:turn", "p2:turn"]);
    });

    it("Stop after the user entry but before the native abort", async () => {
      const { session, store, agent, events } = await setup();
      await session.prompt(prompt("p1"));
      store.append({ id: "u1", kind: "user", text: "hello" });
      agent.agent_status = herdrStatus;
      await session.live.reconcile();
      await session.interrupt("stop-1");
      store.append({ id: "a1", kind: "assistant", text: "", end: "aborted" });
      agent.agent_status = "idle";
      await session.live.reconcile();
      expect(turnStates(events)).toEqual(["started", "canceled"]);
      await session.prompt(prompt("p2", "again"));
      expect(results(events)).toEqual(["p1:turn", "p2:turn"]);
    });
  });

  describe("late Herdr working echo after the transcript already ended the turn", () => {
    /** The whole turn (user entry + abort) lands before Herdr ever reports `working`; the status arrives afterwards. */
    for (const stage of ["submit in flight", "submit resolved", "user entry seen"] as const) {
      it(`does not start a phantom turn that can never end (${stage})`, async () => {
        const { session, store, agent, events, hold } = await setup();
        const release = stage === "submit in flight" ? hold() : null;
        const pending = session.prompt(prompt("p1"));
        if (release) await new Promise((r) => setTimeout(r, 5)); else await pending;
        const stop = session.interrupt("stop-1"); // with submit in flight, Stop waits for the delivery
        if (stage === "user entry seen") { store.append({ id: "u1", kind: "user", text: "hello" }); await session.live.reconcile(); store.append({ id: "a1", kind: "assistant", text: "", end: "aborted" }); }
        else abortedTurn(store);
        await session.live.reconcile(); // Herdr still says idle: the transcript alone ends the turn
        release?.();
        await pending;
        await stop;
        expect(turnStates(events)).toEqual(["started", "canceled"]);
        agent.agent_status = "working"; // Herdr's late status for the already finished turn
        await session.live.reconcile();
        agent.agent_status = "done";
        await session.live.reconcile();
        await session.live.reconcile();
        expect(turnStates(events)).toEqual(["started", "canceled"]);
        expect(session.state.tracker.activeTurn).toBeNull();
        await session.prompt(prompt("p2", "again"));
        expect(results(events)).toEqual(["p1:turn", "p2:turn"]);
      });
    }

    it("still starts a terminal turn when the transcript moves on", async () => {
      const { session, store, agent, events } = await setup();
      await session.prompt(prompt("p1"));
      abortedTurn(store);
      await session.live.reconcile();
      agent.agent_status = "working";
      await session.live.reconcile();
      store.append({ id: "u2", kind: "user", text: "typed in terminal" });
      await session.live.reconcile();
      expect(turnStates(events)).toEqual(["started", "canceled", "started"]);
      store.append({ id: "a2", kind: "assistant", text: "ok" });
      agent.agent_status = "done";
      await session.live.reconcile();
      expect(turnStates(events)).toEqual(["started", "canceled", "started", "completed"]);
    });
  });
});

describe("no-transcript abort (Stop before the harness recorded the prompt)", () => {
  beforeEach(() => { vi.useFakeTimers({ toFake: ["Date"] }); });
  afterEach(() => { vi.useRealTimers(); });
  const advance = (ms: number) => { vi.setSystemTime(Date.now() + ms); };
  const noticeIds = (events: ProviderEvent[]) => events.flatMap((e) => e.type === "session.notice" ? [e.notice.id] : []);
  const flush = () => new Promise((r) => setTimeout(r, 5));
  /** Herdr idles with no user entry ever written; observe at the given offsets after the interrupt. */
  async function observeIdle(session: HerdrHarnessSession, offsets: number[]) {
    let elapsed = 0;
    for (const at of offsets) { advance(at - elapsed); elapsed = at; await session.live.reconcile(); }
  }

  for (const herdrStatus of ["idle", "done"] as const) for (const point of ["submit in flight", "submit resolved"] as const) {
    it(`ends canceled exactly once and admits the next prompt (${point}, herdr ${herdrStatus})`, async () => {
      const { session, agent, events, hold, discards } = await setup(async () => "cleared");
      const release = point === "submit in flight" ? hold() : null;
      const pending = session.prompt(prompt("p1"));
      if (release) await new Promise((r) => setTimeout(r, 5));
      const stop = session.interrupt("stop-1");
      release?.();
      await pending; await stop;
      agent.agent_status = herdrStatus;
      await observeIdle(session, [200, 600, 1000, 1500, 2200, 3000, 12_000]);
      await flush();
      expect(turnStates(events)).toEqual(["started", "canceled"]);
      const canceled = events.find((e) => e.type === "session.turn" && e.state === "canceled");
      expect(canceled).toMatchObject({ error: { message: "Stopped before Fake started this turn; nothing was sent to the model." } });
      expect(noticeIds(events)).not.toContain("interrupt-pending");
      expect(discards).toEqual(["hello"]);
      expect(noticeIds(events)).not.toContain("restored-prompt");
      expect(session.state.tracker.activeTurn).toBeNull();
      await session.prompt(prompt("p2", "again"));
      expect(results(events)).toEqual(["p1:turn", "p2:turn"]);
    });
  }

  it("does not cancel while Herdr still says working, or on a single idle observation", async () => {
    const { session, agent, events } = await setup(async () => "cleared");
    await session.prompt(prompt("p1"));
    await session.interrupt("stop-1");
    agent.agent_status = "working";
    await observeIdle(session, [1500, 3000, 5000]);
    expect(turnStates(events)).toEqual(["started"]);
    agent.agent_status = "idle";
    advance(100); await session.live.reconcile();
    expect(turnStates(events)).toEqual(["started"]);
  });

  it("does not cancel before the interrupt has had time to land", async () => {
    const { session, agent, events } = await setup(async () => "cleared");
    await session.prompt(prompt("p1"));
    await session.interrupt("stop-1");
    agent.agent_status = "idle";
    await observeIdle(session, [100, 300, 600, 900]);
    expect(turnStates(events)).toEqual(["started"]);
  });

  it("does not cancel without a Stop (plain slow start with Herdr idle)", async () => {
    const { session, agent, events } = await setup(async () => "cleared");
    await session.prompt(prompt("p1"));
    agent.agent_status = "idle";
    await observeIdle(session, [1500, 3000, 6000]);
    expect(turnStates(events)).toEqual(["started"]);
  });

  it("a slow but real start (user entry within the window) is not canceled", async () => {
    const { session, store, agent, events, discards } = await setup(async () => "cleared");
    await session.prompt(prompt("p1"));
    await session.interrupt("stop-1");
    agent.agent_status = "idle";
    await observeIdle(session, [1200]);
    store.append({ id: "u1", kind: "user", text: "hello" });
    await observeIdle(session, [2300, 4000]);
    expect(turnStates(events)).toEqual(["started"]);
    expect(discards).toEqual([]);
    store.append({ id: "a1", kind: "assistant", text: "", end: "aborted" });
    await observeIdle(session, [4100]);
    expect(turnStates(events)).toEqual(["started", "canceled"]);
  });

  it("a user entry that appears after the cancel is a separate terminal turn, never the canceled one", async () => {
    const { session, store, agent, events } = await setup(async () => "cleared");
    await session.prompt(prompt("p1"));
    await session.interrupt("stop-1");
    agent.agent_status = "idle";
    await observeIdle(session, [1200, 2400]);
    await flush();
    expect(turnStates(events)).toEqual(["started", "canceled"]);
    const first = events.find((e) => e.type === "session.turn");
    store.append({ id: "u1", kind: "user", text: "hello" });
    agent.agent_status = "working";
    await session.live.reconcile();
    expect(turnStates(events)).toEqual(["started", "canceled", "started"]);
    const turnIds = events.flatMap((e) => e.type === "session.turn" ? [e.turnId] : []);
    expect(turnIds[2]).not.toBe(turnIds[0]);
    expect(first).toBeDefined();
    store.append({ id: "a1", kind: "assistant", text: "late answer" });
    agent.agent_status = "done";
    await session.live.reconcile();
    expect(turnStates(events)).toEqual(["started", "canceled", "started", "completed"]);
    expect(results(events)).toEqual(["p1:turn"]);
  });

  it("a late Herdr working for the aborted turn does not open a phantom turn", async () => {
    const { session, agent, events } = await setup(async () => "cleared");
    await session.prompt(prompt("p1"));
    await session.interrupt("stop-1");
    agent.agent_status = "idle";
    await observeIdle(session, [1200, 2400]);
    expect(turnStates(events)).toEqual(["started", "canceled"]);
    agent.agent_status = "working";
    await session.live.reconcile();
    agent.agent_status = "idle";
    await session.live.reconcile(); await session.live.reconcile();
    expect(turnStates(events)).toEqual(["started", "canceled"]);
    await session.prompt(prompt("p2", "again"));
    expect(results(events)).toEqual(["p1:turn", "p2:turn"]);
  });

  it.each(["kept", "unsupported"] as const)("a %s restored draft yields one notice and is attempted once", async (outcome) => {
    const { session, agent, events, discards } = await setup(async () => outcome);
    await session.prompt(prompt("p1"));
    await session.interrupt("stop-1");
    agent.agent_status = "idle";
    await observeIdle(session, [1200, 2400, 4000, 9000]);
    await flush();
    expect(discards).toEqual(["hello"]);
    const notices = events.flatMap((e) => e.type === "session.notice" && e.notice.id === "restored-prompt" ? [e.notice] : []);
    expect(notices).toHaveLength(1);
    expect(notices[0]!.description).toMatch(/clear the input box.*Open in terminal/);
    expect(turnStates(events)).toEqual(["started", "canceled"]);
  });

  it("an adapter without the hook gives the notice", async () => {
    const { session, agent, events } = await setup();
    await session.prompt(prompt("p1"));
    await session.interrupt("stop-1");
    agent.agent_status = "idle";
    await observeIdle(session, [1200, 2400]);
    await flush();
    expect(noticeIds(events).filter((id) => id === "restored-prompt")).toHaveLength(1);
  });
});
