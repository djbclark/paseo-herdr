// paseo-herdr OMP input companion. Installed into OMP's extensions directory by paseo-herdr/plugin (npm run install:omp-companion); do not edit the installed copy.
// All identity, readiness and draft checks, and the public sendUserMessage
// handoff, run synchronously in the TUI process. Draft bytes never leave it.
import net from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

interface NativeRef { kind: "path" | "id"; value: string; }
interface InputContext {
  mode: string;
  hasUI: boolean;
  agent: { kind: string };
  isIdle(): boolean;
  hasPendingMessages(): boolean;
  ui: {
    getEditorText(): unknown;
    setEditorText(text: string): void;
    notify(message: string, type: "error"): void;
    select?: (...args: any[]) => unknown;
    askDialog?: (...args: any[]) => unknown;
  };
  sessionManager: { getSessionFile(): unknown; getSessionId(): unknown };
  models: { list(): unknown; current(): unknown };
}
interface CompanionApi {
  on(
    event: "session_start" | "session_switch" | "session_shutdown" | "tool_call" | "tool_execution_start" | "tool_execution_end" |
      "tool_approval_requested" | "tool_approval_resolved",
    handler: (event: unknown, ctx: InputContext) => void,
  ): void;
  sendUserMessage(content: string): void;
  setModel(model: unknown): Promise<unknown> | unknown;
  getThinkingLevel(): unknown;
  setThinkingLevel(level: string): unknown;
}
interface ModelEntry {
  native: unknown;
  id: string;
  provider: string;
  name: string;
  reasoning: boolean;
  efforts: string[];
  defaultLevel?: string;
  contextWindow: number | null;
}
interface InputState {
  ref: NativeRef | null;
  mode: string;
  hasUI: boolean;
  isMain: boolean;
  isIdle: boolean;
  hasPending: boolean;
  hasDraft: boolean | null;
}

const APPROVAL_MARK = Symbol.for("paseo-herdr.approvals");
const OUTCOME_RING = 64;
const MAX_ARGS_JSON = 16 * 1024;
const MAX_TITLE = 2048;

type DecisionOutcome = "approved" | "denied" | "answered" | "cancelled" | "timed_out" | "chat";
type DecisionSource = "paseo" | "terminal" | "system";
interface QuestionAnswer { id: string; selectedOptions: string[]; customInput?: string; }
interface DecisionRecord {
  seq: number; id: string; kind: "tool" | "question"; outcome: DecisionOutcome; source: DecisionSource;
  answer?: QuestionAnswer[]; at: string;
}
interface QuestionItem {
  id: string; question: string; header?: string; options: { label: string; description?: string }[];
  multi: boolean; recommended?: number;
}
type DecideResult =
  | { type: "resolved"; outcome: DecisionRecord }
  | { type: "rejected"; code: string; message: string };
interface PendingEntry {
  wire: Record<string, unknown> & { id: string; kind: "tool" | "question" };
  toolCallId?: string;
  questions?: QuestionItem[];
  decide(decision: unknown): DecideResult;
  /** Settle with a system/terminal-observed outcome; `approved` is only meaningful for tool entries. */
  settleExternal(outcome: DecisionOutcome, source: DecisionSource): void;
}
interface DialogSpec<T> {
  local(value: T | undefined, signalAborted: boolean): { ret: T | undefined; outcome: DecisionOutcome; source: DecisionSource; answer?: QuestionAnswer[] };
  failOutcome: DecisionOutcome;
  remote(decision: unknown): { ret: T | undefined; outcome: DecisionOutcome; answer?: QuestionAnswer[] } | { refuse: string };
  /** Value returned to OMP when the entry is settled by a system event. */
  systemReturn(outcome: DecisionOutcome): T | undefined;
}

