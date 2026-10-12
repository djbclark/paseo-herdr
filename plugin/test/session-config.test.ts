import { afterEach, expect, it, vi } from "vitest";
import { ProviderEventSchema, type ProviderEvent, type ProviderPrompt } from "@getpaseo/plugin/server/provider";
import { HerdrHarnessSession, capabilitiesFor } from "../server/session.js";
import { bindingOf } from "../server/binding.js";
import type { AgentInfo } from "../server/herdr/schema.js";
import { FakeConfig, FakeTranscript, makeFakeAdapter } from "./fake-harness.js";

const config = { cwd: "/work", env: {}, mcpServers: {}, settings: {}, persist: true };
function makeAgent(): AgentInfo {
  return { terminal_id: "terminal", pane_id: "pane", agent: "fake", name: "demo", agent_status: "idle",
    agent_session: { source: "herdr:fake", agent: "fake", kind: "id", value: "fake-session-1" },
    workspace_id: "w", tab_id: "t", focused: true, screen_detection_skipped: false,
    state_labels: {}, tokens: {}, launch_pending: false, interactive_ready: true,
    state_change_seq: 0, completion_seq: null, cwd: "/work", revision: 0 };
}
const sessions: HerdrHarnessSession[] = [];
afterEach(() => { for (const session of sessions.splice(0)) session.close(); });
const prompt = (id: string): ProviderPrompt => ({ clientMessageId: id, delivery: "auto",
  input: { type: "message", content: [{ type: "text", text: "hello" }] } });
const configs = (events: ProviderEvent[]) => events.flatMap((event) => event.type === "session.config" ? [event.config] : []);
const answers = (events: ProviderEvent[], requestId: string) =>
  events.filter((event) => (event.type === "request.completed" || event.type === "request.failed") && event.requestId === requestId);

async function setup(options: { withConfig?: boolean; open?: boolean; agent?: Partial<AgentInfo> } = {}) {
  const agent = { ...makeAgent(), ...options.agent };
  const store = new FakeTranscript();
  store.set([{ id: "old-user", kind: "user", text: "old question" }, { id: "old-end", kind: "assistant", text: "old answer" }]);
  const live = options.withConfig === false ? undefined : new FakeConfig();
  store.model = live?.model ?? undefined;
  const adapter = makeFakeAdapter(store, { config: live });
  const events: ProviderEvent[] = [];
  const delivered: string[] = [];
  const session = new HerdrHarnessSession("local", bindingOf(agent, adapter, null), {
    adapter, listAgents: async () => [agent],
    request: async (method) => {
      if (method === "pane.process_info") return { type: "pane_process_info", process_info: {
        pane_id: agent.pane_id, foreground_process_group_id: 100, tty: "/dev/pts/fake",
        foreground_processes: [{ pid: 100, name: "fake" }] } };
      delivered.push(method);
      return { type: "agent_prompted", agent };
    },
    subscribe: async () => ({ [Symbol.asyncIterator]: async function* () {}, close() {} }),
    emit: (event) => events.push(ProviderEventSchema.parse(event)),
  });
  sessions.push(session);
  if (options.open !== false) { await session.open(config, "skip"); await session.live.reconcile(); }
  return { session, store, agent, adapter, live: live!, events, delivered };
}

it("advertises session.configure only for an adapter that can read and change config", async () => {
  expect(capabilitiesFor(makeFakeAdapter())).not.toContain("session.configure");
  expect(capabilitiesFor(makeFakeAdapter(undefined, { config: new FakeConfig() }))).toContain("session.configure");
  const half = { ...makeFakeAdapter(undefined, { config: new FakeConfig() }), configure: undefined };
  expect(capabilitiesFor(half)).not.toContain("session.configure");
  const plain = await setup({ withConfig: false });
  expect(plain.events.find((event) => event.type === "session.opened")).toMatchObject({ capabilities: expect.not.arrayContaining(["session.configure"]) });
  expect(configs(plain.events)).toEqual([]);
  const configurable = await setup();
  expect(configurable.events.find((event) => event.type === "session.opened")).toMatchObject({ capabilities: expect.arrayContaining(["session.configure"]) });
});

it("emits the current selection after open validation and before ready", async () => {
  const { events, live } = await setup();
  expect(live.reads).toBeGreaterThan(0);
  expect(configs(events)).toEqual([{ model: "fake/reasoner", thinkingOption: "medium", models: [], modes: [], thinkingOptions: [], settings: [] }]);
  const types = events.map((event) => event.type);
  expect(types.indexOf("session.config")).toBeLessThan(types.indexOf("session.ready"));
});

it("omits the thinking option for a model without reasoning and maps cleared thinking to off", async () => {
  const off = await setup({ open: false });
  off.live.thinkingLevel = null;
  await off.session.open(config, "skip");
  expect(configs(off.events)[0]).toMatchObject({ model: "fake/reasoner", thinkingOption: "off" });
  const plain = await setup({ open: false });
  plain.live.model = "fake/plain";
  plain.live.thinkingLevel = null;
  await plain.session.open(config, "skip");
  expect(configs(plain.events)).toHaveLength(1);
  expect(configs(plain.events)[0]).toEqual({ model: "fake/plain", models: [], modes: [], thinkingOptions: [], settings: [] });
});

