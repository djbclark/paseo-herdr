import type { ProviderPermissionResponse } from "@getpaseo/plugin/server/provider";

/**
 * The slice of Paseo's `PaseoApi` the approvals bridge uses. Structural so tests can fake it and the real
 * `PluginHookContext["paseo"]` is assignable.
 */
export interface PermissionResponder {
  agents: {
    ref(agentId: string): {
      respondToPermission(options: { requestId: string; response: ProviderPermissionResponse }): Promise<void>;
    };
  };
}

/**
 * Holder for the Paseo API handle. Paseo hands one `PaseoApi` to every lifecycle hook and RPC handler of a plugin
 * (plugin-process.ts: created at initialize, closed at stop), so a handle captured in a hook stays usable after the
 * hook returns, until the plugin stops. Provider code has no other way to reach it.
 */
export class PaseoHost {
  paseo: PermissionResponder | null = null;
  capture(paseo: PermissionResponder): void { this.paseo = paseo; }
  get(): PermissionResponder | null { return this.paseo; }
}
