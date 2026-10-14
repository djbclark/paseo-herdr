import type { ProviderPermissionRequest, ProviderPermissionResponse, ProviderSessionConfig } from "@getpaseo/plugin/server/provider";
import type {
  ConfigTarget, Decision, DecisionOutcome, DecisionRecord, DecisionSource, HarnessAdapter, PendingApproval,
  PendingDecision, PendingQuestion, QuestionAnswer, ResolveResult,
} from "./harness/types.js";
import type { HerdrHarnessSession } from "./session.js";
import { MAX_DECISIONS } from "./binding.js";
import { DECISION_PLUGIN_ID, DECISION_ROW_KIND, DECISION_ROW_VERSION, type DecisionRowData } from "../shared/decision.js";

/** Approvals need both halves of the adapter contract. */
export function supportsApprovals(adapter: HarnessAdapter): boolean {
  return typeof adapter.snapshotApprovals === "function" && typeof adapter.resolveApproval === "function";
}

const BURST_DELAYS_MS = [250, 500];
const STEADY_DELAY_MS = 1000;
/** After an uncertain write the harness is polled this many times before the card is shown again. */
const UNCERTAIN_POLLS = 2;
const MAX_DESCRIPTION_CHARS = 2048;
const PRE_WRITE_REFUSALS = new Set(["unavailable", "bad_request", "invalid_decision"]);
const GONE_REFUSALS = new Set(["unknown_request", "not_pending", "ref_mismatch", "identity_mismatch", "no_session"]);

type CardState = "open" | "resolving" | "resolved" | "withdrawn";
interface Card {
  id: string;
  native: PendingDecision;
  request: ProviderPermissionRequest;
  /** Question cards: the unique Paseo header of each question, same order as `native.questions`. */
  headers: string[];
  state: CardState;
  /** Paseo currently shows the card (it deletes the card the moment the user clicks). */
  visible: boolean;
  /** Polls to wait before an uncertain card is shown again. */
  hold: number;
  resolvedEmitted: boolean;
  /** An outcome observed while our own decision was in flight. */
  outcomeSeen?: DecisionRecord;
}

export type ApprovalsEnabled = "unknown" | "on" | "off";

function defaultSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) { resolve(); return; }
    const done = () => { clearTimeout(timer); signal.removeEventListener("abort", done); resolve(); };
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
  });
}

/** Unique, non-empty Paseo header per question; Paseo keys answers by header. */
export function uniqueHeaders(questions: ReadonlyArray<{ question: string; header?: string }>): string[] {
  const used = new Set<string>();
  return questions.map((item) => {
    const base = item.header?.trim() || item.question.trim().slice(0, 40) || "Question";
    let header = base;
    for (let n = 2; used.has(header); n++) header = `${base} (${n})`;
    used.add(header);
    return header;
  });
}

/** `"A, B, custom"` -> labels merged greedily (a label may contain ", ") plus leftover custom text. */
export function parseAnswer(raw: string, labels: readonly string[], multi: boolean): { selected: string[]; custom: string | undefined } {
  const text = raw.trim();
  if (labels.includes(text)) return { selected: [text], custom: undefined };
  if (!multi) return { selected: [], custom: text || undefined };
  const tokens = text === "" ? [] : text.split(", ");
  const selected: string[] = [];
  const leftover: string[] = [];
  for (let i = 0; i < tokens.length;) {
    let matched = -1;
    for (let j = tokens.length - 1; j >= i; j--) {
      if (labels.includes(tokens.slice(i, j + 1).join(", "))) { matched = j; break; }
    }
    if (matched >= 0) { selected.push(tokens.slice(i, matched + 1).join(", ")); i = matched + 1; }
    else { leftover.push(tokens[i]); i++; }
  }
  return { selected, custom: leftover.length ? leftover.join(", ") : undefined };
}

