import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import net, { type Socket } from "node:net";
import fs from "node:fs";
import { mkdtemp, mkdir, rm, stat, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { once, getEventListeners } from "node:events";
import ompInputCompanion from "../harness-extension/omp.js";
import { configureOmp, inspectOmpInput, readOmpConfig, submitOmpInput } from "../server/harness/omp/input.js";

const REF = { kind: "path" as const, value: "/tmp/omp-input-session.jsonl" };
const INSTANCE = "test-instance";
const PID = 424242;
type Request = Record<string, unknown>;
let root: string;
const cleanups: Array<() => Promise<void>> = [];

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "paseo-omp-input-test-"));
  vi.spyOn(os, "tmpdir").mockReturnValue(root);
});
afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(cleanups.splice(0).map((close) => close()));
  vi.restoreAllMocks();
  await rm(root, { recursive: true, force: true });
});

/** A socket-only protocol peer, not a fake harness/provider wiring test. */
async function inputServer(handle: (request: Request, socket: Socket) => void) {
  const directory = path.join(root, `omp-input-${PID}`);
  await mkdir(directory, { mode: 0o700 });
  const requests: Request[] = [];
  const sockets = new Set<Socket>();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    socket.on("error", () => {});
    socket.setEncoding("utf8");
    let buffer = "";
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      const request = JSON.parse(buffer.slice(0, newline)) as Request;
      buffer = buffer.slice(newline + 1);
      requests.push(request);
      handle(request, socket);
    });
  });
  const listening = once(server, "listening");
  server.listen(path.join(directory, "sock"));
  await listening;
  cleanups.push(async () => {
    for (const socket of sockets) socket.destroy();
    const closed = once(server, "close");
    server.close();
    await closed;
  });
  return { requests };
}

function reply(socket: Socket, request: Request, result: Request): void {
  socket.end(`${JSON.stringify({ nonce: request.nonce, pid: request.pid, ref: request.ref, instanceId: INSTANCE, ...result })}\n`);
}

/** Observe only the companion wire protocol; production never exposes drafts. */
async function wireRequest(pid: number, request: Request): Promise<Request> {
  const socket = net.createConnection({ path: path.join(root, `omp-input-${pid}`, "sock") });
  try {
    await once(socket, "connect");
    socket.setEncoding("utf8");
    socket.write(`${JSON.stringify(request)}\n`);
    let buffer = "";
    for await (const chunk of socket) {
      buffer += String(chunk);
      const newline = buffer.indexOf("\n");
      if (newline >= 0) return JSON.parse(buffer.slice(0, newline)) as Request;
    }
    throw new Error("No complete companion reply");
  } finally { socket.destroy(); }
}

const MODEL_LIST = [
  { provider: "openai-codex", id: "gpt-6", name: "GPT 6", reasoning: true, thinking: { mode: "effort", efforts: ["minimal", "low", "high"], defaultLevel: "low" }, contextWindow: 400000 },
  { provider: "openai-codex", id: "gpt-6-mini", name: "GPT 6 Mini", reasoning: true, thinking: { mode: "effort", efforts: ["low", "medium"] }, contextWindow: 200000 },
  { provider: "ollama-cloud", id: "gpt-oss:20b", name: "GPT OSS", reasoning: false, contextWindow: null },
  { provider: "ollama-cloud", id: "kimi", name: "Kimi", reasoning: false, contextWindow: 128000 },
];

