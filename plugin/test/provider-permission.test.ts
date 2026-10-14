import { createServer, type Server } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import {
  ProviderEventSchema, ProviderInputSchema, type ProviderConnection, type ProviderEvent, type ProviderPermissionResponse,
} from "@getpaseo/plugin/server/provider";
import { HerdrHarnessSession, capabilitiesFor } from "../server/session.js";
import { createHerdrProvider } from "../server/provider.js";
import { bindingOf, parseBinding, persistenceOf, type Binding } from "../server/binding.js";
import { supportsApprovals, parseAnswer, uniqueHeaders } from "../server/approvals.js";
import type { PermissionResponder } from "../server/host.js";
import type { AgentInfo } from "../server/herdr/schema.js";
import type { PendingApproval, PendingQuestion, ResolveResult } from "../server/harness/types.js";
import { DecisionRowSchema, describeDecision } from "../shared/decision.js";
import { FakeApprovals, FakeTranscript, makeFakeAdapter } from "./fake-harness.js";

const config = { cwd: "/work", env: { PASEO_AGENT_ID: "agent-1" }, mcpServers: {}, settings: {}, persist: true };
function makeAgent(status: AgentInfo["agent_status"] = "idle"): AgentInfo {
  return { terminal_id: "terminal", pane_id: "pane", agent: "fake", name: "demo", agent_status: status,
    agent_session: { source: "herdr:fake", agent: "fake", kind: "id", value: "fake-session-1" },
    workspace_id: "w", tab_id: "t", focused: true, screen_detection_skipped: false,
    state_labels: {}, tokens: {}, launch_pending: false, interactive_ready: true,
    state_change_seq: 0, completion_seq: null, cwd: "/work", revision: 0 };
}
const AT = "2026-10-14T00:00:00.000Z";
const tool = (id = "t1", extra: Partial<PendingApproval> = {}): PendingApproval =>
  ({ id, kind: "tool", toolName: "bash", title: "Allow tool: bash", reason: "writes a file", args: { command: "touch x" }, approvalMode: "always-ask", createdAt: AT, ...extra });
const question = (id = "q1", extra: Partial<PendingQuestion> = {}): PendingQuestion => ({ id, kind: "question", toolName: "ask", createdAt: AT,
  questions: [{ id: "a", question: "Which colour?", header: "Colour", multi: true, options: [{ label: "Red, dark" }, { label: "Blue", description: "cool" }, { label: "Green" }] }], ...extra });

const sessions: HerdrHarnessSession[] = [];
afterEach(() => { for (const session of sessions.splice(0)) session.close(); });

