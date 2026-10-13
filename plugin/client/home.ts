import type { PluginClientContext, PluginButtonRegistration } from "@getpaseo/plugin/client";
import { OVERVIEW_SCREEN_ID } from "./helpers.js";
import { createCatalogFollower } from "./catalog.js";

/** Keep a way home in every Herdr chat, including chats restored after reconnect. */
export function registerHerdrHome(client: PluginClientContext): () => void {
  const lifetime = new AbortController();
  let generation = 0;
  let touched = new Set<string>();
  const pills = new Map<string, { workspaceId: string; button: PluginButtonRegistration }>();
  const remove = (agentId: string) => {
    pills.get(agentId)?.button.remove();
    pills.delete(agentId);
  };
  const clear = () => {
    for (const agentId of pills.keys()) remove(agentId);
  };
  const followCatalog = createCatalogFollower(client.paseo);
  const register = (agent: { id: string; provider: string; workspaceId?: string | null; archivedAt?: string | null; runtimeInfo?: { model?: string | null } | null }) => {
    if (lifetime.signal.aborted) return;
    if (!agent.archivedAt) void followCatalog(agent);
    if (!agent.provider.startsWith("herdr-") || !agent.workspaceId || agent.archivedAt) {
      remove(agent.id);
      return;
    }
    if (pills.get(agent.id)?.workspaceId === agent.workspaceId) return;
    remove(agent.id);
    pills.set(agent.id, {
      workspaceId: agent.workspaceId,
      button: client.addComposerPill({
        id: "herdr-home",
        workspaceId: agent.workspaceId,
        agentId: agent.id,
        button: {
          title: "Open Herdr home",
          icon: "House",
          label: "Herdr",
          behavior: { kind: "action", onPress: () => client.openScreen({ screenId: OVERVIEW_SCREEN_ID }) },
        },
      }),
    });
  };
  void client.paseo.agents.list({ page: { limit: 200 }, subscribe: {}, signal: lifetime.signal }).then(({ subscription }) => {
    if (lifetime.signal.aborted) return;
    subscription.subscribe({
      snapshot: ({ entries, pageInfo }) => {
        const snapshotGeneration = ++generation;
        touched = new Set();
        clear();
        for (const { agent } of entries) register(agent);
        // The observed first page supplies live updates; fetch the remainder for older chats.
        void (async () => {
          let next = pageInfo;
          for (let page = 1; page < 50 && next.hasMore && next.nextCursor; page++) {
            if (lifetime.signal.aborted || generation !== snapshotGeneration) return;
            const result = await client.paseo.agents.list({
              page: { limit: 200, cursor: next.nextCursor }, signal: lifetime.signal,
            });
            if (lifetime.signal.aborted || generation !== snapshotGeneration) return;
            for (const { agent } of result.entries) if (!touched.has(agent.id)) register(agent);
            next = result.pageInfo;
          }
        })().catch(() => {
          if (!lifetime.signal.aborted) console.warn("[Herdr] Could not load older chat home buttons");
        });
      },
      update: (message) => {
        if (message.type !== "agent_update") return;
        touched.add(message.payload.kind === "upsert" ? message.payload.agent.id : message.payload.agentId);
        if (message.payload.kind === "upsert") register(message.payload.agent);
        else remove(message.payload.agentId);
      },
      error: () => {
        if (!lifetime.signal.aborted) console.warn("[Herdr] Could not update chat home buttons");
      },
    });
  }).catch(() => {
    if (!lifetime.signal.aborted) console.warn("[Herdr] Could not observe chats for home buttons");
  });
  return () => {
    lifetime.abort();
    clear();
  };
}
