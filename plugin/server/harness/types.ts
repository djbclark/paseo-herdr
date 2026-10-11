import type { ProviderTimelineItem } from "@getpaseo/plugin/server/provider";
import type { AgentSessionRef } from "../herdr/schema.js";

export interface HarnessAdapter {
  readonly id: string;
  readonly label: string;
  resolveTranscript(ref: AgentSessionRef | null): string | null;
  readTranscript(path: string, nativeKey: string): Promise<ProviderTimelineItem[]>;
  transcriptUpdatedAt(path: string): Promise<string | undefined>;
}