async function startCompanion() {
  const state = {
    draft: "", idle: true, pending: false, ref: REF.value,
    current: MODEL_LIST[0] as unknown, thinking: "low" as unknown, list: MODEL_LIST as unknown,
  };
  const ctx = {
    mode: "tui", hasUI: true, agent: { kind: "main" },
    isIdle: vi.fn(() => state.idle),
    hasPendingMessages: vi.fn(() => state.pending),
    ui: { getEditorText: vi.fn((): unknown => state.draft), notify: vi.fn() },
    sessionManager: { getSessionFile: () => state.ref, getSessionId: () => "native-id" },
    models: { list: vi.fn(() => state.list), current: vi.fn(() => state.current) },
  };
  type Event = "session_start" | "session_switch" | "session_shutdown";
  const handlers: Partial<Record<Event, (event: unknown, context: typeof ctx) => void>> = {};
  const sendUserMessage = vi.fn((_text: string) => {});
  const setModel = vi.fn(async (model: unknown) => { state.current = model; return true; });
  const setThinkingLevel = vi.fn((level: string) => { state.thinking = level; });
  const getThinkingLevel = vi.fn(() => state.thinking);
  ompInputCompanion({
    on: (event, handler) => { handlers[event] = handler; },
    sendUserMessage, setModel, setThinkingLevel, getThinkingLevel,
  });
  handlers.session_start?.({}, ctx);
  const socketPath = path.join(root, `omp-input-${process.pid}`, "sock");
  cleanups.push(async () => {
    handlers.session_shutdown?.({}, ctx);
    await vi.waitFor(() => { expect(fs.existsSync(socketPath)).toBe(false); });
  });
  await vi.waitFor(async () => { expect((await stat(socketPath)).isSocket()).toBe(true); });
  return { state, ctx, handlers, sendUserMessage, setModel, setThinkingLevel, getThinkingLevel, socketPath };
}

describe("OMP input client delivery classification", () => {
  it("gives a required-extension install diagnostic for a missing companion", async () => {
    await expect(inspectOmpInput(PID, REF)).rejects.toThrow(/required OMP input companion.*read-only.*npm run install:omp-companion.*restart the OMP agent.*never restarted automatically/);
    await expect(submitOmpInput(PID, REF, INSTANCE, "prompt")).resolves.toMatchObject({ type: "rejected" });
  });

  it("rejects a pre-aborted prompt without connecting or writing", async () => {
    const peer = await inputServer(() => { throw new Error("must not connect"); });
    const controller = new AbortController();
    controller.abort();
    await expect(submitOmpInput(PID, REF, INSTANCE, "prompt", controller.signal)).resolves.toMatchObject({ type: "rejected" });
    expect(peer.requests).toEqual([]);
    expect(getEventListeners(controller.signal, "abort")).toEqual([]);
  });

  it("sends exact text, PID/ref/instance identity and a fresh nonce on each request", async () => {
    const peer = await inputServer((request, socket) => reply(socket, request, request.op === "inspect"
      ? { type: "inspected", mode: "tui", hasUI: true, isMain: true, isIdle: false, hasPending: true, hasDraft: true }
      : { type: "accepted" }));
    await expect(inspectOmpInput(PID, REF)).resolves.toEqual({ pid: PID, instanceId: INSTANCE });
    await inspectOmpInput(PID, REF);
    const text = "  exact\t☃\nsecond line\n\n";
    await expect(submitOmpInput(PID, REF, INSTANCE, text)).resolves.toEqual({ type: "accepted" });
    expect(peer.requests).toHaveLength(3);
    expect(new Set(peer.requests.map((request) => request.nonce)).size).toBe(3);
    expect(peer.requests[2]).toMatchObject({ op: "submit", pid: PID, ref: REF, instanceId: INSTANCE, text });
  });

  it("accepts only an authenticated explicit refusal as rejected", async () => {
    await inputServer((request, socket) => reply(socket, request, { type: "rejected", code: "editor_not_empty", message: "terminal draft preserved" }));
    await expect(submitOmpInput(PID, REF, INSTANCE, "prompt")).resolves.toEqual({ type: "rejected", message: "terminal draft preserved" });
  });

  it.each([
    ["nonce", { nonce: "old-request" }],
    ["PID", { pid: PID + 1 }],
    ["instance", { instanceId: "replacement-instance" }],
    ["native ref", { ref: { kind: "path", value: "/tmp/replacement.jsonl" } }],
  ])("marks a wrong %s uncertain, including otherwise explicit refusals", async (_name, changed) => {
    const peer = await inputServer((request, socket) => reply(socket, request, { type: "rejected", code: "editor_not_empty", message: "refused", ...changed }));
    await expect(submitOmpInput(PID, REF, INSTANCE, "prompt")).resolves.toMatchObject({ type: "uncertain" });
    expect(peer.requests).toHaveLength(1);
  });

  it.each(["not-json", "null", "[]", "7", '{}', '{"type":"accepted"}'])
    ("marks malformed/unidentified reply %s uncertain without retry", async (body) => {
      const peer = await inputServer((_request, socket) => socket.end(`${body}\n`));
      await expect(submitOmpInput(PID, REF, INSTANCE, "prompt")).resolves.toMatchObject({ type: "uncertain" });
      expect(peer.requests).toHaveLength(1);
    });

  it.each([
    { type: "rejected", code: "unknown", message: "unknown refusal" },
    { type: "rejected", code: "not_idle", message: 42 },
    { type: "rejected", code: "not_idle", message: "" },
    { type: "unexpected" },
    { accepted: true },
  ])("marks unknown protocol outcome %j uncertain", async (result) => {
    await inputServer((request, socket) => reply(socket, request, result));
    await expect(submitOmpInput(PID, REF, INSTANCE, "prompt")).resolves.toMatchObject({ type: "uncertain" });
  });

  it.each(["", '{"type":"accepted"}'])
    ("marks post-write EOF/partial reply %j uncertain without retry", async (body) => {
      const peer = await inputServer((_request, socket) => socket.end(body));
      await expect(submitOmpInput(PID, REF, INSTANCE, "prompt")).resolves.toMatchObject({ type: "uncertain" });
      expect(peer.requests).toHaveLength(1);
    });

  it("marks abort after write uncertain and releases the abort listener", async () => {
    const controller = new AbortController();
    const peer = await inputServer(() => { controller.abort(); });
    await expect(submitOmpInput(PID, REF, INSTANCE, "prompt", controller.signal)).resolves.toMatchObject({ type: "uncertain" });
    expect(peer.requests).toHaveLength(1);
    expect(getEventListeners(controller.signal, "abort")).toEqual([]);
  });

  it("marks timeout after write uncertain without retry", async () => {
    const seen = Promise.withResolvers<void>();
    const peer = await inputServer(() => { seen.resolve(); });
    vi.useFakeTimers();
    const result = submitOmpInput(PID, REF, INSTANCE, "prompt");
    await seen.promise;
    await vi.advanceTimersByTimeAsync(3001);
    await expect(result).resolves.toMatchObject({ type: "uncertain" });
    expect(peer.requests).toHaveLength(1);
  });
});

