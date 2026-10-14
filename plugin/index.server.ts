import type { PluginServerContext } from "@getpaseo/plugin/server";
import { harnesses } from "./server/harness/registry.js";
import { createHerdrProvider } from "./server/provider.js";
import { registerManagementRpcs } from "./server/rpc.js";
import { BoundSessions } from "./server/bound-sessions.js";
import { TargetReadiness, defaultTargetReadinessDeps, resolveTarget } from "./server/herdr/target.js";
import { PaseoHost } from "./server/host.js";
import { herdrSettings } from "./shared/settings.js";

export default function contribute(server: PluginServerContext) {
  const settings = server.registerSettings(herdrSettings);
  const env = process.env;
  const readiness = new TargetReadiness({ ...defaultTargetReadinessDeps(), env: () => env });
  const readSettings = async () => {
    const state = await settings.read();
    if (state.status === "invalid") throw new Error(state.error);
    return state.values;
  };
  const readTarget = async () => {
    const values = await readSettings();
    return { target: resolveTarget(values, env), ompEnabled: values.enableOmp };
  };
  // Refreshed on every socketPath() call so the sync session hook sees the target that call resolved.
  let herdrSession: string | null = null;
  const socketPath = async () => {
    const { target } = await readTarget();
    herdrSession = target.herdrSession;
    // Only an auto-start target needs the readiness round trip; connect-only targets fail on first use.
    return target.autoStart ? (await readiness.ensureReady(target)).target.socketPath : target.socketPath;
  };
  const isEnabled = async () => (await readSettings()).enableOmp;
  const boundSessions = new BoundSessions();
  // Paseo gives every hook the plugin's one PaseoApi, which stays valid until the plugin stops. Provider code has no
  // other way to reach it, so capture it from the first hook that fires. Our own cards fire permission_requested.
  const host = new PaseoHost();
  for (const name of ["agent.permission_requested", "agent.turn_started", "agent.created"] as const) {
    server.on(name, (_event, context) => { host.capture(context.paseo); });
  }
  for (const adapter of harnesses) {
    server.registerProvider(createHerdrProvider(adapter, socketPath, { getHerdrSession: () => herdrSession, isEnabled, boundSessions, getPaseo: () => host.get() }));
  }
  registerManagementRpcs(server, { readTarget, ensureReady: (target) => readiness.ensureReady(target), harnesses, boundSessions });
  return () => {};
}
