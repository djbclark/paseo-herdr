import type {
  HarnessAdapter,
  TranscriptLocator,
  TranscriptReader,
  TranscriptSnapshot,
} from "../types.js";
import type { ProviderSessionConfig } from "@getpaseo/plugin/server/provider";
import type { AgentSessionRef, PaneProcessInfo } from "../../herdr/schema.js";
import { FileTail } from "../../file-tail.js";
import { access } from "node:fs/promises";
import { configureOmp, inspectOmpInput, ompInputSocketPath, readOmpConfig, submitOmpInput } from "./input.js";
import { activeChain, lastTurnEndOf, lastTurnEndIdOf, modelOf, thinkingLevelOf, turnStateOf, parseOmpEntries, titleOf } from "./transcript.js";
import { mapChainToProviderItems } from "./to-provider-items.js";
import { companionInstallStatus } from "./companion-install.js";
import { findOmpForks } from "./forks.js";

/**
 * OMP adapter. OMP (oh-my-pi) is the only harness that reports a transcript
 * **path** directly (`agent_session.kind === "path"`), so the locator is the
 * path itself. `nativeSessionKey` is the path, which is what Phase 0 used, so
 * stable timeline ids remain `omp:<path>:<entryId>:<kind>:<n>`.
 */
export const ompAdapter: HarnessAdapter = {
  id: "omp",
  label: "OMP",
  icon: "assets/omp-herdr.svg",
  herdrIntegration: "omp",
  resolveTranscript: async (ref) =>
    ref?.kind === "path" ? { path: ref.value, nativeSessionKey: ref.value } : null,
  nativeSessionKey: (ref) => ref.value,
  openTranscript: (locator: TranscriptLocator): TranscriptReader => {
    const namespace = `omp:${locator.nativeSessionKey}`;
    const tail = new FileTail(locator.path);
    return {
      async snapshot(): Promise<TranscriptSnapshot> {
        const { lines, updatedAt, exists } = await tail.snapshot();
        if (!exists) {
          const empty: TranscriptSnapshot = {
            items: [],
            timestamps: {},
            updatedAt,
            turnState: "idle",
            chainHead: null,
            chainIds: [],
            extendsPrevious: () => true,
          };
          return empty;
        }
        const entries = parseOmpEntries(lines);
        const chain = activeChain(entries);
        const { items, timestamps } = mapChainToProviderItems(chain, namespace);
        const chainIds = chain.flatMap((entry) => typeof entry.id === "string" ? [entry.id] : []);
        const snapshot: TranscriptSnapshot = {
          items,
          timestamps,
          ...(titleOf(entries) ? { title: titleOf(entries) } : {}),
          updatedAt,
          turnState: turnStateOf(chain),
          lastTurnEndId: lastTurnEndIdOf(chain),
          chainHead: chainIds.at(-1) ?? null,
          chainIds,
          ...(lastTurnEndOf(chain) ? { lastTurnEnd: lastTurnEndOf(chain) } : {}),
          ...(modelOf(chain) !== undefined ? { model: modelOf(chain) } : {}),
          ...(thinkingLevelOf(chain) !== undefined ? { thinkingLevel: thinkingLevelOf(chain) } : {}),
          extendsPrevious: (previous: TranscriptSnapshot) =>
            previous.chainIds.length === 0 ||
            (chainIds.length >= previous.chainIds.length &&
              previous.chainIds.every((id, index) => chainIds[index] === id)),
        };
        return snapshot;
      },
      close(): void {
        tail.close();
      },
      subscribe(listener: () => void): () => void {
        return tail.subscribe(listener);
      },
    };
  },
  inspectInput: ({ pid, ref }, signal) => inspectOmpInput(pid, ref, signal),
  submitPrompt: ({ pid, ref, instanceId }, text, { signal }) => submitOmpInput(pid, ref, instanceId, text, signal),
  findForks: findOmpForks,
  readConfig: ({ pid, ref, instanceId }, signal) => readOmpConfig(pid, ref, instanceId, signal),
  configure: ({ pid, ref, instanceId }, changes, signal) => configureOmp(pid, ref, instanceId, changes, signal),
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
    proc.foreground_processes.some((p) => p.pid === proc.foreground_process_group_id &&
      (p.name === "omp" || /(?:^|\/)omp$/.test(p.argv0 ?? "")) &&
      !p.argv?.some((arg) => arg.startsWith("__omp_worker_"))),
  resumeArgs: (ref: AgentSessionRef): string[] => ["--resume", ref.value],
  inputReachable: (pid: number): Promise<boolean> => access(ompInputSocketPath(pid)).then(() => true, () => false),
  blockedHint: "OMP needs approval in the terminal — run: herdr agent attach <target>",
  inputCompanionStatus: async () => {
    const status = await companionInstallStatus();
    if (status.state === "current") return { ok: true };
    if (status.state === "missing") return { ok: false, diagnostic: "OMP input companion is not installed; imported agents are read-only. Run `npm run install:omp-companion` in paseo-herdr/plugin, then restart OMP agents." };
    if (status.state === "outdated") return { ok: false, diagnostic: "OMP input companion is outdated. Rerun `npm run install:omp-companion` in paseo-herdr/plugin, then restart OMP agents." };
    return { ok: false, diagnostic: `A different file exists at ${status.path}. Rerun the installer with --force to replace it.` };
  },
};