interface Rig {
  session: HerdrHarnessSession; agent: AgentInfo; approvals: FakeApprovals; events: ProviderEvent[]; log: string[];
  responded: Array<{ requestId: string; response: ProviderPermissionResponse }>; sleeps: number[];
  paseo: { fail: boolean; present: boolean };
  release(count?: number): Promise<void>;
}
async function setup(options: { approvals?: boolean; status?: AgentInfo["agent_status"]; open?: boolean; binding?: (binding: Binding) => void;
  history?: "skip" | "replay" } = {}): Promise<Rig> {
  const agent = makeAgent(options.status);
  const store = new FakeTranscript();
  store.set([{ id: "old-user", kind: "user", text: "old" }, { id: "old-end", kind: "assistant", text: "answer" }]);
  const approvals = new FakeApprovals();
  const adapter = makeFakeAdapter(store, options.approvals === false ? {} : { approvals });
  const events: ProviderEvent[] = [];
  const log: string[] = [];
  const responded: Rig["responded"] = [];
  const sleeps: number[] = [];
  const waiting: Array<() => void> = [];
  const paseoState = { fail: false, present: true };
  const binding = bindingOf(agent, adapter, null);
  options.binding?.(binding);
  const session: HerdrHarnessSession = new HerdrHarnessSession("local", binding, {
    adapter, listAgents: async () => [agent],
    request: async (method) => {
      if (method === "pane.process_info") return { type: "pane_process_info", process_info: {
        pane_id: agent.pane_id, foreground_process_group_id: 100, tty: "/dev/pts/fake",
        foreground_processes: [{ pid: 100, name: "fake" }] } };
      return { type: "agent_prompted", agent };
    },
    subscribe: async () => ({ [Symbol.asyncIterator]: async function* () {}, close() {} }),
    emit: (event) => {
      events.push(ProviderEventSchema.parse(event));
      if (event.type === "session.permission") log.push(`permission:${event.request.id}`);
      if (event.type === "session.permission_resolved") log.push(`resolved:${event.permissionId}`);
      if (event.type === "timeline.item" && event.item.type === "plugin") log.push(`row:${event.item.id}`);
      if (event.type === "session.persistence") log.push("persist");
    },
    // Paseo forwards the response to the provider after caching it, exactly like PluginAgentSession.respondToPermission.
    getPaseo: () => paseoState.present ? ({ agents: { ref: (agentId: string) => ({
      respondToPermission: async ({ requestId, response }: { requestId: string; response: ProviderPermissionResponse }) => {
        expect(agentId).toBe("agent-1");
        ProviderInputSchema.parse({ type: "session.permission", sessionId: "local", permissionId: requestId, response });
        responded.push({ requestId, response });
        log.push(`respond:${requestId}`);
        if (paseoState.fail) throw new Error("paseo is gone");
        await session.approvals.respond(requestId, response);
      },
    }) } } satisfies PermissionResponder) : null,
    approvalSleep: (ms, signal) => new Promise<void>((resolve) => {
      sleeps.push(ms);
      const done = () => resolve();
      waiting.push(done);
      signal.addEventListener("abort", done, { once: true });
    }),
  });
  sessions.push(session);
  if (options.open !== false) await session.open(config, options.history ?? "skip");
  return { session, agent, approvals, events, log, responded, sleeps, paseo: paseoState,
    release: async (count = 1) => { for (let i = 0; i < count; i++) { await vi.waitFor(() => expect(waiting.length).toBeGreaterThan(0)); waiting.shift()?.(); } } };
}
const permissions = (events: ProviderEvent[]) => events.flatMap((event) => event.type === "session.permission" ? [event.request] : []);
const resolvedIds = (events: ProviderEvent[]) => events.flatMap((event) => event.type === "session.permission_resolved" ? [event.permissionId] : []);
const notices = (events: ProviderEvent[]) => events.flatMap((event) => event.type === "session.notice" ? [event.notice] : []);
const rows = (events: ProviderEvent[]) => events.flatMap((event) => event.type === "timeline.item" && event.item.type === "plugin"
  ? [{ id: event.item.id, kind: event.item.kind, version: event.item.version, pluginId: event.item.pluginId, data: DecisionRowSchema.parse(event.item.data) }] : []);
/** Herdr reports `blocked`; the live loop observes it and polls. */
async function block(rig: Rig): Promise<void> {
  rig.agent.agent_status = "blocked";
  await rig.session.live.reconcile();
}

it("advertises permission and plugin timeline rows only for an adapter that supports approvals", async () => {
  expect(supportsApprovals(makeFakeAdapter())).toBe(false);
  expect(capabilitiesFor(makeFakeAdapter())).not.toContain("permission");
  expect(capabilitiesFor(makeFakeAdapter())).not.toContain("timeline.plugin");
  const half = { ...makeFakeAdapter(undefined, { approvals: new FakeApprovals() }), resolveApproval: undefined };
  expect(capabilitiesFor(half)).not.toContain("permission");
  expect(capabilitiesFor(makeFakeAdapter(undefined, { approvals: new FakeApprovals() }))).toEqual(expect.arrayContaining(["permission", "timeline.plugin"]));
  const on = await setup();
  expect(on.events.find((event) => event.type === "session.opened")).toMatchObject({ capabilities: expect.arrayContaining(["permission", "timeline.plugin"]) });
  const off = await setup({ approvals: false });
  expect(off.events.find((event) => event.type === "session.opened")).toMatchObject({ capabilities: expect.not.arrayContaining(["permission"]) });
  await block(off);
  expect(permissions(off.events)).toEqual([]);
});

it("polls on open and emits a native tool card on entering blocked, on the 250/500/1000 ms schedule", async () => {
  const rig = await setup();
  expect(rig.approvals.snapshotCalls).toEqual([null]);
  rig.approvals.add(tool());
  await block(rig);
  await vi.waitFor(() => expect(permissions(rig.events)).toHaveLength(1));
  expect(permissions(rig.events)[0]).toEqual({
    id: "t1", name: "bash", kind: "tool", title: "Allow tool: bash",
    description: expect.stringContaining("writes a file"),
    input: { command: "touch x" },
    actions: [{ id: "allow", label: "Allow", behavior: "allow", variant: "primary" }, { id: "deny", label: "Deny", behavior: "deny", variant: "danger" }],
    metadata: { herdr: { kind: "tool", approvalMode: "always-ask" } },
  });
  expect(permissions(rig.events)[0].description).toContain("touch x");
  await rig.release(3);
  await vi.waitFor(() => expect(rig.sleeps.length).toBeGreaterThanOrEqual(3));
  expect(rig.sleeps.slice(0, 3)).toEqual([250, 500, 1000]);
  // The cursor advances; the same pending entry never produces a second card.
  expect(rig.approvals.snapshotCalls.at(-1)).toBe(0);
  expect(permissions(rig.events)).toHaveLength(1);
});

