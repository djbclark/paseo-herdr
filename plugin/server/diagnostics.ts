import { homedir } from "node:os";
import { diagnosticsSchema, type Diagnostics, type CompanionStatus, type HerdrTarget } from "../shared/rpc.js";

const MAX_ERROR_CHARS = 300;

export interface DiagnosticsInput {
  pluginVersion: string;
  target: HerdrTarget;
  ompEnabled: boolean;
  herdr: { connected: boolean; version: string | null; autoStarted: boolean; error: string | null };
  companion: CompanionStatus;
  agents: readonly { paneId: string; inputReady: boolean | null }[];
  /** The home directory to abbreviate to `~`; defaults to the real one. Injected by tests. */
  home?: string;
}

/**
 * Replace each occurrence of the home directory with `~`, so a pasted report shows the home directory as `~`.
 * Only whole path segments match: `/Users/bobby` is not under `/Users/bob`, and `/mnt/Users/bob` isn't either.
 * A path segment ends at `/`, whitespace, a quote, a closing bracket or one of `:;,|>`; a `.` ends it only at the
 * end of the text or before whitespace (a sentence full stop), so `/Users/bob.old` stays a different directory.
 * The match is case-sensitive (a case-insensitive one would redact a different directory on a case-sensitive
 * volume), and it does not rewrite `file://` URLs or `/System/Volumes/Data/...` firmlink paths.
 */
export function abbreviateHome(text: string, home: string): string {
  const root = home.replace(/\/+$/, "");
  if (root === "") return text;
  const escaped = root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return text.replace(new RegExp(`(?<![\\w.\\-/])${escaped}(?=$|[/\\s'"\`:;,|>)\\]}]|\\.(?:$|\\s))`, "g"), "~");
}

/**
 * The bug-report object. Every field is copied by name, so nothing else on the inputs (prompts, titles,
 * working folders, environment values, file contents) can reach the output, whatever the inputs carry.
 */
export function buildDiagnostics(input: DiagnosticsInput): Diagnostics {
  const home = input.home ?? homedir();
  const short = (text: string) => abbreviateHome(text, home);
  const agents = input.agents.map((agent) => ({ paneId: agent.paneId, inputReady: agent.inputReady }));
  return diagnosticsSchema.parse({
    pluginVersion: input.pluginVersion,
    target: {
      socketPath: short(input.target.socketPath),
      herdrSession: input.target.herdrSession,
      source: input.target.source,
      autoStart: input.target.autoStart,
    },
    ompEnabled: input.ompEnabled,
    herdr: {
      connected: input.herdr.connected,
      version: input.herdr.version,
      autoStarted: input.herdr.autoStarted,
      error: input.herdr.error === null ? null : short(input.herdr.error).slice(0, MAX_ERROR_CHARS),
    },
    companion: input.companion.path === undefined ? { state: input.companion.state } : { state: input.companion.state, path: short(input.companion.path) },
    agents,
    counts: {
      agents: agents.length,
      inputReady: agents.filter((agent) => agent.inputReady === true).length,
      readOnly: agents.filter((agent) => agent.inputReady === false).length,
      unknown: agents.filter((agent) => agent.inputReady === null).length,
    },
  });
}
