import { cleanTitle } from "../shared/labels.js";
import type { HerdrAgentStatus, HerdrTarget } from "../shared/rpc.js";

/** Pure helpers for the Herdr client UI (no React, no React Native). */

/** Paseo provider id of the OMP harness; "New agent" launches through it. */
export const HERDR_OMP_PROVIDER = "herdr-omp";
export const OVERVIEW_SCREEN_ID = "herdr-overview";

export const OVERVIEW_QUERY_KEY = ["herdr", "overview"] as const;
export const TARGET_QUERY_KEY = ["herdr", "target"] as const;
export const OVERVIEW_REFETCH_MS = 4000;

const STATUS_LABELS: Record<HerdrAgentStatus, string> = {
  idle: "Idle",
  working: "Working",
  blocked: "Blocked",
  done: "Done",
  unknown: "Unknown",
};

export function statusLabel(status: HerdrAgentStatus): string {
  return STATUS_LABELS[status];
}

export type StatusTone = "success" | "warning" | "danger" | "muted" | "accent";

export function statusTone(status: HerdrAgentStatus): StatusTone {
  switch (status) {
    case "working":
      return "accent";
    case "blocked":
      return "warning";
    case "done":
      return "success";
    case "idle":
    case "unknown":
      return "muted";
  }
}

export function describeTarget(target: HerdrTarget): string[] {
  const lines = [`Socket: ${target.socketPath}`];
  lines.push(target.herdrSession ? `Session: ${target.herdrSession}` : "Session: default");
  lines.push(target.autoStart ? "Auto-start: on" : "Auto-start: off");
  return lines;
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === "string" && error) return error;
  return "Something went wrong";
}

/** Returns an error for an unusable folder path, else null. The server validates authoritatively (and expands a leading `~`). */
export function validateFolder(path: string): string | null {
  return path.trim() ? null : "Enter a folder path";
}

/** Short label for a path: its last segment. */
export function pathTail(path: string): string {
  const parts = path.split(/[\\/]+/).filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

/** Readable agent label, the same one Paseo's Import session sheet shows (see shared/labels.ts). */
export function agentLabel(agent: { title: string | null; name: string | null; kind: string | null; terminalId: string }): string {
  return cleanTitle(agent.title) ?? agent.name ?? agent.kind ?? agent.terminalId;
}

/** The value a picked suggestion puts in the field: the path plus "/" so the user can keep drilling down. */
export function folderFieldValue(path: string): string {
  return path.endsWith("/") ? path : `${path}/`;
}

/** True when the daemon must expand the text (`~`, `~/x`) before it can be used as an absolute path. */
export function needsHomeExpansion(folder: string): boolean {
  const trimmed = folder.trim();
  return trimmed === "~" || trimmed.startsWith("~/");
}

export const FOLDER_SOURCE_LABELS = { herdr: "Herdr", paseo: "Paseo", filesystem: "" } as const;
export const FOLDER_SUGGEST_DEBOUNCE_MS = 150;
export const folderSuggestKey = (query: string) => ["herdr", "folders", query] as const;

/**
 * Chats to archive for a row's "Archive duplicate chats" action: the server's duplicate list
 * without the row's primary chat (the one the row opens), de-duplicated, in order.
 */
export function duplicateChatsToArchive(agent: { paseoAgentId: string | null; duplicateChatIds: readonly string[] }): string[] {
  const ids = new Set<string>();
  for (const id of agent.duplicateChatIds) if (id && id !== agent.paseoAgentId) ids.add(id);
  return [...ids];
}

/** Button text for archiving `count` duplicate chats. */
export function archiveDuplicatesLabel(count: number): string {
  return `Archive ${count} duplicate ${count === 1 ? "chat" : "chats"}`;
}