it("takes one final poll on leaving blocked and another when connectivity returns", async () => {
  const rig = await setup();
  await block(rig);
  await vi.waitFor(() => expect(rig.sleeps.length).toBe(1));
  const before = rig.approvals.snapshotCalls.length;
  rig.agent.agent_status = "idle";
  await rig.session.live.reconcile();
  await vi.waitFor(() => expect(rig.approvals.snapshotCalls.length).toBe(before + 1));
  rig.session.state.connected = false;
  await rig.session.live.reconcile();
  await vi.waitFor(() => expect(rig.approvals.snapshotCalls.length).toBe(before + 2));
});

it("keeps the legacy blocked notice when approvals are off or unsupported and suppresses it when on", async () => {
  const none = await setup({ approvals: false, status: "blocked" });
  await none.session.live.reconcile();
  expect(notices(none.events).filter((notice) => notice.id === "blocked" && !notice.dismissed)).toHaveLength(1);
  const old = await setup({ status: "blocked", open: false });
  old.approvals.unsupported = true;
  await old.session.open(config, "skip");
  await old.session.live.reconcile();
  expect(old.session.approvals.enabled).toBe("off");
  expect(notices(old.events).filter((notice) => notice.id === "blocked" && !notice.dismissed)).toHaveLength(1);
  expect(permissions(old.events)).toEqual([]);
  const on = await setup({ status: "blocked" });
  await on.session.live.reconcile();
  expect(on.session.approvals.enabled).toBe("on");
  expect(notices(on.events).filter((notice) => notice.id === "blocked" && !notice.dismissed)).toEqual([]);
});

it("maps a Paseo Allow and a Paseo Deny to the harness and records the decision", async () => {
  const rig = await setup();
  rig.approvals.add(tool("t1"));
  rig.approvals.add(tool("t2"));
  await block(rig);
  await vi.waitFor(() => expect(permissions(rig.events)).toHaveLength(2));
  await rig.session.approvals.respond("t1", { behavior: "allow", selectedActionId: "allow" });
  await rig.session.approvals.respond("t2", { behavior: "deny", selectedActionId: "deny", message: "no" });
  expect(rig.approvals.resolveCalls).toEqual([{ id: "t1", decision: { type: "allow" } }, { id: "t2", decision: { type: "deny" } }]);
  expect(resolvedIds(rig.events)).toEqual(["t1", "t2"]);
  expect(rows(rig.events).map((row) => [row.id, row.data.outcome, row.data.source])).toEqual([["t1", "approved", "paseo"], ["t2", "denied", "paseo"]]);
  expect(rows(rig.events)[0]).toMatchObject({ pluginId: "herdr-harness", kind: "herdr-decision", version: 1 });
  expect(describeDecision(rows(rig.events)[0].data)).toBe("Approved in Paseo");
  const persisted = rig.events.filter((event) => event.type === "session.persistence").at(-1);
  expect(persisted && persisted.type === "session.persistence" ? (persisted.persistence.data as { decisions: unknown[] }).decisions : []).toHaveLength(2);
  // A repeated click on a decided card, and a click on an unknown id, are acknowledged without touching the harness.
  await rig.session.approvals.respond("t1", { behavior: "deny" });
  await rig.session.approvals.respond("ghost", { behavior: "allow" });
  expect(rig.approvals.resolveCalls).toHaveLength(2);
  expect(resolvedIds(rig.events)).toEqual(["t1", "t2", "ghost"]);
});

