import { createServer, type Server } from "node:net";
import { mkdtemp, writeFile, rm, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createHerdrProvider } from "../server/provider.js";
import { ompAdapter } from "../server/harness/omp/adapter.js";
import { classifyHerdrPrompt } from "../server/prompt.js";
import { LaunchError, type LaunchResult } from "../server/launch.js";
import { FakeConfig, FakeTranscript, makeFakeAdapter } from "./fake-harness.js";
import { ProviderEventSchema, type ProviderConnection, type ProviderEvent, type ProviderSessionConfig } from "@getpaseo/plugin/server/provider";

const config: ProviderSessionConfig = {
  cwd: "/work", env: {}, mcpServers: {}, settings: {}, persist: true,
};
let server: Server | undefined;
let directory: string | undefined;
const connections: ProviderConnection[] = [];
afterEach(async () => {
  vi.useRealTimers();
  for (const connection of connections.splice(0)) await connection.close();
  if (server) await new Promise<void>((resolve) => server?.close(() => resolve()));
  if (directory) await rm(directory, { recursive: true, force: true });
  server = undefined;
  directory = undefined;
});

it("imports an active OMP chain and sends a prompt only to its bound idle pane", async () => {
  directory = await mkdtemp(join(tmpdir(), "herdr-provider-"));
  const transcript = join(directory, "session.jsonl");
  const socket = join(directory, "herdr.sock");
  await writeFile(transcript, [
    JSON.stringify({ type: "session", id: "native" }),
    JSON.stringify({ type: "message", id: "u1", parentId: null, message: { role: "user", content: [{ type: "text", text: "Hello" }] } }),
    JSON.stringify({ type: "message", id: "a1", parentId: "u1", message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "Hi" }] } }),
    "",
  ].join("\n"));
  const modifiedAt = new Date("2026-10-11T17:05:00.000Z");
  await utimes(transcript, modifiedAt, modifiedAt);
  const agent = {
    terminal_id: "term-1", pane_id: "pane-1", agent: "omp", name: "demo", title: "Demo", cwd: "/work",
    terminal_title: null, terminal_title_stripped: null, display_agent: "omp", agent_status: "idle",
    screen_detection_skipped: false, state_labels: {}, tokens: {},
    agent_session: { source: "herdr:omp", agent: "omp", kind: "path", value: transcript },
    workspace_id: "w1", tab_id: "t1", focused: true, launch_pending: false, interactive_ready: true,
    state_change_seq: 0, completion_seq: null, foreground_cwd: "/work", revision: 0,
  };
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
        pane_id: "pane-1", foreground_process_group_id: 1234, tty: "/dev/pts/fake",
        foreground_processes: [{ pid: 1234, name: "omp", argv: ["omp"] }],
      } } : request.method === "ping" ? { type: "pong", version: "0.9.3", protocol: 22 } :
        request.method === "agent.list" ? { type: "agent_list", agents: [agent] } :
        request.method === "agent.prompt" ? { type: "agent_prompted", agent } :
        request.method === "integration.list" ? { type: "integration_list", integrations: [{ target: "omp", label: "OMP", command: "omp", available: true, state: "current" }] } :
        { type: "unknown" };
      stream.end(JSON.stringify({ id: request.id, result }) + "\n");
    });
  });
  await new Promise<void>((resolve) => server?.listen(socket, resolve));
  const provider = createHerdrProvider({ ...ompAdapter,
    inputCompanionStatus: async () => ({ ok: true }),
    inspectInput: async ({ pid }) => ({ pid, instanceId: "test-instance" }),
    submitPrompt: async (target, text, ctx) => {
      const result = await ctx.request("agent.prompt", { target: target.paneId, text }, { signal: ctx.signal });
      return classifyHerdrPrompt(result, undefined, { harness: "omp", terminalId: target.terminalId, sessionRef: target.ref,
        agentName: "demo", herdrSession: null, cwd: "/work", submittedMessages: {} });
    },
  }, async () => socket);
  expect(await provider.status?.({})).toEqual({ available: true });
  const missingCompanion = createHerdrProvider({ ...ompAdapter,
    inputCompanionStatus: async () => ({ ok: false, diagnostic: "companion missing" }),
  }, async () => socket);
  expect(await missingCompanion.status?.({})).toEqual({ available: true, diagnostic: "companion missing" });
  const throwingCompanion = createHerdrProvider({ ...ompAdapter,
    inputCompanionStatus: async () => { throw new Error("EACCES"); },
  }, async () => socket);
  expect(await throwingCompanion.status?.({})).toMatchObject({ available: true, diagnostic: expect.stringContaining("EACCES") });
  const connection = await provider.connect({ versions: [1], capabilities: ["session.list", "session.persistence", "prompt.message"] });
  connections.push(connection);
  const events: ProviderEvent[] = [];
  connection.onEvent((event) => events.push(ProviderEventSchema.parse(event)));
  await connection.send({ type: "sessions", requestId: "list", cwd: "/work" });
  await vi.waitFor(() => expect(events.find((event) => event.type === "sessions")).toBeDefined());
  const listing = events.find((event) => event.type === "sessions");
  if (!listing || listing.type !== "sessions") throw new Error("Missing session list");
  expect(listing.sessions).toHaveLength(1);
  expect(listing.sessions[0].updatedAt).toBe(modifiedAt.toISOString());
  await connection.send({ type: "session.open", requestId: "open", sessionId: "local", config,
    persistence: listing.sessions[0].persistence, history: "replay" });
  await vi.waitFor(() => expect(events.find((event) => event.type === "session.ready")).toBeDefined());
  expect(events.flatMap((event) => event.type === "timeline.item" && "text" in event.item ? [event.item.text] : []))
    .toEqual(["Hello", "Hi"]);
  expect(events.find((event) => event.type === "timeline.item" && event.item.type === "user_message")).toMatchObject({
    item: { text: "Hello" },
  });
  await connection.send({ type: "session.prompt", sessionId: "local", prompt: {
    clientMessageId: "message-1", delivery: "auto", input: { type: "message", content: [{ type: "text", text: "Next" }] },
  } });
  await vi.waitFor(() => expect(sent.some((request) => request.method === "agent.prompt")).toBe(true));
  expect(sent.find((request) => request.method === "agent.prompt")?.params).toMatchObject({ target: "pane-1", text: "Next" });
  await writeFile(transcript, [
    JSON.stringify({ type: "session", id: "native" }),
    JSON.stringify({ type: "message", id: "u1", parentId: null, message: { role: "user", content: [{ type: "text", text: "Hello" }] } }),
    JSON.stringify({ type: "message", id: "a1", parentId: "u1", message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "Hi" }] } }),
    JSON.stringify({ type: "message", id: "u2", parentId: "a1", message: { role: "user", content: [{ type: "text", text: "Next" }] } }),
    JSON.stringify({ type: "message", id: "a2", parentId: "u2", message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "Done" }] } }),
    "",
  ].join("\n"));
  await vi.waitFor(() => expect(events.some((event) => event.type === "session.turn" && event.state === "completed")).toBe(true), { timeout: 2500 });
  const committed = events.find((event) => event.type === "timeline.item" && event.item.type === "user_message" && event.item.id.includes(":u2:"));
  expect(committed).toMatchObject({ item: { text: "Next", clientMessageId: "message-1" } });
  const persisted = events.find((event) => event.type === "session.persistence" &&
    Object.values((event.persistence.data as { submittedMessages: Record<string, string> }).submittedMessages).includes("message-1"));
  if (!persisted || persisted.type !== "session.persistence") throw new Error("Missing native message correlation");
  await connection.send({ type: "session.close", sessionId: "local", requestId: "close" });
  await vi.waitFor(() => expect(events.some((event) => event.type === "request.completed" && event.requestId === "close")).toBe(true));
  await connection.send({ type: "session.open", requestId: "reopen", sessionId: "local", config,
    persistence: persisted.persistence, history: "replay" });
  await vi.waitFor(() => expect(events.some((event) => event.type === "session.ready" && event.requestId === "reopen")).toBe(true));
  const replayed = events.filter((event) => event.type === "timeline.item" && event.item.type === "user_message" && event.item.id.includes(":u2:"));
  expect(replayed).toHaveLength(2);
  expect(replayed[1]).toMatchObject({ item: { clientMessageId: "message-1" } });
  agent.agent_status = "working";
  await connection.send({ type: "session.prompt", sessionId: "local", prompt: {
    clientMessageId: "message-2", delivery: "auto", input: { type: "message", content: [{ type: "text", text: "Too soon" }] },
  } });
  await vi.waitFor(() => expect(events.some((event) => event.type === "session.prompt_result" &&
    event.clientMessageId === "message-2" && event.result.type === "failed")).toBe(true));
  expect(sent.filter((request) => request.method === "agent.prompt")).toHaveLength(1);
  await connection.close();
});

