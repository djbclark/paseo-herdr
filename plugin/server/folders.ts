import { readdir, stat } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import type { FolderSuggestion } from "../shared/rpc.js";

export const BLANK_LIMIT = 15;
export const TYPED_LIMIT = 20;

/** Expand a leading `~` or `~/` to the given home directory; anything else is returned unchanged. */
export function expandHome(path: string, home: string): string {
  if (path === "~") return home;
  if (path.startsWith("~/")) return join(home, path.slice(2));
  return path;
}

/** Absolute, normalised form of a (home-expanded) query, or null when it isn't absolute. */
export function resolveQuery(query: string, home: string): string | null {
  const expanded = expandHome(query.trim(), home);
  return expanded && isAbsolute(expanded) ? resolve(expanded) : null;
}

/** Split an absolute path into the directory to list and the (possibly empty) name prefix being typed. */
export function splitParent(expanded: string): { parent: string; segment: string } {
  if (expanded.endsWith("/")) return { parent: expanded, segment: "" };
  const slash = expanded.lastIndexOf("/");
  return { parent: expanded.slice(0, slash + 1) || "/", segment: expanded.slice(slash + 1) };
}

async function listDirectories(parent: string, segment: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(parent, { withFileTypes: true });
  } catch {
    return [];
  }
  const needle = segment.toLowerCase();
  const showHidden = segment.startsWith(".");
  const prefix: string[] = [];
  const inner: string[] = [];
  for (const entry of entries) {
    const name = entry.name;
    if (!showHidden && name.startsWith(".")) continue;
    const lower = name.toLowerCase();
    const index = lower.indexOf(needle);
    if (index < 0) continue;
    const isDir = entry.isDirectory() || (entry.isSymbolicLink() && (await stat(join(parent, name)).then((s) => s.isDirectory(), () => false)));
    if (!isDir) continue;
    (index === 0 ? prefix : inner).push(name);
  }
  const byName = (a: string, b: string) => a.toLowerCase().localeCompare(b.toLowerCase()) || a.localeCompare(b);
  return [...prefix.sort(byName), ...inner.sort(byName)].map((name) => join(parent, name));
}

/**
 * Suggestions for the folder fields. `known` are folders Herdr or Paseo already use (most relevant first).
 * Does at most one readdir; never throws for missing or unreadable directories.
 */
export async function suggestFolders(query: string, home: string, known: readonly FolderSuggestion[]): Promise<{ resolved: string | null; folders: FolderSuggestion[] }> {
  const trimmed = query.trim();
  const dedupe = (items: readonly FolderSuggestion[], limit: number) => {
    const seen = new Set<string>();
    const out: FolderSuggestion[] = [];
    for (const item of items) {
      if (seen.has(item.path)) continue;
      seen.add(item.path);
      out.push(item);
      if (out.length >= limit) break;
    }
    return out;
  };
  if (!trimmed) return { resolved: null, folders: dedupe(known, BLANK_LIMIT) };
  const resolved = resolveQuery(trimmed, home);
  let expanded = expandHome(trimmed, home);
  if (trimmed === "~") expanded = `${home.replace(/\/$/, "")}/`;
  const needle = expanded.replace(/\/+$/, "").toLowerCase();
  const knownMatches = known.filter((item) => item.path.toLowerCase().includes(needle));
  if (!isAbsolute(expanded)) return { resolved, folders: dedupe(knownMatches, TYPED_LIMIT) };
  const { parent, segment } = splitParent(expanded);
  const onDisk = (await listDirectories(parent, segment)).map((path): FolderSuggestion => ({ path, source: known.find((item) => item.path === path)?.source ?? "filesystem" }));
  return { resolved, folders: dedupe([...onDisk, ...knownMatches], TYPED_LIMIT) };
}