it("builds a question card with unique headers and maps answers back: commas inside labels, custom text, multi-select", async () => {
  expect(uniqueHeaders([{ question: "A very long question that goes on and on forever and ever", header: "" }, { question: "Same", header: "X" }, { question: "Other", header: "X" }]))
    .toEqual(["A very long question that goes on and on", "X", "X (2)"]);
  expect(parseAnswer("Red, dark, Blue, mauve", ["Red, dark", "Blue", "Green"], true)).toEqual({ selected: ["Red, dark", "Blue"], custom: "mauve" });
  expect(parseAnswer("Red, dark", ["Red", "Red, dark"], true)).toEqual({ selected: ["Red, dark"], custom: undefined });
  expect(parseAnswer("Blue, custom, with, commas", ["Blue"], true)).toEqual({ selected: ["Blue"], custom: "custom, with, commas" });
  expect(parseAnswer("My own, text", ["Blue"], false)).toEqual({ selected: [], custom: "My own, text" });
  expect(parseAnswer("", ["Blue"], true)).toEqual({ selected: [], custom: undefined });

  const rig = await setup();
  rig.approvals.add(question("q1", { questions: [
    { id: "a", question: "Which colour?", header: "Colour", multi: true, options: [{ label: "Red, dark" }, { label: "Blue", description: "cool" }, { label: "Green" }] },
    { id: "b", question: "Which size?", options: [{ label: "S" }, { label: "M" }], multi: false },
    { id: "c", question: "Which size?", options: [{ label: "S" }], multi: false },
  ] }));
  await block(rig);
  await vi.waitFor(() => expect(permissions(rig.events)).toHaveLength(1));
  const card = permissions(rig.events)[0];
  expect(card).toMatchObject({ id: "q1", name: "ask", kind: "question", title: "Which colour?" });
  expect(card.input).toEqual({ questions: [
    { question: "Which colour?", header: "Colour", options: [{ label: "Red, dark" }, { label: "Blue", description: "cool" }, { label: "Green" }], multiSelect: true, allowOther: true, allowEmpty: true, dismissLabel: "Chat instead" },
    { question: "Which size?", header: "Which size?", options: [{ label: "S" }, { label: "M" }], multiSelect: false, allowOther: true, allowEmpty: false, dismissLabel: "Chat instead" },
    { question: "Which size?", header: "Which size? (2)", options: [{ label: "S" }], multiSelect: false, allowOther: true, allowEmpty: false, dismissLabel: "Chat instead" },
  ] });
  expect(card.metadata).toEqual({ herdr: { kind: "question", questionIds: ["a", "b", "c"], headers: ["Colour", "Which size?", "Which size? (2)"] } });
  await rig.session.approvals.respond("q1", { behavior: "allow", updatedInput: { ...card.input, answers: {
    Colour: "Red, dark, Blue, mauve", "Which size?": "M", "Which size? (2)": "something else" } } });
  expect(rig.approvals.resolveCalls).toEqual([{ id: "q1", decision: { type: "answer", answers: [
    { id: "a", selectedOptions: ["Red, dark", "Blue"], customInput: "mauve" },
    { id: "b", selectedOptions: ["M"] },
    { id: "c", selectedOptions: [], customInput: "something else" },
  ] } }]);
  expect(rows(rig.events)[0].data).toMatchObject({ kind: "question", outcome: "answered", source: "paseo", answers: [
    { header: "Colour", selected: ["Red, dark", "Blue"], custom: "mauve" }, { header: "Which size?", selected: ["M"] }, { header: "Which size? (2)", selected: [], custom: "something else" }] });
  expect(describeDecision(rows(rig.events)[0].data)).toBe("Answered in Paseo: Colour: Red, dark, Blue, mauve; Which size?: M; Which size? (2): something else");
});

it("maps Dismiss on a question to chat and keeps an unusable answer from reaching the harness", async () => {
  const rig = await setup();
  rig.approvals.add(question("q1"));
  rig.approvals.add(question("q2", { questions: [{ id: "a", question: "Pick", header: "Pick", multi: false, options: [{ label: "One" }] }] }));
  await block(rig);
  await vi.waitFor(() => expect(permissions(rig.events)).toHaveLength(2));
  await rig.session.approvals.respond("q1", { behavior: "deny", message: "Dismissed by user" });
  expect(rig.approvals.resolveCalls).toEqual([{ id: "q1", decision: { type: "chat" } }]);
  expect(rows(rig.events)[0].data).toMatchObject({ outcome: "chat", source: "paseo" });
  expect(describeDecision(rows(rig.events)[0].data)).toBe("Chat instead");
  // Single-select with no answer: refused locally, warning, same card again.
  await rig.session.approvals.respond("q2", { behavior: "allow", updatedInput: { answers: {} } });
  expect(rig.approvals.resolveCalls).toHaveLength(1);
  expect(notices(rig.events).some((notice) => notice.severity === "warning" && notice.id === "approval-answer-invalid")).toBe(true);
  expect(permissions(rig.events).filter((request) => request.id === "q2")).toHaveLength(2);
});

