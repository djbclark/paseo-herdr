import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

/**
 * P3.7 management RPC contracts, shared by server handlers (`server.handle`) and the client (`useRpc`).
 * The client never sends a socket path: the server resolves the Herdr target from the host settings.
 *
 * There is no `herdr.agent.start`: "New agent" calls Paseo's own `agents.create` with the
 * `herdr-<harness>` provider. That runs the P3 launch path (new tab in a workspace rooted at the cwd,
 * else a new workspace) and yields a real Paseo chat, which a plugin RPC could not, because the plugin
 * SDK has no agent-import call.
 */

export const agentStatusSchema = z.enum(["idle", "working", "blocked", "done", "unknown"]);
export type HerdrAgentStatus = z.infer<typeof agentStatusSchema>;

/** Where the effective Herdr socket came from, highest priority first. */
export const targetSourceSchema = z.enum(["settingPath", "envPath", "settingSession", "envSession", "default"]);
export type TargetSource = z.infer<typeof targetSourceSchema>;

export const herdrTargetSchema = z.object({
  socketPath: z.string(),
  /** Named Herdr session, or null for the default session. */
  herdrSession: z.string().nullable(),
  source: targetSourceSchema,
  /** True only for an explicitly configured, non-default `herdrSession` setting with no socket override. */
  autoStart: z.boolean(),
  /** Why auto-start is off, for the settings screen; null when `autoStart` is true. */
  autoStartDisabledReason: z.string().nullable(),
});
export type HerdrTarget = z.infer<typeof herdrTargetSchema>;

export const connectionSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("connected"),
    version: z.string(),
    /** True when this plugin process started the Herdr server for this target. */
    autoStarted: z.boolean(),
  }),
  z.object({ status: z.literal("unavailable"), error: z.string() }),
]);
export type HerdrConnection = z.infer<typeof connectionSchema>;

export const overviewAgentSchema = z.object({
  terminalId: z.string(),
  paneId: z.string(),
  /** Herdr agent name (`paseo-xxxxxx` for agents launched from Paseo), if any. */
  name: z.string().nullable(),
  /** Terminal title as reported by Herdr (often the harness prompt plus the conversation title), if any. */
  title: z.string().nullable(),
  /** Herdr agent kind, e.g. `omp`. */
  kind: z.string().nullable(),
  /** Harness label when a registered harness owns this kind, e.g. `OMP`; else null. */
  harness: z.string().nullable(),
  /** Paseo provider id when a registered harness owns this kind, e.g. `herdr-omp`; else null. */
  provider: z.string().nullable(),
  status: agentStatusSchema,
  cwd: z.string().nullable(),
  /** The Paseo agent already bound to this terminal on this target, if any. */
  paseoAgentId: z.string().nullable(),
  attachCommand: z.string(),
  /**
   * Runs the attach without a shell (absolute `herdr` path + args), for a Paseo terminal. Null when the
   * daemon can't find `herdr` on PATH, or when the target is a socket path the Herdr CLI wouldn't reach
   * by session name.
   */
  attach: z.object({ command: z.string(), args: z.array(z.string()) }).nullable(),
});
export type OverviewAgent = z.infer<typeof overviewAgentSchema>;

export const overviewTabSchema = z.object({
  tabId: z.string(),
  number: z.number().int(),
  label: z.string(),
  focused: z.boolean(),
  status: agentStatusSchema,
  agents: z.array(overviewAgentSchema),
});
export type OverviewTab = z.infer<typeof overviewTabSchema>;

export const overviewWorkspaceSchema = z.object({
  workspaceId: z.string(),
  number: z.number().int(),
  label: z.string(),
  focused: z.boolean(),
  /** cwd of the workspace's first pane; null when Herdr reports none. */
  cwd: z.string().nullable(),
  status: agentStatusSchema,
  tabs: z.array(overviewTabSchema),
});
export type OverviewWorkspace = z.infer<typeof overviewWorkspaceSchema>;

/** A Paseo chat owned by one of this plugin's providers, for the Herdr screen's "Recent chats". */
export const recentChatSchema = z.object({
  paseoAgentId: z.string(),
  title: z.string().nullable(),
  /** Harness label, e.g. `OMP`. */
  harness: z.string(),
  cwd: z.string(),
  /** Paseo's chat status (idle, running, error, closed, …). */
  status: z.string(),
  /** Latest user message or chat update (ISO). */
  lastActivityAt: z.string(),
  attention: z.enum(["finished", "error", "permission"]).nullable(),
  /** Where its Herdr agent runs now on the current target; null when it isn't running there. */
  pane: z.object({ paneId: z.string(), status: agentStatusSchema }).nullable(),
  /** Herdr session the chat is bound to (null = default session); may differ from the current target's. */
  herdrSession: z.string().nullable(),
});
export type RecentChat = z.infer<typeof recentChatSchema>;

export const herdrTargetRpc = defineRpc({
  name: "herdr.target",
  input: z.object({}),
  output: z.object({ target: herdrTargetSchema, ompEnabled: z.boolean() }),
});

export const herdrOverviewRpc = defineRpc({
  name: "herdr.overview",
  input: z.object({}),
  output: z.object({
    target: herdrTargetSchema,
    ompEnabled: z.boolean(),
    connection: connectionSchema,
    /** Empty when the connection is unavailable. */
    workspaces: z.array(overviewWorkspaceSchema),
    /** Most recent first, at most 20; archived chats are left out. */
    chats: z.array(recentChatSchema),
    /** A chat-list failure must not look like an empty history. */
    chatError: z.string().nullable(),
  }),
});

export const herdrWorkspaceCreateRpc = defineRpc({
  name: "herdr.workspace.create",
  input: z.object({
    cwd: z.string().trim().min(1, "Enter a folder path"),
    label: z.string().trim().max(80).optional(),
  }),
  output: z.object({ workspaceId: z.string(), label: z.string(), cwd: z.string() }),
});