it("a failing config read emits nothing and does not freeze the session", async () => {
  const { session, events, live } = await setup({ open: false });
  live.readError = new Error("no endpoint");
  await session.open(config, "skip");
  expect(configs(events)).toEqual([]);
  expect(events.some((event) => event.type === "session.notice")).toBe(false);
  expect(session.state.outcome).toBe("active");
  await session.prompt(prompt("p"));
  expect(events.filter((event) => event.type === "session.prompt_result" && event.result.type === "failed")).toEqual([]);
});

it("a read-only session that never read config stays silent and refuses configure", async () => {
  const { session, events } = await setup({ open: false, agent: { agent_session: undefined } });
  await session.open(config, "skip");
  expect(session.state.outcome).toBe("readonly");
  expect(configs(events)).toEqual([]);
  await session.configure("r", { model: "fake/plain" });
  expect(answers(events, "r")).toMatchObject([{ type: "request.failed", error: { code: "read_only" } }]);
});

it("emits one session.config for a terminal-made model change and none for unchanged snapshots", async () => {
  const { session, store, events } = await setup();
  expect(configs(events)).toHaveLength(1);
  await session.live.reconcile();
  await session.live.reconcile();
  expect(configs(events)).toHaveLength(1);
  store.model = "fake/plain";
  store.append({ id: "u2", kind: "user", text: "later" });
  store.append({ id: "a2", kind: "assistant", text: "later answer" });
  await session.live.reconcile();
  expect(configs(events)).toHaveLength(2);
  expect(configs(events)[1]).toMatchObject({ model: "fake/plain" });
  expect(configs(events)[1]).not.toHaveProperty("thinkingOption");
  await session.live.reconcile();
  expect(configs(events)).toHaveLength(2);
  store.thinkingLevel = "high";
  store.model = "fake/reasoner";
  store.append({ id: "u3", kind: "user", text: "again" });
  store.append({ id: "a3", kind: "assistant", text: "again answer" });
  await session.live.reconcile();
  expect(configs(events)).toHaveLength(3);
  expect(configs(events)[2]).toMatchObject({ model: "fake/reasoner", thinkingOption: "high" });
  store.thinkingLevel = null;
  store.append({ id: "u4", kind: "user", text: "off" });
  store.append({ id: "a4", kind: "assistant", text: "off answer" });
  await session.live.reconcile();
  expect(configs(events)[3]).toMatchObject({ model: "fake/reasoner", thinkingOption: "off" });
  expect(configs(events)).toHaveLength(4);
  // The harness may spell "off" as a string; null -> "off" is not a change.
  store.thinkingLevel = "off";
  store.append({ id: "u5", kind: "user", text: "off again" });
  store.append({ id: "a5", kind: "assistant", text: "off again answer" });
  await session.live.reconcile();
  expect(configs(events)).toHaveLength(4);
});

it("configure success emits session.config before request.completed and passes thinking 1:1", async () => {
  const { session, events, live } = await setup();
  await session.configure("c1", { model: "fake/reasoner", thinkingOption: "high" });
  expect(live.configureCalls).toEqual([{ model: "fake/reasoner", thinkingLevel: "high" }]);
  const tail = events.slice(events.findIndex((event) => event.type === "session.ready") + 1);
  expect(tail.map((event) => event.type)).toEqual(["session.config", "request.completed"]);
  expect(configs(events).at(-1)).toMatchObject({ model: "fake/reasoner", thinkingOption: "high" });
  expect(answers(events, "c1")).toHaveLength(1);
  await session.configure("c2", { model: "fake/plain" });
  expect(configs(events).at(-1)).not.toHaveProperty("thinkingOption");
  expect(answers(events, "c2")).toMatchObject([{ type: "request.completed" }]);
});

it("does not re-announce a configured change when the transcript records it later", async () => {
  const { session, store, events } = await setup();
  await session.configure("c1", { model: "fake/plain" });
  expect(configs(events)).toHaveLength(2);
  store.model = "fake/plain";
  store.append({ id: "u2", kind: "user", text: "next" });
  store.append({ id: "a2", kind: "assistant", text: "next answer" });
  await session.live.reconcile();
  expect(configs(events)).toHaveLength(2);
});

