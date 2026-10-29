import { z } from "zod";
import {
  negotiateProviderCapabilities,
  type ProviderConnection,
  type ProviderEvent,
  type ProviderInput,
  type ProviderRegistration,
} from "@getpaseo/plugin/server/provider";
import type { HarnessAdapter, PaneObservation } from "./harness/types.js";
import { createResolver, type AdapterResolver } from "./harness/resolve.js";
import { HerdrClient, checkHerdrStatus, type SubscriptionDescriptor } from "./herdr/client.js";
import { listPaneTargets } from "./herdr/targets.js";
import type { AgentInfo } from "./herdr/schema.js";
import { bindingOf, parseBinding, type Binding } from "./binding.js";
import { discoverSessions } from "./discovery.js";
import { launchAgent } from "./launch.js";
import { HerdrHarnessSession, capabilitiesFor, pendingBinding, type SessionDeps } from "./session.js";
import { ModelCache } from "./config.js";
import type { BoundSessions } from "./bound-sessions.js";
import { paneClaims } from "./pane-claims.js";
import type { PermissionResponder } from "./host.js";
import { HERDR_BIND_OPTION, NATIVE_DEFAULT_MODEL } from "../shared/model.js";

export interface ProviderHooks {
  /** Optional hook to stamp the resolved Herdr session name into persistence. */
  getHerdrSession?: () => string | null;
  /**
   * Adapter routing for new work (discovery, herdrBind): a specific kind match in the shared
   * resolver wins over this provider's adapter. Defaults to a resolver over this one adapter.
   */
  resolver?: AdapterResolver;
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
  const resolver = hooks.resolver ?? createResolver([adapter]);
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
      const claims = new Map<HerdrHarnessSession, () => void>();
      const controller = new AbortController();
      let closed = false;
      const emit = (event: ProviderEvent) => { if (!closed) for (const listener of listeners) listener(event); };
      // Each session pins the socket and Herdr session it opened on: a settings change applies to new
      // operations only and never moves an open chat to another Herdr daemon (P3.7A).
      const sessionDeps = async (): Promise<SessionDeps & { socketPath: string }> => {
        const socketPath = await getSocketPath();
        const herdr = new HerdrClient(socketPath);
        const herdrSession = hooks.getHerdrSession?.() ?? null;
        const request: SessionDeps["request"] = (method, params = {}, options) => herdr.request(method, params, options);
        return {
          socketPath,
          adapter,
          listAgents: async (signal?: AbortSignal) => listPaneTargets(request, { signal }),
          request,
          subscribe: async (subscriptions: SubscriptionDescriptor[], options?: { signal?: AbortSignal }) => herdr.subscribe(subscriptions, options),
          emit,
          modelCache,
          ...(hooks.getPaseo ? { getPaseo: hooks.getPaseo } : {}),
          ...(hooks.approvalSleep ? { approvalSleep: hooks.approvalSleep } : {}),
          getHerdrSession: () => herdrSession,
          ...(hooks.bindHistoryDelayMs !== undefined ? { bindHistoryDelayMs: hooks.bindHistoryDelayMs } : {}),
          // An adapter without a launch spec is import/bind only; `session.open` refuses to create.
          ...(adapter.launch
            ? { launch: hooks.launch ?? ((config, signal) => launchAgent({ request, herdrSession }, adapter, config, signal)) }
            : {}),
        };
      };

      const claim = (session: HerdrHarnessSession, socketPath: string, terminalId = session.state.binding.terminalId) => {
        const release = paneClaims.claim(socketPath, session.state.binding.herdrSession, terminalId, session);
        if (!release) throw new Error(`This ${adapter.label} agent is already open in another conversation`);
        claims.set(session, release);
      };
      const register = (sessionId: string, binding: Binding, deps: SessionDeps & { socketPath: string }, claimOnRegister = true): HerdrHarnessSession | null => {
        const session = new HerdrHarnessSession(sessionId, binding, deps);
        deps.claimPane = (terminalId) => {
          const binding = session.state.binding;
          const release = paneClaims.move(deps.socketPath, binding.herdrSession, binding.terminalId, terminalId, session);
          if (!release) {
            claims.get(session)?.();
            claims.delete(session);
            return false;
          }
          claims.set(session, release);
          return true;
        };
        session.signal.addEventListener("abort", () => {
          if (sessions.get(sessionId) === session) sessions.delete(sessionId);
          hooks.boundSessions?.delete(session);
          claims.get(session)?.();
          claims.delete(session);
        }, { once: true });
        if (closed) { session.close(); return null; }
        try { if (claimOnRegister && binding.terminalId) claim(session, deps.socketPath); }
        catch (error) { session.close(); throw error; }
        sessions.set(sessionId, session);
        return session;
      };