it("records a terminal decision, then answers Paseo with the true response, then resolves the card", async () => {
  const rig = await setup();
  rig.approvals.add(tool("t1"));
  rig.approvals.add(tool("t2"));
  rig.approvals.add(tool("t3"));
  rig.approvals.add(question("q1"));
  rig.approvals.add(question("q2", { questions: [{ id: "a", question: "Pick", header: "Pick", multi: false, options: [{ label: "One" }] }] }));
  rig.approvals.add(question("q3"));
  rig.approvals.add(question("q4"));
  await block(rig);
  await vi.waitFor(() => expect(permissions(rig.events)).toHaveLength(7));
  rig.log.length = 0;
  rig.approvals.decide("t1", "approved");
  rig.approvals.decide("t2", "denied");
  rig.approvals.decide("t3", "cancelled", "system");
  rig.approvals.decide("q1", "answered", "terminal", [{ id: "a", selectedOptions: ["Red, dark", "Blue"], customInput: "mauve" }]);
  rig.approvals.decide("q2", "timed_out", "system", [{ id: "a", selectedOptions: ["One"] }]);
  rig.approvals.decide("q3", "chat");
  rig.approvals.decide("q4", "cancelled");
  await rig.session.live.reconcile();
  await rig.release(3);
  await vi.waitFor(() => expect(rig.responded).toHaveLength(7));
  // For every card: row, then persistence, then the true response, then the resolution.
  for (const id of ["t1", "t2", "t3", "q1", "q2", "q3", "q4"]) {
    const sequence = rig.log.filter((entry) => entry.endsWith(`:${id}`) || entry === "persist");
    expect(sequence.indexOf(`row:${id}`)).toBeLessThan(sequence.indexOf(`respond:${id}`));
    expect(sequence.indexOf(`respond:${id}`)).toBeLessThan(sequence.indexOf(`resolved:${id}`));
    expect(rig.log.indexOf(`row:${id}`)).toBeLessThan(rig.log.indexOf(`respond:${id}`));
    expect(rig.log.filter((entry) => entry === `resolved:${id}`)).toHaveLength(1);
  }
  const byId = Object.fromEntries(rig.responded.map((call) => [call.requestId, call.response]));
  expect(byId.t1).toEqual({ behavior: "allow", selectedActionId: "allow" });
  expect(byId.t2).toEqual({ behavior: "deny", selectedActionId: "deny", message: "Denied in the terminal" });
  expect(byId.t3).toEqual({ behavior: "deny", message: "Cancelled in the terminal", interrupt: true });
  expect(byId.q1).toMatchObject({ behavior: "allow", updatedInput: { answers: { Colour: "Red, dark, Blue, mauve" }, herdr: { outcome: "answered", source: "terminal" } } });
  expect(byId.q2).toMatchObject({ behavior: "allow", updatedInput: { answers: { Pick: "One" }, herdr: { outcome: "timed_out", source: "system" } } });
  expect(byId.q3).toMatchObject({ behavior: "allow", updatedInput: { answers: {}, herdr: { outcome: "chat", source: "terminal" } } });
  expect(byId.q4).toEqual({ behavior: "deny", message: "Cancelled in the terminal", interrupt: true });
  // The harness was never asked to decide anything: Paseo's forward only acknowledged.
  expect(rig.approvals.resolveCalls).toEqual([]);
  expect(Object.fromEntries(rows(rig.events).map((row) => [row.id, describeDecision(row.data)]))).toMatchObject({
    t1: "Approved in the terminal", t2: "Denied in the terminal", t3: "Cancelled in Fake",
    q1: "Answered in the terminal: Colour: Red, dark, Blue, mauve",
    q2: "Timed out in Fake (default option used): Pick: One", q3: "Chat instead", q4: "Cancelled in the terminal" });
});

it("falls back to a direct resolution plus one notice when Paseo cannot be answered", async () => {
  for (const mode of ["throws", "no handle"] as const) {
    const rig = await setup();
    rig.approvals.add(tool("t1"));
    rig.approvals.add(tool("t2"));
    await block(rig);
    await vi.waitFor(() => expect(permissions(rig.events)).toHaveLength(2));
    if (mode === "throws") rig.paseo.fail = true; else rig.paseo.present = false;
    rig.approvals.decide("t1", "denied");
    rig.approvals.decide("t2", "approved");
    await rig.release(1);
    await vi.waitFor(() => expect(resolvedIds(rig.events)).toEqual(["t1", "t2"]));
    expect(rows(rig.events).map((row) => row.data.outcome)).toEqual(["denied", "approved"]);
    expect(notices(rig.events).filter((notice) => notice.id === "decision-wire")).toHaveLength(1);
    expect(rig.log.indexOf("row:t1")).toBeLessThan(rig.log.indexOf("resolved:t1"));
    if (mode === "throws") expect(rig.responded.map((call) => call.requestId)).toEqual(["t1", "t2"]);
    else expect(rig.responded).toEqual([]);
  }
});

