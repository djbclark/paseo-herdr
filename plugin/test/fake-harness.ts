import type {
  HarnessAdapter,
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