describe("OMP companion authoritative editor guard", () => {
  it("uses private permissions and preserves a draft exactly without leaking it", async () => {
    const companion = await startCompanion();
    const draft = "  terminal\t☃\nsecond line\n\n";
    companion.state.draft = draft;
    expect((await stat(path.dirname(companion.socketPath))).mode & 0o777).toBe(0o700);
    expect((await stat(companion.socketPath)).mode & 0o777).toBe(0o600);
    const observed = await wireRequest(process.pid, { op: "inspect", nonce: "inspect-draft", pid: process.pid, ref: REF });
    expect(observed.hasDraft).toBe(true);
    expect(observed).not.toHaveProperty("editorText");
    expect(JSON.stringify(observed)).not.toContain("terminal");
    const identity = await inspectOmpInput(process.pid, REF);
    await expect(submitOmpInput(process.pid, REF, identity.instanceId, "Paseo prompt")).resolves.toMatchObject({ type: "rejected", message: expect.stringContaining("terminal draft") });
    expect(companion.state.draft).toBe(draft);
    expect(companion.sendUserMessage).not.toHaveBeenCalled();
  });

  it("hands off the exact text with no async gap or editor mutation", async () => {
    const companion = await startCompanion();
    const identity = await inspectOmpInput(process.pid, REF);
    companion.ctx.ui.getEditorText.mockImplementation(() => {
      queueMicrotask(() => { companion.state.draft = "later terminal input"; });
      return "";
    });
    companion.sendUserMessage.mockImplementation(() => { expect(companion.state.draft).toBe(""); });
    const text = "  exact\t☃\nsecond line\n\n";
    await expect(submitOmpInput(process.pid, REF, identity.instanceId, text)).resolves.toEqual({ type: "accepted" });
    expect(companion.sendUserMessage).toHaveBeenCalledExactlyOnceWith(text);
    expect(companion.state.draft).toBe("later terminal input");
  });

  it.each(["busy", "pending", "non-TUI", "no UI", "subagent", "unknown editor"])
    ("refuses %s synchronously without sending or changing a draft", async (condition) => {
      const companion = await startCompanion();
      const identity = await inspectOmpInput(process.pid, REF);
      switch (condition) {
        case "busy": companion.state.idle = false; break;
        case "pending": companion.state.pending = true; break;
        case "non-TUI": companion.ctx.mode = "rpc"; break;
        case "no UI": companion.ctx.hasUI = false; break;
        case "subagent": companion.ctx.agent.kind = "sub"; break;
        case "unknown editor": companion.ctx.ui.getEditorText.mockImplementation(() => { throw new Error("secret draft bytes"); }); break;
      }
      await expect(submitOmpInput(process.pid, REF, identity.instanceId, "prompt")).resolves.toMatchObject({ type: "rejected" });
      expect(companion.sendUserMessage).not.toHaveBeenCalled();
      expect(companion.state.draft).toBe("");
    });

  it("checks the expected instance and current native ref before handing off", async () => {
    const companion = await startCompanion();
    const identity = await inspectOmpInput(process.pid, REF);
    await expect(submitOmpInput(process.pid, REF, "stale-instance", "prompt")).resolves.toMatchObject({ type: "uncertain" });
    companion.state.ref = "/tmp/new-session.jsonl";
    companion.handlers.session_switch?.({}, companion.ctx);
    await expect(submitOmpInput(process.pid, REF, identity.instanceId, "prompt")).resolves.toMatchObject({ type: "uncertain" });
    await expect(inspectOmpInput(process.pid, { kind: "path", value: companion.state.ref })).resolves.toEqual(identity);
    expect(companion.sendUserMessage).not.toHaveBeenCalled();
  });

  it("keeps a throwing send handoff uncertain without exposing error/draft bytes", async () => {
    const companion = await startCompanion();
    const identity = await inspectOmpInput(process.pid, REF);
    companion.sendUserMessage.mockImplementation(() => { throw new Error("secret draft bytes"); });
    const result = await submitOmpInput(process.pid, REF, identity.instanceId, "prompt");
    expect(result.type).toBe("uncertain");
    expect(JSON.stringify(result)).not.toContain("secret draft bytes");
    expect(companion.sendUserMessage).toHaveBeenCalledOnce();
  });

  it("does not adopt, chmod, or remove an existing PID directory on startup/shutdown", async () => {
    const directory = path.join(root, `omp-input-${process.pid}`);
    await mkdir(directory, { mode: 0o755 });
    const before = (await stat(directory)).mode;
    const marker = path.join(directory, "other-instance");
    await writeFile(marker, "untouched");
    const handlers: Partial<Record<string, (event: unknown, ctx: unknown) => void>> = {};
    const notify = vi.fn();
    const sendUserMessage = vi.fn();
    ompInputCompanion({
      on: (event, handler) => { handlers[event] = handler as (event: unknown, ctx: unknown) => void; },
      sendUserMessage, setModel: vi.fn(), getThinkingLevel: vi.fn(), setThinkingLevel: vi.fn(),
    });
    handlers.session_start?.({}, { ui: { notify } });
    handlers.session_shutdown?.({}, {});
    expect(notify).toHaveBeenCalledWith(expect.stringContaining("read-only"), "error");
    expect((await stat(directory)).mode).toBe(before);
    expect(await readFile(marker, "utf8")).toBe("untouched");
    expect(sendUserMessage).not.toHaveBeenCalled();
  });
});

