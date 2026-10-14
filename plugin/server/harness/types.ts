import type { ProviderSessionConfig, ProviderTimelineItem } from "@getpaseo/plugin/server/provider";
import type { AgentSessionRef, PaneProcessInfo } from "../herdr/schema.js";

export type NativeTurnEnd = "completed" | "aborted" | "error" | "unknown";
export interface TranscriptLocator { path: string; nativeSessionKey: string; }
export interface TranscriptSnapshot {
  items: ProviderTimelineItem[];
  timestamps: Readonly<Record<string, string>>;
  title?: string;
  updatedAt?: string;
  chainHead: string | null;
  chainIds: readonly string[];
  /** Native state, never inferred from the last display row. */
  turnState: "idle" | "working" | "unknown";
  lastTurnEnd?: NativeTurnEnd;
  lastTurnEndId?: string;
  /** P3.5: last user-selected model (`provider/id`) from the active chain; undefined when the chain records none. */
  model?: string;
  /** P3.5: last recorded thinking level (`null` = off/cleared); undefined when the chain records none (use the live config). */
  thinkingLevel?: string | null;
  extendsPrevious(previous: TranscriptSnapshot): boolean;
}

/** P3.5 model and thinking selection (contract frozen 2026-10-12 from the P3.5 spike). */
export interface HarnessModel {
  /** Exact id Paseo shows and sends back, e.g. `provider/id`. */
  id: string;
  label: string;
  provider: string;
  /** Allowed thinking levels; empty for a model without reasoning. `off` is implied for reasoning models. */
  thinkingLevels: readonly string[];
  defaultThinkingLevel?: string;
  contextWindow?: number;
}
export interface HarnessConfig {
  model: string | null;
  /** Resolved current level (`null` when the model has no reasoning or it is off). */
  thinkingLevel: string | null;
  models: readonly HarnessModel[];
}
export type ConfigureResult =
  | { type: "configured"; config: HarnessConfig }
  | { type: "rejected"; code: string; message: string }
  | { type: "uncertain"; message: string };
export interface ConfigTarget { pid: number; ref: AgentSessionRef; instanceId: string; }

/** P3.6 approvals and questions (contract frozen 2026-10-14). Ids are opaque, harness-issued and never reused. */
export interface PendingApproval {
  id: string;
  kind: "tool";
  toolName: string;
  /** The harness's own dialog title, e.g. `Allow tool: bash`. */
  title: string;
  reason?: string;
  /** Tool arguments; `{ truncated: true }` when too large to ship. */
  args?: unknown;
  approvalMode?: string;
  createdAt: string;
}
export interface PendingQuestionItem {
  id: string;
  question: string;
  header?: string;
  options: { label: string; description?: string }[];
  multi: boolean;
  recommended?: number;
}
export interface PendingQuestion {
  id: string;
  kind: "question";
  toolName: string;
  questions: PendingQuestionItem[];
  createdAt: string;
}
export type PendingDecision = PendingApproval | PendingQuestion;
export type DecisionOutcome = "approved" | "denied" | "answered" | "cancelled" | "timed_out" | "chat";
export type DecisionSource = "paseo" | "terminal" | "system";
export interface QuestionAnswer { id: string; selectedOptions: string[]; customInput?: string; }
export interface DecisionRecord {
  /** Monotonic per harness instance; snapshots return records with `seq > cursor`. */
  seq: number;
  id: string;
  kind: "tool" | "question";
  outcome: DecisionOutcome;
  source: DecisionSource;
  answer?: QuestionAnswer[];
  at: string;
}
export interface ApprovalSnapshot {
  pending: PendingDecision[];
  outcomes: DecisionRecord[];
  cursor: number;
  /** The requested cursor predates the oldest retained outcome: some outcomes were dropped. */
  lost: boolean;
}
export type Decision =
  | { type: "allow" }
  | { type: "deny" }
  | { type: "answer"; answers: QuestionAnswer[] }
  | { type: "chat" };
export type ResolveResult =
  | { type: "resolved"; outcome: DecisionRecord }
  | { type: "rejected"; code: string; message: string; outcome?: DecisionRecord }
  | { type: "uncertain"; message: string };
