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
import { bindingOf, parseBinding } from "./binding.js";
import { discoverSessions } from "./discovery.js";
import { launchAgent } from "./launch.js";
import { HerdrHarnessSession, capabilitiesFor, pendingBinding, type SessionDeps } from "./session.js";
import { ModelCache } from "./config.js";
import type { BoundSessions } from "./bound-sessions.js";
import type { PermissionResponder } from "./host.js";
import { HERDR_BIND_OPTION, NATIVE_DEFAULT_MODEL } from "../shared/model.js";

export interface ProviderHooks {
  /** Optional hook to stamp the resolved Herdr session name into persistence. */
  getHerdrSession?: () => string | null;
  /** Override the agent launcher (tests); defaults to `launchAgent` over the Herdr socket. */
  launch?: SessionDeps["launch"];
  /** Plugin `enable<Harness>` toggle: false means no new discovery or launch; already-open sessions keep working. */
  isEnabled?: () => Promise<boolean>;
  /** Tests: shorten the fallback wait before a bound session re-sends its history. */
  bindHistoryDelayMs?: number;
  /** Shared with the management RPCs so `herdr.chat.ready` can flush a bound chat's history. */
  boundSessions?: BoundSessions;
  /** The Paseo API handle captured from a lifecycle hook (null until one has fired). */
  getPaseo?: () => PermissionResponder | null;
  /** Tests: replaces the real timer between approval polls. */
  approvalSleep?: SessionDeps["approvalSleep"];
}

const BindOptionSchema = z.object({ terminalId: z.string().min(1), paneId: z.string().optional() });

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
    ...(adapter.icon ? { icon: adapter.icon } : {}),
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
      // Each session pins the socket and Herdr session it opened on: a settings change applies to new
      // operations only and never moves an open chat to another Herdr daemon (P3.7A).
      const sessionDeps = async (): Promise<SessionDeps> => {
        const herdr = new HerdrClient(await getSocketPath());
        const herdrSession = hooks.getHerdrSession?.() ?? null;
        const request: SessionDeps["request"] = (method, params = {}, options) => herdr.request(method, params, options);
        return {
          adapter,
          listAgents: async (signal?: AbortSignal) => AgentListResultSchema.parse(await herdr.request("agent.list", {}, { signal })).agents,
          request,
          subscribe: async (subscriptions: SubscriptionDescriptor[], options?: { signal?: AbortSignal }) => herdr.subscribe(subscriptions, options),
          emit,
          modelCache,
          ...(hooks.getPaseo ? { getPaseo: hooks.getPaseo } : {}),
          ...(hooks.approvalSleep ? { approvalSleep: hooks.approvalSleep } : {}),
          getHerdrSession: () => herdrSession,
          ...(hooks.bindHistoryDelayMs !== undefined ? { bindHistoryDelayMs: hooks.bindHistoryDelayMs } : {}),
          launch: hooks.launch ?? ((config, signal) => launchAgent({ request, herdrSession }, adapter, config, signal)),
        };
      };

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
            if (hooks.isEnabled && !(await hooks.isEnabled())) {
              emit({ type: "sessions", requestId: input.requestId, sessions: [] });
              return;
            }
            const agents = await list();
            const summaries = await discoverSessions(adapter, agents, input, hooks);
            emit({ type: "sessions", requestId: input.requestId, sessions: summaries });
            return;
          }
          case "session.open": {
            if (sessions.has(input.sessionId)) throw new Error("Session already open");
            if (!input.persistence) {
              if (hooks.isEnabled && !(await hooks.isEnabled())) {
                throw new Error(`${adapter.label} is turned off in the Herdr plugin settings`);
              }
              const bindOption = input.config.providerOptions?.[HERDR_BIND_OPTION];
              if (bindOption !== undefined) {
                const parsed = BindOptionSchema.safeParse(bindOption);
                if (!parsed.success) throw new Error("Invalid herdrBind option: expected { terminalId, paneId? }");
                const deps = await sessionDeps();
                const agent = (await deps.listAgents()).find((candidate) => candidate.terminal_id === parsed.data.terminalId);
                if (!agent) throw new Error(`The Herdr agent in terminal ${parsed.data.terminalId} is no longer running`);
                if (agent.agent !== adapter.id) throw new Error(`The Herdr agent in terminal ${parsed.data.terminalId} is not a ${adapter.label} agent`);
                const binding = bindingOf(agent, adapter, deps.getHerdrSession?.() ?? null);
                // A read-only chat on the same agent doesn't count: after a restart the client binds a fresh chat and archives the old one.
                const taken = () => [...sessions.values()].some((open) => open.state.outcome === "active" &&
                  open.state.binding.terminalId === binding.terminalId && open.state.binding.herdrSession === binding.herdrSession);
                if (sessions.has(input.sessionId)) throw new Error("Session already open");
                if (taken()) throw new Error(`This ${adapter.label} agent is already open in another conversation`);
                const session = new HerdrHarnessSession(input.sessionId, binding, deps);
                sessions.set(input.sessionId, session);
                hooks.boundSessions?.add(session);
                try {
                  const config = { ...input.config };
                  if (config.model === NATIVE_DEFAULT_MODEL) delete config.model;
                  await session.bind(config, input.requestId);
                } catch (error) {
                  const closedMeanwhile = session.isAborted;
                  session.close();
                  if (sessions.get(input.sessionId) === session) sessions.delete(input.sessionId);
                  if (!closedMeanwhile) throw error;
                }
                return;
              }
              // A created agent without the input companion would be read-only at once; refuse before launching.
              let companion: { ok: boolean; diagnostic?: string } | undefined;
              try { companion = await adapter.inputCompanionStatus?.(); }
              catch (error) { companion = { ok: false, diagnostic: `Input companion check failed: ${String(error)}` }; }
              if (companion && !companion.ok) {
                throw new Error(companion.diagnostic ?? `The ${adapter.label} input companion is not installed`);
              }
              const deps = await sessionDeps();
              if (sessions.has(input.sessionId)) throw new Error("Session already open");
              const session = new HerdrHarnessSession(input.sessionId,
                pendingBinding(adapter, deps.getHerdrSession?.() ?? null, input.config.cwd), deps);
              sessions.set(input.sessionId, session);
              try {
                // This launch-only selection must never reach a harness as a literal model ID.
                const config = { ...input.config };
                if (config.model === NATIVE_DEFAULT_MODEL) delete config.model;
                await session.create(config, input.history, input.requestId);
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
            const deps = await sessionDeps();
            const target = deps.getHerdrSession?.() ?? null;
            if (binding.herdrSession !== target) {
              const name = (session: string | null) => (session ? `Herdr session "${session}"` : "the default Herdr session");
              throw new Error(`This conversation belongs to ${name(binding.herdrSession)}, but the Herdr plugin now targets ${name(target)}. Change the plugin's Herdr settings back to reopen it.`);
            }
            if (sessions.has(input.sessionId)) throw new Error("Session already open");
            const session = new HerdrHarnessSession(input.sessionId, binding, deps);
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
          case "session.permission": {
            const session = sessions.get(input.sessionId);
            if (!session) throw new Error("Unknown session");
            await session.approvals.respond(input.permissionId, input.response);
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
