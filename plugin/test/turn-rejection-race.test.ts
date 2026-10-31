import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProviderEvent, ProviderPrompt } from "@getpaseo/plugin/server/provider";
import { HerdrHarnessSession } from "../server/session.js";
import { bindingOf } from "../server/binding.js";
import { HerdrError } from "../server/herdr/client.js";
import { TurnTracker, type TurnEffect } from "../server/turns.js";
import type { RestoredPromptOutcome } from "../server/harness/types.js";
import type { AgentInfo, AgentStatus } from "../server/herdr/schema.js";
import { FakeTranscript, makeFakeAdapter } from "./fake-harness.js";

/**
 * F5: a status observation made while `submitPrompt` is still pending must not accept the reservation, or a later
 * definite rejection is lost and a terminal-originated turn is attributed to the Paseo prompt.
 * F10: the restored-prompt notice states restoration as fact only when the adapter answered.
 */
const config = { cwd: "/work", env: {}, mcpServers: {}, settings: {}, persist: true };
const agentOf = (status: AgentStatus): AgentInfo => ({ terminal_id: "terminal", pane_id: "pane", agent: "fake", name: "demo", agent_status: status,
  agent_session: { source: "herdr:fake", agent: "fake", kind: "id", value: "fake-session-1" },
  workspace_id: "w", tab_id: "t", focused: true, screen_detection_skipped: false, state_labels: {}, tokens: {},
  launch_pending: false, interactive_ready: true, state_change_seq: 0, completion_seq: null, cwd: "/work", revision: 0 });
const prompt = (id: string, text = "hello"): ProviderPrompt => ({ clientMessageId: id, delivery: "auto", input: { type: "message", content: [{ type: "text", text }] } });
const sessions: HerdrHarnessSession[] = [];
afterEach(() => { for (const session of sessions.splice(0)) session.close(); });

async function setup(options: { discard?: (text: string) => Promise<RestoredPromptOutcome> } = {}) {
  const agent = agentOf("idle");
  const store = new FakeTranscript();
  store.set([{ id: "old-user", kind: "user", text: "old" }, { id: "old-end", kind: "assistant", text: "old answer" }]);
  const adapter = makeFakeAdapter(store);
  if (options.discard) adapter.discardRestoredPrompt = async (_target, text) => options.discard!(text);
  const events: ProviderEvent[] = [];
  let gate: Promise<void> | null = null;
  let rejection: string | null = null;
  const session = new HerdrHarnessSession("s", bindingOf(agent, adapter, null), {
    adapter, listAgents: async () => [structuredClone(agent)],
    request: async (method) => {
      if (method === "pane.process_info") return { type: "pane_process_info", process_info: { pane_id: "pane",
        foreground_process_group_id: 100, tty: "/dev/pts/fake", foreground_processes: [{ pid: 100, name: "fake" }] } };
      if (method === "agent.prompt") {
        const held = gate, reject = rejection;
        gate = null;
        rejection = null;
        await held;
        if (reject) throw new HerdrError("agent_not_ready", reject);
      }
      return { type: "agent_prompted", agent };
    },
    subscribe: async () => ({ [Symbol.asyncIterator]: async function* () {}, close() {} }),
    emit: (event) => events.push(event),
  });
  sessions.push(session);
  await session.open(config, "skip");
  await session.live.reconcile();
  /** Hold the next `agent.prompt`; releasing it fails it with `reject`, or lets it through. */
  const hold = (reject?: string) => {
    let release!: () => void;
    gate = new Promise<void>((resolve) => { release = resolve; });
    rejection = reject ?? null;
    return release;
  };
  return { session, store, agent, events, hold };
}
const turns = (events: ProviderEvent[]) => events.flatMap((e) => e.type === "session.turn" ? [{ turnId: e.turnId, state: e.state }] : []);
const results = (events: ProviderEvent[]) => events.flatMap((e) => e.type === "session.prompt_result" ? [`${e.clientMessageId}:${e.result.type}`] : []);
const tick = () => new Promise((r) => setTimeout(r, 5));

