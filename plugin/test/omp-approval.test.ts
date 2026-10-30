import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import net, { type Socket } from "node:net";
import fs from "node:fs";
import { mkdtemp, mkdir, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import ompInputCompanion from "../harness-extension/omp.js";
import { resolveOmpApproval, snapshotOmpApprovals } from "../server/harness/omp/input.js";

const REF = { kind: "path" as const, value: "/tmp/omp-approval-session.jsonl" };
const PID = 424242;
type Request = Record<string, unknown>;
let root: string;
const cleanups: Array<() => Promise<void>> = [];

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "paseo-omp-approval-test-"));
  vi.spyOn(os, "tmpdir").mockReturnValue(root);
});
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((close) => close()));
  vi.restoreAllMocks();
  await rm(root, { recursive: true, force: true });
});

interface Dialog<T> { args: unknown[]; signal: AbortSignal | undefined; finish(value: T | undefined): void; }
/** A fake dialog that stays open until finished or until its signal aborts (then resolves undefined, like the TUI). */
function fakeDialog<T>(dialogs: Dialog<T>[], optsIndex: number) {
  return vi.fn((...args: unknown[]) => new Promise<T | undefined>((resolve) => {
    const opts = args[optsIndex] as { signal?: AbortSignal } | undefined;
    const dialog: Dialog<T> = { args, signal: opts?.signal, finish: resolve };
    dialogs.push(dialog);
    opts?.signal?.addEventListener("abort", () => resolve(undefined), { once: true });
  }));
}

type Handler = (event: unknown, ctx: unknown) => void;
async function startCompanion(options: { hasUI?: boolean; mode?: string; withDialogs?: boolean } = {}) {
  const selectDialogs: Dialog<string>[] = [];
  const askDialogs: Dialog<unknown>[] = [];
  const originalSelect = fakeDialog(selectDialogs, 2);
  const originalAsk = fakeDialog(askDialogs, 1);
  const ui: Record<string, unknown> = { getEditorText: () => "", setEditorText: () => {}, notify: vi.fn() };
  if (options.withDialogs !== false) { ui.select = originalSelect; ui.askDialog = originalAsk; }
  const ctx = {
    mode: options.mode ?? "tui", hasUI: options.hasUI ?? true, agent: { kind: "main" },
    isIdle: () => false, hasPendingMessages: () => false, ui,
    sessionManager: { getSessionFile: () => REF.value, getSessionId: () => "native-id" },
    models: { list: () => [], current: () => null },
  };
  const handlers = new Map<string, Handler[]>();
  ompInputCompanion({
    on: (event: string, handler: Handler) => { handlers.set(event, [...(handlers.get(event) ?? []), handler]); },
    sendUserMessage: () => {}, setModel: async () => true, setThinkingLevel: () => {}, getThinkingLevel: () => "off",
  } as unknown as Parameters<typeof ompInputCompanion>[0]);
  const emit = (event: string, payload: unknown = {}) => { for (const handler of handlers.get(event) ?? []) handler(payload, ctx); };
  emit("session_start");
  const socketPath = path.join(root, `omp-input-${process.pid}`, "sock");
  cleanups.push(async () => {
    emit("session_shutdown");
    await vi.waitFor(() => { expect(fs.existsSync(socketPath)).toBe(false); });
  });
  await vi.waitFor(async () => { expect((await stat(socketPath)).isSocket()).toBe(true); });
  let identity = { pid: process.pid, instanceId: "" };

  async function wire(op: string, extra: Request = {}): Promise<Request> {
    const socket = net.createConnection({ path: socketPath });
    try {
      await once(socket, "connect");
      socket.setEncoding("utf8");
      socket.write(`${JSON.stringify({ op, nonce: "n", pid: process.pid, ref: REF, instanceId: identity.instanceId, ...extra })}\n`);
      let buffer = "";
      for await (const chunk of socket) {
        buffer += String(chunk);
        const newline = buffer.indexOf("\n");
        if (newline >= 0) return JSON.parse(buffer.slice(0, newline)) as Request;
      }
      throw new Error("No complete companion reply");
    } finally { socket.destroy(); }
  }
  identity = { pid: process.pid, instanceId: String((await wire("inspect")).instanceId) };
  const snapshot = async (cursor?: number) => await wire("approval.snapshot", cursor === undefined ? {} : { cursor });
  const resolve = (id: string, decision: unknown) => wire("approval.resolve", { id, decision });
  const callSelect = (title: string, options: unknown = ["Approve", "Deny"], opts?: unknown) =>
    (ui.select as (...args: unknown[]) => Promise<string | undefined>)(title, options, opts);
  const callAsk = (questions: unknown, opts?: unknown) =>
    (ui.askDialog as (...args: unknown[]) => Promise<unknown>)(questions, opts);
  /** The real approval gate sequence: execution start, then the armed event, then the dialog. */
  const approvalGate = (toolName: string, toolCallId: string, args: unknown = { command: "ls" }) => {
    emit("tool_execution_start", { toolName, toolCallId, args });
    emit("tool_approval_requested", { toolName, toolCallId, reason: "needs review", approvalMode: "always-ask" });
    return callSelect(`Allow tool: ${toolName}`);
  };
  return { ctx, ui, emit, wire, snapshot, resolve, callSelect, callAsk, approvalGate, identity, selectDialogs, askDialogs, originalSelect, originalAsk };
}
type Companion = Awaited<ReturnType<typeof startCompanion>>;
const settle = () => new Promise((resolve) => setTimeout(resolve, 10));

