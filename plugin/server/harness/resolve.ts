import type { HarnessAdapter } from "./types.js";

/**
 * Adapter routing (F3): the adapter id (persistence owner) is kept apart from the Herdr
 * `agent` kind and the Herdr integration. `select` is for NEW work (discovery, herdrBind,
 * overview rows without a chat, restart): a specific kind match wins over the fallback.
 * `adapterAcceptsKind` is for validating an EXISTING binding, so a saved generic chat keeps
 * its adapter after the pane later gets detected as a specific agent; process identity
 * still guards against replacement.
 */
export interface AdapterResolver {
  /** Adapter for new work on a pane of Herdr `agent` kind `kind`: a specific match first, then the single fallback. */
  select(kind: string | null | undefined): HarnessAdapter | null;
  byId(id: string): HarnessAdapter | undefined;
}

export function createResolver(adapters: readonly HarnessAdapter[]): AdapterResolver {
  const byId = new Map<string, HarnessAdapter>();
  const byKind = new Map<string, HarnessAdapter>();
  const fallbacks: HarnessAdapter[] = [];
  for (const adapter of adapters) {
    const known = byId.get(adapter.id);
    if (known) throw new Error(`Two harness adapters share the id "${adapter.id}".`);
    byId.set(adapter.id, adapter);
    if (adapter.nativeKinds === "any") {
      fallbacks.push(adapter);
      continue;
    }
    for (const kind of adapter.nativeKinds) {
      const owner = byKind.get(kind);
      if (owner) throw new Error(`Two harness adapters claim Herdr agent kind "${kind}": ${owner.id} and ${adapter.id}.`);
      byKind.set(kind, adapter);
    }
  }
  if (fallbacks.length > 1) {
    throw new Error(`At most one fallback ("any") harness adapter is allowed; found ${fallbacks.map((adapter) => adapter.id).join(", ")}.`);
  }
  const [fallback] = fallbacks;
  return {
    select(kind) {
      return (kind == null ? undefined : byKind.get(kind)) ?? fallback ?? null;
    },
    byId(id) {
      return byId.get(id);
    },
  };
}

/** Live validation of an EXISTING binding: the kinds the adapter claims, with a fallback claiming everything. */
export function adapterAcceptsKind(adapter: HarnessAdapter | null | undefined, kind: string | null | undefined): boolean {
  if (!adapter) return false;
  if (adapter.nativeKinds === "any") return true;
  return kind != null && adapter.nativeKinds.includes(kind);
}
