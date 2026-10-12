import { readFile } from "node:fs/promises";
import type { OmpAgentMessage } from "./rpc-types.js";
import type { AgentTimelineItem } from "./sdk-types.js";

export interface OmpSessionEntry {
  type?: string;
  id?: string;
  parentId?: string | null;
  timestamp?: string | number;
  message?: Record<string, unknown>;
  [key: string]: unknown;
}

/**
 * Walk the file's last leaf up to the root, reversed. Mirrors OMP's `getBranch()`:
 * the file's last leaf is the active tip because append order follows interaction order.
 */
export async function readActiveOmpEntryChain(
  sessionFile: string,
  activeEntryId?: string,
): Promise<OmpSessionEntry[]> {
  const content = await readFile(sessionFile, "utf8");
  const entries = content.split("\n").flatMap((line) => {
    if (!line.trim()) return [];
    try {
      const value = JSON.parse(line) as OmpSessionEntry;
      return value && typeof value === "object" && typeof value.id === "string" ? [value] : [];
    } catch {
      return [];
    }
  });
  if (entries.length === 0) return [];
  const byId = new Map(entries.map((entry) => [entry.id!, entry]));
  const parentIds = new Set(entries.flatMap((entry) => (entry.parentId ? [entry.parentId] : [])));
  const leaves = entries.filter((entry) => !parentIds.has(entry.id!));
  let current: OmpSessionEntry | undefined =
    (activeEntryId ? byId.get(activeEntryId) : undefined) ?? leaves.at(-1) ?? entries.at(-1);
  const chain: OmpSessionEntry[] = [];
  const seen = new Set<string>();
  while (current?.id && !seen.has(current.id)) {
    chain.push(current);
    seen.add(current.id);
    current = current.parentId ? byId.get(current.parentId) : undefined;
  }
  return chain.slice().reverse();
}

export function isCompactionEntry(entry: OmpSessionEntry): boolean {
  return entry.type === "compaction";
}

export function mapEntryMessage(entry: OmpSessionEntry): OmpAgentMessage | null {
  const message = entry.message;
  if (message && typeof message.role === "string") {
    if (message.role === "system") {
      return null;
    }
    if (message.role === "developer") {
      const content = message.content;
      if (
        Array.isArray(content) &&
        content.length === 1 &&
        content[0]?.type === "text" &&
        typeof content[0].text === "string" &&
        isSystemReminder(content[0].text)
      ) {
        return null;
      }
      return visibleFallback(message.role, message);
    }
    if (["user", "assistant", "toolResult", "custom", "bashExecution"].includes(message.role)) {
      return message as unknown as OmpAgentMessage;
    }
    // OMP roles the live timeline does not render either, such as the fileMention that carries
    // an @-mentioned file's content.
    if (
      [
        "pythonExecution",
        "hookMessage",
        "branchSummary",
        "compactionSummary",
        "fileMention",
      ].includes(message.role)
    ) {
      return null;
    }
    return visibleFallback(message.role, message);
  }
  if (entry.type === "custom_message") {
    return mapCustomMessageEntry(entry);
  }
  if (!entry.type || isControlEntryType(entry.type)) {
    return null;
  }
  return visibleFallback(entry.type, entry);
}

// OMP persists a compaction as a top-level entry; the live timeline shows it as a compaction row.
// The entry does not record whether a manual /compact or auto-compaction produced it.
export function mapCompactionEntry(entry: OmpSessionEntry): AgentTimelineItem {
  return {
    type: "compaction",
    status: "completed",
    ...(typeof entry.tokensBefore === "number" ? { preTokens: entry.tokensBefore } : {}),
  };
}

// omp 18.1+ persists injected rows (skill prompts, hub messages, job notices) as top-level
// custom_message entries without a message object; replay them as live custom messages
function mapCustomMessageEntry(entry: OmpSessionEntry): OmpAgentMessage | null {
  const content = entry.content;
  if (typeof content !== "string" && !Array.isArray(content)) {
    return null;
  }
  return {
    role: "custom",
    content,
    id: entry.id,
    customType: entry.customType,
    display: entry.display,
    details: entry.details,
    attribution: entry.attribution,
  } as OmpAgentMessage;
}

// OMP's rule-violation reminder carries attributes: <system-reminder reason="rule_violation" ...>
function isSystemReminder(text: string): boolean {
  return (
    /^<system-reminder[\s>]/.test(text.trimStart()) && text.trimEnd().endsWith("</system-reminder>")
  );
}

function isControlEntryType(type: string): boolean {
  return (
    type === "session" ||
    type === "session_init" ||
    type === "system" ||
    type === "title" ||
    type === "title_change" ||
    type === "custom" ||
    type === "system_prompt" ||
    type === "model_change" ||
    type === "thinking_level_change" ||
    type === "ttsr_injection" ||
    type === "tool_execution" ||
    type.startsWith("tool_execution_")
  );
}

function visibleFallback(role: string, value: Record<string, unknown>): OmpAgentMessage {
  let text = "Unsupported history record";
  if (typeof value.content === "string") {
    text = value.content;
  } else if (Array.isArray(value.content)) {
    text = textOf(value.content) || text;
  } else if (typeof value.text === "string") {
    text = value.text;
  }
  return { role: "custom", content: `[${role}] ${text}` } as OmpAgentMessage;
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .flatMap((part) =>
      part && typeof part === "object" && typeof (part as { text?: unknown }).text === "string"
        ? [(part as { text: string }).text]
        : [],
    )
    .join("\n");
}
