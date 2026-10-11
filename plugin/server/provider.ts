import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  negotiateProviderCapabilities,
  type ProviderConnection,
  type ProviderEvent,
  type ProviderInput,
  type ProviderPersistence,
  type ProviderRegistration,
  type ProviderTimelineItem,
} from "@getpaseo/plugin/server/provider";
import type { HarnessAdapter } from "./harness/types.js";
import { HerdrClient } from "./herdr/client.js";
import type { AgentInfo, AgentSessionRef } from "./herdr/schema.js";

const CAPABILITIES = ["prompt.message", "session.list", "session.persistence"] as const;
interface Binding {
  harness: string;
  terminalId: string;
  agentName: string | null;
  sessionRef: AgentSessionRef | null;
  cwd: string;
  submittedMessages: Record<string, string>;
}
interface OpenSession { binding: Binding; activeTurn: string | null; }

function bindingOf(agent: AgentInfo, adapter: HarnessAdapter): Binding {
  return {
    harness: adapter.id,
    terminalId: agent.terminal_id,
    agentName: agent.name ?? null,
    sessionRef: agent.agent_session ? { kind: agent.agent_session.kind, value: agent.agent_session.value } : null,
    cwd: agent.cwd ?? agent.foreground_cwd ?? "",
    submittedMessages: {},
  };
}
function persistenceOf(binding: Binding): ProviderPersistence {
  return { version: 1, data: { ...binding, sessionRef: binding.sessionRef ? { ...binding.sessionRef } : null,
    submittedMessages: { ...binding.submittedMessages } } };
}
function parseBinding(persistence: ProviderPersistence, adapter: HarnessAdapter): Binding {
  if (persistence.version !== 1) throw new Error("Invalid Herdr session persistence version");
  const binding = z.object({
    harness: z.string(), terminalId: z.string().min(1), agentName: z.string().nullable(), cwd: z.string(),
    sessionRef: z.object({ kind: z.enum(["path", "id"]), value: z.string().min(1) }).nullable(),
    submittedMessages: z.record(z.string(), z.string()).default({}),
  }).parse(persistence.data);
  if (binding.harness !== adapter.id) throw new Error("Herdr session belongs to another harness");
  return binding;
}
function sameRef(a: AgentSessionRef | null, b: AgentSessionRef | null): boolean {
  return a?.kind === b?.kind && a?.value === b?.value;
}
function findBound(agents: AgentInfo[], binding: Binding, adapter: HarnessAdapter): AgentInfo | null {
  const agent = agents.find((candidate) => candidate.terminal_id === binding.terminalId);
  return agent?.agent === adapter.id && sameRef(binding.sessionRef, bindingOf(agent, adapter).sessionRef) ? agent : null;
}

function correlatedItem(item: ProviderTimelineItem, binding: Binding): ProviderTimelineItem {
  if (item.type !== "user_message") return item;
  const clientMessageId = binding.submittedMessages[item.id];
  return clientMessageId ? { ...item, clientMessageId } : item;
}