// --- Create path (no persistence): provider dispatch ---------------------------------------
async function createRig(options: { companion?: { ok: boolean; diagnostic?: string }; launch: (signal: AbortSignal) => Promise<LaunchResult>; config?: FakeConfig }) {
  directory = await mkdtemp(join(tmpdir(), "herdr-create-"));
  const socket = join(directory, "herdr.sock");
  const agent = { terminal_id: "term-new", pane_id: "pane-new", agent: "fake", name: "paseo-abc123", cwd: "/work",
    agent_status: "idle", screen_detection_skipped: false, state_labels: {}, tokens: {},
    agent_session: { source: "herdr:fake", agent: "fake", kind: "id", value: "fake-session-1" },
    workspace_id: "w1", tab_id: "t1", focused: true, launch_pending: false, interactive_ready: true,
    state_change_seq: 0, completion_seq: null, revision: 0 };
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
        pane_id: "pane-new", foreground_process_group_id: 77, tty: "/dev/pts/fake", foreground_processes: [{ pid: 77, name: "fake" }] } } :
        request.method === "agent.list" ? { type: "agent_list", agents: [agent] } :
        request.method === "agent.prompt" ? { type: "agent_prompted", agent } : { type: "unknown" };
      stream.end(JSON.stringify({ id: request.id, result }) + "\n");
    });
  });
  await new Promise<void>((resolve) => server?.listen(socket, resolve));
  const adapter = makeFakeAdapter(new FakeTranscript(), { config: options.config });
  const launches: AbortSignal[] = [];
  const provider = createHerdrProvider(
    { ...adapter, ...(options.companion ? { inputCompanionStatus: async () => options.companion! } : {}) },
    async () => socket,
    { getHerdrSession: () => "work", launch: async (_config, signal) => { launches.push(signal); return options.launch(signal); } },
  );
  const connection = await provider.connect({ versions: [1], capabilities: ["session.list", "session.persistence", "prompt.message", "session.configure"] });
  connections.push(connection);
  const events: ProviderEvent[] = [];
  connection.onEvent((event) => events.push(ProviderEventSchema.parse(event)));
  return { connection, events, sent, launches };
}
const launchedAgent = (): LaunchResult => ({ agentName: "paseo-abc123", terminalId: "term-new", paneId: "pane-new",
  tabId: "t1", workspaceId: "w1", createdWorkspace: true, cwd: "/work", sessionRef: { kind: "id", value: "fake-session-1" } });
