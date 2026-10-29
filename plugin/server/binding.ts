import { z } from "zod";
import type { ProviderPersistence, ProviderTimelineItem } from "@getpaseo/plugin/server/provider";
import type { HarnessAdapter } from "./harness/types.js";
import type { AgentInfo, AgentSessionRef } from "./herdr/schema.js";
import { DecisionRowSchema, type DecisionRowData } from "../shared/decision.js";

export const PERSISTENCE_VERSION = 1;
export const MAX_SUBMITTED_MESSAGES = 256;
export const MAX_DECISIONS = 64;

/** A decided approval or question, kept so its timeline row survives a plugin reload (P3.6). */
export interface StoredDecision { id: string; data: DecisionRowData; }

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
  occupant?: { pid: number; tty: string | null; instanceId: string };
  /** Optional, newest last, at most {@link MAX_DECISIONS}. */
  decisions?: StoredDecision[];
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
      ...(binding.occupant ? { occupant: binding.occupant } : {}),
      ...(binding.decisions?.length ? { decisions: binding.decisions.slice(-MAX_DECISIONS) as unknown as ProviderPersistence["data"] } : {}),
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
    occupant: z.object({ pid: z.number().int().positive(), tty: z.string().nullable(), instanceId: z.string().min(1) }).optional(),
    // Rows are cosmetic: a malformed entry is dropped rather than failing the whole binding.
    decisions: z.array(z.unknown()).optional(),
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
    ...(parsed.occupant ? { occupant: parsed.occupant } : {}),
    ...(parsed.decisions ? { decisions: storedDecisionsOf(parsed.decisions) } : {}),
  };
}

const StoredDecisionSchema = z.object({ id: z.string().min(1), data: DecisionRowSchema });
function storedDecisionsOf(raw: unknown[]): StoredDecision[] {
  const out: StoredDecision[] = [];
  for (const entry of raw) {
    const parsed = StoredDecisionSchema.safeParse(entry);
    if (parsed.success) out.push(parsed.data);
  }
  return out.slice(-MAX_DECISIONS);
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