it("a Paseo click that lost the race to the terminal records the terminal decision without answering Paseo again", async () => {
  const rig = await setup();
  rig.approvals.add(tool("t1"));
  await block(rig);
  await vi.waitFor(() => expect(permissions(rig.events)).toHaveLength(1));
  // The terminal decides; the poll has not run yet when the user clicks Allow in Paseo.
  rig.approvals.decide("t1", "denied");
  await rig.session.approvals.respond("t1", { behavior: "allow" });
  expect(rows(rig.events).map((row) => [row.data.outcome, row.data.source])).toEqual([["denied", "terminal"]]);
  expect(resolvedIds(rig.events)).toEqual(["t1"]);
  expect(rig.responded).toEqual([]);
  expect(notices(rig.events).some((notice) => notice.id === "decision-wire")).toBe(true);
  await rig.session.live.reconcile();
  expect(rows(rig.events)).toHaveLength(1);
});

it("re-emits the same card after a refusal before anything was written, then accepts the retry", async () => {
  const rig = await setup();
  rig.approvals.add(tool("t1"));
  await block(rig);
  await vi.waitFor(() => expect(permissions(rig.events)).toHaveLength(1));
  rig.approvals.resolveOverride = { type: "rejected", code: "bad_request", message: "refused" };
  await rig.session.approvals.respond("t1", { behavior: "allow" });
  expect(permissions(rig.events)).toHaveLength(2);
  expect(permissions(rig.events)[1]).toEqual(permissions(rig.events)[0]);
  expect(resolvedIds(rig.events)).toEqual([]);
  expect(rows(rig.events)).toEqual([]);
  expect(notices(rig.events).some((notice) => notice.id === "approval-not-sent" && notice.severity === "warning")).toBe(true);
  rig.approvals.resolveOverride = null;
  await rig.session.approvals.respond("t1", { behavior: "allow" });
  expect(rows(rig.events).map((row) => row.data.outcome)).toEqual(["approved"]);
  expect(resolvedIds(rig.events)).toEqual(["t1"]);
});

it("withdraws a card whose request the agent no longer knows and asks the live loop to re-check the agent", async () => {
  const rig = await setup();
  rig.approvals.add(tool("t1"));
  await block(rig);
  await vi.waitFor(() => expect(permissions(rig.events)).toHaveLength(1));
  rig.approvals.resolveOverride = { type: "rejected", code: "identity_mismatch", message: "different process" };
  await rig.session.approvals.respond("t1", { behavior: "allow" });
  expect(rows(rig.events).map((row) => row.data.outcome)).toEqual(["withdrawn"]);
  expect(resolvedIds(rig.events)).toEqual(["t1"]);
  expect(notices(rig.events).some((notice) => notice.id === "approval-agent-changed")).toBe(true);
  expect(permissions(rig.events)).toHaveLength(1);
});

it("asks the live loop to re-check the agent when a snapshot is refused with an identity code", async () => {
  const rig = await setup();
  const reconcile = vi.spyOn(rig.session.live, "reconcile");
  rig.approvals.snapshotError = Object.assign(new Error("The native session changed; reconnect."), { code: "ref_mismatch" });
  await block(rig);
  // `block` reconciles once itself; the refused snapshot must ask for another.
  await vi.waitFor(() => expect(reconcile.mock.calls.length).toBeGreaterThan(1));
});

it("treats an uncertain write as undecided: it shows the card again after two polls, or settles from the outcome", async () => {
  const uncertain: ResolveResult = { type: "uncertain", message: "no reply" };
  const again = await setup();
  again.approvals.add(tool("t1"));
  await block(again);
  await vi.waitFor(() => expect(permissions(again.events)).toHaveLength(1));
  again.approvals.resolveOverride = uncertain;
  await again.session.approvals.respond("t1", { behavior: "allow" });
  expect(permissions(again.events)).toHaveLength(1);
  expect(resolvedIds(again.events)).toEqual([]);
  await vi.waitFor(() => expect(again.sleeps.length).toBeGreaterThan(0));
  await again.release(1);
  await vi.waitFor(() => expect(again.approvals.snapshotCalls.length).toBeGreaterThanOrEqual(3));
  expect(permissions(again.events)).toHaveLength(1);
  await again.release(1);
  await vi.waitFor(() => expect(permissions(again.events)).toHaveLength(2));
  expect(notices(again.events).some((notice) => notice.id === "approval-uncertain")).toBe(true);

  const landed = await setup();
  landed.approvals.add(tool("t1"));
  await block(landed);
  await vi.waitFor(() => expect(permissions(landed.events)).toHaveLength(1));
  landed.approvals.resolveOverride = uncertain;
  await landed.session.approvals.respond("t1", { behavior: "allow" });
  // The write did land after all: the next poll reports our own decision.
  landed.approvals.decide("t1", "approved", "paseo");
  await landed.release(1);
  await vi.waitFor(() => expect(rows(landed.events)).toHaveLength(1));
  expect(rows(landed.events)[0].data).toMatchObject({ outcome: "approved", source: "paseo" });
  expect(resolvedIds(landed.events)).toEqual(["t1"]);
  expect(landed.responded).toEqual([]);
  expect(permissions(landed.events)).toHaveLength(1);
});

