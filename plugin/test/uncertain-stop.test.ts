import { afterEach, expect, it, vi } from "vitest";
import type { ProviderEvent, ProviderPrompt } from "@getpaseo/plugin/server/provider";
import { HerdrHarnessSession } from "../server/session.js";
import { bindingOf } from "../server/binding.js";
import { HerdrError } from "../server/herdr/client.js";
import type { TurnEvidence } from "../server/harness/types.js";
import type { AgentInfo, AgentStatus } from "../server/herdr/schema.js";
import { FakeTranscript, makeFakeAdapter } from "./fake-harness.js";

/**
 * Stop while `agent.prompt` came back uncertain: Paseo does not know whether the agent took the prompt. Herdr's status
 * decides. Working: send the interrupt keys (the work may be ours). Idle/done: send nothing (a bare ctrl+c can exit
 * some harnesses), cancel the reservation, never resubmit.
 */
const config = { cwd: "/work", env: {}, mcpServers: {}, settings: {}, persist: true };
const agentOf = (status: AgentStatus): AgentInfo => ({ terminal_id: "terminal", pane_id: "pane", agent: "fake", name: "demo", agent_status: status,
  agent_session: { source: "herdr:fake", agent: "fake", kind: "id", value: "fake-session-1" },
  workspace_id: "w", tab_id: "t", focused: true, screen_detection_skipped: false, state_labels: {}, tokens: {},
  launch_pending: false, interactive_ready: true, state_change_seq: 0, completion_seq: null, cwd: "/work", revision: 0 });
const prompt = (id: string, text = "hello"): ProviderPrompt => ({ clientMessageId: id, delivery: "auto", input: { type: "message", content: [{ type: "text", text }] } });
const sessions: HerdrHarnessSession[] = [];
afterEach(() => { for (const session of sessions.splice(0)) session.close(); vi.useRealTimers(); });

const turns = (events: ProviderEvent[]) => events.flatMap((e) => e.type === "session.turn" ? [{ state: e.state, error: e.error?.message }] : []);
const results = (events: ProviderEvent[]) => events.flatMap((e) => e.type === "session.prompt_result" ? [`${e.clientMessageId}:${e.result.type}`] : []);

async function setup(mode: TurnEvidence) {
  vi.useFakeTimers({ toFake: ["Date"] });
  const agent = agentOf("idle");
  const store = new FakeTranscript();
  store.set([{ id: "old-user", kind: "user", text: "old" }, { id: "old-end", kind: "assistant", text: "old answer" }]);
  const adapter = makeFakeAdapter(store, { turnEvidence: mode });
  const events: ProviderEvent[] = [];
  const sent: Array<{ method: string; params?: Record<string, unknown> }> = [];
  let stall: HerdrError | null = null;
  const session = new HerdrHarnessSession("s", bindingOf(agent, adapter, null), {
    adapter, listAgents: async () => [structuredClone(agent)],
    request: async (method, params) => {
      if (method === "pane.process_info") return { type: "pane_process_info", process_info: { pane_id: "pane",
        foreground_process_group_id: 100, tty: "/dev/pts/fake", foreground_processes: [{ pid: 100, name: "fake" }] } };
      sent.push({ method, params });
      if (method === "agent.prompt" && stall) { const error = stall; stall = null; throw error; }
      return { type: "agent_prompted", agent };
    },
    subscribe: async () => ({ [Symbol.asyncIterator]: async function* () {}, close() {} }),
    emit: (event) => events.push(event),
  });
  sessions.push(session);
  await session.open(config, "skip");
  await session.live.reconcile();
  /** The next `agent.prompt` stalls: the delivery is uncertain. */
  const stallNext = (message = "stall") => { stall = new HerdrError("agent_prompt_stalled", message); };
  const keys = () => sent.filter((request) => request.method === "pane.send_keys");
  const advance = (ms: number) => { vi.setSystemTime(Date.now() + ms); };
  return { session, agent, events, sent, keys, stallNext, advance };
}

