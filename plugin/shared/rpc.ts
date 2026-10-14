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
  /** Whether the process has its input endpoint (companion); false = read-only until restarted; null = not known. */
  inputReady: z.boolean().nullable(),
  /** An in-place restart (same pane and session) is possible for this harness and agent. */
  canRestart: z.boolean(),
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
    /** Linking Herdr agents to Paseo chats failed; agents still show, but "Open chat" may be missing. */
    chatError: z.string().nullable(),
  }),
});

/** Restart an idle agent in place (same pane and session) so it loads its input companion (R35). */
export const herdrAgentRestartRpc = defineRpc({
  name: "herdr.agent.restart",
  input: z.object({ terminalId: z.string(), paneId: z.string() }),
  output: z.object({ pid: z.number().int() }),
});

/**
 * The client created a chat bound to an existing agent (`herdrBind`) and Paseo is now listening: send its
 * earlier conversation. Paseo drops rows a provider sends before it subscribes to a created chat.
 */
export const herdrChatReadyRpc = defineRpc({
  name: "herdr.chat.ready",
  input: z.object({ terminalId: z.string() }),
  output: z.object({ flushed: z.number().int() }),
});

export const herdrWorkspaceCreateRpc = defineRpc({
  name: "herdr.workspace.create",
  input: z.object({
    cwd: z.string().trim().min(1, "Enter a folder path"),
    label: z.string().trim().max(80).optional(),
  }),
  output: z.object({ workspaceId: z.string(), label: z.string(), cwd: z.string() }),
});

export const folderSourceSchema = z.enum(["herdr", "paseo", "filesystem"]);
export type FolderSource = z.infer<typeof folderSourceSchema>;
export const folderSuggestionSchema = z.object({ path: z.string(), source: folderSourceSchema });
export type FolderSuggestion = z.infer<typeof folderSuggestionSchema>;

/**
 * Folder autocomplete for the Herdr screen's folder fields. The daemon host owns the filesystem and the
 * home directory, so the client asks here (it also uses `resolved` to turn `~/x` into an absolute path).
 */
export const herdrFoldersSuggestRpc = defineRpc({
  name: "herdr.folders.suggest",
  input: z.object({ query: z.string().max(4096) }),
  output: z.object({
    /** Absolute, normalised form of the query (`~` expanded); null when it isn't an absolute path. */
    resolved: z.string().nullable(),
    folders: z.array(folderSuggestionSchema),
  }),
});