const QUESTIONS = [
  { id: "q1", question: "Pick a colour", options: [{ label: "Red", description: "warm" }, { label: "Green" }, { label: "Blue" }], multi: false, recommended: 1 },
  { id: "q2", question: "Pick drinks", options: [{ label: "Tea" }, { label: "Juice" }], multi: true },
];

describe("OMP companion tool approvals", () => {
  it("passes dialogs through untouched when nothing is armed, or the title or options differ", async () => {
    const c = await startCompanion();
    void c.callSelect("Allow tool: bash");
    void c.callSelect("Resume?", ["Yes", "No"]);
    c.emit("tool_approval_requested", { toolName: "bash", toolCallId: "t1" });
    void c.callSelect("Continue?", ["Approve", "Deny"]);
    void c.callSelect("Allow tool: bash", ["Approve", "Deny", "Always"]);
    expect(c.originalSelect).toHaveBeenCalledTimes(4);
    expect(c.selectDialogs.every((dialog) => dialog.signal === undefined)).toBe(true);
    expect(await c.snapshot()).toMatchObject({ type: "approvals", pending: [], outcomes: [], cursor: 0, lost: false });
  });

  it("registers a pending entry only when the dialog is shown and lists it with its details", async () => {
    const c = await startCompanion();
    c.emit("tool_execution_start", { toolName: "bash", toolCallId: "t1", args: { command: "rm -rf x" } });
    c.emit("tool_approval_requested", { toolName: "bash", toolCallId: "t1", reason: "destructive", approvalMode: "always-ask" });
    expect((await c.snapshot()).pending).toEqual([]);
    const result = c.callSelect("Allow tool: bash");
    const snap = await c.snapshot();
    expect(snap.pending).toEqual([{
      id: `${c.identity.instanceId}:1`, kind: "tool", toolName: "bash", title: "Allow tool: bash", reason: "destructive",
      args: { command: "rm -rf x" }, approvalMode: "always-ask", createdAt: expect.any(String),
    }]);
    c.selectDialogs[0]?.finish("Approve");
    await expect(result).resolves.toBe("Approve");
  });

  it.each([
    ["Approve", "approved"],
    ["Deny", "denied"],
    [undefined, "denied"],
  ])("records a terminal answer %s as %s/terminal", async (value, outcome) => {
    const c = await startCompanion();
    const result = c.approvalGate("bash", "t1");
    c.selectDialogs[0]?.finish(value);
    await expect(result).resolves.toBe(value);
    const snap = await c.snapshot();
    expect(snap.pending).toEqual([]);
    expect(snap.outcomes).toEqual([{ seq: 1, id: `${c.identity.instanceId}:1`, kind: "tool", outcome, source: "terminal", at: expect.any(String) }]);
  });

  it.each([
    [{ type: "allow" }, "Approve", "approved"],
    [{ type: "deny" }, "Deny", "denied"],
  ])("a remote %j answers OMP, aborts the terminal dialog and wins exactly once", async (decision, returned, outcome) => {
    const c = await startCompanion();
    const result = c.approvalGate("bash", "t1");
    const id = `${c.identity.instanceId}:1`;
    const reply = await c.resolve(id, decision);
    expect(reply).toMatchObject({ type: "resolved", outcome: { id, outcome, source: "paseo", seq: 1 } });
    await expect(result).resolves.toBe(returned);
    expect(c.selectDialogs[0]?.signal?.aborted).toBe(true);
    c.selectDialogs[0]?.finish("Deny");
    await settle();
    expect((await c.snapshot()).outcomes).toHaveLength(1);
    const again = await c.resolve(id, { type: "allow" });
    expect(again).toMatchObject({ type: "rejected", code: "already_resolved", outcome: { id, outcome, source: "paseo" } });
  });

  it("answers already_resolved with the terminal outcome when the terminal won the race", async () => {
    const c = await startCompanion();
    const result = c.approvalGate("bash", "t1");
    c.selectDialogs[0]?.finish("Approve");
    await result;
    expect(await c.resolve(`${c.identity.instanceId}:1`, { type: "deny" })).toMatchObject({
      type: "rejected", code: "already_resolved", outcome: { outcome: "approved", source: "terminal" },
    });
  });

  it("refuses a decision of the wrong shape and leaves the dialog open", async () => {
    const c = await startCompanion();
    const result = c.approvalGate("bash", "t1");
    const id = `${c.identity.instanceId}:1`;
    for (const decision of [{ type: "chat" }, { type: "answer", answers: [] }, { type: "bogus" }]) {
      expect(await c.resolve(id, decision)).toMatchObject({ type: "rejected", code: "invalid_decision" });
    }
    expect(c.selectDialogs[0]?.signal?.aborted).toBe(false);
    expect((await c.snapshot()).pending).toHaveLength(1);
    c.selectDialogs[0]?.finish("Approve");
    await result;
  });

  it("separates unknown_request from not_pending and rejects malformed resolves", async () => {
    const c = await startCompanion();
    expect(await c.resolve("someone-else:1", { type: "allow" })).toMatchObject({ type: "rejected", code: "unknown_request" });
    expect(await c.resolve(`${c.identity.instanceId}:9`, { type: "allow" })).toMatchObject({ type: "rejected", code: "unknown_request" });
    // Evict the first outcome from the ring: issued by this instance, no longer retained.
    for (let i = 0; i < 65; i++) {
      const result = c.approvalGate("bash", `t${i}`);
      c.selectDialogs[i]?.finish("Approve");
      await result;
    }
    expect(await c.resolve(`${c.identity.instanceId}:1`, { type: "allow" })).toMatchObject({ type: "rejected", code: "not_pending" });
    expect(await c.wire("approval.resolve", { id: "", decision: {} })).toMatchObject({ type: "rejected", code: "bad_request" });
    expect(await c.wire("approval.resolve", { id: "x" })).toMatchObject({ type: "rejected", code: "bad_request" });
  });

  it("keeps a ring of 64 outcomes with a monotonic cursor and flags lost history", async () => {
    const c = await startCompanion();
    for (let i = 0; i < 70; i++) {
      const result = c.approvalGate("bash", `t${i}`);
      c.selectDialogs[i]?.finish("Approve");
      await result;
    }
    const full = await c.snapshot(0) as { outcomes: { seq: number }[]; cursor: number; lost: boolean };
    expect(full.cursor).toBe(70);
    expect(full.outcomes).toHaveLength(64);
    expect(full.outcomes[0]?.seq).toBe(7);
    expect(full.lost).toBe(true);
    const edge = await c.snapshot(6) as { outcomes: unknown[]; lost: boolean };
    expect(edge.lost).toBe(false);
    expect(edge.outcomes).toHaveLength(64);
    const tail = await c.snapshot(68) as { outcomes: { seq: number }[]; lost: boolean };
    expect(tail.outcomes.map((rec) => rec.seq)).toEqual([69, 70]);
    expect(tail.lost).toBe(false);
    expect(await c.wire("approval.snapshot", { cursor: -1 })).toMatchObject({ type: "rejected", code: "bad_request" });
    expect(await c.wire("approval.snapshot", { cursor: "x" })).toMatchObject({ type: "rejected", code: "bad_request" });
  });

  it("caps oversized tool arguments", async () => {
    const c = await startCompanion();
    const result = c.approvalGate("write", "t1", { content: "x".repeat(20000) });
    expect(((await c.snapshot()).pending as Request[])[0]?.args).toEqual({ truncated: true });
    c.selectDialogs[0]?.finish("Deny");
    await result;
  });

  it("matches the armed entry by tool name when several are armed", async () => {
    const c = await startCompanion();
    c.emit("tool_execution_start", { toolName: "bash", toolCallId: "a", args: { command: "one" } });
    c.emit("tool_execution_start", { toolName: "edit", toolCallId: "b", args: { path: "two" } });
    c.emit("tool_approval_requested", { toolName: "bash", toolCallId: "a" });
    c.emit("tool_approval_requested", { toolName: "edit", toolCallId: "b" });
    void c.callSelect("Allow tool: edit");
    expect(((await c.snapshot()).pending as Request[])[0]).toMatchObject({ toolName: "edit", args: { path: "two" } });
  });

  it("does not patch without an interactive UI or without the dialogs", async () => {
    const headless = await startCompanion({ hasUI: false });
    expect(headless.ui.select).toBe(headless.originalSelect);
    expect(headless.ui.askDialog).toBe(headless.originalAsk);
    const rpc = await startCompanion({ mode: "rpc" });
    expect(rpc.ui.select).toBe(rpc.originalSelect);
    await startCompanion({ withDialogs: false });
  });

  it("re-patches idempotently on session_switch and clears armed state", async () => {
    const c = await startCompanion();
    const wrapped = c.ui.select;
    const wrappedAsk = c.ui.askDialog;
    expect(wrapped).not.toBe(c.originalSelect);
    c.emit("tool_approval_requested", { toolName: "bash", toolCallId: "t1" });
    c.emit("tool_call", { toolName: "ask", toolCallId: "a1", input: {} });
    c.emit("session_switch", { reason: "new" });
    expect(c.ui.select).toBe(wrapped);
    expect(c.ui.askDialog).toBe(wrappedAsk);
    void c.callSelect("Allow tool: bash");
    void c.callAsk(QUESTIONS);
    expect(c.originalSelect).toHaveBeenCalledTimes(1);
    expect((await c.snapshot()).pending).toEqual([]);
    expect(c.selectDialogs[0]?.signal).toBeUndefined();
    expect(c.askDialogs[0]?.signal).toBeUndefined();
  });

  it("replaces a wrapper left by the pre-rename (paseo-herdr) companion instead of stacking on it", async () => {
    const c = await startCompanion();
    const legacyWrapper = vi.fn((...args: unknown[]) => c.originalSelect(...args));
    Object.defineProperty(legacyWrapper, Symbol.for("paseo-herdr.approvals"), { value: { owner: "legacy-instance", original: c.originalSelect }, enumerable: false });
    c.ui.select = legacyWrapper;
    c.emit("session_switch", { reason: "new" });
    expect(c.ui.select).not.toBe(legacyWrapper);
    expect(c.ui.select).not.toBe(c.originalSelect);
    void c.callSelect("Allow tool: bash");
    expect(legacyWrapper).not.toHaveBeenCalled();
    expect(c.originalSelect).toHaveBeenCalledTimes(1);
  });

  it("propagates the caller's own abort signal to the dialog", async () => {
    const c = await startCompanion();
    c.emit("tool_approval_requested", { toolName: "bash", toolCallId: "t1" });
    const caller = new AbortController();
    const result = c.callSelect("Allow tool: bash", ["Approve", "Deny"], { signal: caller.signal });
    caller.abort();
    await expect(result).resolves.toBeUndefined();
    expect(((await c.snapshot()).outcomes as Request[])[0]).toMatchObject({ outcome: "denied", source: "terminal" });
  });

  it("records a dialog that throws as denied/system and rethrows", async () => {
    const c = await startCompanion();
    c.ui.select = undefined;
    c.originalSelect.mockImplementationOnce(() => Promise.reject(new Error("boom")));
    // Re-wrap around the throwing original.
    c.ui.select = c.originalSelect;
    c.emit("session_switch", {});
    const result = c.approvalGate("bash", "t1");
    await expect(result).rejects.toThrow("boom");
    expect(((await c.snapshot()).outcomes as Request[])[0]).toMatchObject({ outcome: "denied", source: "system" });
  });

  it("records a tool_approval_resolved for a still-open pending as a system outcome", async () => {
    const c = await startCompanion();
    const result = c.approvalGate("bash", "t1");
    c.emit("tool_approval_resolved", { toolCallId: "t1", approved: true });
    await expect(result).resolves.toBe("Approve");
    expect(c.selectDialogs[0]?.signal?.aborted).toBe(true);
    expect(((await c.snapshot()).outcomes as Request[])[0]).toMatchObject({ outcome: "approved", source: "system" });
  });

  it("settles open pendings as cancelled/system on shutdown", async () => {
    const c = await startCompanion();
    const tool = c.approvalGate("bash", "t1");
    c.emit("tool_call", { toolName: "ask", toolCallId: "a1", input: {} });
    const ask = c.callAsk(QUESTIONS);
    c.emit("session_shutdown");
    await expect(tool).resolves.toBe("Deny");
    await expect(ask).resolves.toBeUndefined();
    expect(c.selectDialogs[0]?.signal?.aborted).toBe(true);
    expect(c.askDialogs[0]?.signal?.aborted).toBe(true);
  });
});