function describeArgs(args: unknown): string {
  if (args === undefined) return "";
  let text: string;
  try { text = typeof args === "string" ? args : JSON.stringify(args, null, 2) ?? ""; } catch { return ""; }
  return text.length > MAX_DESCRIPTION_CHARS ? `${text.slice(0, MAX_DESCRIPTION_CHARS)}…` : text;
}
const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const messageOf = (error: unknown): string => error instanceof Error ? error.message : String(error);

/** Turns a harness's pending approvals and questions into Paseo permission cards, and decisions back into the harness. Owned by one session. */
export class ApprovalController {
  enabled: ApprovalsEnabled;
  private cursor: number | null = null;
  private readonly cards = new Map<string, Card>();
  private agentId: string | null = null;
  private wasBlocked = false;
  private looping = false;
  private closed = false;
  private queue: Promise<void> = Promise.resolve();
  private readonly notices = new Set<string>();

  constructor(private readonly session: HerdrHarnessSession) {
    this.enabled = supportsApprovals(session.adapter) ? "unknown" : "off";
  }

  private get adapter(): HarnessAdapter { return this.session.adapter; }
  private get decisions() { return this.session.state.binding.decisions ??= []; }

  private target(): ConfigTarget | null {
    const { occupant, sessionRef } = this.session.state.binding;
    return occupant && sessionRef ? { pid: occupant.pid, ref: sessionRef, instanceId: occupant.instanceId } : null;
  }
  private get sessionId(): string { return this.session.sessionId; }

  /** Session open: remember Paseo's id for this agent (Paseo injects it into the provider env). */
  begin(config: ProviderSessionConfig): void { this.agentId = config.env?.PASEO_AGENT_ID || null; }

  /** Re-send persisted decision rows so they survive a plugin reload. */
  replay(): void {
    for (const stored of this.decisions) this.emitRow(stored.id, stored.data);
  }

  /** First read after open validation; decides whether this chat has approvals at all. */
  async initialPoll(): Promise<void> {
    if (this.enabled === "off") return;
    await this.pollSerial();
  }

  /** Every Herdr status observation (also repeated ones). */
  observeStatus(status: string): void {
    if (this.enabled === "off" || this.closed) return;
    const blocked = status === "blocked";
    if (blocked && !this.wasBlocked) { this.wasBlocked = true; this.startLoop(); }
    else if (!blocked && this.wasBlocked) { this.wasBlocked = false; void this.pollSerial(); }
  }

  connectivityRestored(): void {
    if (this.enabled !== "off" && !this.closed) void this.pollSerial();
  }

  /** The harness can no longer be trusted (frozen, closed, replaced): take every card down. */
  withdrawAll(reason: string): void {
    if (this.closed) return;
    for (const card of [...this.cards.values()]) {
      if (card.state === "open") void this.withdraw(card, `Card withdrawn: ${reason}; decide in the terminal`, `Card withdrawn: ${reason}; decide in the terminal`);
    }
  }

  close(): void {
    this.closed = true;
    this.cards.clear();
  }

  // ---- polling -------------------------------------------------------------------------------------------------

  private hasOpenCards(): boolean {
    for (const card of this.cards.values()) if (card.state === "open" || card.state === "resolving") return true;
    return false;
  }
  private active(): boolean { return !this.closed && !this.session.isAborted && this.session.state.outcome === "active"; }

  private async sleep(ms: number): Promise<boolean> {
    const sleep = this.session.deps.approvalSleep ?? defaultSleep;
    await sleep(ms, this.session.signal);
    return this.active();
  }

  /** Immediate, 250 ms, 500 ms, then every second while blocked or cards are open. */
  private startLoop(): void {
    if (this.looping || !this.active()) return;
    this.looping = true;
    void (async () => {
      try {
        await this.pollSerial();
        for (const delay of BURST_DELAYS_MS) {
          if (!(await this.sleep(delay))) return;
          await this.pollSerial();
        }
        while (this.enabled !== "off" && (this.wasBlocked || this.hasOpenCards())) {
          if (!(await this.sleep(STEADY_DELAY_MS))) return;
          await this.pollSerial();
        }
      } finally { this.looping = false; }
    })();
  }