it.each(["status", "transcript"] as const)("%s mode: Stop on an uncertain delivery while idle sends no key, cancels it and admits the next prompt", async (mode) => {
  const { session, events, sent, keys, stallNext } = await setup(mode);
  stallNext();
  await session.prompt(prompt("p1"));
  expect(session.state.tracker.isUncertain).toBe(true);
  await session.interrupt("stop-1");
  expect(keys()).toEqual([]);
  expect(events.filter((e) => e.type === "request.completed")).toMatchObject([{ requestId: "stop-1" }]);
  expect(turns(events)).toEqual([
    { state: "started", error: undefined },
    { state: "canceled", error: "Stopped. Paseo could not confirm delivery; nothing was resent." },
  ]);
  expect(session.state.tracker.activeTurn).toBeNull();
  expect(session.state.pending).toBeNull();
  await session.prompt(prompt("p2", "again"));
  expect(sent.filter((request) => request.method === "agent.prompt")).toHaveLength(2);
  expect(results(events)).toEqual(["p1:turn", "p2:turn"]);
});

it("status mode: Stop on an uncertain delivery while the pane is working interrupts once, then the turn ends when the pane idles", async () => {
  const { session, agent, events, keys, stallNext, advance } = await setup("status");
  stallNext();
  await session.prompt(prompt("p1"));
  agent.agent_status = "working";
  agent.state_change_seq = 1;
  await session.interrupt("stop-1");
  expect(keys()).toEqual([{ method: "pane.send_keys", params: { pane_id: "pane", keys: ["ctrl+c"] } }]);
  // The pane showing work is the evidence the prompt arrived: the reservation becomes the Paseo turn.
  await session.live.reconcile();
  expect(turns(events).map((t) => t.state)).toEqual(["started"]);
  expect(session.state.tracker.isActive).toBe(true);
  agent.agent_status = "idle";
  agent.state_change_seq = 2;
  await session.live.reconcile();
  advance(3_000);
  await session.live.reconcile();
  expect(turns(events).map((t) => t.state)).toEqual(["started", "completed"]);
  expect(keys()).toHaveLength(1);
  await session.prompt(prompt("p2", "again"));
  expect(results(events)).toEqual(["p1:turn", "p2:turn"]);
});

it("transcript mode: Stop on an uncertain delivery while working interrupts; with no transcript entry the idle hold then fails it", async () => {
  const { session, agent, events, keys, stallNext, advance } = await setup("transcript");
  stallNext();
  await session.prompt(prompt("p1"));
  agent.agent_status = "working";
  await session.interrupt("stop-1");
  expect(keys()).toHaveLength(1);
  expect(session.state.tracker.isUncertain).toBe(true);
  agent.agent_status = "idle";
  await session.live.reconcile();
  advance(16_000);
  await session.live.reconcile();
  expect(turns(events).map((t) => t.state)).toEqual(["started", "failed"]);
  expect(keys()).toHaveLength(1);
  expect(session.state.tracker.activeTurn).toBeNull();
});

it("Stop on an uncertain delivery while Herdr status is unknown sends nothing and keeps the reservation", async () => {
  const { session, agent, events, keys, stallNext } = await setup("status");
  stallNext();
  await session.prompt(prompt("p1"));
  agent.agent_status = "unknown";
  await session.interrupt("stop-1");
  expect(keys()).toEqual([]);
  expect(session.state.tracker.isUncertain).toBe(true);
  expect(turns(events)).toEqual([]);
  expect(events.filter((e) => e.type === "request.completed")).toMatchObject([{ requestId: "stop-1" }]);
});

it("a Stop that cancels an uncertain delivery drops a stale working flag", async () => {
  const { session, agent, stallNext } = await setup("transcript");
  stallNext();
  await session.prompt(prompt("p1"));
  agent.agent_status = "working";
  await session.live.reconcile();
  expect(session.state.workingSeen).toBe(true);
  agent.agent_status = "idle";
  await session.interrupt("stop-1");
  expect(session.state.tracker.activeTurn).toBeNull();
  expect(session.state.workingSeen).toBe(false);
});

it("the uncertain-delivery notice carries the adapter's message", async () => {
  const { session, events, stallNext } = await setup("transcript");
  stallNext("Herdr timed out waiting for the agent to take the prompt");
  await session.prompt(prompt("p1"));
  const notice = events.flatMap((e) => e.type === "session.notice" && e.notice.id === "prompt-uncertain" ? [e.notice] : []);
  expect(notice).toHaveLength(1);
  expect(notice[0]!.description).toBe("Herdr timed out waiting for the agent to take the prompt. The prompt may still reach the agent; it was not resubmitted. Check the attached terminal.");
});
