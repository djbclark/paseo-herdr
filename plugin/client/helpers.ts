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

/** Returns an error for an unusable folder path, else null. The server validates authoritatively. */
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

/** Compact relative time ("now", "5m ago", "3h ago", "2d ago"); an unparsable date returns "". */
export function timeAgo(iso: string, now: number = Date.now()): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return "";
  const minutes = Math.max(0, Math.floor((now - then) / 60_000));
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? `${hours}h ago` : `${Math.floor(hours / 24)}d ago`;
}

const ATTENTION_LABELS = { permission: "Needs approval", error: "Error", finished: "Finished" } as const;
export function attentionLabel(reason: keyof typeof ATTENTION_LABELS | null): string | null {
  return reason ? ATTENTION_LABELS[reason] : null;
}
