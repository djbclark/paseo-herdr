import { z } from "zod";
import {
  negotiateProviderCapabilities,
  type ProviderConnection,
  type ProviderEvent,
  type ProviderInput,
  type ProviderRegistration,
} from "@getpaseo/plugin/server/provider";
import type { HarnessAdapter } from "./harness/types.js";
import { HerdrClient, checkHerdrStatus, type SubscriptionDescriptor } from "./herdr/client.js";
import { AgentListResultSchema, type AgentInfo } from "./herdr/schema.js";
import { parseBinding } from "./binding.js";
import { discoverSessions } from "./discovery.js";
import { launchAgent } from "./launch.js";
import { HerdrHarnessSession, capabilitiesFor, pendingBinding, type SessionDeps } from "./session.js";
import { ModelCache } from "./config.js";

export interface ProviderHooks {
  /** Optional hook to stamp the resolved Herdr session name into persistence. */
  getHerdrSession?: () => string | null;
  /** Override the agent launcher (tests); defaults to `launchAgent` over the Herdr socket. */
  launch?: SessionDeps["launch"];
}

export function createHerdrProvider(
  adapter: HarnessAdapter,
  getSocketPath: () => Promise<string>,
  hooks: ProviderHooks = {},
): ProviderRegistration {
  const client = async () => new HerdrClient(await getSocketPath());
  // The model list is install-wide, so it outlives connections.
  const modelCache = new ModelCache();
  return {
    id: `herdr-${adapter.id}`,
    label: `${adapter.label} (Herdr)`,
    description: `Chat with an existing Herdr-managed ${adapter.label} agent`,
    async status() {
      try {
        const herdr = await client();
        const result = await checkHerdrStatus(herdr, adapter.herdrIntegration);
        if (!result.available) return { available: false, diagnostic: result.diagnostic ?? "Herdr unavailable" };
        // Import still works read-only without the companion, so the provider stays available.
        let companion: { ok: boolean; diagnostic?: string } | undefined;
        try { companion = await adapter.inputCompanionStatus?.(); }
        catch (error) { companion = { ok: false, diagnostic: `Input companion check failed: ${String(error)}` }; }
        return companion && !companion.ok
          ? { available: true, diagnostic: companion.diagnostic }
          : { available: true, diagnostic: result.diagnostic };
      } catch (error) {
        return { available: false, diagnostic: `Herdr unavailable: ${String(error)}` };
      }
    },
    async connect(request) {
      if (!request.versions.includes(1)) throw new Error("Provider protocol version 1 is required");
      const capabilities = negotiateProviderCapabilities(request.capabilities, capabilitiesFor(adapter));
      const listeners = new Set<(event: ProviderEvent) => void>();
      const sessions = new Map<string, HerdrHarnessSession>();
      let closed = false;
      const emit = (event: ProviderEvent) => { if (!closed) for (const listener of listeners) listener(event); };
      const list = async (signal?: AbortSignal): Promise<AgentInfo[]> => {
        const result = await (await client()).request("agent.list", {}, { signal });
        return AgentListResultSchema.parse(result).agents;
      };
      const herdrRequest: SessionDeps["request"] = (method, params = {}, options) =>
        client().then((herdr) => herdr.request(method, params, options));
      const sessionDeps = (): SessionDeps => ({
        adapter,
        listAgents: (signal?: AbortSignal) => list(signal),
        request: herdrRequest,
        subscribe: (subscriptions: SubscriptionDescriptor[], options?: { signal?: AbortSignal }) =>
          client().then((herdr) => herdr.subscribe(subscriptions, options)),
        emit,
        modelCache,
        getHerdrSession: hooks.getHerdrSession,
        launch: hooks.launch ?? ((config, signal) => launchAgent({ request: herdrRequest, herdrSession: hooks.getHerdrSession?.() ?? null }, adapter, config, signal)),
      });

      const dispatch = async (input: ProviderInput): Promise<void> => {
        switch (input.type) {
          case "catalog": {
            if (modelCache.stale) {
              // Any live, validated session can list the install-wide models; a failure never fails the catalog.
              for (const session of sessions.values()) {
                if (await session.config.refreshModels().catch(() => false)) break;
              }
            }
            emit({ type: "catalog", requestId: input.requestId, catalog: modelCache.catalog() });
            return;
          }
          case "sessions": {
            const agents = await list();
            const summaries = await discoverSessions(adapter, agents, input, hooks);
            emit({ type: "sessions", requestId: input.requestId, sessions: summaries });
            return;
          }
          case "session.open": {
            if (sessions.has(input.sessionId)) throw new Error("Session already open");
            if (!input.persistence) {
              // A created agent without the input companion would be read-only at once; refuse before launching.
              let companion: { ok: boolean; diagnostic?: string } | undefined;
              try { companion = await adapter.inputCompanionStatus?.(); }
              catch (error) { companion = { ok: false, diagnostic: `Input companion check failed: ${String(error)}` }; }
              if (companion && !companion.ok) {
                throw new Error(companion.diagnostic ?? `The ${adapter.label} input companion is not installed`);
              }
              if (sessions.has(input.sessionId)) throw new Error("Session already open");
              const session = new HerdrHarnessSession(input.sessionId,
                pendingBinding(adapter, hooks.getHerdrSession?.() ?? null, input.config.cwd), sessionDeps());
              sessions.set(input.sessionId, session);
              try {
                await session.create(input.config, input.history, input.requestId);
              } catch (error) {
                const closedMeanwhile = session.isAborted;
                session.close();
                if (sessions.get(input.sessionId) === session) sessions.delete(input.sessionId);
                // session.close already answered this request's session; nothing more to report.
                if (!closedMeanwhile) throw error;
              }
              return;
            }
            const binding = parseBinding(input.persistence, adapter);
            const session = new HerdrHarnessSession(input.sessionId, binding, sessionDeps());
            sessions.set(input.sessionId, session);
            try {
              await session.open(input.config, input.history, input.requestId);
            } catch (error) {
              session.close();
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
          case "session.interrupt": {
            const session = sessions.get(input.sessionId);
            if (!session) throw new Error("Unknown session");
            await session.interrupt(input.requestId);
            return;
          }
          case "session.configure": {
            const session = sessions.get(input.sessionId);
            if (!session) throw new Error("Unknown session");
            await session.configure(input.requestId, input.changes);
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