describe("OMP client configuration mapping", () => {
  const wire = (extra: Request[]) => extra;
  const model = (extra: Request) => ({ id: "p/m", provider: "p", name: "M", reasoning: true, efforts: ["low"], contextWindow: 1000, ...extra });

  it("maps models, disambiguates duplicate names by provider and drops levels for non-reasoning models", async () => {
    const peer = await inputServer((request, socket) => reply(socket, request, {
      type: "config", model: "p/m", thinkingLevel: "low",
      models: wire([
        model({}),
        model({ id: "a/dup", provider: "a", name: "Same", defaultLevel: "low" }),
        model({ id: "b/dup", provider: "b", name: "Same", reasoning: false, efforts: ["high"], contextWindow: null }),
      ]),
    }));
    const config = await readOmpConfig(PID, REF, INSTANCE);
    expect(peer.requests[0]).toMatchObject({ op: "config", pid: PID, ref: REF, instanceId: INSTANCE });
    expect(config).toEqual({
      model: "p/m",
      thinkingLevel: "low",
      models: [
        { id: "p/m", label: "M", provider: "p", thinkingLevels: ["low"], contextWindow: 1000 },
        { id: "a/dup", label: "Same (a)", provider: "a", thinkingLevels: ["low"], defaultThinkingLevel: "low", contextWindow: 1000 },
        { id: "b/dup", label: "Same (b)", provider: "b", thinkingLevels: [] },
      ],
    });
  });

  it("throws the companion refusal and rejects malformed or unauthenticated replies", async () => {
    await inputServer((request, socket) => reply(socket, request, { type: "rejected", code: "config_unavailable", message: "state unavailable" }));
    await expect(readOmpConfig(PID, REF, INSTANCE)).rejects.toThrow("state unavailable");
  });

  it.each([
    [{ type: "config", model: 5, thinkingLevel: null, models: [] }],
    [{ type: "config", model: null, thinkingLevel: null, models: "x" }],
    [{ type: "config", model: null, thinkingLevel: null, models: [{ id: "p/m" }] }],
    [{ type: "other" }],
    [{ type: "config", model: null, thinkingLevel: null, models: [], nonce: "stale" }],
  ])("throws on malformed config reply %j", async (result) => {
    await inputServer((request, socket) => reply(socket, request, result));
    await expect(readOmpConfig(PID, REF, INSTANCE)).rejects.toThrow();
  });

  it("classifies configure outcomes with the submit ambiguity rules", async () => {
    const configured = { type: "configured", model: "p/m", thinkingLevel: "low", models: [model({})] };
    const peer = await inputServer((request, socket) => {
      const model = request.model;
      if (model === "bad") reply(socket, request, { type: "rejected", code: "unknown_model", message: "no such model" });
      else if (model === "weird") reply(socket, request, { type: "rejected", code: "made_up", message: "x" });
      else if (model === "stale") reply(socket, request, { ...configured, instanceId: "other" });
      else if (model === "silent") socket.end("");
      else reply(socket, request, configured);
    });
    await expect(configureOmp(PID, REF, INSTANCE, { model: "p/m", thinkingLevel: "low" })).resolves.toMatchObject({
      type: "configured", config: { model: "p/m", thinkingLevel: "low" },
    });
    expect(peer.requests[0]).toMatchObject({ op: "configure", model: "p/m", thinkingLevel: "low", instanceId: INSTANCE });
    await expect(configureOmp(PID, REF, INSTANCE, { model: "bad" })).resolves.toEqual({ type: "rejected", code: "unknown_model", message: "no such model" });
    for (const unsafe of ["weird", "stale", "silent"]) {
      await expect(configureOmp(PID, REF, INSTANCE, { model: unsafe })).resolves.toMatchObject({ type: "uncertain" });
    }
    const before = peer.requests.length;
    await expect(configureOmp(PID, REF, INSTANCE, {})).resolves.toMatchObject({ type: "rejected", code: "bad_request" });
    expect(peer.requests).toHaveLength(before);
    expect(peer.requests.at(-1)).not.toHaveProperty("thinkingLevel", undefined);
  });

  it("rejects when no companion is listening (never written)", async () => {
    await expect(configureOmp(PID, REF, INSTANCE, { model: "p/m" })).resolves.toMatchObject({ type: "rejected" });
  });
});

