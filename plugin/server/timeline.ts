import type { ProviderTimelineItem } from "@getpaseo/plugin/server/provider";
import type { TranscriptSnapshot } from "./harness/types.js";

/**
 * Stable-id diffing of reader snapshots → timeline.item rows. The core stores a
 * `Map<itemId, jsonHash>` of the last-emitted items and emits only new or
 * changed rows on the next snapshot. Item content hashes use stable JSON
 * serialisation of the item (minus the caller-supplied correlation fields),
 * and timestamps ride alongside items (never inside them), so a change in
 * `updatedAt` alone does not force a re-emit.
 */

export interface TimelineRow {
  item: ProviderTimelineItem;
  timestamp?: string;
}

export function hashItem(item: ProviderTimelineItem): string {
  return JSON.stringify(item);
}

/**
 * Diff one snapshot against the previously seeded state. Returns changed rows
 * in snapshot order; each returned user row has its `clientMessageId` attached
 * when `submittedMessages` records the association.
 */
export function diffTimeline(
  snapshot: TranscriptSnapshot,
  previous: ReadonlyMap<string, string>,
  submittedMessages: Record<string, string> = {},
): TimelineRow[] {
  const rows: TimelineRow[] = [];
  for (const item of snapshot.items) {
    const hash = hashItem(item);
    if (previous.get(item.id) === hash) continue;
    rows.push({ item: item.type === "user_message" && submittedMessages[item.id]
      ? { ...item, clientMessageId: submittedMessages[item.id] }
      : item,
      timestamp: snapshot.timestamps[item.id] });
  }
  return rows;
}

/**
 * Seed a fresh diff state from a snapshot so the next diff only reports rows
 * that changed since this baseline. Returns the new state and, for callers
 * that also need the rows themselves (e.g. initial replay), the full row list.
 */
export function seedTimeline(
  snapshot: TranscriptSnapshot,
  submittedMessages: Record<string, string> = {},
): { state: ReadonlyMap<string, string>; rows: TimelineRow[] } {
  const state = new Map<string, string>();
  const rows: TimelineRow[] = [];
  for (const item of snapshot.items) {
    state.set(item.id, hashItem(item));
    rows.push({ item: item.type === "user_message" && submittedMessages[item.id]
      ? { ...item, clientMessageId: submittedMessages[item.id] }
      : item,
      timestamp: snapshot.timestamps[item.id] });
  }
  return { state, rows };
}

/** Empty diff state for a session with no readable transcript yet. */
export function emptyTimelineState(): ReadonlyMap<string, string> {
  return new Map<string, string>();
}
