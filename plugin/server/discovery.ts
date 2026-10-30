import type { ProviderInput, ProviderSessionSummary } from "@getpaseo/plugin/server/provider";
import type { HarnessAdapter, PaneObservation } from "./harness/types.js";
import type { AdapterResolver } from "./harness/resolve.js";
import type { AgentInfo } from "./herdr/schema.js";
import { bindingOf, persistenceOf } from "./binding.js";
import { agentPlace, cleanTitle } from "../shared/labels.js";

export interface DiscoveryOptions {
  /** Optional hook to stamp the resolved Herdr session name into persistence. */
  getHerdrSession?: () => string | null;
  /** Adapter routing for new work: a pane is listed only when `resolver.select(agent)` picks this adapter. */
  resolver: AdapterResolver;
  /**
   * Pane-mode adapters only: builds the per-pane observation the transcript is read through.
   * `signal` is discovery-scoped; it is aborted once this pane's snapshot has been taken.
   */
  observe?: (agent: AgentInfo, signal: AbortSignal) => PaneObservation;
}

/**
 * Build the Import-picker session list for one harness: filter `agent.list` by
 * resolver routing (and `cwd` when supplied), and read each summary's
 * `title`/`updatedAt` through the adapter's transcript reader when the ref is
 * readable. A ref the adapter cannot resolve gets a
 * "History unavailable" description and the observed timestamp.
 */
export async function discoverSessions(
  adapter: HarnessAdapter,
  agents: readonly AgentInfo[],
  input: Extract<ProviderInput, { type: "sessions" }>,
  options: DiscoveryOptions,
): Promise<ProviderSessionSummary[]> {
  const herdrSession = options.getHerdrSession?.() ?? null;
  const filtered = agents.filter(
    (agent) =>
      options.resolver.select(agent.agent) === adapter &&
      (!input.cwd || agent.cwd === input.cwd || agent.foreground_cwd === input.cwd),
  );
  const observedAt = new Date().toISOString();
  const limited = filtered.slice(0, input.limit);
  const paneMode = adapter.binding === "pane";

  return Promise.all(
    limited.map(async (agent) => {
      const binding = bindingOf(agent, adapter, herdrSession);
      // A pane-mode adapter reads the pane itself, so it gets a discovery-scoped observation
      // whose signal dies with this snapshot; adapters must not persist the locator.
      const paneScope = paneMode ? new AbortController() : null;
      try {
        const locator = await adapter.resolveTranscript(binding.sessionRef, {
          cwd: binding.cwd,
          ...(paneScope && options.observe ? { pane: options.observe(agent, paneScope.signal) } : {}),
        });
        let updatedAt = observedAt;
        let history = "history unavailable";
        let lastPrompt: string | undefined;
        let transcriptTitle: string | undefined;
        if (locator) {
          const reader = adapter.openTranscript(locator);
          try {
            const snapshot = await reader.snapshot();
            updatedAt = snapshot.updatedAt ?? observedAt;
            transcriptTitle = snapshot.title;
            lastPrompt = [...snapshot.items].reverse().find((item) => item.type === "user_message")?.text;
            history = "";
          } catch {
            // History stays unavailable; the summary still identifies the agent.
          } finally {
            reader.close();
          }
        }
        // Same naming as the plugin's Herdr screen, so the user can match rows across the two.
        const title = cleanTitle(agent.terminal_title_stripped ?? agent.terminal_title) ?? cleanTitle(transcriptTitle) ?? agent.name ?? `${adapter.label} agent`;
        const place = [`${agentPlace(`${adapter.label} in Herdr`, agent.pane_id)}`, agent.agent_status, history].filter(Boolean).join(" · ");
        const prompt = lastPrompt?.replace(/\s+/g, " ").trim();
        return {
          persistence: persistenceOf(binding),
          cwd: binding.cwd || input.cwd || "",
          title,
          description: prompt ? `${place} — “${prompt.length > 100 ? `${prompt.slice(0, 99)}…` : prompt}”` : place,
          updatedAt,
        };
      } finally {
        paneScope?.abort();
      }
    }),
  );
}