it("a thrown resolve is uncertain, and an outcome seen while it was in flight settles it", async () => {
  const rig = await setup();
  rig.approvals.add(tool("t1"));
  await block(rig);
  await vi.waitFor(() => expect(permissions(rig.events)).toHaveLength(1));
  let release!: () => void;
  rig.approvals.resolveGate = new Promise<void>((resolve) => { release = resolve; });
  rig.approvals.resolveOverride = { type: "uncertain", message: "no reply" };
  const click = rig.session.approvals.respond("t1", { behavior: "allow" });
  await vi.waitFor(() => expect(rig.approvals.resolveCalls).toHaveLength(1));
  rig.approvals.decide("t1", "denied");
  await rig.release(1);
  await vi.waitFor(() => expect(rig.approvals.snapshotCalls.length).toBeGreaterThanOrEqual(3));
  release();
  await click;
  expect(rows(rig.events).map((row) => [row.data.outcome, row.data.source])).toEqual([["denied", "terminal"]]);
  expect(resolvedIds(rig.events)).toEqual(["t1"]);
  expect(permissions(rig.events)).toHaveLength(1);
});

it("withdraws every open card with an explicit row when the session freezes, answering Paseo with a deny", async () => {
  const rig = await setup();
  rig.approvals.add(tool("t1"));
  rig.approvals.add(question("q1"));
  await block(rig);
  await vi.waitFor(() => expect(permissions(rig.events)).toHaveLength(2));
  rig.session.freeze("The bound agent was replaced", "gone");
  await vi.waitFor(() => expect(resolvedIds(rig.events).sort()).toEqual(["q1", "t1"]));
  expect(rows(rig.events).map((row) => row.data.outcome)).toEqual(["withdrawn", "withdrawn"]);
  expect(describeDecision(rows(rig.events)[0].data)).toBe("Card withdrawn: The bound agent was replaced; decide in the terminal");
  expect(rig.responded.every((call) => call.response.behavior === "deny" && /withdrawn/i.test((call.response as { message?: string }).message ?? ""))).toBe(true);
  expect(rig.approvals.resolveCalls).toEqual([]);
});

it("treats pending as authoritative: a card the harness stops listing is withdrawn, also after a lost cursor", async () => {
  const rig = await setup();
  rig.approvals.add(tool("t1"));
  rig.approvals.add(tool("t2"));
  await block(rig);
  await vi.waitFor(() => expect(permissions(rig.events)).toHaveLength(2));
  // Both vanish without a retained outcome: the ring dropped them.
  rig.approvals.pending = [];
  rig.approvals.lost = true;
  await rig.release(1);
  await vi.waitFor(() => expect(rows(rig.events)).toHaveLength(2));
  expect(rows(rig.events).map((row) => describeDecision(row.data))).toEqual(Array(2).fill("Decided in the terminal; details were not retained"));
  await vi.waitFor(() => expect(resolvedIds(rig.events).sort()).toEqual(["t1", "t2"]));
  expect(rig.responded.map((call) => call.response.behavior)).toEqual(["deny", "deny"]);
});

it("replays persisted decision rows on open and never shows a decided card again", async () => {
  const stored = { id: "t1", data: { kind: "tool" as const, outcome: "approved" as const, source: "terminal" as const, title: "Allow tool: bash", at: AT } };
  const rig = await setup({ history: "replay", binding: (binding) => { binding.decisions = [stored]; } });
  expect(rows(rig.events)).toEqual([{ id: "t1", kind: "herdr-decision", version: 1, pluginId: "herdr-harness", data: stored.data }]);
  const replayed = rig.events.findIndex((event) => event.type === "timeline.item" && event.item.type === "plugin");
  expect(replayed).toBeGreaterThan(rig.events.findIndex((event) => event.type === "session.opened"));
  expect(replayed).toBeLessThan(rig.events.findIndex((event) => event.type === "session.ready"));
  rig.approvals.add(tool("t1"));
  await block(rig);
  await vi.waitFor(() => expect(rig.approvals.snapshotCalls.length).toBeGreaterThan(1));
  expect(permissions(rig.events)).toEqual([]);
  const skipped = await setup({ history: "skip", binding: (binding) => { binding.decisions = [stored]; } });
  expect(rows(skipped.events)).toEqual([]);
});