  private pollSerial(): Promise<void> {
    const next = this.queue.catch(() => {}).then(() => this.pollNow());
    this.queue = next;
    return next;
  }

  private async pollNow(): Promise<void> {
    if (this.enabled === "off" || !this.active()) return;
    const target = this.target();
    const snapshot = this.adapter.snapshotApprovals;
    if (!target || !snapshot) return;
    const generation = this.session.state.generation;
    let result: Awaited<ReturnType<NonNullable<HarnessAdapter["snapshotApprovals"]>>>;
    try { result = await snapshot.call(this.adapter, target, this.cursor, this.session.signal); }
    catch (error) {
      // Identity trouble is the reconcile's to judge; anything else is retried by the next poll.
      const code = (error as { code?: unknown } | null)?.code;
      const identityTrouble = code === "ref_mismatch" || code === "identity_mismatch" || code === "no_session" ||
        /identity|mismatch/i.test(messageOf(error));
      if (identityTrouble && this.active()) void this.session.live.reconcile();
      return;
    }
    if (this.closed || !this.session.current(generation)) return;
    if (result === "unsupported") { this.enabled = "off"; return; }
    const first = this.enabled !== "on";
    this.enabled = "on";
    if (first && this.session.state.status === "blocked") {
      // The legacy "needs approval in the terminal" notice is superseded by the cards.
      this.session.emit({ type: "session.notice", sessionId: this.sessionId, notice: {
        id: "blocked", severity: "warning", title: "Needs approval in the terminal", dismissed: true } });
    }
    await this.apply(result.pending, result.outcomes, result.cursor);
    if (this.hasOpenCards()) this.startLoop();
  }

  private async apply(pending: PendingDecision[], outcomes: DecisionRecord[], cursor: number): Promise<void> {
    this.cursor = cursor;
    for (const record of [...outcomes].sort((a, b) => a.seq - b.seq)) await this.observeOutcome(record);
    const pendingIds = new Set(pending.map((entry) => entry.id));
    for (const entry of pending) {
      const card = this.cards.get(entry.id);
      if (card) {
        if (card.state === "open" && !card.visible && card.hold > 0 && --card.hold === 0) {
          this.reemit(card);
          this.notice("approval-uncertain", "warning", "Your decision may not have reached the agent",
            "The agent still shows the request, so the card is back. Decide again, or decide in the terminal.");
        }
      } else if (!this.decisions.some((stored) => stored.id === entry.id)) this.show(entry);
    }
    // Pending is authoritative: an open card the harness no longer lists was decided where we couldn't see it.
    for (const card of [...this.cards.values()]) {
      if (card.state === "open" && !pendingIds.has(card.id)) {
        const note = "Decided in the terminal; details were not retained";
        await this.withdraw(card, note, note);
      }
    }
  }

  private async observeOutcome(record: DecisionRecord): Promise<void> {
    const card = this.cards.get(record.id);
    if (!card || card.state === "resolved" || card.state === "withdrawn") return;
    if (card.state === "resolving") { card.outcomeSeen = record; return; }
    if (record.source === "paseo") await this.settleOwn(card, record);
    else await this.external(card, record);
  }

  // ---- cards ---------------------------------------------------------------------------------------------------

  private requestOf(entry: PendingDecision): { request: ProviderPermissionRequest; headers: string[] } {
    if (entry.kind === "tool") return { request: this.toolRequest(entry), headers: [] };
    const headers = uniqueHeaders(entry.questions);
    const request: ProviderPermissionRequest = {
      id: entry.id, name: entry.toolName, kind: "question",
      title: entry.questions[0]?.question ?? "Question",
      input: { questions: entry.questions.map((item, index) => ({
        question: item.question, header: headers[index],
        options: item.options.map((option) => ({ label: option.label, ...(option.description ? { description: option.description } : {}) })),
        multiSelect: item.multi, allowOther: true, allowEmpty: item.multi, dismissLabel: "Chat instead",
      })) },
      metadata: { herdr: { kind: "question", questionIds: entry.questions.map((item) => item.id), headers } },
    };
    return { request, headers };
  }

