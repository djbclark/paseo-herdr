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
    if (!message || typeof message !== "object") continue;
    if (message.role === "user" || message.role === "toolResult") return undefined;
    if (message.role === "assistant") return mapStopReason(message.stopReason);
  }
  return undefined;
}

function mapStopReason(stopReason: unknown): NativeTurnEnd {
  if (typeof stopReason !== "string") return "unknown";
  if (stopReason === "aborted") return "aborted";
  if (stopReason === "error") return "error";
  return stopReason === "stop" || stopReason === "length" ? "completed" : "unknown";
}

export function turnStateOf(chain: readonly OmpSessionEntry[]): "idle" | "working" | "unknown" {
  for (let index = chain.length - 1; index >= 0; index--) {
    const entry = chain[index];
    if (entry.type !== "message" || !entry.message) continue;
    const message = entry.message;
    if (message.role === "user" || message.role === "toolResult") return "working";
    if (message.role === "assistant") {
      const end = mapStopReason(message.stopReason);
      return end === "unknown" ? (message.stopReason === "toolUse" ? "working" : "unknown") : "idle";
    }
  }
  return "idle";
}

export function lastTurnEndIdOf(chain: readonly OmpSessionEntry[]): string | undefined {
  for (let index = chain.length - 1; index >= 0; index--) {
    const entry = chain[index];
    if (entry.type !== "message" || !entry.message) continue;
    if (entry.message.role === "user" || entry.message.role === "toolResult") return undefined;
    if (entry.message.role === "assistant") return entry.id;
  }
  return undefined;
}

/** Last user-selected model (`provider/id`): model_change entries with role absent or "default" (fallback/temporary roles are ignored). */
export function modelOf(chain: readonly OmpSessionEntry[]): string | undefined {
  // OMP's own rule (getRestorableSessionModels, session/session-context.ts:121 in 18.4.12): the role of the
  // LAST model_change decides. "default" and "fallback" (a retry fallback) mean the latest default model; any
  // other role, e.g. "temporary" from the session-only picker (Alt+P, /switch), is the active model itself.
  const models = new Map<string, string>();
  let lastRole: string | undefined;
  for (const raw of chain) {
    const entry = raw as Record<string, unknown>;
    if (entry.type !== "model_change" || typeof entry.model !== "string" || entry.model.length === 0) continue;
    lastRole = typeof entry.role === "string" ? entry.role : "default";
    models.set(lastRole, entry.model);
  }
  if (lastRole === undefined) return undefined;
  return lastRole === "default" || lastRole === "fallback" ? models.get("default") : models.get(lastRole) ?? models.get("default");
}

/** Last thinking_level_change on the chain (`null` = off/cleared); undefined when none was recorded. */
export function thinkingLevelOf(chain: readonly OmpSessionEntry[]): string | null | undefined {
  for (let index = chain.length - 1; index >= 0; index--) {
    const entry = chain[index] as Record<string, unknown>;
    if (entry.type !== "thinking_level_change") continue;
    if (entry.thinkingLevel === null || typeof entry.thinkingLevel === "string") return entry.thinkingLevel;
  }
  return undefined;
}
