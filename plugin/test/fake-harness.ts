import type {
  HarnessAdapter,
  TranscriptLocator,
  TranscriptReader,
  TranscriptSnapshot,
} from "../server/harness/types.js";
import type { AgentSessionRef } from "../server/herdr/schema.js";
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
}

/** A mutable in-memory transcript shared with a FakeHerdr `agent.list` reply. */
export class FakeTranscript {
  private entries: FakeTranscriptEntry[] = [];
  readonly nativeSessionKey = "fake-session-1";

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

export function makeFakeAdapter(transcript?: FakeTranscript): HarnessAdapter {
  const store = transcript ?? new FakeTranscript();
  return {
    id: FAKE_HARNESS_ID,
    label: "Fake",
    herdrIntegration: "fake",
    resolveTranscript: async (ref) =>
      ref?.kind === "id" ? { path: `memory://${ref.value}`, nativeSessionKey: ref.value } : null,
    nativeSessionKey: (ref) => ref.value,
    openTranscript: (locator: TranscriptLocator): TranscriptReader => ({
      async snapshot(): Promise<TranscriptSnapshot> {
        const items = store.items;
        const timestamps: Record<string, string> = {};
        for (const item of items) timestamps[item.id] = "";
        return {
          items,
          timestamps,
          chainHead: items.at(-1)?.id ?? null,
          chainIds: items.map((item) => item.id),
          extendsPrevious: (previous: TranscriptSnapshot) =>
            previous.chainIds.length === 0 ||
            previous.chainIds.every((id, i) => items[i]?.id === id),
        };
      },
      close() {},
    }),
    interruptKeys: ["ctrl+c"],
    promptWhileWorking: "reject",
    launchArgs: () => [],
    isOccupant: () => true,
    blockedHint: "fake hint",
  };
}
