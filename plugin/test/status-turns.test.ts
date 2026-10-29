import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProviderEvent, ProviderPrompt } from "@getpaseo/plugin/server/provider";
import { HerdrHarnessSession } from "../server/session.js";
import { bindingOf } from "../server/binding.js";
import type { AgentInfo, AgentStatus } from "../server/herdr/schema.js";
import { FakeTranscript, makeFakeAdapter } from "./fake-harness.js";

/**
 * SC: the status-evidence turn lifecycle through a real HerdrHarnessSession on a `turnEvidence: "status"` fake.
 * Herdr's agent status plus its `state_change_seq`/`completion_seq` counters are the only turn evidence:
 * a Paseo turn ends with no native transcript end marker, a terminal turn right after it still starts (no
 * staleWorking echo suppression), the early-abort cancel never runs, and the tracker's next deadline drives
 * one reconcile timer. `agent.list` is mutated per poll the way Herdr's counter updates arrive.
 */
const config = { cwd: "/work", env: {}, mcpServers: {}, settings: {}, persist: true };
const agentOf = (status: AgentStatus): AgentInfo => ({ terminal_id: "terminal", pane_id: "pane", agent: "fake", name: "demo", agent_status: status,
  agent_session: { source: "herdr:fake", agent: "fake", kind: "id", value: "fake-session-1" },
  workspace_id: "w", tab_id: "t", focused: true, screen_detection_skipped: false, state_labels: {}, tokens: {},
  launch_pending: false, interactive_ready: true, state_change_seq: 0, completion_seq: null, cwd: "/work", revision: 0 });
const prompt = (id: string, text = "hello"): ProviderPrompt => ({ clientMessageId: id, delivery: "auto", input: { type: "message", content: [{ type: "text", text }] } });
const sessions: HerdrHarnessSession[] = [];
afterEach(() => { for (const session of sessions.splice(0)) session.close(); });

async function setup(options: { stallFirstPrompt?: boolean } = {}) {
  const agent = agentOf("idle");
  const store = new FakeTranscript();
  store.set([{ id: "old-user", kind: "user", text: "old" }, { id: "old-end", kind: "assistant", text: "old answer" }]);
  const adapter = makeFakeAdapter(store, { turnEvidence: "status" });
  const events: ProviderEvent[] = [];
  const sent: string[] = [];
  let stalled = false;
  const session = new HerdrHarnessSession("s", bindingOf(agent, adapter, null), {
    adapter, listAgents: async () => [structuredClone(agent)],
    request: async (method) => {
      if (method === "pane.process_info") return { type: "pane_process_info", process_info: { pane_id: "pane",
        foreground_process_group_id: 100, tty: "/dev/pts/fake", foreground_processes: [{ pid: 100, name: "fake" }] } };
      sent.push(method);
      if (method === "agent.prompt" && options.stallFirstPrompt && !stalled) {
        stalled = true; // a transport failure the classifier cannot rule a rejection: delivery is uncertain
        throw new Error("socket stalled mid-delivery");
      }
      return { type: "agent_prompted", agent };
    },
    subscribe: async () => ({ [Symbol.asyncIterator]: async function* () {}, close() {} }),
    emit: (event) => events.push(event),
  });
  sessions.push(session);
  await session.open(config, "skip");
  await session.live.reconcile();
  return { session, store, agent, events, sent };
}
const turnStates = (events: ProviderEvent[]) => events.flatMap((e) => e.type === "session.turn" ? [e.state] : []);
const results = (events: ProviderEvent[]) => events.flatMap((e) => e.type === "session.prompt_result" ? [`${e.clientMessageId}:${e.result.type}`] : []);
const noticeIds = (events: ProviderEvent[]) => events.flatMap((e) => e.type === "session.notice" ? [e.notice.id] : []);

