import type {
  ApprovalSnapshot,
  ConfigureResult,
  Decision,
  DecisionOutcome,
  DecisionRecord,
  DecisionSource,
  PendingDecision,
  QuestionAnswer,
  ResolveResult,
  HarnessAdapter,
  HarnessConfig,
  HarnessModel,
  TranscriptLocator,
  TranscriptReader,
  TranscriptSnapshot,
} from "../server/harness/types.js";
import type { AgentSessionRef } from "../server/herdr/schema.js";
import { classifyHerdrPrompt } from "../server/prompt.js";
import type { NativeTurnEnd } from "../server/harness/types.js";
import type { ProviderTimelineItem } from "@getpaseo/plugin/server/provider";

/**
 * Independent id-based fake harness used by `core-is-neutral.test.ts`. It is
 * deliberately unlike OMP: session refs use `kind:"id"` (never a path), the
 * transcript is in-memory, and item ids come from a fake scheme. Core tests
 * that pass with this adapter prove the neutral layer carries no OMP
 * assumptions or harness name literals.
 */
export const FAKE_HARNESS_ID = "fake";

export interface FakeTranscriptEntry {
  id: string;
  kind: "user" | "assistant";
  text: string;
  end?: NativeTurnEnd;
}

/** A mutable in-memory transcript shared with a FakeHerdr `agent.list` reply. */
export class FakeTranscript {
  private entries: FakeTranscriptEntry[] = [];
  readonly listeners = new Set<() => void>();
  get lastEntry(): FakeTranscriptEntry | undefined { return this.entries.at(-1); }
  notify(): void { for (const listener of this.listeners) listener(); }
  readonly nativeSessionKey = "fake-session-1";
  /** P3.5: what the transcript chain records as the last model / thinking level (undefined = nothing recorded). */
  model: string | undefined;
  thinkingLevel: string | null | undefined;

  set(entries: FakeTranscriptEntry[]): void {
    this.entries = [...entries];
  }

  append(entry: FakeTranscriptEntry): void {
    this.entries.push(entry);
  }

  get items(): ProviderTimelineItem[] {
    return this.entries.map((entry) => ({
      id: `fake:${this.nativeSessionKey}:${entry.id}:${entry.kind === "user" ? "user_message" : "assistant_message"}:0`,
      type: entry.kind === "user" ? "user_message" : "assistant_message",
      text: entry.text,
    }));
  }

  ref(): AgentSessionRef {
    return { kind: "id", value: this.nativeSessionKey };
  }
}

export const FAKE_MODELS: readonly HarnessModel[] = [
  { id: "fake/reasoner", label: "Reasoner", provider: "fake", thinkingLevels: ["low", "medium", "high"], defaultThinkingLevel: "medium", contextWindow: 200000 },
  { id: "fake/plain", label: "Plain", provider: "fake", thinkingLevels: [] },
];

/** Mutable live config of the fake agent; tests read the call logs and override responses. */
export class FakeConfig {
  model: string | null = "fake/reasoner";
  thinkingLevel: string | null = "medium";
  models: readonly HarnessModel[] = FAKE_MODELS;
  readError: Error | null = null;
  /** When set, `configure` returns this instead of applying the change. */
  configureOverride: ConfigureResult | null = null;
  /** When set, `configure` waits for it before answering. */
  configureGate: Promise<void> | null = null;
  reads = 0;
  readonly configureCalls: Array<{ model?: string; thinkingLevel?: string }> = [];
  snapshot(): HarnessConfig { return { model: this.model, thinkingLevel: this.thinkingLevel, models: this.models }; }
}

/** Mutable approval state of the fake agent; tests add pending entries, decide them "in the terminal" and read the call logs. */
export class FakeApprovals {
  pending: PendingDecision[] = [];
  outcomes: DecisionRecord[] = [];
  seq = 0;
  /** Report the next snapshot as having dropped outcomes. */
  lost = false;
  /** Answer snapshots with "unsupported" (an older companion). */
  unsupported = false;
  snapshotError: Error | null = null;
  /** When set, `resolveApproval` returns this instead of applying the decision. */
  resolveOverride: ResolveResult | null = null;
  /** When set, `resolveApproval` waits for it first. */
  resolveGate: Promise<void> | null = null;
  readonly snapshotCalls: Array<number | null> = [];
  readonly resolveCalls: Array<{ id: string; decision: Decision }> = [];

  add(entry: PendingDecision): void { this.pending.push(entry); }
  /** A decision made outside Paseo (or by the harness itself). */
  decide(id: string, outcome: DecisionOutcome, source: DecisionSource = "terminal", answer?: QuestionAnswer[]): DecisionRecord {
    const entry = this.pending.find((candidate) => candidate.id === id);
    if (!entry) throw new Error(`no pending ${id}`);
    this.pending = this.pending.filter((candidate) => candidate.id !== id);
    const record: DecisionRecord = { seq: ++this.seq, id, kind: entry.kind, outcome, source, ...(answer ? { answer } : {}), at: "2026-10-14T00:00:00.000Z" };
    this.outcomes.push(record);
    return record;
  }
  snapshot(cursor: number | null): ApprovalSnapshot {
    const lost = this.lost;
    this.lost = false;
    return { pending: structuredClone(this.pending), outcomes: this.outcomes.filter((record) => record.seq > (cursor ?? 0)), cursor: this.seq, lost };
  }
}

