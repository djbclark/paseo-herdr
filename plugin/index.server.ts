import type { PluginServerContext } from "@getpaseo/plugin/server";
import { harnesses } from "./server/harness/registry.js";
import { createHerdrProvider } from "./server/provider.js";
import { herdrSettings } from "./server/settings.js";
import { herdrSessionName, resolveSocketPath } from "./server/herdr/socket-path.js";

export default function contribute(server: PluginServerContext) {
  const settings = server.registerSettings(herdrSettings);
  // Refreshed on every socketPath() call so the sync session hook sees the latest setting before any session/launch uses it.
  let herdrSession: string | null = null;
  const socketPath = async () => {
    const state = await settings.read();
    if (state.status === "invalid") throw new Error(state.error);
    const path = resolveSocketPath({ path: state.values.herdrSocketPath || undefined, session: state.values.herdrSession || undefined });
    herdrSession = herdrSessionName({ setting: state.values.herdrSession, env: process.env, socketPath: path });
    return path;
  };
  for (const adapter of harnesses) server.registerProvider(createHerdrProvider(adapter, socketPath, { getHerdrSession: () => herdrSession }));
  return () => {};
}