export function createHerdrProvider(adapter: HarnessAdapter, getSocketPath: () => Promise<string>): ProviderRegistration {
  const client = async () => new HerdrClient(await getSocketPath());
  return {
    id: `herdr-${adapter.id}`,
    label: `${adapter.label} (Herdr)`,
    description: `Chat with an existing Herdr-managed ${adapter.label} agent`,
    async status() {
      try {
        const response = await (await client()).request("ping", {});
        const ping = z.object({ type: z.literal("pong"), version: z.string() }).parse(response);
        const match = /^(\d+)\.(\d+)\.(\d+)(?:$|[-+])/.exec(ping.version);
        if (!match || match.slice(1).some((part) => !Number.isSafeInteger(Number(part))) ||
            Number(match[1]) === 0 && (Number(match[2]) < 9 || Number(match[2]) === 9 && Number(match[3]) < 3)) {
          return { available: false, diagnostic: "Herdr 0.9.3 or newer required" };
        }
        return { available: true };
      } catch (error) {
        return { available: false, diagnostic: `Herdr unavailable: ${String(error)}` };
      }
    },
    async connect(request) {
      if (!request.versions.includes(1)) throw new Error("Provider protocol version 1 is required");
      const capabilities = negotiateProviderCapabilities(request.capabilities, CAPABILITIES);
      const listeners = new Set<(event: ProviderEvent) => void>();
      const sessions = new Map<string, OpenSession>();
      let closed = false;
      const emit = (event: ProviderEvent) => { if (!closed) for (const listener of listeners) listener(event); };
      const list = async (): Promise<AgentInfo[]> => {
        const result = await (await client()).request("agent.list", {});
        return z.object({ type: z.literal("agent_list"), agents: z.array(z.object({
          terminal_id: z.string(), pane_id: z.string(), agent: z.string().nullish(),
          name: z.string().nullish(), title: z.string().nullish(), cwd: z.string().nullish(),
          foreground_cwd: z.string().nullish(), agent_status: z.enum(["idle", "working", "blocked", "done", "unknown"]),
          agent_session: z.object({ source: z.string(), agent: z.string(), kind: z.enum(["path", "id"]), value: z.string() }).nullish(),
        })) }).parse(result).agents;
      };
      const dispatch = async (input: ProviderInput): Promise<void> => {
        switch (input.type) {
          case "catalog":
            emit({ type: "catalog", requestId: input.requestId, catalog: { models: [], modes: [] } });
            return;
          case "sessions": {
            const agents = (await list()).filter((agent) => agent.agent === adapter.id &&
              (!input.cwd || agent.cwd === input.cwd || agent.foreground_cwd === input.cwd));
            const observedAt = new Date().toISOString();
            const summaries = await Promise.all(agents.slice(0, input.limit).map(async (agent) => {
              const binding = bindingOf(agent, adapter);
              const path = adapter.resolveTranscript(binding.sessionRef);
              return {
                persistence: persistenceOf(binding),
                cwd: agent.cwd ?? agent.foreground_cwd ?? input.cwd ?? "",
                title: agent.title ?? agent.name ?? `${adapter.label} agent`,
                description: path ? undefined : "History unavailable",
                updatedAt: path ? await adapter.transcriptUpdatedAt(path) ?? observedAt : observedAt,
              };
            }));
            emit({ type: "sessions", requestId: input.requestId, sessions: summaries });
            return;
          }
          case "session.open": {
            if (!input.persistence) throw new Error("Import an existing Herdr agent first; creation is not supported yet");
            if (sessions.has(input.sessionId)) throw new Error("Session already open");
            const binding = parseBinding(input.persistence, adapter);
            const agent = findBound(await list(), binding, adapter);
            const current = agent ? { ...bindingOf(agent, adapter), submittedMessages: binding.submittedMessages } : binding;
            const path = adapter.resolveTranscript(current.sessionRef);
            const replay = input.history === "replay" && path
              ? await adapter.readTranscript(path, `${adapter.id}:${current.sessionRef?.value}`) : [];
            sessions.set(input.sessionId, { binding: current, activeTurn: null });
            emit({ type: "session.opened", requestId: input.requestId, sessionId: input.sessionId,
              restoration: "core", capabilities, persistence: persistenceOf(current), cwd: current.cwd || input.config.cwd,
              title: agent?.title ?? agent?.name ?? input.config.title });
            for (const item of replay) emit({ type: "timeline.item", sessionId: input.sessionId, item: correlatedItem(item, current) });
            if (!agent || !path) emit({ type: "session.notice", sessionId: input.sessionId, notice: {
              id: "history-or-agent-unavailable", severity: "warning", title: !agent ? "Herdr agent unavailable" : "History unavailable",
              description: !agent ? "The bound agent is no longer present. This conversation is read-only." :
                "This agent has no readable native transcript; use your terminal for history.",
            } });
            emit({ type: "session.ready", requestId: input.requestId, sessionId: input.sessionId });
            return;
          }
          case "session.prompt": {
            const session = sessions.get(input.sessionId);
            if (!session) throw new Error("Unknown session");
            if (session.activeTurn) throw new Error("Agent is already working");
            if (input.prompt.delivery !== "auto" || input.prompt.input.type !== "message" ||
                input.prompt.input.content.some((part) => part.type !== "text")) throw new Error("Only plain-text messages are supported");
            const text = input.prompt.input.content.filter((part) => part.type === "text").map((part) => part.text).join("\n");
            if (!text.trim()) throw new Error("Prompt cannot be empty");
            const agent = findBound(await list(), session.binding, adapter);
            if (!agent) throw new Error("The Herdr agent binding has changed; input is disabled");
            if (agent.agent_status !== "idle" && agent.agent_status !== "done") throw new Error("Agent is not idle; use your terminal to finish its current turn");
            const path = adapter.resolveTranscript(session.binding.sessionRef);
            if (!path) throw new Error("Cannot show this agent’s conversation; prompt from the attached terminal instead");
            const before = await adapter.readTranscript(path, `${adapter.id}:${session.binding.sessionRef?.value}`);
            const previousAssistantIds = new Set(before.filter((item) => item.type === "assistant_message").map((item) => item.id));
            const previousUserIds = new Set(before.filter((item) => item.type === "user_message").map((item) => item.id));
            const result = await (await client()).request("agent.prompt", {
              target: agent.pane_id, text,
              wait: { until: ["working", "blocked", "idle", "done"], timeout_ms: 10000 },
            });
            z.object({ type: z.literal("agent_prompted") }).parse(result);
            const turnId = randomUUID();
            session.activeTurn = turnId;
            emit({ type: "session.prompt_result", sessionId: input.sessionId,
              clientMessageId: input.prompt.clientMessageId, result: { type: "turn", turnId } });
            emit({ type: "session.turn", sessionId: input.sessionId, turnId, state: "started" });
            // P0 has no event stream: a bounded status poll refreshes committed text and finishes the turn.
            void (async () => {
              for (let attempt = 0; attempt < 120 && !closed; attempt++) {
                await new Promise((resolve) => setTimeout(resolve, 1000));
                const current = findBound(await list(), session.binding, adapter);
                if (!current) throw new Error("The Herdr agent binding changed during the turn");
                if (current.agent_status === "working" || current.agent_status === "blocked") continue;
                if (current.agent_status !== "idle" && current.agent_status !== "done") continue;
                const items = await adapter.readTranscript(path, `${adapter.id}:${session.binding.sessionRef?.value}`);
                if (!items.some((item) => item.type === "assistant_message" && !previousAssistantIds.has(item.id))) continue;
                const committedUser = items.find((item) => item.type === "user_message" && !previousUserIds.has(item.id));
                if (committedUser?.type === "user_message") {
                  session.binding.submittedMessages[committedUser.id] = input.prompt.clientMessageId;
                  emit({ type: "session.persistence", sessionId: input.sessionId, persistence: persistenceOf(session.binding) });
                  if (committedUser.text !== text) emit({ type: "session.notice", sessionId: input.sessionId, notice: {
                    id: `prompt-text-${committedUser.id}`, severity: "warning", title: "Native prompt text differed",
                    description: "OMP submitted different text than the Paseo composer; check the attached terminal for a pending draft.",
                  } });
                }
                for (const item of items) emit({ type: "timeline.item", sessionId: input.sessionId, item: correlatedItem(item, session.binding) });
                emit({ type: "session.turn", sessionId: input.sessionId, turnId, state: "completed" });
                session.activeTurn = null;
                return;
              }
              throw new Error("Turn status could not be confirmed; inspect the attached terminal");
            })().catch((error: unknown) => {
              emit({ type: "session.turn", sessionId: input.sessionId, turnId, state: "failed", error: { message: String(error) } });
              session.activeTurn = null;
            });
            return;
          }
          case "session.close":
            sessions.delete(input.sessionId);
            emit({ type: "session.closed", sessionId: input.sessionId });
            emit({ type: "request.completed", requestId: input.requestId });
            return;
          default:
            if ("requestId" in input) emit({ type: "request.failed", requestId: input.requestId,
              error: { message: `${input.type} is not supported yet` } });
            return;
        }
      };
      return {
        version: 1, capabilities,
        async send(input) {
          if (closed) throw new Error("Provider connection closed");
          queueMicrotask(() => { void dispatch(input).catch((error: unknown) => {
            const message = error instanceof Error ? error.message : String(error);
            if (input.type === "session.prompt") emit({ type: "session.prompt_result", sessionId: input.sessionId,
              clientMessageId: input.prompt.clientMessageId, result: { type: "failed", error: { message } } });
            else if ("requestId" in input) emit({ type: "request.failed", requestId: input.requestId, error: { message } });
          }); });
        },
        onEvent(listener) { listeners.add(listener); return () => listeners.delete(listener); },
        async close() { closed = true; sessions.clear(); listeners.clear(); },
      } satisfies ProviderConnection;
    },
  };
}