  private toolRequest(entry: PendingApproval): ProviderPermissionRequest {
    const args = describeArgs(entry.args);
    const description = [entry.reason, args].filter((part): part is string => !!part).join("\n\n");
    const input = isPlainObject(entry.args) && entry.args.truncated !== true ? (entry.args as ProviderPermissionRequest["input"]) : undefined;
    return {
      id: entry.id, name: entry.toolName, kind: "tool", title: entry.title || `Allow tool: ${entry.toolName}`,
      ...(description ? { description } : {}),
      ...(input ? { input } : {}),
      actions: [
        { id: "allow", label: "Allow", behavior: "allow", variant: "primary" },
        { id: "deny", label: "Deny", behavior: "deny", variant: "danger" },
      ],
      metadata: { herdr: { kind: "tool", ...(entry.approvalMode ? { approvalMode: entry.approvalMode } : {}) } },
    };
  }

  private show(entry: PendingDecision): void {
    const { request, headers } = this.requestOf(entry);
    const card: Card = { id: entry.id, native: entry, request, headers, state: "open", visible: true, hold: 0, resolvedEmitted: false };
    this.cards.set(entry.id, card);
    this.session.emit({ type: "session.permission", sessionId: this.sessionId, request });
  }

  /** Paseo deletes a card the moment the user clicks; a refused decision needs the same card shown again. */
  private reemit(card: Card): void {
    card.state = "open";
    card.visible = true;
    card.hold = 0;
    card.resolvedEmitted = false;
    this.session.emit({ type: "session.permission", sessionId: this.sessionId, request: card.request });
  }

  private emitResolved(permissionId: string, card?: Card): void {
    if (card) { if (card.resolvedEmitted) return; card.resolvedEmitted = true; }
    this.session.emit({ type: "session.permission_resolved", sessionId: this.sessionId, permissionId });
  }

  private notice(id: string, severity: "info" | "warning", title: string, description: string): void {
    this.session.emit({ type: "session.notice", sessionId: this.sessionId, notice: { id, severity, title, description } });
  }
  private noticeOnce(id: string, title: string, description: string): void {
    if (this.notices.has(id)) return;
    this.notices.add(id);
    this.notice(id, "info", title, description);
  }

  // ---- rows ----------------------------------------------------------------------------------------------------

  private rowOf(card: Card, outcome: DecisionRowData["outcome"], source: DecisionSource, extra: { answer?: QuestionAnswer[]; note?: string; at?: string } = {}): DecisionRowData {
    const native = card.native;
    const answers = extra.answer && native.kind === "question"
      ? extra.answer.flatMap((answer) => {
        const index = native.questions.findIndex((item) => item.id === answer.id);
        if (index < 0) return [];
        return [{ header: card.headers[index], selected: [...answer.selectedOptions], ...(answer.customInput ? { custom: answer.customInput } : {}) }];
      })
      : undefined;
    return {
      kind: native.kind, outcome, source,
      title: card.request.title ?? native.toolName,
      agentLabel: this.adapter.label,
      ...(answers?.length ? { answers } : {}),
      ...(extra.note ? { note: extra.note } : {}),
      at: extra.at ?? new Date().toISOString(),
    };
  }

  private emitRow(id: string, data: DecisionRowData): void {
    this.session.emit({ type: "timeline.item", sessionId: this.sessionId, timestamp: data.at, item: {
      type: "plugin", id, pluginId: DECISION_PLUGIN_ID, kind: DECISION_ROW_KIND, version: DECISION_ROW_VERSION,
      data: data as unknown as Record<string, never>,
    } });
  }

  /** Row first, then persistence: the record must outlive a reload even if the wire answer fails. */
  private record(card: Card, data: DecisionRowData): void {
    const list = this.decisions;
    const existing = list.findIndex((stored) => stored.id === card.id);
    if (existing >= 0) list.splice(existing, 1);
    list.push({ id: card.id, data });
    if (list.length > MAX_DECISIONS) list.splice(0, list.length - MAX_DECISIONS);
    this.emitRow(card.id, data);
    this.session.persist();
  }