describe("TurnTracker: status observed while delivery is in flight", () => {
  function makeTracker() {
    const effects: TurnEffect[] = [];
    const tracker = new TurnTracker({ now: () => 0, onEffect: (effect) => effects.push(effect) });
    return { tracker, effects };
  }

  it.each(["working", "blocked"] as const)("%s before the response does not accept the reservation", (status) => {
    const { tracker, effects } = makeTracker();
    tracker.reservePending({ turnId: "t1", clientMessageId: "m1" });
    tracker.observeStatus(status);
    expect(tracker.isPending).toBe(true);
    expect(effects.filter((e) => e.type === "prompt_accepted" || e.type === "turn")).toEqual([]);
  });

  it("a rejection after working fails the prompt and continues the work as a terminal turn", () => {
    const { tracker, effects } = makeTracker();
    tracker.reservePending({ turnId: "t1", clientMessageId: "m1" });
    tracker.observeStatus("working");
    tracker.rejectPending("Agent is busy");
    expect(effects.filter((e) => e.type !== "notice")).toEqual([
      { type: "prompt_failed", clientMessageId: "m1", message: "Agent is busy" },
      { type: "turn", turnId: expect.not.stringMatching(/^t1$/), state: "started" },
    ]);
    expect(tracker.isActive).toBe(true);
    expect(tracker.activeTurn).not.toBe("t1");
    tracker.observeStatus("idle");
    tracker.observeNativeTurnEnd("completed");
    expect(tracker.activeTurn).toBeNull();
  });

  it("a rejection after the work already stopped leaves no turn behind", () => {
    const { tracker, effects } = makeTracker();
    tracker.reservePending({ turnId: "t1", clientMessageId: "m1" });
    tracker.observeStatus("working");
    tracker.observeStatus("idle");
    tracker.rejectPending("Agent is busy");
    expect(effects).toEqual([{ type: "prompt_failed", clientMessageId: "m1", message: "Agent is busy" }]);
    expect(tracker.activeTurn).toBeNull();
  });

  it("a rejection with no status observed behaves as before", () => {
    const { tracker, effects } = makeTracker();
    tracker.reservePending({ turnId: "t1", clientMessageId: "m1" });
    tracker.rejectPending("Agent is busy");
    expect(effects).toEqual([{ type: "prompt_failed", clientMessageId: "m1", message: "Agent is busy" }]);
    expect(tracker.activeTurn).toBeNull();
  });

  it("an acceptance after working reports the reserved turn once", () => {
    const { tracker, effects } = makeTracker();
    tracker.reservePending({ turnId: "t1", clientMessageId: "m1" });
    tracker.observeStatus("working");
    tracker.acceptPending();
    expect(effects).toEqual([
      { type: "prompt_accepted", clientMessageId: "m1", turnId: "t1" },
      { type: "turn", turnId: "t1", state: "started" },
    ]);
  });
});

describe("rejection racing a status observation", () => {
  it("working seen while submit is pending, then rejection: the prompt fails and the turn is not Paseo's", async () => {
    const { session, store, agent, events, hold } = await setup();
    const release = hold("Agent is busy");
    const pending = session.prompt(prompt("p1"));
    await tick();
    agent.agent_status = "working"; // a turn typed in the terminal begins while our input is in flight
    await session.live.reconcile();
    expect(results(events)).toEqual([]); // not reported as accepted
    expect(turns(events)).toEqual([]);
    release();
    await pending;
    expect(results(events)).toEqual(["p1:failed"]);
    expect(events.find((e) => e.type === "session.prompt_result")).toMatchObject({ result: { error: { message: "Agent is busy" } } });
    // The terminal's work is tracked on its own, never under a prompt result.
    const started = turns(events);
    expect(started).toHaveLength(1);
    expect(started[0]!.state).toBe("started");
    expect(session.state.tracker.activeTurn).toBe(started[0]!.turnId);
    expect(session.state.pending).toBeNull();
    store.append({ id: "u1", kind: "user", text: "typed in terminal" });
    store.append({ id: "a1", kind: "assistant", text: "ok" });
    agent.agent_status = "done";
    await session.live.reconcile();
    expect(turns(events).map((t) => t.state)).toEqual(["started", "completed"]);
    expect(results(events)).toEqual(["p1:failed"]);
    await session.prompt(prompt("p2", "again"));
    expect(results(events)).toEqual(["p1:failed", "p2:turn"]);
  });

  it("a rejection when no status raced it only fails the prompt", async () => {
    const { session, events, hold } = await setup();
    const release = hold("Agent is busy");
    const pending = session.prompt(prompt("p1"));
    await tick();
    release();
    await pending;
    expect(results(events)).toEqual(["p1:failed"]);
    expect(turns(events)).toEqual([]);
    expect(session.state.tracker.activeTurn).toBeNull();
  });

  it("working seen while submit is pending, then acceptance: one turn owned by the prompt", async () => {
    const { session, agent, events, hold } = await setup();
    const release = hold();
    const pending = session.prompt(prompt("p1"));
    await tick();
    agent.agent_status = "working";
    await session.live.reconcile();
    release();
    await pending;
    expect(results(events)).toEqual(["p1:turn"]);
    const result = events.find((e) => e.type === "session.prompt_result");
    const started = turns(events);
    expect(started.map((t) => t.state)).toEqual(["started"]);
    expect(result).toMatchObject({ result: { type: "turn", turnId: started[0]!.turnId } });
    expect(session.state.tracker.activeTurn).toBe(started[0]!.turnId);
  });

  it("working after the prompt was accepted: unchanged", async () => {
    const { session, agent, events } = await setup();
    await session.prompt(prompt("p1"));
    agent.agent_status = "working";
    await session.live.reconcile();
    expect(results(events)).toEqual(["p1:turn"]);
    expect(turns(events).map((t) => t.state)).toEqual(["started"]);
  });

  it("a working echo right after a rejected send starts no terminal turn (F2)", async () => {
    const { session, agent, events, hold } = await setup();
    // The previous Paseo turn was stopped fast: its native end is consumed, so Herdr's late `working` is an echo.
    session.state.staleWorking = { endId: "old-end", echoed: false };
    const release = hold("Agent is busy");
    const pending = session.prompt(prompt("p1"));
    await tick();
    agent.agent_status = "working";
    await session.live.reconcile();
    release();
    await pending;
    expect(results(events)).toEqual(["p1:failed"]);
    expect(turns(events)).toEqual([]);
    expect(session.state.tracker.activeTurn).toBeNull();
    // Once the echo ends the guard clears, and genuinely new work opens a turn again.
    agent.agent_status = "idle";
    await session.live.reconcile();
    expect(session.state.staleWorking).toBeNull();
    agent.agent_status = "working";
    await session.live.reconcile();
    expect(turns(events).map((t) => t.state)).toEqual(["started"]);
  });
});