      const dispatch = async (input: ProviderInput): Promise<void> => {
        if (closed) return;
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
            const herdr = await client();
            const agents = await listPaneTargets(
              (method, params = {}, options) => herdr.request(method, params, options),
              { signal: controller.signal },
            );
            if (closed) return;
            const summaries = await discoverSessions(adapter, agents, input, {
              getHerdrSession: hooks.getHerdrSession,
              resolver,
              // A pane-mode adapter reads panes through a discovery-scoped observation on this connection.
              ...(adapter.binding === "pane"
                ? {
                    observe: (agent: AgentInfo, signal: AbortSignal): PaneObservation => ({
                      terminalId: agent.terminal_id,
                      herdrSession: hooks.getHerdrSession?.() ?? null,
                      paneId: () => agent.pane_id,
                      request: (method, params = {}, options) => herdr.request(method, params, { ...options, signal: options?.signal ?? signal }),
                      signal,
                    }),
                  }
                : {}),
            });
            emit({ type: "sessions", requestId: input.requestId, sessions: summaries });
            return;
          }
          case "session.open": {
            if (sessions.has(input.sessionId)) throw new Error("Session already open");
            if (!input.persistence) {
              if (hooks.isEnabled) {
                const enabled = await hooks.isEnabled();
                if (closed) return;
                if (!enabled) throw new Error(`${adapter.label} is turned off in the Herdr plugin settings`);
              }
              const bindOption = input.config.providerOptions?.[HERDR_BIND_OPTION];
              if (bindOption !== undefined) {
                const parsed = BindOptionSchema.safeParse(bindOption);
                if (!parsed.success) throw new Error("Invalid herdrBind option: expected { terminalId, paneId? }");
                const deps = await sessionDeps();
                if (closed) return;
                const agent = (await deps.listAgents(controller.signal)).find((candidate) => candidate.terminal_id === parsed.data.terminalId);
                if (closed) return;
                if (!agent) throw new Error(`The Herdr agent in terminal ${parsed.data.terminalId} is no longer running`);
                // New binding: route by kind, so a specific adapter wins over this one even if it is the fallback.
                if (resolver.select(agent.agent) !== adapter) throw new Error(`The Herdr agent in terminal ${parsed.data.terminalId} is not a ${adapter.label} agent`);
                const binding = bindingOf(agent, adapter, deps.getHerdrSession?.() ?? null);
                if (sessions.has(input.sessionId)) throw new Error("Session already open");
                const session = register(input.sessionId, binding, deps);
                if (!session) return;
                hooks.boundSessions?.add(session);
                try {
                  const config = { ...input.config };
                  if (config.model === NATIVE_DEFAULT_MODEL) delete config.model;
                  await session.bind(config, input.requestId);
                  if (closed) session.close();
                } catch (error) {
                  const closedMeanwhile = session.isAborted;
                  session.close();
                  if (sessions.get(input.sessionId) === session) sessions.delete(input.sessionId);
                  if (!closedMeanwhile) throw error;
                }
                return;
              }
              // An adapter without a launch spec is import/bind only; refuse before the companion
              // check or any Herdr I/O, so nothing is started on its behalf.
              if (!adapter.launch) {
                throw new Error(`${adapter.label} agents can't be started from Paseo; start one in a Herdr terminal and import it instead.`);
              }
              // A created agent without the input companion would be read-only at once; refuse before launching.
              let companion: { ok: boolean; diagnostic?: string } | undefined;
              try { companion = await adapter.inputCompanionStatus?.(); }
              catch (error) { companion = { ok: false, diagnostic: `Input companion check failed: ${String(error)}` }; }
              if (closed) return;
              if (companion && !companion.ok) {
                throw new Error(companion.diagnostic ?? `The ${adapter.label} input companion is not installed`);
              }
              const deps = await sessionDeps();
              if (closed) return;
              if (sessions.has(input.sessionId)) throw new Error("Session already open");
              const session = register(input.sessionId,
                pendingBinding(adapter, deps.getHerdrSession?.() ?? null, input.config.cwd), deps);
              if (!session) return;
              const launch = deps.launch!;
              deps.launch = async (config, signal) => {
                const launched = await launch(config, signal);
                if (!closed && !signal.aborted) claim(session, deps.socketPath, launched.terminalId);
                return launched;
              };
              try {
                // This launch-only selection must never reach a harness as a literal model ID.
                const config = { ...input.config };
                if (config.model === NATIVE_DEFAULT_MODEL) delete config.model;
                await session.create(config, input.history, input.requestId);
                if (closed) session.close();
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
            if (closed) return;
            const target = deps.getHerdrSession?.() ?? null;
            if (binding.herdrSession !== target) {
              const name = (session: string | null) => (session ? `Herdr session "${session}"` : "the default Herdr session");
              throw new Error(`This conversation belongs to ${name(binding.herdrSession)}, but the Herdr plugin now targets ${name(target)}. Change the plugin's Herdr settings back to reopen it.`);
            }
            if (sessions.has(input.sessionId)) throw new Error("Session already open");
            const session = register(input.sessionId, binding, deps, false);
            if (!session) return;
            try {
              await session.open(input.config, input.history, input.requestId);
              if (closed) session.close();
            } catch (error) {
              const closedMeanwhile = session.isAborted;
              session.close();
              if (!closedMeanwhile) throw error;
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
        async close() { closed = true; controller.abort(); for (const session of sessions.values()) session.close(); sessions.clear(); listeners.clear(); },
      } satisfies ProviderConnection;
    },
  };
}
