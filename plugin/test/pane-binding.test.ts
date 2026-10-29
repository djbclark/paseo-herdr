import { afterEach, expect, it, vi } from "vitest";
import type { ProviderEvent, ProviderPrompt } from "@getpaseo/plugin/server/provider";
import { HerdrHarnessSession } from "../server/session.js";
import { bindingOf } from "../server/binding.js";
import type { HarnessAdapter, InputTarget, PaneObservation } from "../server/harness/types.js";
import type { AgentInfo } from "../server/herdr/schema.js";
import { FakeTranscript, makeFakeAdapter } from "./fake-harness.js";

/**
 * Pane-bound sessions (adapter `binding: "pane"`): no native session ref, a screen reader that needs the validated pane,
 * and per-session pane observation. A native-ref adapter keeps its null-ref freeze.
 */
const config = { cwd: "/work", env: {}, mcpServers: {}, settings: {}, persist: true };
const agentOf = (terminal: string, pane: string, overrides: Partial<AgentInfo> = {}): AgentInfo => ({
  terminal_id: terminal, pane_id: pane, agent: "claude", name: null, agent_status: "idle", agent_session: null,
  workspace_id: "w", tab_id: "t", focused: true, screen_detection_skipped: false, state_labels: {}, tokens: {},
  launch_pending: false, interactive_ready: true, state_change_seq: 0, completion_seq: null, cwd: "/work", revision: 0, ...overrides });
const prompt = (id: string, text = "hello"): ProviderPrompt => ({ clientMessageId: id, delivery: "auto", input: { type: "message", content: [{ type: "text", text }] } });
const sessions: HerdrHarnessSession[] = [];
afterEach(() => { for (const session of sessions.splice(0)) session.close(); });

interface Seen { terminalId: string; paneId: string | null; observation: PaneObservation }

/** One Herdr stand-in shared by every session of a test: a mutable agent list, a pid per pane, and a screen per pane id. */
function world(agents: AgentInfo[], options: { nativeKinds?: readonly string[] | "any"; binding?: "pane" | "native-ref" } = {}) {
  const screens = new Map<string, string>();
  const seen: Seen[] = [];
  const pids = new Map<string, number>();
  const sent: Array<{ method: string; params?: Record<string, unknown> }> = [];
  const targets: InputTarget[] = [];
  let promptGate: Promise<void> | null = null;
  const binding = options.binding ?? "pane";
  const adapter: HarnessAdapter = makeFakeAdapter(new FakeTranscript(), {
    binding, nativeKinds: options.nativeKinds ?? "any", turnEvidence: binding === "pane" ? "status" : "transcript",
    ...(binding === "pane" ? { paneReader: (observation: PaneObservation) => {
      seen.push({ terminalId: observation.terminalId, paneId: observation.paneId(), observation });
      return screens.get(observation.paneId() ?? "") ?? "";
    } } : {}),
  });
  const submit = adapter.submitPrompt;
  adapter.submitPrompt = async (target, text, ctx) => { targets.push(target); return submit(target, text, ctx); };
  const open = async (agent: AgentInfo, id = `s-${agent.terminal_id}`) => {
    const events: ProviderEvent[] = [];
    const session = new HerdrHarnessSession(id, bindingOf(agent, adapter, null), {
      adapter, listAgents: async () => agents.map((candidate) => structuredClone(candidate)),
      request: async (method, params) => {
        if (method === "pane.process_info") {
          const paneId = String(params?.pane_id);
          const owner = agents.find((candidate) => candidate.pane_id === paneId)!;
          const pid = pids.get(owner.terminal_id) ?? 100;
          return { type: "pane_process_info", process_info: { pane_id: paneId, foreground_process_group_id: pid, tty: `/dev/pts/${owner.terminal_id}`,
            foreground_processes: [{ pid, name: "claude" }] } };
        }
        if (method === "agent.prompt") { const held = promptGate; promptGate = null; await held; }
        sent.push({ method, params });
        return { type: "agent_prompted", agent: agents.find((candidate) => candidate.pane_id === params?.target) ?? agent };
      },
      subscribe: async () => ({ [Symbol.asyncIterator]: async function* () {}, close() {} }),
      emit: (event) => events.push(event),
    });
    sessions.push(session);
    await session.open(config, "skip");
    await session.live.reconcile();
    return { session, events };
  };
  /** Hold the next `agent.prompt` until the returned function is called. */
  const holdNextPrompt = () => {
    const { promise, resolve } = Promise.withResolvers<void>();
    promptGate = promise;
    return resolve;
  };
  return { screens, seen, pids, sent, targets, adapter, open, holdNextPrompt };
}
const notices = (events: ProviderEvent[]) => events.flatMap((e) => e.type === "session.notice" ? [e.notice.title] : []);

