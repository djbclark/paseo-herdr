import { AgentListResultSchema, type AgentInfo } from "./schema.js";
import type { HerdrRequestFn } from "../harness/types.js";

export interface ListPaneTargetsOptions {
  /** Abort the in-flight `agent.list` request. */
  signal?: AbortSignal;
}

/**
 * The panes Paseo can bind a harness session to: today every `agent.list` entry
 * (any agent kind or none — Herdr lists only agent terminals, so `pane.list`-only
 * plain shells are not included). A later change can merge those shells in here
 * without touching any caller; `agent_status` already tolerates "unknown", which
 * a merged plain-shell entry would carry.
 */
export async function listPaneTargets(request: HerdrRequestFn, opts: ListPaneTargetsOptions = {}): Promise<AgentInfo[]> {
  return AgentListResultSchema.parse(await request("agent.list", {}, { signal: opts.signal })).agents;
}
