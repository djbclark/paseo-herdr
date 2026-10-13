import { createServer, type Server } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createHerdrProvider } from "../server/provider.js";
import { HERDR_BIND_OPTION } from "../shared/model.js";
import { BoundSessions } from "../server/bound-sessions.js";
import { FakeTranscript, makeFakeAdapter } from "./fake-harness.js";
import { ProviderEventSchema, type ProviderConnection, type ProviderEvent, type ProviderSessionConfig } from "@getpaseo/plugin/server/provider";

const config: ProviderSessionConfig = { cwd: "/work", env: {}, mcpServers: {}, settings: {}, persist: true };
const bound = (terminalId = "term-live", extra: Record<string, unknown> = {}): ProviderSessionConfig =>
  ({ ...config, providerOptions: { [HERDR_BIND_OPTION]: { terminalId, paneId: "pane-live", ...extra } } });
let server: Server | undefined;
let directory: string | undefined;
const connections: ProviderConnection[] = [];
afterEach(async () => {
  for (const connection of connections.splice(0)) await connection.close();
  if (server) await new Promise<void>((resolve) => server?.close(() => resolve()));
  if (directory) await rm(directory, { recursive: true, force: true });
  server = undefined;
  directory = undefined;
});

const liveAgent = (overrides: Record<string, unknown> = {}) => ({ terminal_id: "term-live", pane_id: "pane-live", agent: "fake", name: "demo", cwd: "/work",
  agent_status: "idle", screen_detection_skipped: false, state_labels: {}, tokens: {},
  agent_session: { source: "herdr:fake", agent: "fake", kind: "id", value: "fake-session-1" },
  workspace_id: "w1", tab_id: "t1", focused: true, launch_pending: false, interactive_ready: true,
  state_change_seq: 0, completion_seq: null, revision: 0, ...overrides });

async function rig(options: { agents?: Array<Record<string, unknown>>; isEnabled?: () => Promise<boolean>; delay?: number; boundSessions?: BoundSessions } = {}) {
  directory = await mkdtemp(join(tmpdir(), "herdr-bind-"));
  const socket = join(directory, "herdr.sock");
  const agents = options.agents ?? [liveAgent()];
  const sent: Array<{ method: string; params: Record<string, unknown> }> = [];
  server = createServer((stream) => {
    let bytes = "";
    stream.setEncoding("utf8");
    stream.on("data", (chunk: string) => {
      bytes += chunk;
      if (!bytes.includes("\n")) return;
      const request = JSON.parse(bytes.slice(0, bytes.indexOf("\n"))) as { id: string; method: string; params: Record<string, unknown> };
      sent.push({ method: request.method, params: request.params });
      if (request.method === "events.subscribe") {
        stream.write(JSON.stringify({ id: request.id, result: { type: "subscription_started" } }) + "\n");
        return;
      }
      const result = request.method === "pane.process_info" ? { type: "pane_process_info", process_info: {
        pane_id: "pane-live", foreground_process_group_id: 77, tty: "/dev/pts/fake", foreground_processes: [{ pid: 77, name: "fake" }] } } :
        request.method === "agent.list" ? { type: "agent_list", agents } :
        request.method === "agent.prompt" ? { type: "agent_prompted", agent: agents[0] } : { type: "unknown" };
      stream.end(JSON.stringify({ id: request.id, result }) + "\n");
    });
  });
  await new Promise<void>((resolve) => server?.listen(socket, resolve));
  const transcript = new FakeTranscript();
  transcript.set([{ id: "u1", kind: "user", text: "Hello" }, { id: "a1", kind: "assistant", text: "Hi" }]);
  const launches: unknown[] = [];
  const provider = createHerdrProvider(makeFakeAdapter(transcript), async () => socket, {
    getHerdrSession: () => "work", isEnabled: options.isEnabled, bindHistoryDelayMs: options.delay ?? 30, boundSessions: options.boundSessions,
    launch: async (launchConfig) => { launches.push(launchConfig); throw new Error("must not launch"); },
  });
  const connection = await provider.connect({ versions: [1], capabilities: ["session.list", "session.persistence", "prompt.message"] });
  connections.push(connection);
  const events: ProviderEvent[] = [];
  connection.onEvent((event) => events.push(ProviderEventSchema.parse(event)));
  const open = (sessionId: string, requestId: string, sessionConfig = bound()) =>
    connection.send({ type: "session.open", requestId, sessionId, config: sessionConfig, history: "skip" });
  const failure = async (requestId: string) => {
    await vi.waitFor(() => expect(events.some((event) => event.type === "request.failed" && event.requestId === requestId)).toBe(true));
    const event = events.find((candidate) => candidate.type === "request.failed" && candidate.requestId === requestId);
    return event && event.type === "request.failed" ? event.error.message : "";
  };
  return { connection, events, sent, launches, open, failure, transcript };
}
const texts = (events: ProviderEvent[]) => events.flatMap((event) => event.type === "timeline.item" && "text" in event.item ? [event.item.text] : []);