it("persists decision rows as an optional binding field, capped at 64, with the version unchanged", () => {
  const adapter = makeFakeAdapter();
  const binding = bindingOf(makeAgent(), adapter, null);
  expect(persistenceOf(binding).data).not.toHaveProperty("decisions");
  expect(parseBinding(persistenceOf(binding), adapter).decisions).toBeUndefined();
  binding.decisions = Array.from({ length: 70 }, (_, i) => ({ id: `d${i}`, data: { kind: "tool" as const, outcome: "denied" as const, source: "paseo" as const, title: "t", at: AT } }));
  const persistence = persistenceOf(binding);
  expect(persistence.version).toBe(1);
  const parsed = parseBinding(persistence, adapter);
  expect(parsed.decisions).toHaveLength(64);
  expect(parsed.decisions?.[0].id).toBe("d6");
  // A malformed stored row is dropped; the binding still opens.
  const damaged = { ...persistence, data: { ...(persistence.data as object), decisions: [{ id: "x", data: { nope: true } }, binding.decisions[69]] } };
  expect(parseBinding(damaged as typeof persistence, adapter).decisions?.map((row) => row.id)).toEqual(["d69"]);
});

it("uses the session's Paseo agent id and the provider routes session.permission to the bridge", async () => {
  let directory = "";
  let server: Server | undefined;
  let connection: ProviderConnection | undefined;
  try {
    directory = await mkdtemp(join(tmpdir(), "herdr-perm-"));
    const socket = join(directory, "herdr.sock");
    const agent = { ...makeAgent("blocked") };
    server = createServer((stream) => {
      let bytes = "";
      stream.setEncoding("utf8");
      stream.on("data", (chunk: string) => {
        bytes += chunk;
        if (!bytes.includes("\n")) return;
        const request = JSON.parse(bytes.slice(0, bytes.indexOf("\n"))) as { id: string; method: string };
        if (request.method === "events.subscribe") { stream.write(JSON.stringify({ id: request.id, result: { type: "subscription_started" } }) + "\n"); return; }
        const result = request.method === "pane.process_info" ? { type: "pane_process_info", process_info: {
          pane_id: "pane", foreground_process_group_id: 77, tty: "/dev/pts/fake", foreground_processes: [{ pid: 77, name: "fake" }] } } :
          request.method === "agent.list" ? { type: "agent_list", agents: [agent] } : { type: "unknown" };
        stream.end(JSON.stringify({ id: request.id, result }) + "\n");
      });
    });
    await new Promise<void>((resolve) => server?.listen(socket, resolve));
    const approvals = new FakeApprovals();
    approvals.add(tool("t1"));
    const store = new FakeTranscript();
    store.set([{ id: "u1", kind: "user", text: "Hello" }, { id: "a1", kind: "assistant", text: "Hi" }]);
    const provider = createHerdrProvider(makeFakeAdapter(store, { approvals }), async () => socket, {
      getHerdrSession: () => "work", approvalSleep: (_ms, signal) => new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true })),
    });
    connection = await provider.connect({ versions: [1], capabilities: ["session.list", "session.persistence", "prompt.message", "permission", "timeline.plugin"] });
    expect(connection.capabilities).toEqual(expect.arrayContaining(["permission", "timeline.plugin"]));
    const events: ProviderEvent[] = [];
    connection.onEvent((event) => events.push(ProviderEventSchema.parse(event)));
    const persistence = persistenceOf(bindingOf(agent, makeFakeAdapter(), "work"));
    await connection.send({ type: "session.open", requestId: "r1", sessionId: "s1", config, persistence, history: "skip" });
    await vi.waitFor(() => expect(permissions(events)).toHaveLength(1));
    await connection.send({ type: "session.permission", sessionId: "s1", permissionId: "t1", response: { behavior: "deny" } });
    await vi.waitFor(() => expect(resolvedIds(events)).toEqual(["t1"]));
    expect(approvals.resolveCalls).toEqual([{ id: "t1", decision: { type: "deny" } }]);
    expect(rows(events).map((row) => row.data.outcome)).toEqual(["denied"]);
    await connection.send({ type: "session.permission", sessionId: "missing", permissionId: "t1", response: { behavior: "deny" } });
  } finally {
    await connection?.close();
    if (server) await new Promise<void>((resolve) => server?.close(() => resolve()));
    if (directory) await rm(directory, { recursive: true, force: true });
  }
});
