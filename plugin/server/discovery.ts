import type { ProviderInput, ProviderSessionSummary } from "@getpaseo/plugin/server/provider";
import type { HarnessAdapter } from "./harness/types.js";
import type { AgentInfo } from "./herdr/schema.js";
import { bindingOf, persistenceOf } from "./binding.js";

export interface DiscoveryOptions {
  /** Optional hook to stamp the resolved Herdr session name into persistence. */
  getHerdrSession?: () => string | null;
}

/**
 * Build the Import-picker session list for one harness: filter `agent.list` by
 * `agent === adapter.id` (and `cwd` when supplied), and read each summary's
 * `title`/`updatedAt` through the adapter's transcript reader when the ref is
 * readable. A non-readable ref (e.g. OMP `kind:"id"`) gets an
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
      let description: string | undefined;
      if (locator) {
        const reader = adapter.openTranscript(locator);
        try {
          const snapshot = await reader.snapshot();
          updatedAt = snapshot.updatedAt ?? observedAt;
        } catch {
          description = "History unavailable";
        } finally {
          reader.close();
        }
      } else {
        description = "History unavailable";
      }
      return {
        persistence: persistenceOf(binding),
        cwd: binding.cwd || input.cwd || "",
        title: agent.title ?? agent.name ?? `${adapter.label} agent`,
        description,
        updatedAt,
      };
    }),
  );
}
