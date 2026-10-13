import { afterEach, describe, expect, it } from "vitest";
import type { ProviderEvent, ProviderPrompt } from "@getpaseo/plugin/server/provider";
import { HerdrHarnessSession } from "../server/session.js";
import { bindingOf } from "../server/binding.js";
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

async function setup() {
  const agent = agentOf("idle");
  const store = new FakeTranscript();
  store.set([{ id: "old-user", kind: "user", text: "old" }, { id: "old-end", kind: "assistant", text: "old answer" }]);
  const adapter = makeFakeAdapter(store);
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
  return { session, store, agent, events, sent, hold };
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
