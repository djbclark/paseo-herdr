import { COMPANION_INSTALL_NAME, COMPANION_INSTALL_STEP, LEGACY_COMPANION_NAME } from "../shared/companion.js";
import { cleanTitle } from "../shared/labels.js";
import type { CompanionStatus, Diagnostics, HerdrAgentStatus, HerdrTarget } from "../shared/rpc.js";

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

/** The part of an overview agent row the archive re-check reads. */
interface DuplicateRow {
  terminalId: string;
  paneId: string;
  paseoAgentId: string | null;
  duplicateChatIds: readonly string[];
}

export type DuplicateArchivePlan =
  | { skip: null; archive: string[] }
  | { skip: "agent-gone" | "owner-changed" | "none-left"; archive: [] };

/**
 * Re-check an "Archive duplicate chats" tap against a fresh overview before archiving anything. Only ids
 * the user was shown AND the fresh row still lists as duplicates are archived, and only when the same
 * terminal and pane still has the same owner chat: if the owner changed (another chat became the newest)
 * the shown list may now contain the chat in use, so nothing is archived.
 */
export function freshDuplicatesToArchive(
  shown: DuplicateRow,
  workspaces: readonly { tabs: readonly { agents: readonly DuplicateRow[] }[] }[],
): DuplicateArchivePlan {
  const fresh = workspaces
    .flatMap((workspace) => workspace.tabs.flatMap((tab) => tab.agents))
    .find((agent) => agent.terminalId === shown.terminalId && agent.paneId === shown.paneId);
  if (!fresh) return { skip: "agent-gone", archive: [] };
  if (fresh.paseoAgentId !== shown.paseoAgentId) return { skip: "owner-changed", archive: [] };
  const stillShown = new Set(duplicateChatsToArchive(shown));
  const archive = duplicateChatsToArchive(fresh).filter((id) => stillShown.has(id));
  return archive.length === 0 ? { skip: "none-left", archive: [] } : { skip: null, archive };
}

/** Toast text when the re-check archived nothing. */
export function duplicateArchiveSkippedMessage(skip: Exclude<DuplicateArchivePlan["skip"], null>): string {
  switch (skip) {
    case "agent-gone":
      return "Nothing archived: this agent is no longer listed.";
    case "owner-changed":
      return "Nothing archived: the agent's chat changed since this list was shown. Check the row and try again.";
    case "none-left":
      return "Nothing archived: those duplicate chats are already gone.";
  }
}

/**
 * Toast text for a partly failed archive, with the first rejection's reason; null when every archive
 * worked (or none was tried).
 */
export function archiveFailureMessage(results: readonly PromiseSettledResult<unknown>[]): string | null {
  const rejected = results.filter((result): result is PromiseRejectedResult => result.status === "rejected");
  if (rejected.length === 0) return null;
  return `Couldn't archive ${rejected.length} of ${results.length} duplicate chats: ${errorMessage(rejected[0]!.reason)}`;
}

/** Button text for archiving `count` duplicate chats. */
export function archiveDuplicatesLabel(count: number): string {
  return `Archive ${count} duplicate ${count === 1 ? "chat" : "chats"}`;
}

/**
 * Warning for the top of the Herdr screen when the OMP input companion isn't current; null when there is
 * nothing to warn about (current, or OMP turned off). It names the command, never runs it.
 */
export function companionBanner(companion: CompanionStatus | undefined, ompEnabled: boolean): string | null {
  if (!companion || !ompEnabled || companion.state === "current") return null;
  const where = companion.path ? ` (${companion.path})` : "";
  switch (companion.state) {
    case "missing":
      return `The OMP input companion isn't installed, so OMP agents open read-only. To install it, ${COMPANION_INSTALL_STEP}, then restart your OMP agents.`;
    case "outdated":
      // Only the pre-rename file is reported by path: it is either alone or next to a current companion (two would be active).
      return companion.path?.endsWith(LEGACY_COMPANION_NAME)
        ? `The old OMP input companion ${LEGACY_COMPANION_NAME}${where} is still installed; OMP loads every file in that directory, so it must be replaced by ${COMPANION_INSTALL_NAME}. To fix it, ${COMPANION_INSTALL_STEP}, then restart your OMP agents.`
        : `The OMP input companion is outdated${where}. To update it, ${COMPANION_INSTALL_STEP}, then restart your OMP agents.`;
    case "foreign":
      return `A file that isn't this plugin's companion is in the way${where}. Inspect it; to replace it, run \`node scripts/install-omp-companion.mjs --force\` from the installed plugin directory, then restart your OMP agents.`;
    case "unknown":
      return "Couldn't check the OMP input companion (for example OMP's extensions directory is unreadable). See Troubleshooting: Companion missing, outdated or foreign.";
  }
}

/** The text "Copy diagnostics" puts on the clipboard (and shows when the clipboard isn't available). */
export function diagnosticsText(diagnostics: Diagnostics): string {
  return JSON.stringify(diagnostics, null, 2);
}
