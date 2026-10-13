import { describe, expect, it, vi } from "vitest";
import { createCatalogFollower } from "../client/catalog.js";

function rig(initial: string[], afterRefresh: string[]) {
  let models = initial;
  const listModels = vi.fn(async () => ({ models: models.map((id) => ({ id })) }));
  const refresh = vi.fn(async () => { models = afterRefresh; return {}; });
  let clock = 0;
  const follow = createCatalogFollower({ providers: { listModels, refresh } } as never, { now: () => clock, minIntervalMs: 60_000 });
  return { follow, listModels, refresh, advance: (ms: number) => { clock += ms; } };
}
const chat = (model: string | null, provider = "herdr-omp") => ({ provider, runtimeInfo: { model } });

describe("createCatalogFollower", () => {
  it("refreshes the provider once when a chat's active model isn't in Paseo's list", async () => {
    const { follow, refresh } = rig(["native-default"], ["native-default", "p/switched"]);
    await follow(chat("p/switched"));
    expect(refresh).toHaveBeenCalledExactlyOnceWith({ providers: ["herdr-omp"] });
    await follow(chat("p/switched"));
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("does nothing for known models, other providers or chats without a model", async () => {
    const { follow, refresh, listModels } = rig(["p/known"], ["p/known"]);
    await follow(chat("p/known"));
    await follow(chat("x/y", "claude"));
    await follow(chat(null));
    expect(refresh).not.toHaveBeenCalled();
    expect(listModels).toHaveBeenCalledTimes(1);
  });

  it("refreshes at most once per interval and never concurrently", async () => {
    const { follow, refresh, advance } = rig(["native-default"], ["native-default"]);
    await Promise.all([follow(chat("p/a")), follow(chat("p/a"))]);
    expect(refresh).toHaveBeenCalledTimes(1);
    await follow(chat("p/b"));
    expect(refresh).toHaveBeenCalledTimes(1);
    advance(60_000);
    await follow(chat("p/b"));
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it("swallows SDK failures", async () => {
    const follow = createCatalogFollower({ providers: { listModels: async () => { throw new Error("offline"); }, refresh: vi.fn() } } as never);
    await expect(follow(chat("p/a"))).resolves.toBeUndefined();
  });
});