const openNew = { type: "session.open", requestId: "open", sessionId: "new", config, history: "replay" } as const;

it("creates an agent without persistence, announces how to attach, and admits a prompt", async () => {
  const { connection, events, sent } = await createRig({ companion: { ok: true }, launch: async () => launchedAgent() });
  await connection.send(openNew);
  await vi.waitFor(() => expect(events.some((event) => event.type === "session.ready")).toBe(true));
  expect(events.find((event) => event.type === "session.opened")).toMatchObject({ requestId: "open", persistence: { data: {
    terminalId: "term-new", agentName: "paseo-abc123", herdrSession: "work", sessionRef: { kind: "id", value: "fake-session-1" } } } });
  const notices = events.filter((event) => event.type === "session.notice");
  expect(notices).toHaveLength(1);
  expect(notices[0]).toMatchObject({ notice: { id: "attach", severity: "info",
    description: expect.stringContaining("herdr --session work agent attach paseo-abc123") } });
  await connection.send({ type: "session.prompt", sessionId: "new", prompt: {
    clientMessageId: "m1", delivery: "auto", input: { type: "message", content: [{ type: "text", text: "Go" }] } } });
  await vi.waitFor(() => expect(sent.some((request) => request.method === "agent.prompt")).toBe(true));
  expect(sent.find((request) => request.method === "agent.prompt")?.params).toMatchObject({ target: "pane-new", text: "Go" });
});

