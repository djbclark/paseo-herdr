import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import net, { type Socket } from "node:net";
import fs from "node:fs";
import { mkdtemp, mkdir, rm, stat, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { once, getEventListeners } from "node:events";
import ompInputCompanion from "../harness-extension/omp.js";
import { inspectOmpInput, submitOmpInput } from "../server/harness/omp/input.js";

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

async function startCompanion() {
  const state = { draft: "", idle: true, pending: false, ref: REF.value };
  const ctx = {
    mode: "tui", hasUI: true, agent: { kind: "main" },
    isIdle: vi.fn(() => state.idle),
    hasPendingMessages: vi.fn(() => state.pending),
    ui: { getEditorText: vi.fn((): unknown => state.draft), notify: vi.fn() },
    sessionManager: { getSessionFile: () => state.ref, getSessionId: () => "native-id" },
  };
  type Event = "session_start" | "session_switch" | "session_shutdown";
  const handlers: Partial<Record<Event, (event: unknown, context: typeof ctx) => void>> = {};
  const sendUserMessage = vi.fn((_text: string) => {});
  ompInputCompanion({
    on: (event, handler) => { handlers[event] = handler; },
    sendUserMessage,
  });
  handlers.session_start?.({}, ctx);
  const socketPath = path.join(root, `omp-input-${process.pid}`, "sock");
  cleanups.push(async () => {
    handlers.session_shutdown?.({}, ctx);
    await vi.waitFor(() => { expect(fs.existsSync(socketPath)).toBe(false); });
  });
  await vi.waitFor(async () => { expect((await stat(socketPath)).isSocket()).toBe(true); });
  return { state, ctx, handlers, sendUserMessage, socketPath };
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
    ompInputCompanion({ on: (event, handler) => { handlers[event] = handler as (event: unknown, ctx: unknown) => void; }, sendUserMessage });
    handlers.session_start?.({}, { ui: { notify } });
    handlers.session_shutdown?.({}, {});
    expect(notify).toHaveBeenCalledWith(expect.stringContaining("read-only"), "error");
    expect((await stat(directory)).mode).toBe(before);
    expect(await readFile(marker, "utf8")).toBe("untouched");
    expect(sendUserMessage).not.toHaveBeenCalled();
  });
});
