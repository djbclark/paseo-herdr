import type { ProviderInput, ProviderSessionSummary } from "@getpaseo/plugin/server/provider";
import type { HarnessAdapter } from "./harness/types.js";
import type { AgentInfo } from "./herdr/schema.js";
import { bindingOf, persistenceOf } from "./binding.js";
import { agentPlace, cleanTitle } from "../shared/labels.js";

export interface DiscoveryOptions {
  /** Optional hook to stamp the resolved Herdr session name into persistence. */
  getHerdrSession?: () => string | null;
}

/**
 * Build the Import-picker session list for one harness: filter `agent.list` by
 * `agent === adapter.id` (and `cwd` when supplied), and read each summary's
 * `title`/`updatedAt` through the adapter's transcript reader when the ref is
 * readable. A ref the adapter cannot resolve gets a
 * "History unavailable" description and the observed timestamp.
 */
export async function discoverSessions(
  adapter: HarnessAdapter,
  agents: readonly AgentInfo[],
  input: Extract<ProviderInput, { type: "sessions" }>,
  options: DiscoveryOptions = {},
): Promise<ProviderSessionSummary[]> {
  const herdrSession = options.getHerdrSession?.() ?? null;
  const filtered = agents.filter(
    (agent) =>
      agent.agent === adapter.id &&
      (!input.cwd || agent.cwd === input.cwd || agent.foreground_cwd === input.cwd),
  );
  const observedAt = new Date().toISOString();
  const limited = filtered.slice(0, input.limit);

  return Promise.all(
    limited.map(async (agent) => {
      const binding = bindingOf(agent, adapter, herdrSession);
      const locator = await adapter.resolveTranscript(binding.sessionRef, { cwd: binding.cwd });
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
    }),
  );
}
