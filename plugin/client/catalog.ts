import type { PluginClientContext } from "@getpaseo/plugin/client";

type Paseo = PluginClientContext["paseo"];
interface ObservedAgent { provider: string; runtimeInfo?: { model?: string | null } | null }

/**
 * Paseo caches each provider's model list and only re-reads it on a refresh. After a plugin reload our list
 * is empty until a live session has reported the install's models, so a model switched in the terminal
 * (Alt+P, /switch) isn't in Paseo's list and its picker can't show it. When a Herdr chat reports an active
 * model the list lacks, refresh that provider: at most once per `minIntervalMs`, never concurrently.
 */
export function createCatalogFollower(paseo: Paseo, options: { now?: () => number; minIntervalMs?: number } = {}) {
  const now = options.now ?? Date.now;
  const minIntervalMs = options.minIntervalMs ?? 60_000;
  const known = new Map<string, Set<string>>();
  const lastRefresh = new Map<string, number>();
  const busy = new Set<string>();
  const list = async (provider: string) =>
    new Set(((await paseo.providers.listModels(provider)).models ?? []).map((model) => model.id));
  return async function observe(agent: ObservedAgent): Promise<void> {
    const { provider } = agent;
    const model = agent.runtimeInfo?.model;
    if (!provider.startsWith("herdr-") || !model || known.get(provider)?.has(model) || busy.has(provider)) return;
    busy.add(provider);
    try {
      let ids = known.get(provider) ?? await list(provider);
      if (!ids.has(model) && now() - (lastRefresh.get(provider) ?? -Infinity) >= minIntervalMs) {
        lastRefresh.set(provider, now());
        await paseo.providers.refresh({ providers: [provider] });
        ids = await list(provider);
      }
      known.set(provider, ids);
    } catch {
      // Best effort: the picker just keeps showing the configured model until the next refresh.
    } finally {
      busy.delete(provider);
    }
  };
}