describe("OMP companion config and configure ops", () => {
  async function ready() {
    const companion = await startCompanion();
    const identity = await inspectOmpInput(process.pid, REF);
    return { ...companion, identity };
  }
  const wireConfigure = (identity: { instanceId: string }, changes: Request, over: Request = {}) =>
    wireRequest(process.pid, { op: "configure", nonce: "n1", pid: process.pid, ref: REF, instanceId: identity.instanceId, ...changes, ...over });
  const applied = (c: Awaited<ReturnType<typeof ready>>) => [c.setModel.mock.calls.length, c.setThinkingLevel.mock.calls.length];

  it("reports the live model, thinking level and the model list, even while busy", async () => {
    const c = await ready();
    c.state.idle = false;
    c.state.pending = true;
    const config = await readOmpConfig(process.pid, REF, c.identity.instanceId);
    expect(config.model).toBe("openai-codex/gpt-6");
    expect(config.thinkingLevel).toBe("low");
    expect(config.models.map((m) => m.id)).toEqual(["openai-codex/gpt-6", "openai-codex/gpt-6-mini", "ollama-cloud/gpt-oss:20b", "ollama-cloud/kimi"]);
    expect(config.models[0]).toEqual({ id: "openai-codex/gpt-6", label: "GPT 6", provider: "openai-codex", thinkingLevels: ["minimal", "low", "high"], defaultThinkingLevel: "low", contextWindow: 400000 });
    expect(config.models[2]).toEqual({ id: "ollama-cloud/gpt-oss:20b", label: "GPT OSS", provider: "ollama-cloud", thinkingLevels: [] });
    expect(applied(c)).toEqual([0, 0]);
  });

  it("reports null model and thinking when OMP has none", async () => {
    const c = await ready();
    c.state.current = undefined;
    c.state.thinking = undefined;
    await expect(readOmpConfig(process.pid, REF, c.identity.instanceId)).resolves.toMatchObject({ model: null, thinkingLevel: null });
  });

  it.each([
    ["models list is not an array", (c: Awaited<ReturnType<typeof ready>>) => { c.state.list = { nope: true }; }],
    ["models list throws", (c: Awaited<ReturnType<typeof ready>>) => { c.ctx.models.list.mockImplementation(() => { throw new Error("boom"); }); }],
    ["current model has an unknown shape", (c: Awaited<ReturnType<typeof ready>>) => { c.state.current = 42; }],
    ["thinking level has an unknown shape", (c: Awaited<ReturnType<typeof ready>>) => { c.state.thinking = { level: "x" }; }],
  ])("refuses config when %s", async (_name, break_) => {
    const c = await ready();
    break_(c);
    const observed = await wireRequest(process.pid, { op: "config", nonce: "n", pid: process.pid, ref: REF, instanceId: c.identity.instanceId });
    expect(observed).toMatchObject({ type: "rejected", code: "config_unavailable" });
  });

  it("applies the model then the thinking level and reads both back", async () => {
    const c = await ready();
    const order: string[] = [];
    c.setModel.mockImplementation(async (model) => { order.push("model"); c.state.current = model; return true; });
    c.setThinkingLevel.mockImplementation((level: string) => { order.push("thinking"); c.state.thinking = level; });
    const result = await configureOmp(process.pid, REF, c.identity.instanceId, { model: "openai-codex/gpt-6-mini", thinkingLevel: "medium" });
    expect(result).toMatchObject({ type: "configured", config: { model: "openai-codex/gpt-6-mini", thinkingLevel: "medium" } });
    expect(order).toEqual(["model", "thinking"]);
    expect(c.setModel).toHaveBeenCalledExactlyOnceWith(MODEL_LIST[1]);
    expect(c.setThinkingLevel).toHaveBeenCalledExactlyOnceWith("medium");
  });

  it("changes only the thinking level against the current model, and only the model otherwise", async () => {
    const c = await ready();
    await expect(configureOmp(process.pid, REF, c.identity.instanceId, { thinkingLevel: "off" })).resolves.toMatchObject({ type: "configured", config: { thinkingLevel: "off" } });
    expect(applied(c)).toEqual([0, 1]);
    await expect(configureOmp(process.pid, REF, c.identity.instanceId, { model: "ollama-cloud/kimi" })).resolves.toMatchObject({ type: "configured", config: { model: "ollama-cloud/kimi" } });
    expect(applied(c)).toEqual([1, 1]);
  });

  it("accepts a model id containing a colon", async () => {
    const c = await ready();
    await expect(configureOmp(process.pid, REF, c.identity.instanceId, { model: "ollama-cloud/gpt-oss:20b" })).resolves.toMatchObject({ type: "configured" });
  });

  it.each([
    ["unknown model", { model: "gpt-6" }, "unknown_model"],
    ["fuzzy model alias", { model: "@default" }, "unknown_model"],
    ["fuzzy model with thinking suffix", { model: "openai-codex/gpt-6:high" }, "unknown_model"],
    ["thinking level not in efforts", { thinkingLevel: "xhigh" }, "invalid_thinking"],
    ["level valid for another model only", { model: "openai-codex/gpt-6", thinkingLevel: "medium" }, "invalid_thinking"],
    ["thinking on a non-reasoning target", { model: "ollama-cloud/kimi", thinkingLevel: "low" }, "thinking_unsupported"],
    ["off on a non-reasoning target", { model: "ollama-cloud/kimi", thinkingLevel: "off" }, "thinking_unsupported"],
    ["valid model but invalid level", { model: "openai-codex/gpt-6-mini", thinkingLevel: "bogus" }, "invalid_thinking"],
    ["nothing requested", {}, "bad_request"],
    ["non-string model", { model: 5 }, "bad_request"],
    ["empty thinking level", { thinkingLevel: "" }, "bad_request"],
  ])("validates %s before applying anything", async (_name, changes, code) => {
    const c = await ready();
    const observed = await wireConfigure(c.identity, changes);
    expect(observed).toMatchObject({ type: "rejected", code });
    expect(applied(c)).toEqual([0, 0]);
  });

  it("validates thinking against the current model when no model is requested", async () => {
    const c = await ready();
    c.state.current = MODEL_LIST[2];
    await expect(wireConfigure(c.identity, { thinkingLevel: "low" })).resolves.toMatchObject({ type: "rejected", code: "thinking_unsupported" });
    c.state.current = { provider: "gone", id: "model" };
    await expect(wireConfigure(c.identity, { thinkingLevel: "low" })).resolves.toMatchObject({ type: "rejected", code: "unknown_model" });
    expect(applied(c)).toEqual([0, 0]);
  });

  it.each([
    ["busy", "not_idle"], ["pending", "pending_messages"], ["non-TUI", "not_interactive"], ["no UI", "not_interactive"], ["subagent", "not_interactive"],
  ])("refuses configure while %s without applying anything", async (condition, code) => {
    const c = await ready();
    switch (condition) {
      case "busy": c.state.idle = false; break;
      case "pending": c.state.pending = true; break;
      case "non-TUI": c.ctx.mode = "rpc"; break;
      case "no UI": c.ctx.hasUI = false; break;
      case "subagent": c.ctx.agent.kind = "sub"; break;
    }
    await expect(wireConfigure(c.identity, { model: "openai-codex/gpt-6-mini", thinkingLevel: "low" })).resolves.toMatchObject({ type: "rejected", code });
    expect(applied(c)).toEqual([0, 0]);
  });

  it("does not consult the editor draft: a terminal draft never blocks configure", async () => {
    const c = await ready();
    c.state.draft = "half-typed";
    await expect(configureOmp(process.pid, REF, c.identity.instanceId, { thinkingLevel: "high" })).resolves.toMatchObject({ type: "configured" });
    expect(c.state.draft).toBe("half-typed");
  });

  it("requires matching instance, pid and native ref for config and configure", async () => {
    const c = await ready();
    for (const op of ["config", "configure"]) {
      const base = { op, nonce: "n", pid: process.pid, ref: REF, instanceId: c.identity.instanceId, thinkingLevel: "high" };
      await expect(wireRequest(process.pid, { ...base, instanceId: "stale" })).resolves.toMatchObject({ type: "rejected", code: "identity_mismatch" });
      await expect(wireRequest(process.pid, { ...base, instanceId: undefined })).resolves.toMatchObject({ type: "rejected", code: "identity_mismatch" });
      await expect(wireRequest(process.pid, { ...base, pid: process.pid + 1 })).resolves.toMatchObject({ type: "rejected", code: "identity_mismatch" });
      await expect(wireRequest(process.pid, { ...base, ref: { kind: "path", value: "/tmp/other.jsonl" } })).resolves.toMatchObject({ type: "rejected", code: "ref_mismatch" });
    }
    expect(applied(c)).toEqual([0, 0]);
  });

  it("rejects model_unavailable when setModel returns false and does not touch thinking", async () => {
    const c = await ready();
    c.setModel.mockImplementation(async () => false);
    const result = await configureOmp(process.pid, REF, c.identity.instanceId, { model: "openai-codex/gpt-6-mini", thinkingLevel: "low" });
    expect(result).toMatchObject({ type: "rejected", code: "model_unavailable" });
    expect(c.setThinkingLevel).not.toHaveBeenCalled();
  });

  it("reports uncertain when setModel throws, without leaking the error text", async () => {
    const c = await ready();
    c.setModel.mockImplementation(async () => { throw new Error("secret token"); });
    const result = await configureOmp(process.pid, REF, c.identity.instanceId, { model: "openai-codex/gpt-6-mini", thinkingLevel: "low" });
    expect(result.type).toBe("uncertain");
    expect(JSON.stringify(result)).not.toContain("secret token");
    expect(c.setThinkingLevel).not.toHaveBeenCalled();
  });

  it("reports uncertain when setThinkingLevel throws or the model read-back differs", async () => {
    const c = await ready();
    c.setThinkingLevel.mockImplementation(() => { throw new Error("boom"); });
    await expect(configureOmp(process.pid, REF, c.identity.instanceId, { thinkingLevel: "high" })).resolves.toMatchObject({ type: "uncertain" });
    c.setThinkingLevel.mockImplementation(() => {});
    c.setModel.mockImplementation(async () => true);
    await expect(configureOmp(process.pid, REF, c.identity.instanceId, { model: "openai-codex/gpt-6-mini" })).resolves.toMatchObject({ type: "uncertain" });
  });

  it("calls setModel synchronously after the idle check and refuses a second configure while one is in flight", async () => {
    const c = await ready();
    const gate = Promise.withResolvers<boolean>();
    c.setModel.mockImplementation(async (model) => { c.state.current = model; return gate.promise; });
    const first = configureOmp(process.pid, REF, c.identity.instanceId, { model: "openai-codex/gpt-6-mini" });
    await vi.waitFor(() => { expect(c.setModel).toHaveBeenCalledOnce(); });
    await expect(wireConfigure(c.identity, { thinkingLevel: "low" })).resolves.toMatchObject({ type: "rejected", code: "not_idle" });
    await expect(submitOmpInput(process.pid, REF, c.identity.instanceId, "prompt")).resolves.toMatchObject({ type: "rejected" });
    gate.resolve(true);
    await expect(first).resolves.toMatchObject({ type: "configured" });
    expect(c.sendUserMessage).not.toHaveBeenCalled();
  });
});