describe("restored-prompt notice (F10)", () => {
  beforeEach(() => { vi.useFakeTimers({ toFake: ["Date"] }); });
  afterEach(() => { vi.useRealTimers(); });
  const advance = (ms: number) => { vi.setSystemTime(Date.now() + ms); };
  /** Stop right after a prompt, then Herdr idles with no user entry: the early-abort path cancels and asks the adapter. */
  async function abortEarly(discard?: (text: string) => Promise<RestoredPromptOutcome>) {
    const rig = await setup({ discard });
    await rig.session.prompt(prompt("p1"));
    await rig.session.interrupt("stop-1");
    rig.agent.agent_status = "idle";
    let elapsed = 0;
    for (const at of [1200, 2400, 4000, 9000]) { advance(at - elapsed); elapsed = at; await rig.session.live.reconcile(); }
    await tick();
    expect(turns(rig.events).map((t) => t.state)).toEqual(["started", "canceled"]);
    return restoredNotices(rig.events);
  }
  const restoredNotices = (all: ProviderEvent[]) => all.flatMap((e) => e.type === "session.notice" && e.notice.id === "restored-prompt" ? [e.notice] : []);
  const claimed = (n: { title: string; description?: string }) => /put your message back/.test(n.title) || /^The message was not sent\./.test(n.description ?? "");

  it("an adapter without discardRestoredPrompt neither claims delivery nor denies delivery or typing", async () => {
    const notices = await abortEarly();
    expect(notices).toHaveLength(1);
    expect(claimed(notices[0]!)).toBe(false);
    const text = `${notices[0]!.title} ${notices[0]!.description}`;
    expect(text).not.toMatch(/nothing was typed|not delivered|did not receive|was not sent|not typed/i);
    expect(text).not.toMatch(/was (delivered|received|sent)\b/i);
    expect(notices[0]!.title).toBe("Fake may not have received your message");
    expect(notices[0]!.description).toBe("The message was typed into the terminal and may still be in the input box. Check the terminal before sending it again.");
  });

  it("an adapter that cannot tell, or fails, gets the conditional notice", async () => {
    const unsupported = await abortEarly(async () => "unsupported");
    expect(unsupported.map(claimed)).toEqual([false]);
  });

  it("an adapter that throws gets the conditional notice", async () => {
    const thrown = await abortEarly(async () => { throw new Error("socket closed"); });
    expect(thrown).toHaveLength(1);
    expect(claimed(thrown[0]!)).toBe(false);
  });

  it("an adapter that answered kept reports retained text without claiming the message was not sent", async () => {
    const notices = await abortEarly(async () => "kept");
    expect(notices).toHaveLength(1);
    expect(notices[0]!.title).toMatch(/kept text in its input box/);
    expect(claimed(notices[0]!)).toBe(false);
    expect(notices[0]!.description).toMatch(/^The input box was not cleared.*clear the input box.*Open in terminal/);
  });

  it("an adapter that could not tell (unknown) gets the conditional notice, not a kept claim", async () => {
    const notices = await abortEarly(async () => "unknown");
    expect(notices).toHaveLength(1);
    expect(notices[0]!.title).toMatch(/may have kept your message/);
    expect(notices[0]!.description).toMatch(/^If the message was not sent.*clear the input box.*Open in terminal/);
    expect(notices[0]!.title).not.toMatch(/kept text/);
  });

  it("a cleared draft produces no notice", async () => {
    expect(await abortEarly(async () => "cleared")).toEqual([]);
  });
});