/** `config` makes the adapter implement the optional P3.5A readConfig/configure pair. */
export function makeFakeAdapter(transcript?: FakeTranscript, options: { config?: FakeConfig; approvals?: FakeApprovals } = {}): HarnessAdapter {
  const store = transcript ?? new FakeTranscript();
  const live = options.config;
  const configSupport: Pick<HarnessAdapter, "readConfig" | "configure"> = live ? {
    readConfig: async () => {
      live.reads++;
      if (live.readError) throw live.readError;
      return live.snapshot();
    },
    configure: async (_target, changes) => {
      live.configureCalls.push(changes);
      await live.configureGate;
      if (live.configureOverride) return live.configureOverride;
      const model = changes.model ?? live.model;
      const entry = live.models.find((candidate) => candidate.id === model);
      if (!entry) return { type: "rejected", code: "unknown_model", message: `Unknown model ${model}` };
      let level = changes.model !== undefined && changes.thinkingLevel === undefined ? (entry.thinkingLevels.length ? entry.defaultThinkingLevel ?? null : null) : live.thinkingLevel;
      if (changes.thinkingLevel !== undefined) {
        if (!entry.thinkingLevels.length || (changes.thinkingLevel !== "off" && !entry.thinkingLevels.includes(changes.thinkingLevel))) {
          return { type: "rejected", code: "invalid_thinking", message: `${entry.label} does not support ${changes.thinkingLevel}` };
        }
        level = changes.thinkingLevel === "off" ? null : changes.thinkingLevel;
      }
      live.model = entry.id;
      live.thinkingLevel = entry.thinkingLevels.length ? level : null;
      return { type: "configured", config: live.snapshot() };
    },
  } : {};
  const approvals = options.approvals;
  const approvalSupport: Pick<HarnessAdapter, "snapshotApprovals" | "resolveApproval"> = approvals ? {
    snapshotApprovals: async (_target, cursor) => {
      approvals.snapshotCalls.push(cursor);
      if (approvals.snapshotError) throw approvals.snapshotError;
      return approvals.unsupported ? "unsupported" : approvals.snapshot(cursor);
    },
    resolveApproval: async (_target, id, decision) => {
      approvals.resolveCalls.push({ id, decision });
      await approvals.resolveGate;
      if (approvals.resolveOverride) return approvals.resolveOverride;
      const known = approvals.outcomes.find((record) => record.id === id);
      if (known) return { type: "rejected", code: "already_resolved", message: "Already decided", outcome: known };
      if (!approvals.pending.some((entry) => entry.id === id)) return { type: "rejected", code: "unknown_request", message: "Unknown request" };
      const outcome: DecisionOutcome = decision.type === "allow" ? "approved" : decision.type === "deny" ? "denied" : decision.type === "chat" ? "chat" : "answered";
      return { type: "resolved", outcome: approvals.decide(id, outcome, "paseo", decision.type === "answer" ? decision.answers : undefined) };
    },
  } : {};
  return {
    ...configSupport,
    ...approvalSupport,
    id: FAKE_HARNESS_ID,
    label: "Fake",
    herdrIntegration: "fake",
    resolveTranscript: async (ref) =>
      ref?.kind === "id" ? { path: `memory://${ref.value}`, nativeSessionKey: ref.value } : null,
    nativeSessionKey: (ref) => ref.value,
    openTranscript: (locator: TranscriptLocator): TranscriptReader & { notify(): void } => {
      const listeners = store.listeners;
      return {
        async snapshot(): Promise<TranscriptSnapshot> {
          const items = store.items;
          const timestamps: Record<string, string> = {};
          for (const item of items) timestamps[item.id] = "";
          return {
            items,
            timestamps,
            ...(store.model !== undefined ? { model: store.model } : {}),
            ...(store.thinkingLevel !== undefined ? { thinkingLevel: store.thinkingLevel } : {}),
            turnState: !store.lastEntry || store.lastEntry.kind === "assistant" ? "idle" : "working",
            ...(store.lastEntry?.kind === "assistant" ? { lastTurnEnd: store.lastEntry.end ?? "completed", lastTurnEndId: store.lastEntry.id } : {}),
            chainHead: items.at(-1)?.id ?? null,
            chainIds: items.map((item) => item.id),
            extendsPrevious: (previous: TranscriptSnapshot) =>
              previous.chainIds.length === 0 ||
              previous.chainIds.every((id, i) => items[i]?.id === id),
          };
        },
        subscribe(listener: () => void): () => void {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
        notify(): void {
          for (const listener of listeners) listener();
        },
        close() {},
      };
    },
    inspectInput: async ({ pid }) => ({ pid, instanceId: "fake-instance" }),
    submitPrompt: async (target, text, ctx) => {
      const binding = { harness: FAKE_HARNESS_ID, terminalId: target.terminalId, sessionRef: target.ref,
        herdrSession: null, agentName: null, cwd: "/work", submittedMessages: {} };
      try {
        const result = await ctx.request("agent.prompt", { target: target.paneId, text }, { signal: ctx.signal });
        return classifyHerdrPrompt(result, undefined, binding);
      } catch (error) { return classifyHerdrPrompt(undefined, error, binding); }
    },
    interruptKeys: ["ctrl+c"],
    promptWhileWorking: "reject",
    launchArgs: () => [],
    isOccupant: () => true,
    blockedHint: "fake hint",
  };
}
