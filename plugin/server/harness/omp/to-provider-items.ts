import type { ProviderTimelineItem, ProviderToolCallDetail } from "@getpaseo/plugin/server/provider";
import { OmpHistoryMapper, type OmpCapturedUserMessageEntry } from "./vendor/message-history.js";
import { OMP_HISTORY_MAPPER_HOOKS } from "./vendor/history-hooks.js";
import { mapCompactionEntry, mapEntryMessage, type OmpSessionEntry } from "./vendor/history.js";
import { normalizeProviderReplayTimestamp } from "./vendor/provider-history-timestamps.js";
import type { AgentTimelineItem } from "./vendor/sdk-types.js";
import type { JsonValue } from "./vendor/sdk-types.js";
import type { OmpAgentMessage } from "./vendor/rpc-types.js";

type ReplayEntry =
  | { entry: OmpSessionEntry; message: OmpAgentMessage }
  | { entry: OmpSessionEntry; item: AgentTimelineItem };

/**
 * Non-content telemetry rows OMP appends to the chain but never renders in its
 * own TUI (`credential_pin`, `model_usage`, `service_tier_change`). They carry
 * no message/`content`/`text`, so the vendored `mapEntryMessage` would surface
 * them as `[<type>] Unsupported history record`; faithful replay skips them.
 */
const SKIPPED_TELEMETRY_TYPES: Readonly<Record<string, true>> = {
  credential_pin: true,
  model_usage: true,
  service_tier_change: true,
};

function isSkippedTelemetry(entry: OmpSessionEntry): boolean {
  return entry.type !== undefined && entry.type in SKIPPED_TELEMETRY_TYPES;
}

export interface MappedOmpChain {
  items: ProviderTimelineItem[];
  timestamps: Record<string, string>;
}

/**
 * Map one active chain through the vendored OMP history mapper and assign
 * stable provider timeline ids. Tool rows use `<namespace>:tool:<callId>` so
 * the `running` (assistant toolCall) and terminal (toolResult) states share an
 * id and reconcile as one row; every other row is
 * `<namespace>:<entryId>:<kind>:<n>`, which keeps the Phase 0 text ids
 * (`…:user_message:0`, `…:assistant_message:0`) byte-for-byte identical.
 */
export function mapChainToProviderItems(
  chain: readonly OmpSessionEntry[],
  namespace: string,
): MappedOmpChain {
  const replayEntries: ReplayEntry[] = [];
  const userEntries: OmpCapturedUserMessageEntry[] = [];
  for (const entry of chain) {
    if (entry.type === "compaction") {
      replayEntries.push({ entry, item: mapCompactionEntry(entry) });
      continue;
    }
    if (isSkippedTelemetry(entry)) continue;
    const message = mapEntryMessage(entry);
    if (!message) continue;
    replayEntries.push({ entry, message });
    if (message.role === "user" && typeof entry.id === "string") {
      userEntries.push({ id: entry.id, text: "" });
    }
  }

  const mapper = new OmpHistoryMapper("omp", userEntries, OMP_HISTORY_MAPPER_HOOKS);
  const items: ProviderTimelineItem[] = [];
  const timestamps: Record<string, string> = {};
  const indexOfId = new Map<string, number>();

  for (const replayEntry of replayEntries) {
    const entryId = replayEntry.entry.id;
    if (typeof entryId !== "string") continue;
    const timestamp = normalizeProviderReplayTimestamp(replayEntry.entry.timestamp) ?? undefined;
    const mappedItems: AgentTimelineItem[] =
      "item" in replayEntry
        ? [replayEntry.item]
        : mapper
            .mapMessages([replayEntry.message])
            .flatMap((event) => (event.type === "timeline" ? [event.item] : []));
    const counters = new Map<string, number>();
    for (const item of mappedItems) {
      const id = stableId(namespace, entryId, item, counters);
      const providerItem = toProviderItem(id, item);
      // A tool call spans two native entries: the assistant toolCall
      // (`running`) and the toolResult entry (`completed`/`failed`). The native
      // toolCallId is only unique within one assistant message — OMP reuses
      // ids like `ollama:0:bash` across turns — so the stable tool id is
      // `:tool:<callId>` under the *assistant* entry id namespace: the paired
      // rows reconcile to one id, and two executions never collide.
      const toolAssistantEntryId = "item" in replayEntry ? undefined :
        resolveToolAssistantEntryId(replayEntry.message, replayEntries);
      const finalId = providerItem.type === "tool_call" && collapsedCallId(item) && toolAssistantEntryId
        ? `${namespace}:${toolAssistantEntryId}:tool:${collapsedCallId(item)}` : id;
      const collapsed = finalId !== id ? toProviderItem(finalId, item) : providerItem;
      const existing = indexOfId.get(finalId);
      if (existing !== undefined && items[existing].type === "tool_call" && collapsed.type === "tool_call") {
        items[existing] = collapsed;
      } else {
        indexOfId.set(finalId, items.length);
        items.push(collapsed);
      }
      if (timestamp) timestamps[finalId] = timestamp;
    }
  }

  return { items, timestamps };
}

