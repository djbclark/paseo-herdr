import { z } from "zod";
import {
  negotiateProviderCapabilities,
  type ProviderConnection,
  type ProviderEvent,
  type ProviderInput,
  type ProviderRegistration,
} from "@getpaseo/plugin/server/provider";
import type { HarnessAdapter } from "./harness/types.js";
import { HerdrClient, checkHerdrStatus } from "./herdr/client.js";
import { AgentListResultSchema, type AgentInfo } from "./herdr/schema.js";
import { parseBinding } from "./binding.js";
import { discoverSessions } from "./discovery.js";
import { HerdrHarnessSession } from "./session.js";

const CAPABILITIES = ["prompt.message", "session.list", "session.persistence"] as const;

export interface ProviderHooks {
  /** Optional hook to stamp the resolved Herdr session name into persistence. */
  getHerdrSession?: () => string | null;
}

export function createHerdrProvider(
  adapter: HarnessAdapter,
  getSocketPath: () => Promise<string>,
  hooks: ProviderHooks = {},
): ProviderRegistration {
  const client = async () => new HerdrClient(await getSocketPath());
  return {
    id: `herdr-${adapter.id}`,
    label: `${adapter.label} (Herdr)`,
    description: `Chat with an existing Herdr-managed ${adapter.label} agent`,
    async status() {
      try {
        const herdr = await client();
        const result = await checkHerdrStatus(herdr, adapter.herdrIntegration);
        return result.available
          ? { available: true, diagnostic: result.diagnostic }
          : { available: false, diagnostic: result.diagnostic ?? "Herdr unavailable" };
      } catch (error) {
        return { available: false, diagnostic: `Herdr unavailable: ${String(error)}` };
      }
    },
    async connect(request) {
      if (!request.versions.includes(1)) throw new Error("Provider protocol version 1 is required");
      const capabilities = negotiateProviderCapabilities(request.capabilities, CAPABILITIES);
      const listeners = new Set<(event: ProviderEvent) => void>();
      const sessions = new Map<string, HerdrHarnessSession>();
      let closed = false;
      const emit = (event: ProviderEvent) => { if (!closed) for (const listener of listeners) listener(event); };
      const list = async (signal?: AbortSignal): Promise<AgentInfo[]> => {
        const result = await (await client()).request("agent.list", {}, { signal });
        return AgentListResultSchema.parse(result).agents;
      };
      const sessionDeps = () => ({
        adapter,
        listAgents: (signal?: AbortSignal) => list(signal),
        request: (method: string, params: Record<string, unknown> = {}, options?: { signal?: AbortSignal }) =>
          client().then((herdr) => herdr.request(method, params, options)),
        emit,
        getHerdrSession: hooks.getHerdrSession,
      });

      const dispatch = async (input: ProviderInput): Promise<void> => {
        switch (input.type) {
          case "catalog":
            emit({ type: "catalog", requestId: input.requestId, catalog: { models: [], modes: [] } });
            return;
          case "sessions": {
            const agents = await list();
            const summaries = await discoverSessions(adapter, agents, input, hooks);
            emit({ type: "sessions", requestId: input.requestId, sessions: summaries });
            return;
          }
          case "session.open": {
            if (!input.persistence) throw new Error("Import an existing Herdr agent first; creation is not supported yet");
            if (sessions.has(input.sessionId)) throw new Error("Session already open");
            const binding = parseBinding(input.persistence, adapter);
            const deps = sessionDeps();
            const session = new HerdrHarnessSession(input.sessionId, binding, deps);
            sessions.set(input.sessionId, session);
            try {
              await session.open(input.config, input.history, input.requestId);
            } catch (error) {
              sessions.delete(input.sessionId);
              throw error;
            }
            return;
          }
          case "session.prompt": {
            const session = sessions.get(input.sessionId);
            if (!session) throw new Error("Unknown session");
            await session.prompt(input.prompt);
            return;
          }
          case "session.close":
            sessions.get(input.sessionId)?.close();
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
        async close() { closed = true; for (const session of sessions.values()) session.close(); sessions.clear(); listeners.clear(); },
      } satisfies ProviderConnection;
    },
  };
}