it("refuses to create when the input companion is missing and never launches", async () => {
  const { connection, events, launches } = await createRig({ companion: { ok: false, diagnostic: "companion missing" },
    launch: async () => launchedAgent() });
  await connection.send(openNew);
  await vi.waitFor(() => expect(events.some((event) => event.type === "request.failed")).toBe(true));
  expect(events.find((event) => event.type === "request.failed")).toMatchObject({ requestId: "open", error: { message: "companion missing" } });
  expect(launches).toEqual([]);
  expect(events.some((event) => event.type === "session.opened")).toBe(false);
});

it("fails the request on LaunchError and does not leave the session registered", async () => {
  let attempt = 0;
  const { connection, events } = await createRig({ companion: { ok: true }, launch: async () => {
    if (attempt++ === 0) throw new LaunchError("Launch timed out; pane p-9 in workspace w-9 is still running", "timeout");
    return launchedAgent();
  } });
  await connection.send(openNew);
  await vi.waitFor(() => expect(events.some((event) => event.type === "request.failed")).toBe(true));
  expect(events.find((event) => event.type === "request.failed")).toMatchObject({
    requestId: "open", error: { message: expect.stringContaining("pane p-9") } });
  expect(events.some((event) => event.type === "session.opened")).toBe(false);
  // The id is free again (no "Session already open") and a prompt to it is unknown.
  await connection.send({ type: "session.prompt", sessionId: "new", prompt: {
    clientMessageId: "m0", delivery: "auto", input: { type: "message", content: [{ type: "text", text: "x" }] } } });
  await vi.waitFor(() => expect(events.some((event) => event.type === "session.prompt_result")).toBe(true));
  expect(events.find((event) => event.type === "session.prompt_result")).toMatchObject({
    result: { type: "failed", error: { message: "Unknown session" } } });
  await connection.send({ ...openNew, requestId: "retry" });
  await vi.waitFor(() => expect(events.some((event) => event.type === "session.ready" && event.requestId === "retry")).toBe(true));
});

it("close during launch aborts the launch and emits no session events afterwards", async () => {
  let release!: (result: LaunchResult) => void;
  const { connection, events, launches } = await createRig({ companion: { ok: true },
    launch: () => new Promise<LaunchResult>((resolve) => { release = resolve; }) });
  await connection.send(openNew);
  await vi.waitFor(() => expect(launches).toHaveLength(1));
  await connection.send({ type: "session.close", sessionId: "new", requestId: "close" });
  await vi.waitFor(() => expect(events.some((event) => event.type === "request.completed" && event.requestId === "close")).toBe(true));
  expect(launches[0].aborted).toBe(true);
  release(launchedAgent());
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(events.map((event) => event.type)).toEqual(["session.closed", "request.completed"]);
});

it("OMP launch args pass model and thinking and never disable extensions (the companion must load)", () => {
  expect(ompAdapter.launchArgs({ ...config, model: "m-1", thinkingOption: "high" })).toEqual(["--model", "m-1", "--thinking", "high"]);
  expect(ompAdapter.launchArgs(config)).toEqual([]);
  expect(ompAdapter.launchArgs({ ...config, model: "m-1" }).join(" ")).not.toContain("--no-extensions");
});

// --- P3.5A: configure capability, catalog and dispatch ---------------------------------------
const catalogOf = (events: ProviderEvent[], requestId: string) => {
  const event = events.find((candidate) => candidate.type === "catalog" && candidate.requestId === requestId);
  if (!event || event.type !== "catalog") throw new Error(`Missing catalog ${requestId}`);
  return event.catalog;
};

it("advertises session.configure only when the adapter can read and change config", async () => {
  const plain = await createRig({ companion: { ok: true }, launch: async () => launchedAgent() });
  expect(plain.connection.capabilities).not.toContain("session.configure");
  await plain.connection.send(openNew);
  await vi.waitFor(() => expect(plain.events.some((event) => event.type === "session.ready")).toBe(true));
  expect(plain.events.find((event) => event.type === "session.opened")).toMatchObject({ capabilities: expect.not.arrayContaining(["session.configure"]) });
  expect(plain.events.some((event) => event.type === "session.config")).toBe(false);
  await plain.connection.close();

  const configurable = await createRig({ companion: { ok: true }, launch: async () => launchedAgent(), config: new FakeConfig() });
  expect(configurable.connection.capabilities).toContain("session.configure");
  await configurable.connection.send(openNew);
  await vi.waitFor(() => expect(configurable.events.some((event) => event.type === "session.ready")).toBe(true));
  expect(configurable.events.find((event) => event.type === "session.opened")).toMatchObject({ capabilities: expect.arrayContaining(["session.configure"]) });
});