describe("OMP companion ask questions", () => {
  async function ask(c: Companion, opts?: unknown) {
    c.emit("tool_call", { toolName: "ask", toolCallId: "a1", input: { questions: QUESTIONS } });
    const result = c.callAsk(QUESTIONS, { timeout: 5000, ...(opts as object | undefined) });
    return { result, id: `${c.identity.instanceId}:1` };
  }
  const answers = [
    { id: "q1", selectedOptions: ["Blue"] },
    { id: "q2", selectedOptions: ["Tea", "Juice"] },
  ];

  it("intercepts askDialog only after the tool_call event and stops after tool_execution_end", async () => {
    const c = await startCompanion();
    void c.callAsk(QUESTIONS);
    expect(c.askDialogs[0]?.signal).toBeUndefined();
    expect((await c.snapshot()).pending).toEqual([]);
    c.emit("tool_call", { toolName: "bash", toolCallId: "b1", input: {} });
    void c.callAsk(QUESTIONS);
    expect(c.askDialogs[1]?.signal).toBeUndefined();
    const { result } = await ask(c);
    expect((await c.snapshot()).pending).toHaveLength(1);
    c.askDialogs[2]?.finish(undefined);
    await result;
    c.emit("tool_execution_end", { toolName: "ask", toolCallId: "a1" });
    void c.callAsk(QUESTIONS);
    expect(c.askDialogs[3]?.signal).toBeUndefined();
  });

  it("lists a normalized copy of the questions and forwards dialog options", async () => {
    const c = await startCompanion();
    const { result } = await ask(c);
    expect((await c.snapshot()).pending).toEqual([{
      id: `${c.identity.instanceId}:1`, kind: "question", toolName: "ask", createdAt: expect.any(String),
      questions: [
        { id: "q1", question: "Pick a colour", multi: false, recommended: 1, options: [{ label: "Red", description: "warm" }, { label: "Green" }, { label: "Blue" }] },
        { id: "q2", question: "Pick drinks", multi: true, options: [{ label: "Tea" }, { label: "Juice" }] },
      ],
    }]);
    expect(c.askDialogs[0]?.args[1]).toMatchObject({ timeout: 5000 });
    c.askDialogs[0]?.finish(undefined);
    await result;
  });

  it("classifies a terminal answer, listing selections and custom text", async () => {
    const c = await startCompanion();
    const { result } = await ask(c);
    const submit = {
      kind: "submit",
      results: [
        { id: "q1", question: "Pick a colour", options: ["Red", "Green", "Blue"], multi: false, selectedOptions: [], customInput: "Magenta" },
        { id: "q2", question: "Pick drinks", options: ["Tea", "Juice"], multi: true, selectedOptions: ["Tea"], note: "hot" },
      ],
    };
    c.askDialogs[0]?.finish(submit);
    await expect(result).resolves.toBe(submit);
    expect(((await c.snapshot()).outcomes as Request[])[0]).toMatchObject({
      kind: "question", outcome: "answered", source: "terminal",
      answer: [{ id: "q1", selectedOptions: [], customInput: "Magenta" }, { id: "q2", selectedOptions: ["Tea"] }],
    });
  });

  it("classifies Esc as cancelled/terminal, an aborted caller signal as cancelled/system, and chat as chat/terminal", async () => {
    const c = await startCompanion();
    const first = await ask(c);
    c.askDialogs[0]?.finish(undefined);
    await expect(first.result).resolves.toBeUndefined();
    const caller = new AbortController();
    const second = c.callAsk(QUESTIONS, { signal: caller.signal });
    caller.abort();
    await expect(second).resolves.toBeUndefined();
    const third = c.callAsk(QUESTIONS);
    c.askDialogs[2]?.finish({ kind: "chat" });
    await expect(third).resolves.toEqual({ kind: "chat" });
    const outcomes = (await c.snapshot()).outcomes as Request[];
    expect(outcomes.map((rec) => [rec.outcome, rec.source])).toEqual([["cancelled", "terminal"], ["cancelled", "system"], ["chat", "terminal"]]);
  });

  it("classifies an all-timed-out result as timed_out/system with the default answer", async () => {
    const c = await startCompanion();
    const { result } = await ask(c);
    c.askDialogs[0]?.finish({ kind: "submit", results: [
      { id: "q1", question: "Pick a colour", options: ["Red", "Green", "Blue"], multi: false, selectedOptions: ["Green"], timedOut: true },
      { id: "q2", question: "Pick drinks", options: ["Tea", "Juice"], multi: true, selectedOptions: [], timedOut: true },
    ] });
    await result;
    expect(((await c.snapshot()).outcomes as Request[])[0]).toMatchObject({
      outcome: "timed_out", source: "system", answer: [{ id: "q1", selectedOptions: ["Green"] }, { id: "q2", selectedOptions: [] }],
    });
  });

  it("submits a remote answer byte-identical in shape to a terminal one (no timedOut, customInput only when present)", async () => {
    const c = await startCompanion();
    const { result, id } = await ask(c);
    const reply = await c.resolve(id, { type: "answer", answers });
    expect(reply).toMatchObject({ type: "resolved", outcome: { outcome: "answered", source: "paseo", answer: answers } });
    const value = await result as { kind: string; results: Record<string, unknown>[] };
    expect(value).toEqual({ kind: "submit", results: [
      { id: "q1", question: "Pick a colour", options: ["Red", "Green", "Blue"], multi: false, selectedOptions: ["Blue"] },
      { id: "q2", question: "Pick drinks", options: ["Tea", "Juice"], multi: true, selectedOptions: ["Tea", "Juice"] },
    ] });
    for (const item of value.results) {
      expect(Object.keys(item)).not.toContain("timedOut");
      expect(Object.keys(item)).not.toContain("customInput");
    }
    expect(c.askDialogs[0]?.signal?.aborted).toBe(true);
  });

  it("accepts a custom answer for a single-select and an empty multi-select", async () => {
    const c = await startCompanion();
    const { result, id } = await ask(c);
    const custom = [{ id: "q1", selectedOptions: [], customInput: "Magenta" }, { id: "q2", selectedOptions: [] }];
    expect(await c.resolve(id, { type: "answer", answers: custom })).toMatchObject({ type: "resolved" });
    const value = await result as { results: Record<string, unknown>[] };
    expect(value.results[0]).toEqual({ id: "q1", question: "Pick a colour", options: ["Red", "Green", "Blue"], multi: false, selectedOptions: [], customInput: "Magenta" });
    expect(value.results[1]).not.toHaveProperty("customInput");
  });

  it.each([
    ["an unknown label", [{ id: "q1", selectedOptions: ["Purple"] }, { id: "q2", selectedOptions: [] }]],
    ["a single-select with nothing selected and no custom text", [{ id: "q1", selectedOptions: [] }, { id: "q2", selectedOptions: [] }]],
    ["a single-select with nothing selected and empty custom text", [{ id: "q1", selectedOptions: [], customInput: "" }, { id: "q2", selectedOptions: [] }]],
    ["a single-select with two labels", [{ id: "q1", selectedOptions: ["Red", "Blue"] }, { id: "q2", selectedOptions: [] }]],
    ["a repeated label", [{ id: "q1", selectedOptions: ["Red"] }, { id: "q2", selectedOptions: ["Tea", "Tea"] }]],
    ["a wrong id", [{ id: "q2", selectedOptions: ["Red"] }, { id: "q1", selectedOptions: [] }]],
    ["too few answers", [{ id: "q1", selectedOptions: ["Red"] }]],
    ["a malformed selection", [{ id: "q1", selectedOptions: "Red" }, { id: "q2", selectedOptions: [] }]],
  ])("refuses %s and keeps the dialog open", async (_name, bad) => {
    const c = await startCompanion();
    const { result, id } = await ask(c);
    expect(await c.resolve(id, { type: "answer", answers: bad })).toMatchObject({ type: "rejected", code: "invalid_decision" });
    expect(c.askDialogs[0]?.signal?.aborted).toBe(false);
    expect((await c.snapshot()).pending).toHaveLength(1);
    expect(await c.resolve(id, { type: "answer", answers })).toMatchObject({ type: "resolved" });
    await result;
  });

  it("returns a chat result, never undefined, for a remote chat and refuses allow/deny", async () => {
    const c = await startCompanion();
    const { result, id } = await ask(c);
    expect(await c.resolve(id, { type: "allow" })).toMatchObject({ type: "rejected", code: "invalid_decision" });
    expect(await c.resolve(id, { type: "chat" })).toMatchObject({ type: "resolved", outcome: { outcome: "chat", source: "paseo" } });
    await expect(result).resolves.toEqual({ kind: "chat" });
  });
});

