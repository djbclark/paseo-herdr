import type { PluginServerContext } from "@getpaseo/plugin/server";
import { harnesses } from "./server/harness/registry.js";
import { createResolver } from "./server/harness/resolve.js";
import { ompAdapter } from "./server/harness/omp/adapter.js";
import { createHerdrProvider } from "./server/provider.js";
import { registerManagementRpcs } from "./server/rpc.js";
import { companionInstallStatus } from "./server/harness/omp/companion-install.js";
import { BoundSessions } from "./server/bound-sessions.js";
import { TargetReadiness, defaultTargetReadinessDeps, resolveTarget } from "./server/herdr/target.js";
import { PaseoHost } from "./server/host.js";
import { herdrSettings } from "./shared/settings.js";

export default function contribute(server: PluginServerContext) {
  const settings = server.registerSettings(herdrSettings);
  const env = process.env;
  // Adapter routing (F3): one resolver over every registered adapter, shared by providers and RPCs.
  const resolver = createResolver(harnesses);
  // `enableOmp` keeps gating only the omp adapter; per-adapter toggles wait for a settings wave.
  const harnessEnabled = (values: { enableOmp: boolean }, adapterId: string): boolean =>
    adapterId === ompAdapter.id ? values.enableOmp : true;
  const readiness = new TargetReadiness({ ...defaultTargetReadinessDeps(), env: () => env });
  const readSettings = async () => {
    const state = await settings.read();
    if (state.status === "invalid") throw new Error(state.error);
    return state.values;
  };
  const readTarget = async () => {
    const values = await readSettings();
    return { target: resolveTarget(values, env), ompEnabled: values.enableOmp, enabled: (adapterId: string) => harnessEnabled(values, adapterId) };
  };
  // Refreshed on every socketPath() call so the sync session hook sees the target that call resolved.
  let herdrSession: string | null = null;
  const socketPath = async () => {
    const { target } = await readTarget();
    herdrSession = target.herdrSession;
    // Only an auto-start target needs the readiness round trip; connect-only targets fail on first use.
    return target.autoStart ? (await readiness.ensureReady(target)).target.socketPath : target.socketPath;
  };
  const boundSessions = new BoundSessions();
  // Paseo gives every hook the plugin's one PaseoApi, which stays valid until the plugin stops. Provider code has no
  // other way to reach it, so capture it from the first hook that fires. Our own cards fire permission_requested.
  const host = new PaseoHost();
  for (const name of ["agent.permission_requested", "agent.turn_started", "agent.created"] as const) {
    server.on(name, (_event, context) => { host.capture(context.paseo); });
  }
  for (const adapter of harnesses) {
    server.registerProvider(createHerdrProvider(adapter, socketPath, {
      getHerdrSession: () => herdrSession,
      isEnabled: async () => harnessEnabled(await readSettings(), adapter.id),
      resolver,
      boundSessions,
      getPaseo: () => host.get(),
    }));
  }
  registerManagementRpcs(server, { readTarget, ensureReady: (target) => readiness.ensureReady(target), harnesses, boundSessions, resolver, companionStatus: () => companionInstallStatus() });
  return () => {};
}