it("serves an empty catalog before any config was read, then models from the cache with per-model thinking options", async () => {
  const config = new FakeConfig();
  const { connection, events } = await createRig({ companion: { ok: true }, launch: async () => launchedAgent(), config });
  await connection.send({ type: "catalog", requestId: "c0", options: { cwd: "/work" } } as never);
  await vi.waitFor(() => expect(events.some((event) => event.type === "catalog")).toBe(true));
  expect(catalogOf(events, "c0")).toEqual({ models: [], modes: [] });
  await connection.send(openNew);
  await vi.waitFor(() => expect(events.some((event) => event.type === "session.ready")).toBe(true));
  await connection.send({ type: "catalog", requestId: "c1", options: { cwd: "/work" } } as never);
  await vi.waitFor(() => expect(events.some((event) => event.type === "catalog" && event.requestId === "c1")).toBe(true));
  const catalog = catalogOf(events, "c1");
  expect(catalog.modes).toEqual([]);
  expect(catalog.models).toEqual([
    { id: "fake/reasoner", label: "Reasoner", description: "fake", contextWindowMaxTokens: 200000, isDefault: true,
      thinkingOptions: [{ id: "off", label: "Off" }, { id: "low", label: "low" }, { id: "medium", label: "medium" }, { id: "high", label: "high" }],
      defaultThinkingOptionId: "medium" },
    { id: "fake/plain", label: "Plain", description: "fake" },
  ]);
});

it("refreshes a stale model cache through a live session and survives a failing refresh", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  const config = new FakeConfig();
  const { connection, events } = await createRig({ companion: { ok: true }, launch: async () => launchedAgent(), config });
  await connection.send(openNew);
  await vi.waitFor(() => expect(events.some((event) => event.type === "session.ready")).toBe(true));
  const reads = config.reads;
  await connection.send({ type: "catalog", requestId: "fresh" } as never);
  await vi.waitFor(() => expect(events.some((event) => event.type === "catalog")).toBe(true));
  expect(config.reads).toBe(reads);
  vi.setSystemTime(Date.now() + 6 * 60 * 1000);
  config.models = [...config.models, { id: "fake/new", label: "New", provider: "fake", thinkingLevels: [] }];
  await connection.send({ type: "catalog", requestId: "stale" } as never);
  await vi.waitFor(() => expect(events.some((event) => event.type === "catalog" && event.requestId === "stale")).toBe(true));
  expect(config.reads).toBe(reads + 1);
  expect(catalogOf(events, "stale").models.map((model) => model.id)).toEqual(["fake/reasoner", "fake/plain", "fake/new"]);
  vi.setSystemTime(Date.now() + 6 * 60 * 1000);
  config.readError = new Error("companion gone");
  await connection.send({ type: "catalog", requestId: "failing" } as never);
  await vi.waitFor(() => expect(events.some((event) => event.type === "catalog" && event.requestId === "failing")).toBe(true));
  expect(catalogOf(events, "failing").models).toHaveLength(3);
});

it("dispatches session.configure: config first then completion, and fails an unknown session", async () => {
  const config = new FakeConfig();
  const { connection, events } = await createRig({ companion: { ok: true }, launch: async () => launchedAgent(), config });
  await connection.send({ type: "session.configure", requestId: "ghost", sessionId: "nope", changes: { model: "fake/plain" } });
  await vi.waitFor(() => expect(events.some((event) => event.type === "request.failed" && event.requestId === "ghost")).toBe(true));
  await connection.send(openNew);
  await vi.waitFor(() => expect(events.some((event) => event.type === "session.ready")).toBe(true));
  await connection.send({ type: "session.configure", requestId: "cfg", sessionId: "new", changes: { thinkingOption: "high" } });
  await vi.waitFor(() => expect(events.some((event) => event.type === "request.completed" && event.requestId === "cfg")).toBe(true));
  const tail = events.slice(events.findIndex((event) => event.type === "session.ready"));
  const configs = tail.filter((event) => event.type === "session.config");
  expect(configs.at(-1)).toMatchObject({ config: { model: "fake/reasoner", thinkingOption: "high" } });
  expect(tail.map((event) => event.type).lastIndexOf("session.config")).toBeLessThan(tail.findIndex((event) => event.type === "request.completed"));
});
