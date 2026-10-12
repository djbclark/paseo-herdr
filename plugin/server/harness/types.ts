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
  lastTurnEnd?: NativeTurnEnd;
  extendsPrevious(previous: TranscriptSnapshot): boolean;
}
export interface TranscriptReader {
  snapshot(): Promise<TranscriptSnapshot>;
  close(): void;
}
export interface HarnessAdapter {
  readonly id: string;
  readonly label: string;
  readonly herdrIntegration: string;
  resolveTranscript(ref: AgentSessionRef | null, ctx: { cwd: string }): Promise<TranscriptLocator | null>;
  nativeSessionKey(ref: AgentSessionRef): string;
  openTranscript(locator: TranscriptLocator): TranscriptReader;
  readonly interruptKeys: readonly string[];
  readonly promptWhileWorking: "reject";
  launchArgs(config: ProviderSessionConfig): string[];
  isOccupant(proc: PaneProcessInfo): boolean;
  readonly blockedHint: string;
}