it("refuses with stable codes: unsupported adapter, mode/settings, busy, disconnected, read-only", async () => {
  const unsupported = await setup({ withConfig: false });
  await unsupported.session.configure("u", { model: "x" });
  expect(answers(unsupported.events, "u")).toMatchObject([{ type: "request.failed", error: { code: "unsupported" } }]);

  const { session, events, live, store, agent } = await setup();
  await session.configure("mode", { mode: "plan" });
  await session.configure("settings", { settings: { a: true } });
  expect(answers(events, "mode")).toMatchObject([{ type: "request.failed", error: { code: "unsupported" } }]);
  expect(answers(events, "settings")).toMatchObject([{ type: "request.failed", error: { code: "unsupported" } }]);

  // An unfinished native turn (started in the terminal) is busy.
  store.append({ id: "u2", kind: "user", text: "terminal question" });
  await session.configure("busy", { model: "fake/plain" });
  expect(answers(events, "busy")).toMatchObject([{ type: "request.failed", error: { code: "busy" } }]);
  store.append({ id: "a2", kind: "assistant", text: "done" });
  await session.live.reconcile();
  // A working status is busy even when the transcript looks idle.
  agent.agent_status = "working";
  await session.configure("working", { model: "fake/plain" });
  expect(answers(events, "working")).toMatchObject([{ type: "request.failed", error: { code: "busy" } }]);
  agent.agent_status = "idle";

  session.state.connected = false;
  await session.configure("down", { model: "fake/plain" });
  expect(answers(events, "down")).toMatchObject([{ type: "request.failed", error: { code: "disconnected" } }]);
  session.state.connected = true;

  expect(live.configureCalls).toEqual([]);
  session.freeze("gone", "gone");
  await session.configure("ro", { model: "fake/plain" });
  expect(answers(events, "ro")).toMatchObject([{ type: "request.failed", error: { code: "read_only" } }]);
  expect(live.configureCalls).toEqual([]);
});

it("is busy while another configure or a prompt admission is in progress", async () => {
  const { session, events, live, delivered } = await setup();
  let release!: () => void;
  live.configureGate = new Promise<void>((resolve) => { release = resolve; });
  const first = session.configure("first", { model: "fake/plain" });
  await vi.waitFor(() => expect(live.configureCalls).toHaveLength(1));
  await session.configure("second", { model: "fake/reasoner" });
  await session.prompt(prompt("p"));
  expect(answers(events, "second")).toMatchObject([{ type: "request.failed", error: { code: "busy" } }]);
  expect(events.filter((event) => event.type === "session.prompt_result")).toMatchObject([{ result: { type: "failed" } }]);
  expect(delivered).toEqual([]);
  release();
  await first;
  expect(answers(events, "first")).toMatchObject([{ type: "request.completed" }]);
  // The reservation is released afterwards.
  live.configureGate = null;
  await session.configure("third", { model: "fake/reasoner" });
  expect(answers(events, "third")).toMatchObject([{ type: "request.completed" }]);
});

it("passes adapter rejections through with their code and leaves the selection alone", async () => {
  const { session, events } = await setup();
  const before = configs(events).length;
  await session.configure("bad", { model: "fake/plain", thinkingOption: "high" });
  expect(answers(events, "bad")).toMatchObject([{ type: "request.failed", error: { code: "invalid_thinking", message: expect.stringContaining("does not support high") } }]);
  await session.configure("ghost", { model: "fake/missing" });
  expect(answers(events, "ghost")).toMatchObject([{ type: "request.failed", error: { code: "unknown_model" } }]);
  expect(configs(events)).toHaveLength(before);
});

it("an uncertain outcome fails the request with code uncertain, then reconciles from a fresh read", async () => {
  const { session, events, live } = await setup();
  live.configureOverride = { type: "uncertain", message: "The companion did not answer." };
  live.model = "fake/plain";
  live.thinkingLevel = null;
  await session.configure("maybe", { model: "fake/plain" });
  expect(answers(events, "maybe")).toMatchObject([{ type: "request.failed", error: { code: "uncertain", message: expect.stringContaining("may have been applied") } }]);
  expect(configs(events).at(-1)).toMatchObject({ model: "fake/plain" });
  expect(configs(events)).toHaveLength(2);
  // Nothing changed on re-read: no duplicate.
  live.configureOverride = { type: "uncertain", message: "again" };
  await session.configure("maybe2", { model: "fake/plain" });
  expect(configs(events)).toHaveLength(2);
  expect(answers(events, "maybe2")).toHaveLength(1);
});

it("answers the request exactly once when the adapter throws or the session closes", async () => {
  const thrown = await setup();
  thrown.adapter.configure = async () => { throw new Error("socket exploded"); };
  await thrown.session.configure("boom", { model: "fake/plain" });
  expect(answers(thrown.events, "boom")).toMatchObject([{ type: "request.failed", error: { code: "failed", message: "socket exploded" } }]);
  expect(thrown.session.state.admitting).toBe(false);

  const closing = await setup();
  let release!: () => void;
  closing.live.configureGate = new Promise<void>((resolve) => { release = resolve; });
  const pending = closing.session.configure("late", { model: "fake/plain" });
  await vi.waitFor(() => expect(closing.live.configureCalls).toHaveLength(1));
  closing.session.close();
  release();
  await pending;
  expect(answers(closing.events, "late")).toMatchObject([{ type: "request.failed", error: { code: "closed" } }]);

  const closed = await setup();
  closed.session.close();
  await closed.session.configure("after", { model: "fake/plain" });
  expect(answers(closed.events, "after")).toHaveLength(1);
});
