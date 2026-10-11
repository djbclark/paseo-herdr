import type { PluginServerContext } from "@getpaseo/plugin/server";
import { harnesses } from "./server/harness/registry.js";
import { createHerdrProvider } from "./server/provider.js";
import { herdrSettings } from "./server/settings.js";

export default function contribute(server: PluginServerContext) {
  const settings = server.registerSettings(herdrSettings);
  const socketPath = async () => {
    const state = await settings.read();
    if (state.status === "invalid") throw new Error(state.error);
    const path = state.values.herdrSocketPath || process.env.HERDR_SOCKET_PATH;
    if (!path) throw new Error("Set the herdrSocketPath plugin setting or HERDR_SOCKET_PATH");
    return path;
  };
  for (const adapter of harnesses) server.registerProvider(createHerdrProvider(adapter, socketPath));
  return () => {};
}
