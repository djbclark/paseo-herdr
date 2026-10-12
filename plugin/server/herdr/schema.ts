import { z } from "zod";

/**
 * Herdr JSON wire schemas (herdr/src/api/schema/*.rs, tagged by `type` in
 * snake_case; responses carry `{id, result:{type,...}}` or `{id, error}`).
 *
 * Two event naming shapes exist on the wire (IMPLEMENTATION.md finding 3):
 * - Lifecycle pushes are snake_case `EventEnvelope`s, e.g.
 *   `{"event":"pane_updated","data":{"type":"pane_updated","pane":{…}}}`.
 * - Per-pane subscription pushes keep dotted names, e.g.
 *   `{"event":"pane.agent_status_changed","data":{"pane_id":…,"agent_status":…}}`.
 */

export const agentStatusSchema = z.enum(["idle", "working", "blocked", "done", "unknown"]);
export type AgentStatus = z.infer<typeof agentStatusSchema>;

/** Session identity shared by bindings/persistence (kind + value only). */
export interface AgentSessionRef {
  kind: "path" | "id";
  value: string;
}

/** Wire `agent_session` shape (herdr/src/api/schema/agents.rs: AgentSessionInfo). */
export const agentSessionInfoSchema = z.object({
  source: z.string(),
  agent: z.string(),
  kind: z.enum(["path", "id"]),
  value: z.string(),
});
export type AgentSessionInfo = z.infer<typeof agentSessionInfoSchema>;

export const AgentInfoSchema = z.object({
  terminal_id: z.string(),
  name: z.string().nullish(),
  agent: z.string().nullish(),
  title: z.string().nullish(),
  terminal_title: z.string().nullish(),
  terminal_title_stripped: z.string().nullish(),
  display_agent: z.string().nullish(),
  agent_status: agentStatusSchema,
  screen_detection_skipped: z.boolean().default(false),
  state_labels: z.record(z.string(), z.string()).default({}),
  tokens: z.record(z.string(), z.string()).default({}),
  agent_session: agentSessionInfoSchema.nullish(),
  workspace_id: z.string(),
  tab_id: z.string(),
  pane_id: z.string(),
  focused: z.boolean(),
  launch_pending: z.boolean().default(false),
  interactive_ready: z.boolean().default(false),
  state_change_seq: z.number().int().nonnegative().default(0),
  completion_seq: z.number().int().nonnegative().nullish(),
  cwd: z.string().nullish(),
  foreground_cwd: z.string().nullish(),
  revision: z.number().int().nonnegative(),
});
export type AgentInfo = z.infer<typeof AgentInfoSchema>;

export const PaneInfoSchema = z.object({
  pane_id: z.string(),
  terminal_id: z.string(),
  workspace_id: z.string(),
  tab_id: z.string(),
  focused: z.boolean(),
  cwd: z.string().nullish(),
  foreground_cwd: z.string().nullish(),
  restore_error: z.string().nullish(),
  label: z.string().nullish(),
  agent: z.string().nullish(),
  title: z.string().nullish(),
  terminal_title: z.string().nullish(),
  terminal_title_stripped: z.string().nullish(),
  display_agent: z.string().nullish(),
  agent_status: agentStatusSchema,
  state_labels: z.record(z.string(), z.string()).default({}),
  tokens: z.record(z.string(), z.string()).default({}),
  agent_session: agentSessionInfoSchema.nullish(),
  scroll: z
    .object({
      offset_from_bottom: z.number().int().nonnegative(),
      max_offset_from_bottom: z.number().int().nonnegative(),
      viewport_rows: z.number().int().nonnegative(),
    })
    .nullish(),
  revision: z.number().int().nonnegative(),
});
export type PaneInfo = z.infer<typeof PaneInfoSchema>;

export const paneProcessInfoProcessSchema = z.object({
  pid: z.number().int().nonnegative(),
  name: z.string(),
  argv0: z.string().nullish(),
  argv: z.array(z.string()).nullish(),
  cmdline: z.string().nullish(),
  cwd: z.string().nullish(),
});
export type PaneProcessInfoProcess = z.infer<typeof paneProcessInfoProcessSchema>;

export const PaneProcessInfoSchema = z.object({
  pane_id: z.string(),
  shell_pid: z.number().int().nonnegative().nullish(),
  foreground_process_group_id: z.number().int().nonnegative().nullish(),
  tty: z.string().nullish(),
  foreground_processes: z.array(paneProcessInfoProcessSchema).default([]),
});
export type PaneProcessInfo = z.infer<typeof PaneProcessInfoSchema>;

export const PingResultSchema = z.object({
  type: z.literal("pong"),
  version: z.string(),
  protocol: z.number().int(),
  capabilities: z.unknown().optional(),
});
export type PingResult = z.infer<typeof PingResultSchema>;

export const integrationStateSchema = z.enum(["not_installed", "current", "outdated"]);
export type IntegrationState = z.infer<typeof integrationStateSchema>;