  // ---- outcomes decided away from this Paseo click ----------------------------------------------------------------

  private responseFor(card: Card, record: DecisionRecord): ProviderPermissionResponse {
    const herdr = { outcome: record.outcome, source: record.source };
    switch (record.outcome) {
      case "approved": return { behavior: "allow", selectedActionId: "allow" };
      case "denied": return { behavior: "deny", selectedActionId: "deny", message: "Denied in the terminal" };
      case "cancelled": return { behavior: "deny", message: "Cancelled in the terminal", interrupt: true };
      case "chat": return { behavior: "allow", updatedInput: { ...(card.request.input ?? {}), answers: {}, herdr } };
      case "answered":
      case "timed_out": {
        const answers: Record<string, string> = {};
        const questions = card.native.kind === "question" ? card.native.questions : [];
        for (const answer of record.answer ?? []) {
          const index = questions.findIndex((item) => item.id === answer.id);
          if (index < 0) continue;
          const parts = [...answer.selectedOptions, ...(answer.customInput ? [answer.customInput] : [])];
          answers[card.headers[index]] = questions[index].multi ? parts.join(", ") : (answer.customInput ?? answer.selectedOptions.join(", "));
        }
        return { behavior: "allow", updatedInput: { ...(card.request.input ?? {}), answers, herdr } };
      }
    }
  }

  /** Decided in the terminal (or by the harness itself): record it, then tell Paseo the truth. */
  private async external(card: Card, record: DecisionRecord, options: { inHandler?: boolean } = {}): Promise<void> {
    if (card.state === "resolved" || card.state === "withdrawn") return;
    card.state = "resolved";
    this.record(card, this.rowOf(card, record.outcome as DecisionOutcome, record.source, { answer: record.answer, at: record.at }));
    if (options.inHandler) { this.emitResolved(card.id, card); return; }
    await this.answerPaseo(card, this.responseFor(card, record));
  }

  /** Our own decision landed but its reply was lost (uncertain write): the card is gone from Paseo already. */
  private async settleOwn(card: Card, record: DecisionRecord): Promise<void> {
    if (card.state === "resolved" || card.state === "withdrawn") return;
    card.state = "resolved";
    this.record(card, this.rowOf(card, record.outcome, record.source, { answer: record.answer, at: record.at }));
    this.emitResolved(card.id, card);
  }

  private async withdraw(card: Card, note: string, message: string, options: { inHandler?: boolean } = {}): Promise<void> {
    if (card.state === "resolved" || card.state === "withdrawn") return;
    const wasVisible = card.visible;
    card.state = "withdrawn";
    this.record(card, this.rowOf(card, "withdrawn", "system", { note }));
    if (options.inHandler || !wasVisible) { this.emitResolved(card.id, card); return; }
    await this.answerPaseo(card, { behavior: "deny", message });
  }

  /**
   * Answer Paseo's own pending request with the true response; Paseo forwards it to `respond` below, which acknowledges
   * the already-decided id. Without a handle (or on failure) the bare resolution still clears the card.
   */
  private async answerPaseo(card: Card, response: ProviderPermissionResponse): Promise<void> {
    const paseo = this.session.deps.getPaseo?.() ?? null;
    if (paseo && this.agentId) {
      try {
        await paseo.agents.ref(this.agentId).respondToPermission({ requestId: card.id, response });
        // Normally the provider handler acknowledged it during the call; cover a path that never reached us.
        this.emitResolved(card.id, card);
        return;
      } catch { /* fall through to the direct resolution */ }
    }
    this.emitResolved(card.id, card);
    this.noticeOnce("decision-wire", "Paseo shows a generic outcome for a terminal decision",
      "The conversation lists what was decided, but Paseo's own record of this permission may say it was denied.");
  }

  // ---- Paseo's decision -----------------------------------------------------------------------------------------