describe("status-evidence turns (turnEvidence: status)", () => {
  beforeEach(() => { vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout", "setInterval", "clearInterval"] }); });
  afterEach(() => { vi.useRealTimers(); });
  const advance = (ms: number) => vi.setSystemTime(Date.now() + ms);
  const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };

  it("ends a Paseo turn with no native end marker, and frees the next prompt", async () => {
    const { session, store, agent, events } = await setup();
    await session.prompt(prompt("p1"));
    expect(turnStates(events)).toEqual(["started"]);
    agent.agent_status = "working"; agent.state_change_seq = 1;
    await session.live.reconcile();
    expect(turnStates(events)).toEqual(["started"]); // working keeps the turn open
    agent.agent_status = "done"; agent.completion_seq = 1;
    await session.live.reconcile();
    expect(turnStates(events)).toEqual(["started", "completed"]); // completionSeq advance ends at once
    expect(session.state.tracker.activeTurn).toBeNull();
    expect(store.lastEntry?.id).toBe("old-end"); // no transcript row was ever written for the turn
    await session.prompt(prompt("p2", "again"));
    expect(results(events)).toEqual(["p1:turn", "p2:turn"]);
  });

  it("starts a terminal turn right after a status-ended Paseo turn (no staleWorking suppression)", async () => {
    const { session, agent, events } = await setup();
    await session.prompt(prompt("p1"));
    agent.agent_status = "working"; agent.state_change_seq = 1;
    await session.live.reconcile();
    agent.agent_status = "done"; agent.completion_seq = 1;
    await session.live.reconcile();
    agent.agent_status = "working"; agent.state_change_seq = 2; // the user types in the terminal
    await session.live.reconcile();
    const ids = events.flatMap((e) => e.type === "session.turn" ? [e.turnId] : []);
    expect(turnStates(events)).toEqual(["started", "completed", "started"]);
    expect(ids[2]).not.toBe(ids[0]);
    agent.agent_status = "idle"; agent.state_change_seq = 3;
    await session.live.reconcile(); // idle hold starts
    advance(3_100);
    await session.live.reconcile();
    expect(turnStates(events)).toEqual(["started", "completed", "started", "completed"]);
  });

  it("Stop with no transcript entry never early-aborts; the turn completes via the no-activity settle", async () => {
    const { session, agent, events, sent } = await setup();
    await session.prompt(prompt("p1"));
    await session.interrupt("stop-1");
    expect(sent).toContain("pane.send_keys");
    agent.agent_status = "idle"; // Herdr never reports working; no user entry ever appears
    let elapsed = 0;
    for (const at of [1_200, 2_400, 4_000, 9_000, 14_000]) { advance(at - elapsed); elapsed = at; await session.live.reconcile(); }
    expect(turnStates(events)).toEqual(["started"]); // transcript mode would have canceled by ~2.4 s
    advance(2_300); // 16_300: 15 s held since the first idle observation
    await session.live.reconcile();
    expect(turnStates(events)).toEqual(["started", "completed"]);
    expect(noticeIds(events)).toContain("no-activity");
    expect(session.state.pending).toBeNull();
    await session.prompt(prompt("p2", "again"));
    expect(results(events)).toEqual(["p1:turn", "p2:turn"]);
  });

  it("arms one reconcile timer for the tracker's next deadline", async () => {
    const { session, agent, events } = await setup();
    await session.prompt(prompt("p1"));
    agent.agent_status = "working"; agent.state_change_seq = 1;
    await session.live.reconcile();
    agent.agent_status = "idle"; agent.state_change_seq = 2; // activity seen; a 3 s deadline is armed
    await session.live.reconcile();
    expect(turnStates(events)).toEqual(["started"]);
    await vi.advanceTimersByTimeAsync(3_000); // the deadline timer reconciles by itself
    await flush();
    expect(turnStates(events)).toEqual(["started", "completed"]);
  });

  it("tolerates an unknown status without ending the turn or freezing the session", async () => {
    const { session, agent, events } = await setup();
    await session.prompt(prompt("p1"));
    agent.agent_status = "working"; agent.state_change_seq = 1;
    await session.live.reconcile();
    agent.agent_status = "unknown";
    advance(31_000); // past the transcript-mode unknownBindingLossMs window
    await session.live.reconcile();
    await session.live.reconcile();
    expect(turnStates(events)).toEqual(["started"]);
    expect(session.state.outcome).toBe("active");
    agent.agent_status = "done"; agent.completion_seq = 1;
    await session.live.reconcile();
    expect(turnStates(events)).toEqual(["started", "completed"]);
  });

  it("an uncertain delivery is accepted when Herdr shows the work", async () => {
    const { session, agent, events } = await setup({ stallFirstPrompt: true });
    await session.prompt(prompt("p1"));
    expect(results(events)).toEqual(["p1:turn"]); // reported as uncertain, not failed
    agent.agent_status = "working"; agent.state_change_seq = 1;
    await session.live.reconcile();
    expect(turnStates(events)).toEqual(["started"]);
    agent.agent_status = "done"; agent.completion_seq = 1;
    await session.live.reconcile();
    expect(turnStates(events)).toEqual(["started", "completed"]);
    expect(results(events)).toEqual(["p1:turn"]);
  });

  it("an uncertain delivery that never lands fails after continuous idle and frees the next prompt", async () => {
    const { session, agent, events } = await setup({ stallFirstPrompt: true });
    await session.prompt(prompt("p1"));
    expect(session.state.pending).not.toBeNull();
    let elapsed = 0;
    for (const at of [100, 8_000, 15_200]) { advance(at - elapsed); elapsed = at; await session.live.reconcile(); }
    expect(turnStates(events)).toEqual(["started", "failed"]);
    expect(session.state.pending).toBeNull();
    await session.prompt(prompt("p2", "again"));
    expect(results(events)).toEqual(["p1:turn", "p2:turn"]);
    expect(turnStates(events)).toEqual(["started", "failed", "started"]);
  });
});
