import { afterEach, expect, it, vi } from "vitest";
import { ProviderEventSchema, type ProviderEvent, type ProviderPrompt, type ProviderSessionConfig } from "@getpaseo/plugin/server/provider";
import { HerdrHarnessSession, pendingBinding, type SessionDeps } from "../server/session.js";
import { LaunchError, type LaunchResult } from "../server/launch.js";
import { attachCommand, paneReadCommand } from "../server/herdr-commands.js";
import type { AgentInfo } from "../server/herdr/schema.js";
import { FakeTranscript, makeFakeAdapter } from "./fake-harness.js";

const config: ProviderSessionConfig = { cwd: "/work", env: {}, mcpServers: {}, settings: {}, persist: true };
const launched = (overrides: Partial<LaunchResult> = {}): LaunchResult => ({
  agentName: "paseo-abc123", terminalId: "terminal", paneId: "pane", tabId: "t", workspaceId: "w",
  createdWorkspace: false, cwd: "/work", sessionRef: { kind: "id", value: "fake-session-1" }, ...overrides,
});
function makeAgent(sessionRef: { kind: "id" | "path"; value: string } | null = { kind: "id", value: "fake-session-1" }): AgentInfo {
  return { terminal_id: "terminal", pane_id: "pane", agent: "fake", name: "paseo-abc123", agent_status: "idle",
    ...(sessionRef ? { agent_session: { source: "herdr:fake", agent: "fake", ...sessionRef } } : {}),
    workspace_id: "w", tab_id: "t", focused: true, screen_detection_skipped: false,
    state_labels: {}, tokens: {}, launch_pending: false, interactive_ready: true,
    state_change_seq: 0, completion_seq: null, cwd: "/work", revision: 0 };
}
const prompt = (id: string): ProviderPrompt => ({ clientMessageId: id, delivery: "auto",
  input: { type: "message", content: [{ type: "text", text: "hello" }] } });

const sessions: HerdrHarnessSession[] = [];
afterEach(() => { for (const session of sessions.splice(0)) session.close(); });

function setup(options: { launch?: SessionDeps["launch"]; agent?: AgentInfo; herdrSession?: string | null } = {}) {
  const agent = options.agent ?? makeAgent();
  const adapter = makeFakeAdapter(new FakeTranscript());
  const events: ProviderEvent[] = [];
  const delivered: Array<{ method: string; params?: Record<string, unknown> }> = [];
  const herdrSession = options.herdrSession ?? null;
  const session = new HerdrHarnessSession("created", pendingBinding(adapter, herdrSession, config.cwd), {
    adapter, listAgents: async () => [agent],
    request: async (method, params) => {
      if (method === "pane.process_info") return { type: "pane_process_info", process_info: {
        pane_id: "pane", foreground_process_group_id: 100, tty: "/dev/pts/fake", foreground_processes: [{ pid: 100, name: "fake" }] } };
      delivered.push({ method, params });
      return { type: "agent_prompted", agent };
    },
    subscribe: async () => ({ [Symbol.asyncIterator]: async function* () {}, close() {} }),
    emit: (event) => events.push(ProviderEventSchema.parse(event)),
    getHerdrSession: () => herdrSession,
    launch: options.launch ?? (async () => launched()),
  });
  sessions.push(session);
  return { session, events, delivered, agent };
}
const notices = (events: ProviderEvent[]) => events.filter((event) => event.type === "session.notice");

it("creates: opened carries launch identity, ready, one attach notice, then prompts normally", async () => {
  const { session, events, delivered } = setup();
  await session.create(config, "replay", "req");
  const opened = events.find((event) => event.type === "session.opened");
  expect(opened).toMatchObject({ requestId: "req", title: "paseo-abc123", cwd: "/work", persistence: { data: {
    terminalId: "terminal", agentName: "paseo-abc123", sessionRef: { kind: "id", value: "fake-session-1" }, harness: "fake" } } });
  // validateAgent persists the captured occupant identity between opened and ready.
  expect(events.map((event) => event.type)).toEqual(["session.opened", "session.persistence", "session.ready", "session.notice"]);
  expect(notices(events)).toHaveLength(1);
  expect(notices(events)[0]).toMatchObject({ notice: { id: "attach", severity: "info",
    description: expect.stringContaining("herdr agent attach paseo-abc123") } });
  expect(JSON.stringify(notices(events))).not.toContain("--session");
  expect(session.state.outcome).toBe("active");
  await session.live.reconcile();
  await session.prompt(prompt("first"));
  expect(delivered.map((request) => request.method)).toEqual(["agent.prompt"]);
  expect(events.filter((event) => event.type === "session.prompt_result" && event.result.type === "failed")).toEqual([]);
});