/** P3.5B: a sibling native session forked off ours by another process. */
export interface NativeFork { path: string; sessionId: string; }
export interface TranscriptReader {
  snapshot(): Promise<TranscriptSnapshot>;
  /** Notify when the underlying transcript may have changed (P2A live sync). */
  subscribe(listener: () => void): () => void;
  close(): void;
}
export type PromptDelivery =
  | { type: "accepted" }
  | { type: "rejected"; message: string }
  | { type: "uncertain"; message: string };
export type RestoredPromptOutcome = "cleared" | "kept" | "unsupported";
export interface InputTarget { pid: number; ref: AgentSessionRef; }
export interface HarnessAdapter {
  readonly id: string;
  readonly label: string;
  /** Plugin-directory-relative path to a self-contained SVG; Paseo shows it beside this harness's chats and import rows. */
  readonly icon?: string;
  readonly herdrIntegration: string;
  resolveTranscript(ref: AgentSessionRef | null, ctx: { cwd: string }): Promise<TranscriptLocator | null>;
  nativeSessionKey(ref: AgentSessionRef): string;
  openTranscript(locator: TranscriptLocator): TranscriptReader;
  /** Process-local input endpoint; identity survives pane moves, not process replacement. */
  inspectInput(target: InputTarget, signal?: AbortSignal): Promise<{ pid: number; instanceId: string }>;
  submitPrompt(target: InputTarget & { instanceId: string; paneId: string; terminalId: string }, text: string, ctx: {
    signal: AbortSignal;
    request(method: string, params?: Record<string, unknown>, options?: { signal?: AbortSignal }): Promise<unknown>;
  }): Promise<PromptDelivery>;
  readonly interruptKeys: readonly string[];
  readonly promptWhileWorking: "reject";
  launchArgs(config: ProviderSessionConfig): string[];
  isOccupant(proc: PaneProcessInfo): boolean;
  readonly blockedHint: string;
  /** Optional: input companion install check; a not-ok result keeps import read-only. */
  inputCompanionStatus?(): Promise<{ ok: boolean; diagnostic?: string }>;
  /** P3.5A: live model/thinking state and the install-wide model list. */
  readConfig?(target: ConfigTarget, signal?: AbortSignal): Promise<HarnessConfig>;
  /** P3.5A: change model and/or thinking level; only while idle; validates exactly, applies nothing on refusal. */
  configure?(target: ConfigTarget, changes: { model?: string; thinkingLevel?: string }, signal?: AbortSignal): Promise<ConfigureResult>;
  /** Optional: arguments that reopen `ref` in a fresh process (in-place restart, R35). Without it the harness can't be restarted from Paseo. */
  resumeArgs?(ref: AgentSessionRef): string[];
  /** Optional: cheap check (no round trip) that process `pid` has its input endpoint; false means it started without the companion. */
  inputReachable?(pid: number): Promise<boolean>;
  /**
   * Optional: a turn Paseo submitted was aborted before the harness recorded it, and the harness may have put the prompt
   * text back into its input box. Clear it only if the box holds exactly `text`; never touch anything else. Called at most
   * once per canceled turn, never retried. "unsupported" = this harness/companion cannot tell (older companion).
   */
  discardRestoredPrompt?(target: InputTarget & { instanceId: string }, text: string, signal?: AbortSignal): Promise<RestoredPromptOutcome>;
  /** P3.5B: sibling sessions whose header names `locator`'s session as their parent (excluding `locator` itself). */
  findForks?(locator: TranscriptLocator, signal?: AbortSignal): Promise<NativeFork[]>;
  /**
   * P3.6: pending approvals/questions plus outcomes after `cursor` (null = from the start). "unsupported" = the
   * companion predates approvals; the session falls back to the terminal-only notice.
   */
  snapshotApprovals?(target: ConfigTarget, cursor: number | null, signal?: AbortSignal): Promise<ApprovalSnapshot | "unsupported">;
  /** P3.6: decide one pending entry. Never retried: refusals are definite only before the write; after it, "uncertain". */
  resolveApproval?(target: ConfigTarget, id: string, decision: Decision, signal?: AbortSignal): Promise<ResolveResult>;
}