export const IntegrationInfoSchema = z.object({
  target: z.string(),
  label: z.string(),
  command: z.string(),
  available: z.boolean(),
  state: integrationStateSchema,
});
export type IntegrationInfo = z.infer<typeof IntegrationInfoSchema>;

export const IntegrationListResultSchema = z.object({
  type: z.literal("integration_list"),
  integrations: z.array(IntegrationInfoSchema),
});
export type IntegrationListResult = z.infer<typeof IntegrationListResultSchema>;

export const AgentListResultSchema = z.object({
  type: z.literal("agent_list"),
  agents: z.array(AgentInfoSchema),
});
export type AgentListResult = z.infer<typeof AgentListResultSchema>;

export const AgentInfoResultSchema = z.object({
  type: z.literal("agent_info"),
  agent: AgentInfoSchema,
});
export type AgentInfoResult = z.infer<typeof AgentInfoResultSchema>;

export const AgentPromptedResultSchema = z.object({
  type: z.literal("agent_prompted"),
  agent: AgentInfoSchema,
});
export type AgentPromptedResult = z.infer<typeof AgentPromptedResultSchema>;

export const PaneProcessInfoResultSchema = z.object({
  type: z.literal("pane_process_info"),
  process_info: PaneProcessInfoSchema,
});
export type PaneProcessInfoResult = z.infer<typeof PaneProcessInfoResultSchema>;

/* ---- subscription / lifecycle event shapes ---- */

export const paneAgentStatusChangedSchema = z.object({
  pane_id: z.string(),
  workspace_id: z.string(),
  agent_status: agentStatusSchema,
  agent: z.string().nullish(),
  title: z.string().nullish(),
  display_agent: z.string().nullish(),
  state_labels: z.record(z.string(), z.string()).default({}),
});

/** Dotted per-pane subscription push: `{"event":"pane.agent_status_changed","data":{…}}`. */
export const subscriptionAgentStatusChangedSchema = z.object({
  event: z.literal("pane.agent_status_changed"),
  data: paneAgentStatusChangedSchema,
});

/** Snake_case lifecycle push: `{"event":"pane_agent_status_changed","data":{"type":"pane_agent_status_changed",…}}`. */
export const lifecycleAgentStatusChangedSchema = z.object({
  event: z.literal("pane_agent_status_changed"),
  data: z.object({
    type: z.literal("pane_agent_status_changed"),
    pane_id: z.string(),
    workspace_id: z.string(),
    agent_status: agentStatusSchema,
    agent: z.string().nullish(),
    title: z.string().nullish(),
    display_agent: z.string().nullish(),
    state_labels: z.record(z.string(), z.string()).default({}),
  }),
});

export const lifecyclePaneUpdatedSchema = z.object({
  event: z.literal("pane_updated"),
  data: z.object({ type: z.literal("pane_updated"), pane: PaneInfoSchema }),
});

export const lifecyclePaneMovedSchema = z.object({
  event: z.literal("pane_moved"),
  data: z.object({
    type: z.literal("pane_moved"),
    previous_pane_id: z.string(),
    previous_workspace_id: z.string(),
    previous_tab_id: z.string(),
    pane: PaneInfoSchema,
    created_workspace: z.unknown().nullish(),
    created_tab: z.unknown().nullish(),
    closed_workspace_id: z.string().nullish(),
    closed_tab_id: z.string().nullish(),
  }),
});

export const lifecyclePaneAgentDetectedSchema = z.object({
  event: z.literal("pane_agent_detected"),
  data: z.object({
    type: z.literal("pane_agent_detected"),
    pane_id: z.string(),
    workspace_id: z.string(),
    agent: z.string().nullish(),
    released: z.boolean().default(false),
    final_status: agentStatusSchema.nullish(),
  }),
});

export const subscriptionScrollChangedSchema = z.object({
  event: z.literal("pane.scroll_changed"),
  data: z.object({
    pane_id: z.string(),
    workspace_id: z.string(),
    scroll: z.object({
      offset_from_bottom: z.number().int().nonnegative(),
      max_offset_from_bottom: z.number().int().nonnegative(),
      viewport_rows: z.number().int().nonnegative(),
    }),
  }),
});

/** Any single line pushed on an `events.subscribe` stream (both naming shapes). */
export const subscriptionEventSchema = z.union([
  subscriptionAgentStatusChangedSchema,
  subscriptionScrollChangedSchema,
  lifecycleAgentStatusChangedSchema,
  lifecyclePaneUpdatedSchema,
  lifecyclePaneMovedSchema,
  lifecyclePaneAgentDetectedSchema,
  // Passthrough for events this phase does not interpret but must not drop.
  z.object({
    event: z.string(),
    data: z.unknown(),
  }),
]);
export type SubscriptionEvent = z.infer<typeof subscriptionEventSchema>;

export interface HerdrResult {
  type: string;
  [key: string]: unknown;
}