/**
 * The toolResult entry names its tool call but not the assistant entry that
 * issued it. Resolve the origin by chain position: the assistant toolCall whose
 * *most recent* occurrence precedes this toolResult in replay order. OMP
 * reuses ids like `ollama:0:bash` across turns, so a global last-match would
 * bind earlier results to later assistants.
 */
function resolveToolAssistantEntryId(
  message: OmpAgentMessage,
  replayEntries: readonly ReplayEntry[],
): string | undefined {
  if (message.role !== "toolResult") return undefined;
  const mine = replayEntries.findIndex(
    (candidate) => "message" in candidate && candidate.message === message,
  );
  if (mine < 0) return undefined;
  let origin: string | undefined;
  for (let index = 0; index < mine; index++) {
    const candidate = replayEntries[index];
    if ("item" in candidate || candidate.message.role !== "assistant" || typeof candidate.entry.id !== "string") continue;
    for (const content of candidate.message.content ?? []) {
      if (content.type === "toolCall" && content.id === message.toolCallId) origin = candidate.entry.id;
    }
  }
  return origin;
}

function collapsedCallId(item: AgentTimelineItem): string | undefined {
  return item.type === "tool_call" ? item.callId : undefined;
}

function stableId(
  namespace: string,
  entryId: string,
  item: AgentTimelineItem,
  counters: Map<string, number>,
): string {
  // The native toolCallId is only unique within one assistant message; OMP
  // reuses ids like `ollama:0:bash` across turns. Namespace the tool id by its
  // assistant entry so the same id never maps two different tool executions.
  if (item.type === "tool_call") return `${namespace}:${entryId}:tool:${item.callId}`;
  const index = counters.get(item.type) ?? 0;
  counters.set(item.type, index + 1);
  return `${namespace}:${entryId}:${item.type}:${index}`;
}

function toProviderItem(id: string, item: AgentTimelineItem): ProviderTimelineItem {
  switch (item.type) {
    case "user_message":
      return { id, type: "user_message", text: item.text };
    case "assistant_message":
      return { id, type: "assistant_message", text: item.text };
    case "reasoning":
      return { id, type: "reasoning", text: item.text };
    case "tool_call":
      return item.status === "failed"
        ? {
            id,
            type: "tool_call" as const,
            callId: item.callId,
            name: item.name,
            detail: item.detail as ProviderToolCallDetail,
            ...(item.metadata === undefined
              ? {}
              : { metadata: item.metadata as Readonly<Record<string, JsonValue>> }),
            status: "failed" as const,
            error: item.error as JsonValue,
          }
        : {
            id,
            type: "tool_call" as const,
            callId: item.callId,
            name: item.name,
            detail: item.detail as ProviderToolCallDetail,
            ...(item.metadata === undefined
              ? {}
              : { metadata: item.metadata as Readonly<Record<string, JsonValue>> }),
            status: item.status as "running" | "completed" | "canceled",
            error: null,
          };
    case "todo":
      return { id, type: "todo", items: item.items };
    case "error":
      return { id, type: "error", message: item.message };
    case "notification":
      return { id, type: "notification", level: item.level, message: item.message };
    case "compaction":
      return {
        id,
        type: "compaction",
        status: item.status,
        ...(item.trigger === undefined ? {} : { trigger: item.trigger }),
        ...(item.preTokens === undefined ? {} : { preTokens: item.preTokens }),
      };
    case "plugin":
      return {
        id,
        type: "plugin",
        pluginId: item.pluginId,
        kind: item.kind,
        version: item.version,
        data: item.data,
      };
  }
}
