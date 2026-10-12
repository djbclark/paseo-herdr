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
  extendsPrevious(previous: TranscriptSnapshot): boolean;
}
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
export interface InputTarget { pid: number; ref: AgentSessionRef; }
export interface HarnessAdapter {
  readonly id: string;
  readonly label: string;
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
}

