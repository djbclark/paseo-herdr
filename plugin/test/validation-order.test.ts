import { afterEach, expect, it, vi } from "vitest";
import { HerdrHarnessSession } from "../server/session.js";
import { paneClaims } from "../server/pane-claims.js";
import type { Binding } from "../server/binding.js";
import type { AgentInfo } from "../server/herdr/schema.js";
import { FakeTranscript, makeFakeAdapter } from "./fake-harness.js";

/**
 * F3: concurrent `validateAgent` calls can resolve their `agent.list` in reverse order. The call that started last
 * holds the newest view of Herdr, so an earlier one finishing late must not move the pane claim or state back.
 */
const SOCKET = "/tmp/validation-order.sock";
const adapter = makeFakeAdapter(new FakeTranscript(), { nativeKinds: ["fake"] });
const agentAt = (terminal: string, pane: string): AgentInfo => ({
  terminal_id: terminal, pane_id: pane, agent: "fake", name: null, agent_status: "idle",
  agent_session: { source: "herdr:fake", agent: "fake", kind: "id", value: "r1" },
  workspace_id: "w", tab_id: "t", focused: true, screen_detection_skipped: false, state_labels: {}, tokens: {},
  launch_pending: false, interactive_ready: true, state_change_seq: 0, completion_seq: null, cwd: "/work", revision: 0 });

const sessions: HerdrHarnessSession[] = [];
afterEach(() => { for (const session of sessions.splice(0)) session.close(); });

/** An opened-before native-ref binding on a terminal that is gone from every listing, so each validation recovers by ref and may move it. */
function rig(processInfoFor: (paneId: string, call: number) => string = (paneId) => paneId) {
  const binding: Binding = { harness: adapter.id, herdrSession: null, terminalId: "t-0", agentName: null,
    sessionRef: { kind: "id", value: "r1" }, cwd: "/work", submittedMessages: {},
    occupant: { pid: 100, tty: "/dev/pts/x", instanceId: "fake-instance" } };
  const lists: Array<PromiseWithResolvers<AgentInfo[]>> = [];
  let infoCalls = 0;
  const session: HerdrHarnessSession = new HerdrHarnessSession("s1", binding, {
    adapter,
    listAgents: () => { const gate = Promise.withResolvers<AgentInfo[]>(); lists.push(gate); return gate.promise; },
    request: async (method, params) => {
      if (method !== "pane.process_info") throw new Error(`unexpected ${method}`);
      const paneId = String(params?.pane_id);
      return { type: "pane_process_info", process_info: { pane_id: processInfoFor(paneId, ++infoCalls), foreground_process_group_id: 100, tty: "/dev/pts/x",
        foreground_processes: [{ pid: 100, name: "fake" }] } };
    },
    subscribe: async () => ({ [Symbol.asyncIterator]: async function* () {}, close() {} }),
    emit: () => {},
    claimPane: (terminalId) => {
      const release = paneClaims.move(SOCKET, null, session.state.binding.terminalId, terminalId, session);
      return release !== null;
    },
  });
  sessions.push(session);
  return { session, lists };
}
/** Whether a different session is refused the terminal, i.e. `session` holds its claim. */
const claimHeld = (terminalId: string): boolean => {
  const intruder = new HerdrHarnessSession("probe", { harness: adapter.id, herdrSession: null, terminalId, agentName: null, sessionRef: null, cwd: "/", submittedMessages: {} }, {
    adapter, listAgents: async () => [], request: async () => ({}), subscribe: async () => ({ [Symbol.asyncIterator]: async function* () {}, close() {} }), emit: () => {} });
  sessions.push(intruder);
  const release = paneClaims.claim(SOCKET, null, terminalId, intruder);
  release?.();
  return release === null;
};