it("binds an existing agent without launching and carries the same persistence discovery offers", async () => {
  const { connection, events, launches, open, sent } = await rig();
  await connection.send({ type: "sessions", requestId: "list", cwd: "/work" });
  await vi.waitFor(() => expect(events.some((event) => event.type === "sessions")).toBe(true));
  const listing = events.find((event) => event.type === "sessions");
  if (!listing || listing.type !== "sessions") throw new Error("Missing listing");
  await open("a", "open");
  await vi.waitFor(() => expect(events.some((event) => event.type === "session.ready" && event.requestId === "open")).toBe(true));
  const opened = events.find((event) => event.type === "session.opened");
  expect(opened).toMatchObject({ requestId: "open", persistence: listing.sessions[0].persistence, cwd: "/work", title: "demo" });
  expect(launches).toEqual([]);
  expect(sent.some((request) => request.method === "agent.start" || request.method === "workspace.create")).toBe(false);
  expect(events.filter((event) => event.type === "session.notice")).toMatchObject([{ notice: { id: "attach", severity: "info",
    description: expect.stringContaining("herdr --session work agent attach demo") } }]);
});

it("re-sends earlier messages as live rows after ready, not before, and keeps later rows behind them", async () => {
  const { events, open, transcript } = await rig({ delay: 80 });
  await open("a", "open");
  await vi.waitFor(() => expect(events.some((event) => event.type === "session.ready")).toBe(true));
  expect(texts(events)).toEqual([]);
  await vi.waitFor(() => expect(texts(events)).toEqual(["Hello", "Hi"]));
  const readyAt = events.findIndex((event) => event.type === "session.ready");
  expect(events.findIndex((event) => event.type === "timeline.item")).toBeGreaterThan(readyAt);
  expect(events.filter((event) => event.type === "timeline.item").map((event) => event.type === "timeline.item" && event.item.id))
    .toEqual(transcript.items.map((item) => item.id));
});

it("drops the pending history re-send when the chat is closed first", async () => {
  const { connection, events, open } = await rig({ delay: 60 });
  await open("a", "open");
  await vi.waitFor(() => expect(events.some((event) => event.type === "session.ready")).toBe(true));
  await connection.send({ type: "session.close", sessionId: "a", requestId: "close" });
  await vi.waitFor(() => expect(events.some((event) => event.type === "request.completed" && event.requestId === "close")).toBe(true));
  await new Promise((resolve) => setTimeout(resolve, 120));
  expect(texts(events)).toEqual([]);
});

