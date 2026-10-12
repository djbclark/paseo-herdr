import type {
  HarnessAdapter,
  TranscriptLocator,
  TranscriptReader,
  TranscriptSnapshot,
} from "../types.js";
import type { ProviderSessionConfig } from "@getpaseo/plugin/server/provider";
import type { PaneProcessInfo } from "../../herdr/schema.js";
import { FileTail } from "../../file-tail.js";
import { activeChain, lastTurnEndOf, parseOmpEntries, titleOf } from "./transcript.js";
import { mapChainToProviderItems } from "./to-provider-items.js";

/**
 * OMP adapter. OMP (oh-my-pi) is the only harness that reports a transcript
 * **path** directly (`agent_session.kind === "path"`), so the locator is the
 * path itself. `nativeSessionKey` is the path, which is what Phase 0 used, so
 * stable timeline ids remain `omp:<path>:<entryId>:<kind>:<n>`.
 */
export const ompAdapter: HarnessAdapter = {
  id: "omp",
  label: "OMP",
  herdrIntegration: "omp",
  resolveTranscript: async (ref) =>
    ref?.kind === "path" ? { path: ref.value, nativeSessionKey: ref.value } : null,
  nativeSessionKey: (ref) => ref.value,
  openTranscript: (locator: TranscriptLocator): TranscriptReader => {
    const namespace = `omp:${locator.nativeSessionKey}`;
    const tail = new FileTail(locator.path);
    let lastSnapshot: TranscriptSnapshot | null = null;
    return {
      async snapshot(): Promise<TranscriptSnapshot> {
        const { lines, updatedAt, exists } = await tail.snapshot();
        if (!exists) {
          const empty: TranscriptSnapshot = {
            items: [],
            timestamps: {},
            updatedAt,
            chainHead: null,
            chainIds: [],
            extendsPrevious: () => true,
          };
          lastSnapshot = empty;
          return empty;
        }
        const entries = parseOmpEntries(lines);
        const chain = activeChain(entries);
        const { items, timestamps } = mapChainToProviderItems(chain, namespace);
        const chainIds = items.map((item) => item.id);
        const snapshot: TranscriptSnapshot = {
          items,
          timestamps,
          ...(titleOf(entries) ? { title: titleOf(entries) } : {}),
          updatedAt,
          chainHead: chainIds.at(-1) ?? null,
          chainIds,
          ...(lastTurnEndOf(chain) ? { lastTurnEnd: lastTurnEndOf(chain) } : {}),
          extendsPrevious: (previous: TranscriptSnapshot) =>
            previous.chainIds.length === 0 ||
            (chainIds.length >= previous.chainIds.length &&
              previous.chainIds.every((id, index) => chainIds[index] === id)),
        };
        lastSnapshot = snapshot;
        return snapshot;
      },
      close(): void {
        tail.close();
      },
    };
  },
  interruptKeys: ["esc"],
  promptWhileWorking: "reject",
  launchArgs: (config: ProviderSessionConfig): string[] => {
    const args: string[] = [];
    if (config.model) args.push("--model", config.model);
    if (config.thinkingOption) args.push("--thinking", config.thinkingOption);
    return args;
  },
  isOccupant: (proc: PaneProcessInfo): boolean =>
    proc.foreground_process_group_id !== null &&
    proc.foreground_process_group_id !== undefined &&
    proc.foreground_processes.some((p) => p.pid === proc.foreground_process_group_id),
  blockedHint: "OMP needs approval in the terminal — run: herdr agent attach <target>",
};
