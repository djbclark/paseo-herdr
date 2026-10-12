import { open, readdir, stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { NativeFork, TranscriptLocator } from "../types.js";

/** Header lines are small, but the title row ahead of them is padded; 4 KiB covers both. */
const HEADER_BYTES = 4096;
const HEADER_LINES = 3;
/** Forks are created after our file; a margin absorbs coarse timestamps and clock skew. */
const MTIME_MARGIN_MS = 60_000;
const MAX_CANDIDATES = 2000;

interface SessionHeader { id: string; parentSession?: string }

async function readHeader(path: string): Promise<SessionHeader | null> {
  let handle;
  try {
    handle = await open(path, "r");
    const buffer = Buffer.alloc(HEADER_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, HEADER_BYTES, 0);
    const lines = buffer.toString("utf8", 0, bytesRead).split("\n").slice(0, HEADER_LINES);
    for (const line of lines) {
      try {
        const value = JSON.parse(line) as { type?: unknown; id?: unknown; parentSession?: unknown };
        if (value && value.type === "session" && typeof value.id === "string") {
          return { id: value.id, ...(typeof value.parentSession === "string" ? { parentSession: value.parentSession } : {}) };
        }
      } catch {
        // partial last line (cut at the byte bound) or garbage: keep looking
      }
    }
    return null;
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => {});
  }
}

/**
 * Sibling session files whose header `parentSession` names our session (R23: a
 * later writer to a claimed file moves to a new file). Reads only each
 * candidate's first bytes; unreadable files are ignored.
 */
export async function findOmpForks(locator: TranscriptLocator, signal?: AbortSignal): Promise<NativeFork[]> {
  const own = await readHeader(locator.path);
  if (!own) return [];
  const dir = dirname(locator.path);
  let names: string[];
  let floor = 0;
  try {
    names = (await readdir(dir)).filter((name) => name.endsWith(".jsonl"));
    const info = await stat(locator.path);
    const born = info.birthtimeMs > 0 ? info.birthtimeMs : info.ctimeMs;
    floor = born - MTIME_MARGIN_MS;
  } catch {
    return [];
  }
  const forks: NativeFork[] = [];
  for (const name of names.slice(0, MAX_CANDIDATES)) {
    if (signal?.aborted) break;
    const path = join(dir, name);
    if (path === locator.path || name === basename(locator.path)) continue;
    try {
      if ((await stat(path)).mtimeMs < floor) continue;
    } catch {
      continue;
    }
    const header = await readHeader(path);
    if (header?.parentSession === own.id && header.id !== own.id) forks.push({ path, sessionId: header.id });
  }
  return forks;
}