it("a validation that started earlier but resolves later does not commit, and returns the newer committed agent", async () => {
  const { session, lists } = rig();
  const earlier = session.validateAgent();
  const later = session.validateAgent();
  expect(lists).toHaveLength(2);
  // Herdr moved the agent between the two listings; the later call saw the newer position.
  lists[1]!.resolve([agentAt("t-new", "p-new")]);
  expect((await later)?.terminal_id).toBe("t-new");
  lists[0]!.resolve([agentAt("t-old", "p-old")]);
  // Not null: the session is healthy, so the caller of the superseded call must not read it as "unavailable".
  expect((await earlier)?.terminal_id).toBe("t-new");

  expect(session.state.paneId).toBe("p-new");
  expect(session.state.binding.terminalId).toBe("t-new");
  expect(claimHeld("t-new")).toBe(true);
  expect(claimHeld("t-old")).toBe(false);
  expect(session.state.outcome).toBe("active");
});

it("a superseded validation of the same unchanged agent resolves to it", async () => {
  const { session, lists } = rig();
  const earlier = session.validateAgent();
  const later = session.validateAgent();
  lists[1]!.resolve([agentAt("t-1", "p-1")]);
  await later;
  lists[0]!.resolve([agentAt("t-1", "p-1")]);
  expect((await earlier)?.pane_id).toBe("p-1");
  expect(session.state.outcome).toBe("active");
});

it("a superseded validation returns null when the newer one froze the session", async () => {
  const { session, lists } = rig();
  const earlier = session.validateAgent();
  const later = session.validateAgent();
  // The newer call finds the bound ref replaced and freezes; the older one finishes afterwards.
  lists[1]!.resolve([{ ...agentAt("t-0", "p-0"), agent_session: { source: "herdr:fake", agent: "fake", kind: "id", value: "other" } }]);
  expect(await later).toBeNull();
  expect(session.state.outcome).toBe("readonly");
  lists[0]!.resolve([agentAt("t-1", "p-1")]);
  expect(await earlier).toBeNull();
  expect(session.state.binding.terminalId).toBe("t-0");
});

it("a superseded validation returns null once the session is closed", async () => {
  const { session, lists } = rig();
  const earlier = session.validateAgent();
  const later = session.validateAgent();
  lists[1]!.resolve([agentAt("t-1", "p-1")]);
  await later;
  session.close();
  lists[0]!.resolve([agentAt("t-1", "p-1")]);
  expect(await earlier).toBeNull();
});

it("a superseded validation whose move retry is exhausted does not mark the pane disconnected", async () => {
  // The older call keeps getting alias pane ids; a newer call already committed, so the older one must not write connectivity loss.
  const { session, lists } = rig((paneId, call) => (call === 2 || call === 3 ? "p-alias" : paneId));
  session.state.connected = true; // the rig never opens the session; open() sets this
  const earlier = session.validateAgent();
  const later = session.validateAgent();
  lists[1]!.resolve([agentAt("t-1", "p-1")]);
  await later;
  lists[0]!.resolve([agentAt("t-1", "p-1")]);
  await vi.waitFor(() => expect(lists).toHaveLength(3));
  lists[2]!.resolve([agentAt("t-1", "p-1")]);
  expect((await earlier)?.terminal_id).toBe("t-1");
  expect(session.state.connected).toBe(true);
});

it("validations resolving in start order still commit in order", async () => {
  const { session, lists } = rig();
  const first = session.validateAgent();
  const second = session.validateAgent();
  lists[0]!.resolve([agentAt("t-old", "p-old")]);
  expect((await first)?.terminal_id).toBe("t-old");
  lists[1]!.resolve([agentAt("t-new", "p-new")]);
  expect((await second)?.terminal_id).toBe("t-new");
  expect(session.state.paneId).toBe("p-new");
  expect(claimHeld("t-new")).toBe(true);
  expect(claimHeld("t-old")).toBe(false);
});

it("a move retry keeps its call's sequence, so it still commits when nothing newer did", async () => {
  // The first process_info answers with an alias pane id (Herdr resolved a moved pane): the call re-reads once.
  const { session, lists } = rig((paneId, call) => (call === 1 ? "p-alias" : paneId));
  const validating = session.validateAgent();
  lists[0]!.resolve([agentAt("t-new", "p-new")]);
  await vi.waitFor(() => expect(lists).toHaveLength(2));
  lists[1]!.resolve([agentAt("t-new", "p-new")]);
  expect((await validating)?.pane_id).toBe("p-new");
  expect(session.state.paneId).toBe("p-new");
});
