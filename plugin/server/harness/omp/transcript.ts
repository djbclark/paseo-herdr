import { readFile, stat } from "node:fs/promises";
import type { ProviderTimelineItem } from "@getpaseo/plugin/server/provider";

export async function ompTranscriptUpdatedAt(path: string): Promise<string | undefined> {
  try {
    const { mtime } = await stat(path);
    return mtime.getTime() > 0 && Number.isFinite(mtime.getTime()) ? mtime.toISOString() : undefined;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

/**
 * Reader for OMP (oh-my-pi) session JSONL transcripts.
 *
 * A transcript is a JSONL file: a leading `title` row (no id), a `session`
 * header row (id, no parentId-derived parent), then entries linked by
 * `id`/`parentId`. Entries form a tree when the session was forked or
 * branched in place; the conversation to replay is the active chain: the
 * walk from the file's last leaf up to the root, reversed.
 *
 * Item ids are namespaced by the caller (`<namespace>:<entryId>:<kind>:<n>`)
 * so the same native entry always produces the same id for a given session
 * identity, and two native sessions never collide.
 *
 * Phase 0 scope: plain user/assistant text only. Thinking parts, tool
 * calls/results, and control rows (title, session, model_change, custom,
 * ...) are skipped; the vendored mapper replaces them in Phase 1.
 */

interface OmpSessionEntry {
  id: string;
  type?: unknown;
  parentId?: unknown;
  message?: unknown;
}

export async function readOmpTranscript(
  path: string,
  namespace: string,
): Promise<ProviderTimelineItem[]> {
  if (typeof namespace !== "string" || namespace.length === 0) {
    throw new TypeError("readOmpTranscript: namespace must be a non-empty string");
  }

  let content: string;
  try {
    content = await readFile(path, "utf8");
  } catch (error) {
    // R10: Herdr reports the session path before OMP creates the file.
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }

  const entries = parseEntries(content);
  const chain = activeChain(entries);
  const items: ProviderTimelineItem[] = [];
  for (const entry of chain) {
    const item = textItem(entry, namespace);
    if (item) items.push(item);
  }
  return items;
}

/** Parse JSONL, skipping blank lines and torn/lost rows (in-place rewrites can truncate the tail). */
function parseEntries(content: string): OmpSessionEntry[] {
  const entries: OmpSessionEntry[] = [];
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let value: unknown;
    try {
      value = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (isSessionEntry(value)) entries.push(value);
  }
  return entries;
}

function isSessionEntry(value: unknown): value is OmpSessionEntry {
  return (
    typeof value === "object" && value !== null && "id" in value && typeof value.id === "string"
  );
}

/**
 * Walk from the last leaf (no other entry lists it as parent) to the root,
 * with guards for missing parents, cycles, and duplicate ids. Mirrors
 * OMP's `getBranch()`: the file's last leaf is the active tip because
 * append order follows interaction order.
 */
function activeChain(entries: readonly OmpSessionEntry[]): OmpSessionEntry[] {
  if (entries.length === 0) return [];
  const byId = new Map<string, OmpSessionEntry>();
  for (const entry of entries) byId.set(entry.id, entry);
  const parentIds = new Set<string>();
  for (const entry of entries) {
    if (typeof entry.parentId === "string") parentIds.add(entry.parentId);
  }
  const canonical = [...byId.values()];
  const leaves = canonical.filter((entry) => !parentIds.has(entry.id));
  let current: OmpSessionEntry | undefined = leaves.at(-1) ?? canonical.at(-1);
  const seen = new Set<string>();
  const chain: OmpSessionEntry[] = [];
  while (current && !seen.has(current.id)) {
    chain.push(current);
    seen.add(current.id);
    current = typeof current.parentId === "string" ? byId.get(current.parentId) : undefined;
  }
  return chain.reverse();
}

/** User/assistant text parts as one namespaced item per entry; empty-text and other roles skip. */
function textItem(entry: OmpSessionEntry, namespace: string): ProviderTimelineItem | null {
  if (typeof entry.type !== "string" || entry.type !== "message") return null;
  const message = entry.message;
  if (!message || typeof message !== "object") return null;
  const role = "role" in message && typeof message.role === "string" ? message.role : undefined;
  const text = textOf("content" in message ? message.content : undefined);
  if (text.length === 0) return null;
  if (role === "user") {
    return { id: `${namespace}:${entry.id}:user_message:0`, type: "user_message", text };
  }
  if (role === "assistant") {
    return { id: `${namespace}:${entry.id}:assistant_message:0`, type: "assistant_message", text };
  }
  return null;
}

/** Concatenate string/text-part content the way Paseo's OMP mapper does. */
function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const texts: string[] = [];
  for (const part of content) {
    if (typeof part === "object" && part !== null && "text" in part) {
      const text = part.text;
      if (typeof text === "string") texts.push(text);
    }
  }
  return texts.join("\n");
}