it("gives each of two same-cwd panes with no native session its own observation and reads its own pane", async () => {
  const agents = [agentOf("t1", "pane-1"), agentOf("t2", "pane-2")];
  const rig = world(agents);
  rig.screens.set("pane-1", "screen of pane one");
  rig.screens.set("pane-2", "screen of pane two");
  const first = await rig.open(agents[0]!);
  const second = await rig.open(agents[1]!);
  const textOf = (session: HerdrHarnessSession) => session.state.snapshot?.items.map((item) => item.type === "user_message" ? item.text : "");
  expect(textOf(first.session)).toEqual(["screen of pane one"]);
  expect(textOf(second.session)).toEqual(["screen of pane two"]);
  // Every read had a validated pane id, and the observation is the session's own live view (not another pane's).
  expect(rig.seen.every((entry) => entry.paneId !== null)).toBe(true);
  expect(rig.seen.filter((entry) => entry.terminalId === "t1").map((entry) => entry.paneId)).toEqual(expect.arrayContaining(["pane-1"]));
  expect(rig.seen.filter((entry) => entry.terminalId === "t1").every((entry) => entry.paneId === "pane-1" && entry.observation === first.session.observation)).toBe(true);
  expect(rig.seen.filter((entry) => entry.terminalId === "t2").every((entry) => entry.paneId === "pane-2" && entry.observation === second.session.observation)).toBe(true);
  expect(first.session.observation.signal).toBe(first.session.signal);
});

it("validates before it opens the reader, and replays the validation's events after session.opened", async () => {
  const agents = [agentOf("t1", "pane-1")];
  const rig = world(agents);
  rig.screens.set("pane-1", "hello screen");
  const { events } = await rig.open(agents[0]!);
  const kinds = events.map((event) => event.type);
  expect(kinds[0]).toBe("session.opened");
  // First validation of an unbound occupant persists it; that event must not precede session.opened.
  expect(kinds.indexOf("session.persistence")).toBeGreaterThan(kinds.indexOf("session.opened"));
  expect(rig.seen[0]!.paneId).toBe("pane-1");
});

it("a pane whose terminal is gone at open time opens read-only with one notice, after session.opened", async () => {
  const gone = agentOf("t-gone", "pane-gone");
  const rig = world([agentOf("t-other", "pane-other")]);
  const { session, events } = await rig.open(gone);
  expect(session.state.outcome).toBe("readonly");
  expect(rig.seen).toEqual([]);
  expect(events.map((event) => event.type)).toEqual(["session.opened", "session.notice", "session.ready"]);
  expect(notices(events)).toEqual(["Fake agent unavailable"]);
});

