import type { NativeTurnEnd } from "../types.js";
import type { OmpSessionEntry } from "./vendor/history.js";

/**
 * Torn-line-tolerant JSONL parse of an OMP session file. Lines are complete
 * newline-terminated records supplied by the core FileTail; a torn or lost
 * final row (in-place rewrite can truncate the tail) is skipped, never fatal.
 * Title/session/control rows are kept here (they carry no `id`) and filtered
 * later by `activeChain` / `titleOf`.
 */
export function parseOmpEntries(lines: readonly string[]): OmpSessionEntry[] {
  const entries: OmpSessionEntry[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const value = JSON.parse(trimmed) as OmpSessionEntry;
      if (value && typeof value === "object") entries.push(value);
    } catch {
      // torn / lost row — skip
    }
  }
  return entries;
}

/**
 * Walk from the file's last leaf (no other entry lists it as parent) to the
 * root, reversed. Mirrors OMP's `getBranch()`: the file's last leaf is the
 * active tip because append order follows interaction order. Entries without
 * a string `id` (title/session rows) are not part of the tree and are skipped.
 */
export function activeChain(entries: readonly OmpSessionEntry[]): OmpSessionEntry[] {
  const byId = new Map<string, OmpSessionEntry>();
  for (const entry of entries) {
    if (typeof entry.id === "string") byId.set(entry.id, entry);
  }
  const parentIds = new Set<string>();
  for (const entry of entries) {
    if (typeof entry.parentId === "string") parentIds.add(entry.parentId);
  }
  const canonical = [...byId.values()];
  const leaves = canonical.filter((entry) => !parentIds.has(entry.id!));
  let current: OmpSessionEntry | undefined = leaves.at(-1) ?? canonical.at(-1);
  const seen = new Set<string>();
  const chain: OmpSessionEntry[] = [];
  while (current?.id && !seen.has(current.id)) {
    chain.push(current);
    seen.add(current.id);
    current = typeof current.parentId === "string" ? byId.get(current.parentId) : undefined;
  }
  return chain.reverse();
}

/** The title row (`type:"title"`, no id) carries the conversation title. */
export function titleOf(entries: readonly OmpSessionEntry[]): string | undefined {
  const title = entries.find((entry) => entry.type === "title")?.title;
  return typeof title === "string" ? title : undefined;
}

/** Native outcome of the chain's last assistant entry (stopReason → NativeTurnEnd). */
export function lastTurnEndOf(chain: readonly OmpSessionEntry[]): NativeTurnEnd | undefined {
  for (let index = chain.length - 1; index >= 0; index -= 1) {
    const entry = chain[index];
    if (entry.type !== "message") continue;
    const message = entry.message;
    if (!message || typeof message !== "object" || message.role !== "assistant") continue;
    return mapStopReason(message.stopReason);
  }
  return undefined;
}

function mapStopReason(stopReason: unknown): NativeTurnEnd {
  if (typeof stopReason !== "string") return "unknown";
  if (stopReason === "aborted") return "aborted";
  if (stopReason === "error") return "error";
  return "completed";
}