function nativeRef(ctx: InputContext): NativeRef | null {
  try {
    const file = ctx.sessionManager.getSessionFile();
    if (typeof file === "string" && (path.posix.isAbsolute(file) || path.win32.isAbsolute(file))) {
      return { kind: "path", value: file };
    }
    const id = ctx.sessionManager.getSessionId();
    if (typeof id === "string" && id.length > 0) return { kind: "id", value: id };
  } catch { /* Unknown native identity must never admit a prompt. */ }
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Null when the list has an unknown shape; individually malformed entries are unselectable and skipped. */
function readModelList(ctx: InputContext): ModelEntry[] | null {
  try {
    const list = ctx.models.list();
    if (!Array.isArray(list)) return null;
    const models: ModelEntry[] = [];
    for (const item of list as unknown[]) {
      if (!isRecord(item) || typeof item.provider !== "string" || item.provider.length === 0 ||
          typeof item.id !== "string" || item.id.length === 0 || typeof item.reasoning !== "boolean") continue;
      const thinking = isRecord(item.thinking) ? item.thinking : undefined;
      const efforts = Array.isArray(thinking?.efforts)
        ? (thinking.efforts as unknown[]).filter((level): level is string => typeof level === "string" && level.length > 0)
        : [];
      models.push({
        native: item,
        id: `${item.provider}/${item.id}`,
        provider: item.provider,
        name: typeof item.name === "string" && item.name.length > 0 ? item.name : item.id,
        reasoning: item.reasoning,
        efforts,
        ...(typeof thinking?.defaultLevel === "string" && thinking.defaultLevel.length > 0 ? { defaultLevel: thinking.defaultLevel } : {}),
        contextWindow: typeof item.contextWindow === "number" && Number.isFinite(item.contextWindow) ? item.contextWindow : null,
      });
    }
    return models;
  } catch { return null; }
}

/** `undefined` = the API misbehaved; `null` = no current model. */
function readCurrentModel(ctx: InputContext): string | null | undefined {
  try {
    const current = ctx.models.current();
    if (current === undefined || current === null) return null;
    if (isRecord(current) && typeof current.provider === "string" && typeof current.id === "string" &&
        current.provider.length > 0 && current.id.length > 0) return `${current.provider}/${current.id}`;
  } catch { /* fall through */ }
  return undefined;
}

export default function ompInputCompanion(pi: CompanionApi): void {
  // A new extension instance (including an explicit operator reload) invalidates
  // every prior input identity, even when the OS process PID stays the same.
  const instanceId = randomUUID();
  const directory = path.join(os.tmpdir(), `omp-input-${process.pid}`);
  const socketPath = path.join(directory, "sock");
  const connections = new Set<net.Socket>();
  let ctx: InputContext | null = null;
  let server: net.Server | null = null;
  let directoryIdentity: fs.Stats | null = null;
  let socketIdentity: fs.Stats | null = null;
  let started = false;
  let ready = false;
  let configuring = false;

  // ---- P3.6 approvals: shared dialog interception ------------------------------------------------------------------
  const armed = new Map<string, { toolName: string; reason?: string; approvalMode?: string }>();
  const startedArgs = new Map<string, { toolName: string; args: unknown }>();
  let askStarted: { toolCallId: string; args: unknown } | null = null;
  const pending = new Map<string, PendingEntry>();
  const outcomes: DecisionRecord[] = [];
  let seq = 0;
  let counter = 0;

  function record(entry: { id: string; kind: "tool" | "question" }, outcome: DecisionOutcome, source: DecisionSource, answer?: QuestionAnswer[]): DecisionRecord {
    const rec: DecisionRecord = {
      seq: ++seq, id: entry.id, kind: entry.kind, outcome, source,
      ...(answer ? { answer } : {}), at: new Date().toISOString(),
    };
    outcomes.push(rec);
    if (outcomes.length > OUTCOME_RING) outcomes.shift();
    return rec;
  }

  function cappedArgs(args: unknown): unknown {
    if (args === undefined) return undefined;
    try {
      const json = JSON.stringify(args);
      if (json === undefined) return undefined;
      return json.length > MAX_ARGS_JSON ? { truncated: true } : JSON.parse(json);
    } catch { return { truncated: true }; }
  }

  /**
   * One dialog, two deciders. `settled` flips synchronously, so exactly one outcome is ever recorded; the loser is
   * aborted through the combined signal and its late value is ignored.
   */
  function raceDialog<T>(
    wire: PendingEntry["wire"],
    extra: Pick<PendingEntry, "toolCallId" | "questions">,
    run: (signal: AbortSignal) => Promise<T | undefined>,
    userSignal: AbortSignal | undefined,
    spec: DialogSpec<T>,
  ): Promise<T | undefined> {
    return new Promise<T | undefined>((resolve, reject) => {
      const localAbort = new AbortController();
      let settled = false;
      const settle = (outcome: DecisionOutcome, source: DecisionSource, answer: QuestionAnswer[] | undefined, ret: T | undefined): DecisionRecord => {
        settled = true;
        pending.delete(wire.id);
        const rec = record(wire, outcome, source, answer);
        localAbort.abort();
        resolve(ret);
        return rec;
      };
      const entry: PendingEntry = {
        wire, ...extra,
        decide(decision) {
          if (settled) return { type: "rejected", code: "already_resolved", message: "This request was already decided." };
          const result = spec.remote(decision);
          if ("refuse" in result) return { type: "rejected", code: "invalid_decision", message: result.refuse };
          return { type: "resolved", outcome: settle(result.outcome, "paseo", result.answer, result.ret) };
        },
        settleExternal(outcome, source) {
          if (settled) return;
          settle(outcome, source, undefined, spec.systemReturn(outcome));
        },
      };
      pending.set(wire.id, entry);
      const signal = userSignal ? AbortSignal.any([userSignal, localAbort.signal]) : localAbort.signal;
      let promise: Promise<T | undefined>;
      try { promise = run(signal); } catch (error) { promise = Promise.reject(error); }
      promise.then(
        (value) => {
          if (settled) return;
          const local = spec.local(value, userSignal?.aborted === true);
          settle(local.outcome, local.source, local.answer, local.ret);
        },
        (error) => {
          if (settled) return;
          settled = true;
          pending.delete(wire.id);
          record(wire, spec.failOutcome, "system");
          reject(error);
        },
      );
    });
  }

  function claimArmed(toolName: string): { toolCallId: string; reason?: string; approvalMode?: string } | null {
    const claimed = new Set<string>();
    for (const entry of pending.values()) if (entry.toolCallId) claimed.add(entry.toolCallId);
    const free = [...armed].filter(([toolCallId]) => !claimed.has(toolCallId));
    const named = free.find(([, value]) => value.toolName === toolName);
    const chosen = named ?? (armed.size === 1 ? free[0] : undefined);
    return chosen ? { toolCallId: chosen[0], ...(chosen[1].reason !== undefined ? { reason: chosen[1].reason } : {}), ...(chosen[1].approvalMode !== undefined ? { approvalMode: chosen[1].approvalMode } : {}) } : null;
  }

  const TOOL_PREFIX = "Allow tool: ";
  function wrapSelect(original: (...args: any[]) => unknown): (...args: any[]) => unknown {
    const wrapper = function (this: unknown, title: unknown, options: unknown, opts?: { signal?: AbortSignal } & Record<string, unknown>): unknown {
      const isGate = Array.isArray(options) && options.length === 2 && options[0] === "Approve" && options[1] === "Deny" &&
        armed.size > 0 && typeof title === "string" && title.startsWith(TOOL_PREFIX);
      if (!isGate) return Reflect.apply(original, this, [title, options, opts]);
      const toolName = (title as string).slice(TOOL_PREFIX.length).split("\n")[0]?.trim() ?? "";
      const match = claimArmed(toolName);
      const args = match ? cappedArgs(startedArgs.get(match.toolCallId)?.args) : undefined;
      const wire = {
        id: `${instanceId}:${++counter}`, kind: "tool" as const, toolName,
        title: (title as string).slice(0, MAX_TITLE),
        ...(match?.reason !== undefined ? { reason: match.reason } : {}),
        ...(args !== undefined ? { args } : {}),
        ...(match?.approvalMode !== undefined ? { approvalMode: match.approvalMode } : {}),
        createdAt: new Date().toISOString(),
      };
      return raceDialog<string>(
        wire, match ? { toolCallId: match.toolCallId } : {},
        (signal) => Promise.resolve(Reflect.apply(original, this, [title, options, { ...opts, signal }]) as string | undefined),
        opts?.signal,
        {
          local: (value) => value === "Approve"
            ? { ret: value, outcome: "approved", source: "terminal" }
            : { ret: value, outcome: "denied", source: "terminal" },
          failOutcome: "denied",
          remote: (decision) => {
            const type = isRecord(decision) ? decision.type : undefined;
            if (type === "allow") return { ret: "Approve", outcome: "approved" };
            if (type === "deny") return { ret: "Deny", outcome: "denied" };
            return { refuse: "A tool approval accepts only allow or deny." };
          },
          systemReturn: (outcome) => outcome === "approved" ? "Approve" : "Deny",
        },
      );
    };
    Object.defineProperty(wrapper, APPROVAL_MARK, { value: { owner: instanceId, original }, enumerable: false });
    return wrapper;
  }

  function normalizeQuestions(questions: unknown): QuestionItem[] {
    if (!Array.isArray(questions)) return [];
    return questions.map((raw, index): QuestionItem => {
      const q = isRecord(raw) ? raw : {};
      const options = Array.isArray(q.options) ? q.options : [];
      return {
        id: typeof q.id === "string" ? q.id : String(index),
        question: typeof q.question === "string" ? q.question : "",
        ...(typeof q.header === "string" && q.header.length > 0 ? { header: q.header } : {}),
        options: options.flatMap((option) => {
          const o = isRecord(option) ? option : {};
          return typeof o.label === "string"
            ? [{ label: o.label, ...(typeof o.description === "string" && o.description.length > 0 ? { description: o.description } : {}) }]
            : [];
        }),
        multi: q.multi === true,
        ...(typeof q.recommended === "number" && Number.isFinite(q.recommended) ? { recommended: q.recommended } : {}),
      };
    });
  }

  /** Null = invalid. Results carry exactly the keys a terminal answer does (no timedOut, customInput only when present). */
  function remoteSubmit(questions: QuestionItem[], answers: unknown): { results: Record<string, unknown>[]; answer: QuestionAnswer[] } | string {
    if (!Array.isArray(answers) || answers.length !== questions.length) return "The answers must match the questions one to one.";
    const results: Record<string, unknown>[] = [];
    const answer: QuestionAnswer[] = [];
    for (const [index, q] of questions.entries()) {
      const a = answers[index];
      if (!isRecord(a) || a.id !== q.id) return `Answer ${index + 1} does not match question ${q.id}.`;
      if (!Array.isArray(a.selectedOptions) || !a.selectedOptions.every((label) => typeof label === "string")) return `Answer ${q.id} has malformed selectedOptions.`;
      const selected = a.selectedOptions as string[];
      const labels = q.options.map((option) => option.label);
      if (selected.some((label) => !labels.includes(label)) || new Set(selected).size !== selected.length) return `Answer ${q.id} names an unknown or repeated option.`;
      if (a.customInput !== undefined && typeof a.customInput !== "string") return `Answer ${q.id} has a malformed customInput.`;
      const customInput = typeof a.customInput === "string" && a.customInput.length > 0 ? a.customInput : undefined;
      if (!q.multi && selected.length > 1) return `Question ${q.id} accepts one option.`;
      if (!q.multi && selected.length === 0 && customInput === undefined) return `Question ${q.id} needs an option or custom text.`;
      results.push({
        id: q.id, question: q.question, options: labels, multi: q.multi, selectedOptions: [...selected],
        ...(customInput !== undefined ? { customInput } : {}),
      });
      answer.push({ id: q.id, selectedOptions: [...selected], ...(customInput !== undefined ? { customInput } : {}) });
    }
    return { results, answer };
  }

  function wrapAskDialog(original: (...args: any[]) => unknown): (...args: any[]) => unknown {
    const wrapper = function (this: unknown, questions: unknown, opts?: { signal?: AbortSignal } & Record<string, unknown>): unknown {
      if (!askStarted) return Reflect.apply(original, this, [questions, opts]);
      const normalized = normalizeQuestions(questions);
      const wire = {
        id: `${instanceId}:${++counter}`, kind: "question" as const, toolName: "ask",
        questions: JSON.parse(JSON.stringify(normalized)) as QuestionItem[],
        createdAt: new Date().toISOString(),
      };
      return raceDialog<unknown>(
        wire, { toolCallId: askStarted.toolCallId, questions: normalized },
        (signal) => Promise.resolve(Reflect.apply(original, this, [questions, { ...opts, signal }])),
        opts?.signal,
        {
          local: (value, aborted) => {
            if (value === undefined || value === null) return { ret: value, outcome: "cancelled", source: aborted ? "system" : "terminal" };
            if (isRecord(value) && value.kind === "chat") return { ret: value, outcome: "chat", source: "terminal" };
            const results = isRecord(value) && Array.isArray(value.results) ? value.results.filter(isRecord) : [];
            const answer = results.map((r): QuestionAnswer => ({
              id: String(r.id),
              selectedOptions: Array.isArray(r.selectedOptions) ? r.selectedOptions.filter((o): o is string => typeof o === "string") : [],
              ...(typeof r.customInput === "string" && r.customInput.length > 0 ? { customInput: r.customInput } : {}),
            }));
            const timedOut = results.length > 0 && results.every((r) => r.timedOut === true);
            return { ret: value, outcome: timedOut ? "timed_out" : "answered", source: timedOut ? "system" : "terminal", answer };
          },
          failOutcome: "cancelled",
          remote: (decision) => {
            const type = isRecord(decision) ? decision.type : undefined;
            if (type === "chat") return { ret: { kind: "chat" }, outcome: "chat" };
            if (type === "answer" && isRecord(decision)) {
              const built = remoteSubmit(normalized, decision.answers);
              if (typeof built === "string") return { refuse: built };
              return { ret: { kind: "submit", results: built.results }, outcome: "answered", answer: built.answer };
            }
            return { refuse: "A question accepts only an answer or chat." };
          },
          // Never undefined for a live ask: that would make OMP abort the whole turn. Shutdown has no turn to keep.
          systemReturn: (outcome) => outcome === "cancelled" ? undefined : { kind: "chat" },
        },
      );
    };
    Object.defineProperty(wrapper, APPROVAL_MARK, { value: { owner: instanceId, original }, enumerable: false });
    return wrapper;
  }

  function patchDialogs(context: InputContext): void {
    if (context.mode !== "tui" || context.hasUI !== true) return;
    const ui = context.ui;
    try {
      // The descriptor value is the real function; reading ui.select through OMP's per-handler proxy returns a wrapper.
      // NOTE: OMP main adds ui.approve(); once it exists, intercept it instead of select (not implemented for 18.4.x).
      for (const [name, wrap] of [["select", wrapSelect], ["askDialog", wrapAskDialog]] as const) {
        const value = Object.getOwnPropertyDescriptor(ui, name)?.value as ((...args: any[]) => unknown) | undefined;
        if (typeof value !== "function") continue;
        const mark = (value as unknown as Record<symbol, unknown>)[APPROVAL_MARK];
        if (isRecord(mark) && mark.owner === instanceId) continue;
        // A wrapper left by a previous instance of this extension is replaced, never stacked.
        const original = isRecord(mark) && typeof mark.original === "function" ? mark.original as (...args: any[]) => unknown : value;
        (ui as Record<string, unknown>)[name] = wrap(original);
      }
    } catch { /* A UI object we cannot patch simply leaves approvals terminal-only. */ }
  }

  function approvalSnapshot(request: Record<string, unknown>): Record<string, unknown> | string {
    if (request.cursor !== undefined && (typeof request.cursor !== "number" || !Number.isSafeInteger(request.cursor) || request.cursor < 0)) {
      return "The approval cursor must be a non-negative integer.";
    }
    const cursor = typeof request.cursor === "number" ? request.cursor : 0;
    const oldest = outcomes[0]?.seq;
    return {
      type: "approvals",
      pending: [...pending.values()].map((entry) => entry.wire),
      outcomes: outcomes.filter((rec) => rec.seq > cursor),
      cursor: seq,
      lost: oldest !== undefined && cursor + 1 < oldest,
    };
  }

  function approvalResolve(request: Record<string, unknown>, respond: (result: Record<string, unknown>) => void, refuse: (code: string, message: string) => void): void {
    if (typeof request.id !== "string" || request.id.length === 0 || !isRecord(request.decision)) {
      refuse("bad_request", "approval.resolve needs an id and a decision.");
      return;
    }
    const id = request.id;
    const entry = pending.get(id);
    if (!entry) {
      const done = outcomes.find((rec) => rec.id === id);
      if (done) {
        respond({ type: "rejected", code: "already_resolved", message: "This request was already decided.", outcome: done });
        return;
      }
      const prefix = `${instanceId}:`;
      const n = id.startsWith(prefix) ? Number(id.slice(prefix.length)) : NaN;
      if (Number.isSafeInteger(n) && n >= 1 && n <= counter) refuse("not_pending", "This request is no longer pending and its outcome was not retained.");
      else refuse("unknown_request", "This OMP instance never issued that request.");
      return;
    }
    const result = entry.decide(request.decision);
    if (result.type === "resolved") respond({ type: "resolved", outcome: result.outcome });
    else refuse(result.code, result.message);
  }

  function settleAllPending(outcome: DecisionOutcome): void {
    for (const entry of [...pending.values()]) entry.settleExternal(outcome, "system");
  }


  function snapshot(): InputState | null {
    if (!ctx) return null;
    try {
      let hasDraft: boolean | null = null;
      // RPC's inert getEditorText() is not an authoritative editor check.
      if (ctx.mode === "tui" && ctx.hasUI === true && ctx.agent.kind === "main") {
        try {
          const text = ctx.ui.getEditorText();
          if (typeof text === "string") hasDraft = text.length !== 0;
        } catch { /* Unknown editor state is not empty. */ }
      }
      return {
        ref: nativeRef(ctx),
        mode: ctx.mode,
        hasUI: ctx.hasUI,
        isMain: ctx.agent.kind === "main",
        isIdle: ctx.isIdle(),
        hasPending: ctx.hasPendingMessages(),
        hasDraft,
      };
    } catch { return null; }
  }

  function readThinkingLevel(): string | null | undefined {
    try {
      const level = pi.getThinkingLevel();
      return typeof level === "string" ? level : level === undefined || level === null ? null : undefined;
    } catch { return undefined; }
  }

  function wireModel(model: ModelEntry): Record<string, unknown> {
    return {
      id: model.id, provider: model.provider, name: model.name, reasoning: model.reasoning,
      efforts: model.efforts, ...(model.defaultLevel ? { defaultLevel: model.defaultLevel } : {}),
      contextWindow: model.contextWindow,
    };
  }

  function configure(
    request: Record<string, unknown>,
    state: InputState,
    respond: (result: Record<string, unknown>) => void,
    refuse: (code: string, message: string) => void,
  ): void {
    const context = ctx;
    if (!context) { refuse("no_session", "The OMP session state is unavailable."); return; }
    if (state.mode !== "tui" || state.hasUI !== true || state.isMain !== true) {
      refuse("not_interactive", "OMP configuration requires an interactive main TUI session.");
      return;
    }
    if (state.isIdle !== true || configuring) {
      refuse("not_idle", "OMP is working; wait until it is idle before changing the model or thinking level.");
      return;
    }
    if (state.hasPending !== false) {
      refuse("pending_messages", "OMP has pending messages; wait for them to finish before changing the model or thinking level.");
      return;
    }
    const wantsModel = request.model !== undefined;
    const wantsThinking = request.thinkingLevel !== undefined;
    if (!wantsModel && !wantsThinking) { refuse("bad_request", "Nothing to configure."); return; }
    if ((wantsModel && (typeof request.model !== "string" || request.model.length === 0)) ||
        (wantsThinking && (typeof request.thinkingLevel !== "string" || request.thinkingLevel.length === 0))) {
      refuse("bad_request", "Model and thinking level must be non-empty strings.");
      return;
    }
    const models = readModelList(context);
    if (!models) { refuse("config_unavailable", "OMP model state is unavailable."); return; }
    // Exact provider/id match only; never the fuzzy resolver.
    let target: ModelEntry | undefined;
    if (wantsModel) {
      target = models.find((candidate) => candidate.id === request.model);
      if (!target) { refuse("unknown_model", `OMP has no available model ${String(request.model)}.`); return; }
    } else {
      const current = readCurrentModel(context);
      if (current === undefined) { refuse("config_unavailable", "OMP model state is unavailable."); return; }
      target = models.find((candidate) => candidate.id === current);
      if (!target) { refuse("unknown_model", "The current OMP model is not in the available model list."); return; }
    }
    if (wantsThinking) {
      const level = request.thinkingLevel as string;
      if (!target.reasoning) {
        refuse("thinking_unsupported", `${target.id} does not support thinking levels.`);
        return;
      }
      if (level !== "off" && !target.efforts.includes(level)) {
        refuse("invalid_thinking", `${target.id} does not support thinking level ${level}.`);
        return;
      }
    }
    // Everything is validated. No await may separate the idle check above from
    // the first setModel call below.
    const chosen: ModelEntry = target;
    configuring = true;
    void (async () => {
      try {
        if (wantsModel) {
          let applied: unknown;
          try { applied = await pi.setModel(chosen.native); }
          catch {
            respond({ type: "uncertain", message: "OMP failed while switching models; the model may have partly changed. Do not retry automatically." });
            return;
          }
          if (applied !== true) {
            refuse("model_unavailable", `OMP could not switch to ${chosen.id} (no API key or unavailable).`);
            return;
          }
        }
        if (wantsThinking) {
          try { pi.setThinkingLevel(request.thinkingLevel as string); }
          catch {
            respond({ type: "uncertain", message: "OMP failed while setting the thinking level; the configuration may have partly changed." });
            return;
          }
        }
        const model = readCurrentModel(context);
        const thinkingLevel = readThinkingLevel();
        const fresh = readModelList(context);
        if (model === undefined || thinkingLevel === undefined || !fresh) {
          respond({ type: "uncertain", message: "OMP applied the change but its state could not be read back." });
          return;
        }
        if (wantsModel && model !== chosen.id) {
          respond({ type: "uncertain", message: "OMP did not report the requested model after switching." });
          return;
        }
        respond({ type: "configured", model, thinkingLevel, models: fresh.map(wireModel) });
      } finally {
        configuring = false;
      }
    })();
  }

  function handle(value: unknown, socket: net.Socket): void {
    const request = typeof value === "object" && value !== null && !Array.isArray(value)
      ? value as Record<string, unknown> : {};
    const state = snapshot();
    const identity = { nonce: request.nonce, pid: process.pid, instanceId, ref: state?.ref ?? null };
    const respond = (result: Record<string, unknown>) => {
      socket.end(`${JSON.stringify({ ...identity, ...result })}\n`);
    };
    const refuse = (code: string, message: string) => respond({ type: "rejected", code, message });
    const ref = request.ref;
    if (typeof request.nonce !== "string" || request.nonce.length === 0 ||
        (request.op !== "inspect" && request.op !== "submit" && request.op !== "config" && request.op !== "configure" && request.op !== "clearDraft" &&
         request.op !== "approval.snapshot" && request.op !== "approval.resolve") ||
        typeof ref !== "object" || ref === null || Array.isArray(ref)) {
      refuse("bad_request", "Invalid OMP input companion request.");
      return;
    }
    if (request.pid !== process.pid || (request.op !== "inspect" && request.instanceId !== instanceId)) {
      refuse("identity_mismatch", "The OMP input process instance changed; reconnect before sending another prompt.");
      return;
    }
    if (!state) {
      refuse("no_session", "The OMP session state is unavailable.");
      return;
    }
    const expected = ref as Record<string, unknown>;
    if (!state.ref || expected.kind !== state.ref.kind || expected.value !== state.ref.value) {
      refuse("ref_mismatch", "The OMP native session changed; reconnect before sending another prompt.");
      return;
    }
    if (request.op === "inspect") {
      respond({ type: "inspected", ...state });
      return;
    }
    if (request.op === "config") {
      const liveCtx = ctx;
      if (!liveCtx) { refuse("no_session", "The OMP session state is unavailable."); return; }
      const models = readModelList(liveCtx);
      const model = readCurrentModel(liveCtx);
      const thinkingLevel = readThinkingLevel();
      if (!models || model === undefined || thinkingLevel === undefined) {
        refuse("config_unavailable", "OMP model state is unavailable.");
        return;
      }
      respond({ type: "config", model, thinkingLevel, models: models.map(wireModel) });
      return;
    }
    if (request.op === "approval.snapshot") {
      const snap = approvalSnapshot(request);
      if (typeof snap === "string") refuse("bad_request", snap); else respond(snap);
      return;
    }
    if (request.op === "approval.resolve") {
      approvalResolve(request, respond, refuse);
      return;
    }
    if (request.op === "configure") {
      configure(request, state, respond, refuse);
      return;
    }
    if (request.op === "clearDraft") {
      // Esc on a still-queued prompt makes OMP restore the text to the editor. Drop it only if the editor holds exactly the
      // text this plugin submitted (OMP restores a lone queued message verbatim); any other content is the user's.
      if (state.mode !== "tui" || state.hasUI !== true || state.isMain !== true) {
        refuse("not_interactive", "OMP input requires an interactive main TUI session.");
        return;
      }
      if (typeof request.text !== "string" || request.text.length === 0) {
        refuse("empty_text", "Prompt text must not be empty.");
        return;
      }
      const liveCtx = ctx;
      if (!liveCtx) { refuse("no_session", "The OMP session state is unavailable."); return; }
      let current: unknown;
      try { current = liveCtx.ui.getEditorText(); } catch { current = undefined; }
      if (typeof current !== "string") {
        refuse("editor_unknown", "OMP editor state is unavailable; the terminal draft has not been changed.");
        return;
      }
      if (current === "") { respond({ type: "cleared", empty: true }); return; }
      if (current !== request.text) { respond({ type: "kept" }); return; }
      try { liveCtx.ui.setEditorText(""); }
      catch { respond({ type: "kept" }); return; }
      respond({ type: "cleared" });
      return;
    }
    if (configuring) {
      refuse("not_idle", "OMP is applying a model change; wait before sending a prompt.");
      return;
    }
    if (state.mode !== "tui" || state.hasUI !== true || state.isMain !== true) {
      refuse("not_interactive", "OMP input requires an interactive main TUI session.");
      return;
    }
    if (state.isIdle !== true) {
      refuse("not_idle", "OMP is working; wait until it is idle before sending a prompt.");
      return;
    }
    if (state.hasPending !== false) {
      refuse("pending_messages", "OMP has pending messages; wait for them to finish before sending a prompt.");
      return;
    }
    if (state.hasDraft === null) {
      refuse("editor_unknown", "OMP editor state is unavailable; the terminal draft has not been changed.");
      return;
    }
    if (state.hasDraft !== false) {
      refuse("editor_not_empty", "OMP has a terminal draft. Send or remove that draft in the terminal before sending a Paseo prompt; it has not been changed.");
      return;
    }
    if (typeof request.text !== "string" || request.text.length === 0) {
      refuse("empty_text", "Prompt text must not be empty.");
      return;
    }
    // No await, terminal keys, editor mutation, normalization, or template
    // expansion between the authoritative checks above and this exact handoff.
    try {
      pi.sendUserMessage(request.text);
    } catch {
      respond({ type: "uncertain", message: "OMP failed during the prompt handoff; delivery is uncertain. Do not retry automatically." });
      return;
    }
    respond({ type: "accepted" });
  }

  function removeOwnedDirectory(): void {
    if (!directoryIdentity) return;
    try {
      const current = fs.lstatSync(directory);
      if (!current.isDirectory() || current.dev !== directoryIdentity.dev || current.ino !== directoryIdentity.ino) return;
      if (socketIdentity && fs.existsSync(socketPath)) {
        const socket = fs.lstatSync(socketPath);
        if (!socket.isSocket() || socket.dev !== socketIdentity.dev || socket.ino !== socketIdentity.ino) return;
        fs.unlinkSync(socketPath);
      }
      // Never recursively remove a stale or replacement instance's directory.
      fs.rmdirSync(directory);
    } catch { /* Crash remnants or unexpected files stay untouched. */ }
  }

  function closeEndpoint(): void {
    ready = false;
    for (const socket of connections) socket.destroy();
    if (server?.listening) server.close(removeOwnedDirectory);
    else removeOwnedDirectory();
  }

  pi.on("session_start", (_event, context) => {
    ctx = context;
    patchDialogs(context);
    if (started) return;
    started = true;
    try {
      // Exclusive creation: a reused PID never unlinks another instance's
      // endpoint or adopts a directory/symlink it did not create.
      fs.mkdirSync(directory, { mode: 0o700 });
      directoryIdentity = fs.lstatSync(directory);
      fs.chmodSync(directory, 0o700);
      server = net.createServer((socket) => {
        if (!ready) { socket.destroy(); return; }
        connections.add(socket);
        socket.once("close", () => connections.delete(socket));
        socket.on("error", () => { socket.destroy(); });
        socket.setEncoding("utf8");
        socket.setTimeout(3000, () => socket.destroy());
        let buffer = "";
        let handled = false;
        socket.on("data", (chunk: string) => {
          if (handled) return;
          buffer += chunk;
          const newline = buffer.indexOf("\n");
          if (newline < 0) return;
          handled = true;
          let request: unknown;
          try { request = JSON.parse(buffer.slice(0, newline)); }
          catch { socket.end('{"type":"rejected","code":"bad_request","message":"Invalid JSON request."}\n'); return; }
          handle(request, socket);
        });
      });
      server.on("error", () => {
        closeEndpoint();
        ctx?.ui.notify("Paseo OMP input companion could not bind its private socket; this session is read-only. Existing endpoints are left untouched.", "error");
      });
      server.listen(socketPath, () => {
        try {
          socketIdentity = fs.lstatSync(socketPath);
          fs.chmodSync(socketPath, 0o600);
          ready = true;
        } catch {
          closeEndpoint();
          ctx?.ui.notify("Paseo OMP input companion could not secure its private socket; this session is read-only.", "error");
        }
      });
    } catch {
      closeEndpoint();
      ctx.ui.notify("Paseo OMP input companion could not create its private process directory; this session is read-only. Existing endpoints are left untouched.", "error");
    }
  });
  pi.on("session_switch", (_event, context) => {
    ctx = context;
    armed.clear();
    startedArgs.clear();
    askStarted = null;
    patchDialogs(context);
  });
  // The ask tool calls askDialog before tool_execution_start reaches extensions, so tool_call is the earliest signal.
  pi.on("tool_call", (event) => {
    if (isRecord(event) && event.toolName === "ask" && typeof event.toolCallId === "string") {
      askStarted = { toolCallId: event.toolCallId, args: event.input };
    }
  });
  pi.on("tool_execution_start", (event) => {
    if (isRecord(event) && typeof event.toolCallId === "string") {
      startedArgs.set(event.toolCallId, { toolName: String(event.toolName), args: event.args });
    }
  });
  pi.on("tool_execution_end", (event) => {
    if (!isRecord(event) || typeof event.toolCallId !== "string") return;
    startedArgs.delete(event.toolCallId);
    armed.delete(event.toolCallId);
    if (askStarted?.toolCallId === event.toolCallId) askStarted = null;
  });
  pi.on("tool_approval_requested", (event) => {
    if (!isRecord(event) || typeof event.toolCallId !== "string") return;
    armed.set(event.toolCallId, {
      toolName: String(event.toolName),
      ...(typeof event.reason === "string" ? { reason: event.reason } : {}),
      ...(typeof event.approvalMode === "string" ? { approvalMode: event.approvalMode } : {}),
    });
  });
  pi.on("tool_approval_resolved", (event) => {
    if (!isRecord(event) || typeof event.toolCallId !== "string") return;
    armed.delete(event.toolCallId);
    // Normally the dialog already settled and this finds nothing; a still-open pending was decided some other way.
    for (const entry of [...pending.values()]) {
      if (entry.toolCallId === event.toolCallId) entry.settleExternal(event.approved === true ? "approved" : "denied", "system");
    }
  });
  pi.on("session_shutdown", () => {
    settleAllPending("cancelled");
    ctx = null;
    closeEndpoint();
  });
}