it("submits the prompt with a null ref and the validated pane, and ignores the screen's turn state", async () => {
  const agents = [agentOf("t1", "pane-1")];
  const rig = world(agents);
  // A one-line screen reads as an unfinished native turn in transcript mode; status mode gates on Herdr alone.
  rig.screens.set("pane-1", "a single line");
  const { session, events } = await rig.open(agents[0]!);
  expect(session.state.snapshot?.turnState).toBe("working");
  await session.prompt(prompt("p1"));
  expect(events.filter((event) => event.type === "session.prompt_result")).toMatchObject([{ clientMessageId: "p1", result: { type: "turn" } }]);
  expect(rig.targets).toHaveLength(1);
  expect(rig.targets[0]).toMatchObject({ pid: 100, ref: null,
    pane: { paneId: "pane-1", terminalId: "t1", process: { pane_id: "pane-1", foreground_process_group_id: 100 } } });
  expect(rig.sent.filter((request) => request.method === "agent.prompt")).toHaveLength(1);
});

it("measures a status-mode turn against the counters at admission, not at acceptance", async () => {
  const agents = [agentOf("t1", "pane-1", { state_change_seq: 7, completion_seq: 3 })];
  const rig = world(agents);
  const { session, events } = await rig.open(agents[0]!);
  const release = rig.holdNextPrompt();
  const pending = session.prompt(prompt("p1"));
  await vi.waitFor(() => expect(session.state.tracker.isPending).toBe(true));
  // A quick turn ran while the send was in flight: the pane's counters moved past the admission baseline.
  agents[0]!.state_change_seq = 9;
  agents[0]!.completion_seq = 4;
  await session.live.reconcile();
  release();
  await pending;
  await session.live.reconcile();
  expect(events.filter((event) => event.type === "session.turn").map((event) => event.type === "session.turn" ? event.state : ""))
    .toEqual(["started", "completed"]);
});

it("follows a pane move: the observation reports the new pane and the reader reads it", async () => {
  const agents = [agentOf("t1", "pane-1")];
  const rig = world(agents);
  rig.screens.set("pane-1", "before the move");
  rig.screens.set("pane-1b", "after the move");
  const { session } = await rig.open(agents[0]!);
  expect(session.observation.paneId()).toBe("pane-1");
  agents[0]!.pane_id = "pane-1b";
  await session.live.reconcile();
  expect(session.observation.paneId()).toBe("pane-1b");
  expect(session.observation.terminalId).toBe("t1");
  expect(session.state.snapshot?.items.map((item) => item.type === "user_message" ? item.text : "")).toEqual(["after the move"]);
  expect(session.state.outcome).toBe("active");
});

it("a foreground pid change freezes a pane-bound session and refuses input", async () => {
  const agents = [agentOf("t1", "pane-1")];
  const rig = world(agents);
  const { session, events } = await rig.open(agents[0]!);
  rig.pids.set("t1", 555);
  await session.live.reconcile();
  expect(session.state.outcome).toBe("readonly");
  expect(notices(events)).toEqual(["The bound agent was replaced"]);
  await session.prompt(prompt("p1"));
  expect(rig.targets).toEqual([]);
});

it("a pane binding ignores the native session ref but not the agent kind", async () => {
  const agents = [agentOf("t1", "pane-1", { agent: "claude" })];
  const rig = world(agents, { nativeKinds: ["claude"] });
  const { session, events } = await rig.open(agents[0]!);
  // A ref that appears later is not a replacement for a pane binding.
  agents[0]!.agent_session = { source: "herdr:claude", agent: "claude", kind: "id", value: "late-session" };
  await session.live.reconcile();
  expect(session.state.outcome).toBe("active");
  expect(session.state.binding.sessionRef).toBeNull();
  agents[0]!.agent = "codex";
  await session.live.reconcile();
  expect(session.state.outcome).toBe("readonly");
  expect(notices(events)).toEqual(["The bound agent was replaced"]);
});

it("a native-ref binding with no ref still freezes as history unavailable", async () => {
  const agents = [agentOf("t1", "pane-1", { agent: "fake" })];
  const rig = world(agents, { binding: "native-ref", nativeKinds: ["fake"] });
  const { session, events } = await rig.open(agents[0]!);
  expect(session.state.outcome).toBe("readonly");
  expect(notices(events)).toEqual(["History unavailable"]);
  await session.prompt(prompt("p1"));
  expect(rig.sent).toEqual([]);
});
