/**
 * VENDORED from paseo/packages/server/src/server/agent/agent-sdk-types.ts
 * (commit 804335b). Trimmed to the types the OMP history mapper closure needs.
 * See VENDORED.md for provenance and a list of every retained type.
 */

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export interface AgentTaskItem {
  text: string;
  completed: boolean;
  id?: string;
  status?: "pending" | "in_progress" | "completed";
  activeForm?: string;
}

export const TOOL_CALL_ICON_NAMES = [
  "wrench",
  "square_terminal",
  "eye",
  "pencil",
  "search",
  "bot",
  "sparkles",
  "brain",
  "mic_vocal",
] as const;

export type ToolCallIconName = (typeof TOOL_CALL_ICON_NAMES)[number];

export type ToolCallDetail =
  | { type: "shell"; command: string; cwd?: string; output?: string; exitCode?: number | null }
  | { type: "read"; filePath: string; content?: string; offset?: number; limit?: number }
  | {
      type: "edit";
      filePath: string;
      oldString?: string;
      newString?: string;
      unifiedDiff?: string;
    }
  | { type: "write"; filePath: string; content?: string }
  | {
      type: "search";
      query: string;
      toolName?: "search" | "grep" | "glob" | "web_search";
      content?: string;
      filePaths?: string[];
      webResults?: Array<{ title: string; url: string }>;
      annotations?: string[];
      numFiles?: number;
      numMatches?: number;
      durationMs?: number;
      durationSeconds?: number;
      truncated?: boolean;
      mode?: "content" | "files_with_matches" | "count";
    }
  | {
      type: "fetch";
      url: string;
      prompt?: string;
      result?: string;
      code?: number;
      codeText?: string;
      bytes?: number;
      durationMs?: number;
    }
  | {
      type: "worktree_setup";
      worktreePath: string;
      branchName: string;
      log: string;
      commands: Array<{
        index: number;
        command: string;
        cwd: string;
        log: string;
        status: "running" | "completed" | "failed";
        exitCode: number | null;
        durationMs?: number;
      }>;
      truncated?: boolean;
    }
  | {
      type: "sub_agent";
      subAgentType?: string;
      description?: string;
      childSessionId?: string;
      log: string;
      actions?: Array<{ index: number; toolName: string; summary?: string }>;
    }
  | { type: "plain_text"; label?: string; text?: string; icon?: ToolCallIconName }
  | { type: "plan"; text: string }
  | { type: "unknown"; input: unknown; output: unknown };

export type ToolCallTimelineItem =
  | ({ type: "tool_call"; callId: string; name: string; detail: ToolCallDetail; metadata?: Record<string, unknown> } & {
      status: "running";
      error: null;
    })
  | ({ type: "tool_call"; callId: string; name: string; detail: ToolCallDetail; metadata?: Record<string, unknown> } & {
      status: "completed";
      error: null;
    })
  | ({ type: "tool_call"; callId: string; name: string; detail: ToolCallDetail; metadata?: Record<string, unknown> } & {
      status: "failed";
      error: unknown;
    })
  | ({ type: "tool_call"; callId: string; name: string; detail: ToolCallDetail; metadata?: Record<string, unknown> } & {
      status: "canceled";
      error: null;
    });

export interface CompactionTimelineItem {
  type: "compaction";
  status: "loading" | "completed";
  trigger?: "auto" | "manual";
  preTokens?: number;
}

export interface PluginTimelineItem {
  type: "plugin";
  id: string;
  pluginId: string;
  kind: string;
  version: number;
  data: JsonValue;
}

export type AgentTimelineItem =
  | { type: "user_message"; text: string; messageId?: string; clientMessageId?: string }
  | { type: "assistant_message"; text: string; messageId?: string }
  | { type: "reasoning"; text: string }
  | ToolCallTimelineItem
  | { type: "todo"; items: AgentTaskItem[] }
  | { type: "error"; message: string }
  | { type: "notification"; level: "info" | "warning" | "error"; message: string }
  | CompactionTimelineItem
  | PluginTimelineItem;

export type AgentStreamEvent =
  | { type: "thread_started"; sessionId: string; provider: string }
  | { type: "turn_started"; provider: string; turnId?: string }
  | { type: "turn_completed"; provider: string; turnId?: string }
  | { type: "turn_canceled"; provider: string; reason: string; turnId?: string }
  | { type: "timeline"; item: AgentTimelineItem; provider: string; turnId?: string; timestamp?: string };

/** The subset of AgentStreamEvent produced by the history mapper. */
export type AgentProvider = string;
