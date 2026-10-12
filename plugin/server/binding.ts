import { z } from "zod";
import type { ProviderPersistence, ProviderTimelineItem } from "@getpaseo/plugin/server/provider";
import type { HarnessAdapter } from "./harness/types.js";
import type { AgentInfo, AgentSessionRef } from "./herdr/schema.js";

export const PERSISTENCE_VERSION = 1;
export const MAX_SUBMITTED_MESSAGES = 256;

/**
 * Native session binding captured at open and carried in persistence. The
 * `sessionRef` is the full wire shape (source/agent are deterministic from the
 * adapter id and are reconstructed on parse); persistence serialises only
 * `{ kind, value }` per the P1 persistence contract.
 */
export interface Binding {
  harness: string;
  herdrSession: string | null;
  terminalId: string;
  agentName: string | null;
  sessionRef: AgentSessionRef | null;
  cwd: string;
  submittedMessages: Record<string, string>;
}

/** The `{kind, value}` session identity from a wire agent (strips `source`/`agent`). */
export function sessionRefOf(agent: AgentInfo): AgentSessionRef | null {
  return agent.agent_session ? { kind: agent.agent_session.kind, value: agent.agent_session.value } : null;
}

export function bindingOf(agent: AgentInfo, adapter: HarnessAdapter, herdrSession: string | null): Binding {
  return {
    harness: adapter.id,
    herdrSession,
    terminalId: agent.terminal_id,
    agentName: agent.name ?? null,
    sessionRef: sessionRefOf(agent),
    cwd: agent.cwd ?? agent.foreground_cwd ?? "",
    submittedMessages: {},
  };
}

/** Keep only the most recent N entries by insertion order. */
export function capSubmittedMessages(submitted: Record<string, string>): Record<string, string> {
  const keys = Object.keys(submitted);
  if (keys.length <= MAX_SUBMITTED_MESSAGES) return { ...submitted };
  const out: Record<string, string> = {};
  for (const key of keys.slice(keys.length - MAX_SUBMITTED_MESSAGES)) out[key] = submitted[key];
  return out;
}

export function persistenceOf(binding: Binding): ProviderPersistence {
  return {
    version: PERSISTENCE_VERSION,
    data: {
      harness: binding.harness,
      herdrSession: binding.herdrSession,
      terminalId: binding.terminalId,
      agentName: binding.agentName,
      sessionRef: binding.sessionRef ? { kind: binding.sessionRef.kind, value: binding.sessionRef.value } : null,
      cwd: binding.cwd,
      submittedMessages: capSubmittedMessages(binding.submittedMessages),
    },
  };
}

export function parseBinding(persistence: ProviderPersistence, adapter: HarnessAdapter): Binding {
  if (persistence.version !== PERSISTENCE_VERSION) throw new Error("Invalid Herdr session persistence version");
  const parsed = z.object({
    harness: z.string(),
    herdrSession: z.string().nullable().default(null),
    terminalId: z.string().min(1),
    agentName: z.string().nullable(),
    cwd: z.string(),
    sessionRef: z.object({ kind: z.enum(["path", "id"]), value: z.string().min(1) }).nullable(),
    submittedMessages: z.record(z.string(), z.string()).default({}),
  }).parse(persistence.data);
  if (parsed.harness !== adapter.id) throw new Error("Herdr session belongs to another harness");
  return {
    harness: parsed.harness,
    herdrSession: parsed.herdrSession,
    terminalId: parsed.terminalId,
    agentName: parsed.agentName,
    sessionRef: parsed.sessionRef ? { kind: parsed.sessionRef.kind, value: parsed.sessionRef.value } : null,
    cwd: parsed.cwd,
    submittedMessages: capSubmittedMessages(parsed.submittedMessages),
  };
}

export function sameRef(a: { kind: string; value: string } | null, b: { kind: string; value: string } | null): boolean {
  return a?.kind === b?.kind && a?.value === b?.value;
}

/** Attach the optimistic `clientMessageId` to a committed native user row. */
export function correlateItem(item: ProviderTimelineItem, submittedMessages: Record<string, string>): ProviderTimelineItem {
  if (item.type !== "user_message") return item;
  const clientMessageId = submittedMessages[item.id];
  return clientMessageId ? { ...item, clientMessageId } : item;
}

/**
 * Locate the currently-live occupant for a binding. `terminal_id` anchors the
 * pane; the harness and native session identity must both still match the
 * binding captured at open (path fallback is handled by the caller, never here
 * — a first-of-several path match would be an unsafe guess).
 */
export function findBound(agents: readonly AgentInfo[], binding: Binding, adapter: HarnessAdapter): AgentInfo | null {
  const agent = agents.find((candidate) => candidate.terminal_id === binding.terminalId);
  if (!agent || agent.agent !== adapter.id) return null;
  if (!sameRef(binding.sessionRef, sessionRefOf(agent))) return null;
  return agent;
}