it("refuses an agent that is gone, one of another kind, and a malformed option, never launching", async () => {
  const { events, launches, open, failure } = await rig({ agents: [liveAgent(), liveAgent({ terminal_id: "term-other", agent: "other" })] });
  await open("a", "gone", bound("term-missing"));
  expect(await failure("gone")).toBe("The Herdr agent in terminal term-missing is no longer running");
  await open("b", "kind", bound("term-other"));
  expect(await failure("kind")).toBe("The Herdr agent in terminal term-other is not a Fake agent");
  await open("c", "bad", { ...config, providerOptions: { [HERDR_BIND_OPTION]: { paneId: "p" } } });
  expect(await failure("bad")).toBe("Invalid herdrBind option: expected { terminalId, paneId? }");
  expect(launches).toEqual([]);
  expect(events.some((event) => event.type === "session.opened")).toBe(false);
});

it("refuses a second bind to the same agent but frees it once the first chat is closed", async () => {
  const { connection, events, open, failure } = await rig();
  await open("a", "first");
  await vi.waitFor(() => expect(events.some((event) => event.type === "session.ready" && event.requestId === "first")).toBe(true));
  await open("b", "second");
  expect(await failure("second")).toBe("This Fake agent is already open in another conversation");
  await connection.send({ type: "session.close", sessionId: "a", requestId: "close" });
  await vi.waitFor(() => expect(events.some((event) => event.type === "request.completed" && event.requestId === "close")).toBe(true));
  await open("c", "third");
  await vi.waitFor(() => expect(events.some((event) => event.type === "session.ready" && event.requestId === "third")).toBe(true));
});

it("a double tap opens exactly one session", async () => {
  const { events, open } = await rig();
  await open("a", "one");
  await open("b", "two");
  await vi.waitFor(() => expect(events.filter((event) => event.type === "session.ready" || event.type === "request.failed")).toHaveLength(2));
  expect(events.filter((event) => event.type === "session.ready")).toHaveLength(1);
  expect(events.filter((event) => event.type === "request.failed")).toMatchObject([{ error: { message: expect.stringContaining("already open") } }]);
});

it("respects the harness toggle exactly as launch does", async () => {
  const { events, launches, open, failure } = await rig({ isEnabled: async () => false });
  await open("a", "off");
  expect(await failure("off")).toBe("Fake is turned off in the Herdr plugin settings");
  expect(launches).toEqual([]);
  expect(events.some((event) => event.type === "session.opened")).toBe(false);
});

it("accepts the native-default model selection on a bind", async () => {
  const { events, open } = await rig();
  await open("a", "open", { ...bound(), model: "native-default" });
  await vi.waitFor(() => expect(events.some((event) => event.type === "session.ready")).toBe(true));
});

it("still launches when no bind option is given", async () => {
  const { launches, open, failure } = await rig();
  await open("a", "plain", config);
  expect(await failure("plain")).toBe("must not launch");
  expect(launches).toHaveLength(1);
});

it("sends the history as soon as the client says Paseo is listening, without waiting for the fallback", async () => {
  const boundSessions = new BoundSessions();
  const { events, open } = await rig({ delay: 60_000, boundSessions });
  await open("s1", "o1");
  await vi.waitFor(() => expect(events.some((event) => event.type === "session.ready")).toBe(true));
  expect(texts(events)).toEqual([]);
  expect(boundSessions.flushHistory("work", "term-live")).toBe(1);
  expect(texts(events)).toEqual(["Hello", "Hi"]);
  boundSessions.flushHistory("work", "term-live");
  expect(texts(events)).toEqual(["Hello", "Hi"]);
  expect(boundSessions.flushHistory(null, "term-live")).toBe(0);
});

it("lets a fresh chat bind an agent whose existing chat is read-only", async () => {
  const { events, open } = await rig({ agents: [liveAgent({ agent_session: null })] });
  await open("old", "o1");
  await vi.waitFor(() => expect(events.some((event) => event.type === "session.ready" && event.requestId === "o1")).toBe(true));
  expect(events.some((event) => event.type === "session.notice" && event.notice.title === "History unavailable")).toBe(true);
  await open("new", "o2");
  await vi.waitFor(() => expect(events.some((event) => event.type === "session.ready" && event.requestId === "o2")).toBe(true));
  expect(events.some((event) => event.type === "request.failed")).toBe(false);
});
