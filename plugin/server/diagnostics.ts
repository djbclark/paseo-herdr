import { diagnosticsSchema, type Diagnostics, type CompanionStatus, type HerdrTarget } from "../shared/rpc.js";

const MAX_ERROR_CHARS = 300;

export interface DiagnosticsInput {
  pluginVersion: string;
  target: HerdrTarget;
  ompEnabled: boolean;
  herdr: { connected: boolean; version: string | null; error: string | null };
  companion: CompanionStatus;
  agents: readonly { paneId: string; inputReady: boolean | null }[];
}

/**
 * The bug-report object. Every field is copied by name, so nothing else on the inputs (prompts, titles,
 * working folders, environment values, file contents) can reach the output, whatever the inputs carry.
 */
export function buildDiagnostics(input: DiagnosticsInput): Diagnostics {
  const agents = input.agents.map((agent) => ({ paneId: agent.paneId, inputReady: agent.inputReady }));
  return diagnosticsSchema.parse({
    pluginVersion: input.pluginVersion,
    target: {
      socketPath: input.target.socketPath,
      herdrSession: input.target.herdrSession,
      source: input.target.source,
      autoStart: input.target.autoStart,
    },
    ompEnabled: input.ompEnabled,
    herdr: {
      connected: input.herdr.connected,
      version: input.herdr.version,
      error: input.herdr.error === null ? null : input.herdr.error.slice(0, MAX_ERROR_CHARS),
    },
    companion: input.companion.path === undefined ? { state: input.companion.state } : { state: input.companion.state, path: input.companion.path },
    agents,
    counts: {
      agents: agents.length,
      inputReady: agents.filter((agent) => agent.inputReady === true).length,
      readOnly: agents.filter((agent) => agent.inputReady === false).length,
      unknown: agents.filter((agent) => agent.inputReady === null).length,
    },
  });
}