  private decisionOf(card: Card, response: ProviderPermissionResponse): Decision | { invalid: string } {
    const native = card.native;
    if (native.kind === "tool") return { type: response.behavior === "allow" ? "allow" : "deny" };
    if (response.behavior === "deny") return { type: "chat" };
    const raw = response.updatedInput?.answers;
    const given = isPlainObject(raw) ? raw : {};
    const answers: QuestionAnswer[] = [];
    for (let i = 0; i < native.questions.length; i++) {
      const item = native.questions[i];
      const value = given[card.headers[i]];
      if (typeof value !== "string") {
        if (!item.multi) return { invalid: `No answer was given for "${card.headers[i]}".` };
        answers.push({ id: item.id, selectedOptions: [] });
        continue;
      }
      const parsed = parseAnswer(value, item.options.map((option) => option.label), item.multi);
      if (!item.multi && !parsed.selected.length && !parsed.custom) return { invalid: `No answer was given for "${card.headers[i]}".` };
      answers.push({ id: item.id, selectedOptions: parsed.selected, ...(parsed.custom ? { customInput: parsed.custom } : {}) });
    }
    return { type: "answer", answers };
  }

  /** `session.permission` from Paseo: the user decided in Paseo (or Paseo is acknowledging a decision we made). */
  async respond(permissionId: string, response: ProviderPermissionResponse): Promise<void> {
    const card = this.cards.get(permissionId);
    if (!card || card.state !== "open") { this.emitResolved(permissionId, card); return; }
    const decision = this.decisionOf(card, response);
    if ("invalid" in decision) {
      this.notice("approval-answer-invalid", "warning", "That answer could not be used", `${decision.invalid} The question is shown again.`);
      this.reemit(card);
      return;
    }
    const target = this.target();
    const resolve = this.adapter.resolveApproval;
    card.state = "resolving";
    let result: ResolveResult;
    if (!target || !resolve) result = { type: "rejected", code: "unavailable", message: "The agent cannot be reached right now." };
    else {
      try { result = await resolve.call(this.adapter, target, permissionId, decision, this.session.signal); }
      catch (error) { result = { type: "uncertain", message: messageOf(error) }; }
    }
    if (this.closed || this.session.isAborted) return;
    if (card.state !== "resolving") { this.emitResolved(permissionId, card); return; }
    const seen = card.outcomeSeen;
    if (result.type === "resolved") {
      card.state = "resolved";
      this.record(card, this.rowOf(card, result.outcome.outcome, result.outcome.source, { answer: result.outcome.answer, at: result.outcome.at }));
      this.emitResolved(permissionId, card);
    } else if (result.type === "rejected" && result.code === "already_resolved" && result.outcome) {
      await this.external(card, result.outcome, { inHandler: true });
      if (result.outcome.source !== "paseo") {
        this.noticeOnce("decision-wire", "Paseo shows a generic outcome for a terminal decision",
          "The conversation lists what was decided, but Paseo's own record of this permission may show your click.");
      }
    } else if (result.type === "rejected" && (GONE_REFUSALS.has(result.code) || result.code === "already_resolved")) {
      const note = "Card withdrawn: the agent changed; decide in the terminal";
      await this.withdraw(card, note, note, { inHandler: true });
      this.notice("approval-agent-changed", "warning", "The agent changed", "The agent changed; decide in the terminal.");
      void this.session.live.reconcile();
    } else if (result.type === "rejected") {
      // Refused before anything was written: nothing happened, so the same card comes back.
      this.reemit(card);
      this.notice("approval-not-sent", "warning", "Your decision was not sent",
        `${result.message || "The agent refused it."}${PRE_WRITE_REFUSALS.has(result.code) ? "" : ` (${result.code})`}`);
    } else if (seen) {
      // The write was uncertain but a poll already saw how it ended.
      if (seen.source === "paseo") await this.settleOwn(card, seen);
      else await this.external(card, seen, { inHandler: true });
    } else {
      card.state = "open";
      card.visible = false;
      card.hold = UNCERTAIN_POLLS;
      this.startLoop();
    }
  }
}