it("adds the --session hint only when the Herdr session is named", async () => {
  const { session, events } = setup({ herdrSession: "my session" });
  await session.create(config, "skip", "req");
  expect(notices(events)[0]).toMatchObject({ notice: { description: expect.stringContaining("herdr --session 'my session' agent attach paseo-abc123") } });
  expect(events.find((event) => event.type === "session.opened")).toMatchObject({
    persistence: { data: { herdrSession: "my session" } } });
});

it("a launch that reports no session ref stays running but read-only, and says how to attach", async () => {
  const { session, events, delivered } = setup({ launch: async () => launched({ sessionRef: null }), agent: makeAgent(null) });
  await session.create(config, "replay", "req");
  expect(events.find((event) => event.type === "session.opened")).toMatchObject({ persistence: { data: { sessionRef: null } } });
  expect(events.some((event) => event.type === "session.ready")).toBe(true);
  expect(session.state.outcome).toBe("readonly");
  expect(notices(events).map((event) => event.notice.id)).toEqual(["history-or-agent-unavailable", "attach"]);
  expect(notices(events)[1]).toMatchObject({ notice: { description: expect.stringMatching(/attach paseo-abc123.*read-only/) } });
  await session.prompt(prompt("blocked"));
  expect(delivered).toEqual([]);
});

it("an open failure after a successful launch fails the request but says where the agent is", async () => {
  const { session, events } = setup();
  vi.spyOn(session.adapter, "resolveTranscript").mockRejectedValue(new Error("transcript index unreadable"));
  await expect(session.create(config, "replay", "req")).rejects.toThrow(
    "transcript index unreadable. The agent keeps running in Herdr; attach with: herdr agent attach paseo-abc123");
  expect(notices(events)).toEqual([]);
});

it("a launch failure propagates its message and emits no session events", async () => {
  const { session, events } = setup({ launch: async () => { throw new LaunchError("pane p-1 in workspace w-1 timed out", "timeout"); } });
  await expect(session.create(config, "skip", "req")).rejects.toThrow("pane p-1 in workspace w-1 timed out");
  expect(events).toEqual([]);
});

it("close during launch aborts the launch signal and emits nothing afterwards", async () => {
  let signal!: AbortSignal;
  let finish!: (result: LaunchResult) => void;
  const { session, events } = setup({ launch: (_config, abort) => { signal = abort;
    return new Promise<LaunchResult>((resolve) => { finish = resolve; }); } });
  const creating = session.create(config, "replay", "req");
  await Promise.resolve();
  expect(signal.aborted).toBe(false);
  session.close();
  expect(signal.aborted).toBe(true);
  finish(launched());
  await creating;
  expect(events).toEqual([]);
});

it("close during launch with a launcher that rejects on abort stays quiet", async () => {
  const { session, events } = setup({ launch: (_config, abort) => new Promise<LaunchResult>((_resolve, reject) => {
    abort.addEventListener("abort", () => reject(new LaunchError("aborted", "aborted"))); }) });
  const creating = session.create(config, "skip", "req");
  session.close();
  await expect(creating).rejects.toThrow("aborted");
  expect(events).toEqual([]);
});

it("refuses to create when no launcher is wired", async () => {
  const { session } = setup();
  const bare = new HerdrHarnessSession("x", pendingBinding(session.adapter, null, "/work"), { ...session.deps, launch: undefined });
  await expect(bare.create(config, "skip")).rejects.toThrow(/not supported/);
});

it("builds attach and pane-read commands with the session flag only for named sessions", () => {
  expect(attachCommand(null, "paseo-abc123")).toBe("herdr agent attach paseo-abc123");
  expect(attachCommand("paseo-spike-e", "paseo-abc123")).toBe("herdr --session paseo-spike-e agent attach paseo-abc123");
  expect(attachCommand("my session", "a'b")).toBe("herdr --session 'my session' agent attach 'a'\\''b'");
  expect(paneReadCommand(null, "p1")).toBe("herdr pane read p1");
  expect(paneReadCommand("paseo-spike-e", "p1")).toBe("herdr --session paseo-spike-e pane read p1");
});

it("surfaces an unreachable launch failure as the create error message", async () => {
  const { session } = setup({ launch: async () => { throw new LaunchError("Herdr became unreachable during launch; the agent was probably stopped with it", "unreachable"); } });
  await expect(session.create(config, "replay", "req")).rejects.toThrow("Herdr became unreachable during launch");
});
