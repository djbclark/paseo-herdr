import { afterEach, expect, it } from "vitest";
import type { ProviderEvent, ProviderPrompt } from "@getpaseo/plugin/server/provider";
import { HerdrHarnessSession } from "../server/session.js";
import { bindingOf } from "../server/binding.js";
import { HerdrError } from "../server/herdr/client.js";
import type { AgentInfo, AgentStatus } from "../server/herdr/schema.js";
import { FakeTranscript, makeFakeAdapter } from "./fake-harness.js";

/**
 * `working` seen while a submit is in flight must not outlive a rejection that starts no terminal turn: it would
 * disable the late-`working` guard of the next fast Paseo turn and leave a phantom turn that never ends.
 */
const config = { cwd: "/work", env: {}, mcpServers: {}, settings: {}, persist: true };
const agentOf = (status: AgentStatus): AgentInfo => ({ terminal_id: "terminal", pane_id: "pane", agent: "fake", name: "demo", agent_status: status,
  agent_session: { source: "herdr:fake", agent: "fake", kind: "id", value: "fake-session-1" },
  workspace_id: "w", tab_id: "t", focused: true, screen_detection_skipped: false, state_labels: {}, tokens: {},
  launch_pending: false, interactive_ready: true, state_change_seq: 0, completion_seq: null, cwd: "/work", revision: 0 });
const prompt = (id: string, text = "hello"): ProviderPrompt => ({ clientMessageId: id, delivery: "auto", input: { type: "message", content: [{ type: "text", text }] } });
const sessions: HerdrHarnessSession[] = [];
afterEach(() => { for (const session of sessions.splice(0)) session.close(); });

const turns = (events: ProviderEvent[]) => events.flatMap((e) => e.type === "session.turn" ? [e.state] : []);
const results = (events: ProviderEvent[]) => events.flatMap((e) => e.type === "session.prompt_result" ? [`${e.clientMessageId}:${e.result.type}`] : []);
const tick = () => new Promise((r) => setTimeout(r, 5));

it("a rejection that starts no terminal turn does not leak workingSeen into the next fast Paseo turn", async () => {
  const agent = agentOf("idle");
  const store = new FakeTranscript();
  store.set([{ id: "old-user", kind: "user", text: "old" }, { id: "old-end", kind: "assistant", text: "old answer" }]);
  const adapter = makeFakeAdapter(store);
  const events: ProviderEvent[] = [];
  let release!: () => void;
  let gate: Promise<void> | null = null;
  const session = new HerdrHarnessSession("s", bindingOf(agent, adapter, null), {
    adapter, listAgents: async () => [structuredClone(agent)],
    request: async (method) => {
      if (method === "pane.process_info") return { type: "pane_process_info", process_info: { pane_id: "pane",
        foreground_process_group_id: 100, tty: "/dev/pts/fake", foreground_processes: [{ pid: 100, name: "fake" }] } };
      if (method === "agent.prompt") {
        const held = gate;
        gate = null;
        if (held) {
          await held;
          throw new HerdrError("agent_not_ready", "Agent is busy");
        }
      }
      return { type: "agent_prompted", agent };
    },
    subscribe: async () => ({ [Symbol.asyncIterator]: async function* () {}, close() {} }),
    emit: (event) => events.push(event),
  });
  sessions.push(session);
  await session.open(config, "skip");
  await session.live.reconcile();

  gate = new Promise<void>((resolve) => { release = resolve; });
  const first = session.prompt(prompt("p1"));
  await tick();
  // A terminal-typed turn starts and finishes while our input is in flight.
  agent.agent_status = "working";
  await session.live.reconcile();
  expect(session.state.workingSeen).toBe(true);
  store.append({ id: "t-user", kind: "user", text: "typed in terminal" });
  store.append({ id: "t-end", kind: "assistant", text: "ok" });
  agent.agent_status = "idle";
  await session.live.reconcile();
  release();
  await first;
  expect(results(events)).toEqual(["p1:failed"]);
  expect(turns(events)).toEqual([]);
  expect(session.state.tracker.activeTurn).toBeNull();
  expect(session.state.workingSeen).toBe(false);

  // The next Paseo turn ends in the transcript before Herdr reports working; Herdr's late `working` is then an echo.
  await session.prompt(prompt("p2", "again"));
  store.append({ id: "u2", kind: "user", text: "again" });
  store.append({ id: "a2", kind: "assistant", text: "done fast" });
  await session.live.reconcile();
  expect(results(events)).toEqual(["p1:failed", "p2:turn"]);
  expect(turns(events)).toEqual(["started", "completed"]);
  agent.agent_status = "working";
  await session.live.reconcile();
  expect(turns(events)).toEqual(["started", "completed"]);
  expect(session.state.tracker.activeTurn).toBeNull();
  // A genuinely new turn after the echo still opens normally.
  agent.agent_status = "idle";
  await session.live.reconcile();
  agent.agent_status = "working";
  await session.live.reconcile();
  expect(session.state.tracker.activeTurn).not.toBeNull();
});
