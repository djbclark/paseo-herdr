import type { PluginServerContext } from "@getpaseo/plugin/server";
import { harnesses } from "./server/harness/registry.js";
import { createHerdrProvider } from "./server/provider.js";
import { herdrSettings } from "./server/settings.js";
import { resolveSocketPath } from "./server/herdr/socket-path.js";

export default function contribute(server: PluginServerContext) {
  const settings = server.registerSettings(herdrSettings);
  const socketPath = async () => {
    const state = await settings.read();
    if (state.status === "invalid") throw new Error(state.error);
    return resolveSocketPath({ path: state.values.herdrSocketPath || undefined, session: state.values.herdrSession || undefined });
  };
  for (const adapter of harnesses) server.registerProvider(createHerdrProvider(adapter, socketPath));
  return () => {};
}