describe("OMP approval client", () => {
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
  const reply = (socket: Socket, request: Request, result: Request) =>
    socket.end(`${JSON.stringify({ nonce: request.nonce, pid: request.pid, ref: request.ref, instanceId: "inst", ...result })}\n`);

  it("maps a bad_request snapshot reply from an older companion to unsupported", async () => {
    const peer = await inputServer((request, socket) => reply(socket, request, { type: "rejected", code: "bad_request", message: "Invalid OMP input companion request." }));
    await expect(snapshotOmpApprovals(PID, REF, "inst", null)).resolves.toBe("unsupported");
    expect(peer.requests[0]).toMatchObject({ op: "approval.snapshot", pid: PID, instanceId: "inst" });
    expect(peer.requests[0]).not.toHaveProperty("cursor");
  });

  it("throws on other snapshot refusals and mismatched identity", async () => {
    await inputServer((request, socket) => reply(socket, request, { type: "rejected", code: "ref_mismatch", message: "native session changed" }));
    await expect(snapshotOmpApprovals(PID, REF, "inst", 3)).rejects.toMatchObject({ message: "native session changed", code: "ref_mismatch" });
  });

  it("is uncertain after the write when the companion drops the connection, and never retries", async () => {
    const peer = await inputServer((_request, socket) => socket.destroy());
    await expect(resolveOmpApproval(PID, REF, "inst", "inst:1", { type: "allow" })).resolves.toMatchObject({ type: "uncertain" });
    expect(peer.requests).toHaveLength(1);
  });

  it("is rejected (unavailable) before the write when nothing listens", async () => {
    await expect(resolveOmpApproval(PID, REF, "inst", "inst:1", { type: "allow" })).resolves.toMatchObject({ type: "rejected", code: "unavailable" });
  });

  it("is uncertain for a reply with the wrong identity, even a refusal", async () => {
    await inputServer((request, socket) => reply(socket, request, { type: "rejected", code: "invalid_decision", message: "no", nonce: "old" }));
    await expect(resolveOmpApproval(PID, REF, "inst", "inst:1", { type: "allow" })).resolves.toMatchObject({ type: "uncertain" });
  });

  it("carries the already-decided outcome on an already_resolved refusal", async () => {
    const outcome = { seq: 4, id: "inst:1", kind: "tool", outcome: "approved", source: "terminal", at: "2026-10-14T00:00:00.000Z" };
    await inputServer((request, socket) => reply(socket, request, { type: "rejected", code: "already_resolved", message: "done", outcome }));
    await expect(resolveOmpApproval(PID, REF, "inst", "inst:1", { type: "deny" })).resolves.toEqual({ type: "rejected", code: "already_resolved", message: "done", outcome });
  });

  it("round-trips snapshot and resolve against the real companion", async () => {
    const c = await startCompanion();
    const result = c.approvalGate("bash", "t1");
    const snap = await snapshotOmpApprovals(process.pid, REF, c.identity.instanceId, null);
    expect(snap).toMatchObject({ cursor: 0, lost: false, outcomes: [], pending: [{ kind: "tool", toolName: "bash", args: { command: "ls" }, approvalMode: "always-ask" }] });
    const id = (snap as { pending: { id: string }[] }).pending[0]?.id as string;
    const resolved = await resolveOmpApproval(process.pid, REF, c.identity.instanceId, id, { type: "allow" });
    expect(resolved).toMatchObject({ type: "resolved", outcome: { id, outcome: "approved", source: "paseo", seq: 1 } });
    await expect(result).resolves.toBe("Approve");
    await expect(resolveOmpApproval(process.pid, REF, c.identity.instanceId, id, { type: "deny" })).resolves.toMatchObject({ type: "rejected", code: "already_resolved", outcome: { seq: 1 } });
    await expect(snapshotOmpApprovals(process.pid, REF, c.identity.instanceId, 1)).resolves.toMatchObject({ cursor: 1, outcomes: [] });
  });

  it("refuses a foreign instance id before looking anything up", async () => {
    const c = await startCompanion();
    expect(await c.wire("approval.resolve", { instanceId: "other-instance", id: "other-instance:1", decision: { type: "allow" } }))
      .toMatchObject({ type: "rejected", code: "identity_mismatch" });
    expect(await c.wire("approval.snapshot", { instanceId: "other-instance" })).toMatchObject({ type: "rejected", code: "identity_mismatch" });
    // The client cannot trust a reply from a different instance than the one it addressed.
    await expect(resolveOmpApproval(process.pid, REF, "other-instance", "other-instance:1", { type: "allow" })).resolves.toMatchObject({ type: "uncertain" });
  });
});
