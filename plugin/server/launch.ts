import type { ProviderSessionConfig } from "@getpaseo/plugin/server/provider";
import type { HarnessAdapter } from "./harness/types.js";
import { randomBytes } from "node:crypto";
import { realpath as defaultRealpath, stat } from "node:fs/promises";
import { basename, isAbsolute, normalize, sep } from "node:path";
import { HerdrError } from "./herdr/client.js";
import { attachCommand, paneReadCommand } from "./herdr-commands.js";
import {
  AgentInfoResultSchema,
  AgentStartedResultSchema,
  PaneListResultSchema,
  PaneProcessInfoResultSchema,
  PaneReadResultSchema,
  TabCreatedResultSchema,
  WorkspaceCreatedResultSchema,
  type AgentInfo,
  type AgentSessionRef,
} from "./herdr/schema.js";

/**
 * Create path (P3): launch a harness agent in Herdr and wait until it is ready.
 * Contract frozen from spike 5 (IMPLEMENTATION.md R25-R30). Harness-neutral:
 * only `adapter.id` (agent.start kind) and `adapter.launchArgs` are used.
 */

export interface LaunchDeps {
  /** One-shot Herdr request (client.request). Errors are HerdrError with `.code`. */
  request(method: string, params?: Record<string, unknown>, options?: { signal?: AbortSignal }): Promise<unknown>;
  /** Injected for tests; default Date.now / setTimeout. */
  now?: () => number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** Injected for tests; default random `paseo-<6 hex>`. */
  makeName?: () => string;
  /** Injected for tests; default fs.stat on the path. Must reject for missing or non-directory paths. */
  checkDirectory?: (path: string) => Promise<void>;
  /** Injected for tests; default fs.promises.realpath. Used only when reported and requested paths differ as strings. */
  realpath?: (path: string) => Promise<string>;
  /** Herdr session name (null/absent = default session); only used to build recovery commands in error messages. */
  herdrSession?: string | null;
}

/** Everything known about a launched agent; enough to persist a Binding. */
export interface LaunchResult {
  agentName: string;
  terminalId: string;
  paneId: string;
  tabId: string;
  workspaceId: string;
  /** `true` when this launch created the workspace (not just a tab). */
  createdWorkspace: boolean;
  cwd: string;
  /** Native session ref as reported by Herdr; typically reported before ready (R27). */
  sessionRef: AgentSessionRef | null;
}

/**
 * Failure with everything the user needs to recover: what was created and how
 * to look at it. `resources` is omitted when nothing was created.
 */
export class LaunchError extends Error {
  constructor(
    message: string,
    readonly code: "invalid_cwd" | "cwd_mismatch" | "start_rejected" | "exited" | "not_ready" | "timeout" | "aborted" | "unreachable",
    readonly resources?: { workspaceId: string; tabId: string; paneId: string; terminalId: string; agentName?: string },
  ) {
    super(message);
    this.name = "LaunchError";
  }
}

type Resources = NonNullable<LaunchError["resources"]>;
type Created = { workspaceId: string; tabId: string; paneId: string; terminalId: string };

const START_TIMEOUT_MS = 30_000;
const DEADLINE_SLACK_MS = 1_000;
const POLL_MS = 150;
const BUSY_RETRY_MS = 150;
const BUSY_WINDOW_MS = 2_000;
const GHOST_MS = 1_500;
const UNREACHABLE_MS = 5_000;
const MAX_NAMES = 3;
const PANE_TAIL_LINES = 5;

const defaultSleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal?.addEventListener("abort", done, { once: true });
  });

async function defaultCheckDirectory(path: string): Promise<void> {
  if (!(await stat(path)).isDirectory()) throw new Error(`${path} is not a directory`);
}

function normalizePath(path: string): string {
  const normalized = normalize(path);
  return normalized.length > 1 && normalized.endsWith(sep) ? normalized.slice(0, -1) : normalized;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isNotFound(error: unknown): boolean {
  return error instanceof HerdrError && error.code === "agent_not_found";
}

export async function launchAgent(
  deps: LaunchDeps,
  adapter: HarnessAdapter,
  config: ProviderSessionConfig,
  signal: AbortSignal,
): Promise<LaunchResult> {
  const now = deps.now ?? Date.now;
  const sleepFn = deps.sleep ?? defaultSleep;
  const makeName = deps.makeName ?? (() => `paseo-${randomBytes(3).toString("hex")}`);
  const checkDirectory = deps.checkDirectory ?? defaultCheckDirectory;
  const realpath = deps.realpath ?? defaultRealpath;
  const realOf = async (path: string): Promise<string | null> => {
    try {
      return await realpath(path);
    } catch {
      return null;
    }
  };
  const cwd = config.cwd;

  let created: Created | undefined;
  let createdWorkspace = false;
  let agentName: string | undefined;
  /** True once an agent.start request has been sent that might have taken effect. */
  let startAttempted = false;

  const call = (method: string, params?: Record<string, unknown>) => deps.request(method, params, { signal });
  const resources = (): Resources | undefined => (created ? { ...created, ...(agentName ? { agentName } : {}) } : undefined);
  const herdrSession = deps.herdrSession ?? null;
  const where = (code?: LaunchError["code"]): string => {
    if (!created) return "";
    const base = `Herdr workspace ${created.workspaceId}, tab ${created.tabId}, pane ${created.paneId}`;
    // After an exit (or a dead Herdr) the named agent is gone, so only the pane can still be inspected.
    if (code === "exited" || code === "unreachable") return `${base}; inspect the pane with: ${paneReadCommand(herdrSession, created.paneId)}`;
    return agentName ? `${base}; attach with: ${attachCommand(herdrSession, agentName)}` : base;
  };
  const fail = (code: LaunchError["code"], message: string): LaunchError => {
    const place = where(code);
    return new LaunchError(place ? `${message} (${place})` : message, code, resources());
  };
  const abortedError = (): LaunchError => fail("aborted", "Launch aborted");
  const sleep = async (ms: number): Promise<void> => {
    try {
      await sleepFn(ms, signal);
    } catch {
      // The abort check that follows decides what to do.
    }
  };

  /** Start of the current run of consecutive transport failures (no reply at all from Herdr); null while replies arrive. */
  let transportDownSince: number | null = null;
  /** Records a reply of any kind (including error replies): Herdr is reachable. */
  const noteReply = (): void => {
    transportDownSince = null;
  };
  /** Records a failure to get any reply; throws "unreachable" once it has lasted UNREACHABLE_MS. */
  const noteTransportFailure = (error: unknown): void => {
    const at = now();
    transportDownSince ??= at;
    if (at - transportDownSince >= UNREACHABLE_MS) {
      throw fail(
        "unreachable",
        `Herdr became unreachable during launch (no reply for ${Math.round((at - transportDownSince) / 1000)}s: ${describe(error)}); the agent was probably stopped with it. Check Herdr and the pane`,
      );
    }
  };

  /** Best-effort diagnostic: last few non-empty lines of the pane. Never throws. */
  const paneTail = async (): Promise<string> => {
    if (!created) return "";
    try {
      const reply = PaneReadResultSchema.parse(
        await deps.request("pane.read", { pane_id: created.paneId, source: "recent", lines: 40, strip_ansi: true }),
      );
      const lines = reply.read.text.split("\n").map((line) => line.trimEnd()).filter((line) => line.trim() !== "");
      return lines.slice(-PANE_TAIL_LINES).join("\n");
    } catch {
      return "";
    }
  };
  const exitedError = async (reason: string): Promise<LaunchError> => {
    const tail = await paneTail();
    return fail("exited", tail ? `${reason}. Last pane output:\n${tail}\n` : reason);
  };

  /** Close what this launch created; only legal before agent.start was attempted. */
  const cleanup = async (): Promise<void> => {
    if (!created || startAttempted) return;
    try {
      if (createdWorkspace) await deps.request("workspace.close", { workspace_id: created.workspaceId });
      else await deps.request("tab.close", { tab_id: created.tabId });
    } catch {
      // Best effort.
    }
  };

  try {
    // 1. Validate the directory; Herdr would silently substitute $HOME.
    if (!isAbsolute(cwd)) throw new LaunchError(`Working directory must be an absolute path: ${cwd}`, "invalid_cwd");
    try {
      await checkDirectory(cwd);
    } catch (error) {
      throw new LaunchError(`Working directory does not exist or is not a directory: ${cwd} (${describe(error)})`, "invalid_cwd");
    }
    if (signal.aborted) throw abortedError();

    // 2. Pick a place: a new tab in a workspace already rooted at cwd, else a new workspace.
    const wanted = normalizePath(cwd);
    // Same directory under another spelling (symlink): realpath both sides, but only when the strings differ.
    let wantedReal: Promise<string | null> | undefined;
    const sameDirectory = async (reported: string): Promise<boolean> => {
      if (normalizePath(reported) === wanted) return true;
      wantedReal ??= realOf(cwd);
      const real = await realOf(reported);
      return real !== null && real === (await wantedReal);
    };
    let rootPane: { pane_id: string; terminal_id: string; workspace_id: string; tab_id: string; cwd?: string | null; foreground_cwd?: string | null };
    try {
      const panes = PaneListResultSchema.parse(await call("pane.list")).panes;
      let host: (typeof panes)[number] | undefined;
      for (const pane of panes) {
        if (pane.cwd != null && (await sameDirectory(pane.cwd))) {
          host = pane;
          break;
        }
      }
      if (host) {
        const reply = TabCreatedResultSchema.parse(
          await call("tab.create", { workspace_id: host.workspace_id, cwd, focus: false, label: "paseo" }),
        );
        rootPane = reply.root_pane;
        created = { workspaceId: reply.tab.workspace_id, tabId: reply.tab.tab_id, paneId: rootPane.pane_id, terminalId: rootPane.terminal_id };
      } else {
        const reply = WorkspaceCreatedResultSchema.parse(
          await call("workspace.create", { cwd, label: basename(cwd) || cwd, focus: false }),
        );
        rootPane = reply.root_pane;
        createdWorkspace = true;
        created = { workspaceId: reply.workspace.workspace_id, tabId: reply.tab.tab_id, paneId: rootPane.pane_id, terminalId: rootPane.terminal_id };
      }
    } catch (error) {
      if (error instanceof LaunchError) throw error;
      if (signal.aborted) throw abortedError();
      throw new LaunchError(`Herdr could not create a pane for ${cwd}: ${describe(error)}`, "start_rejected");
    }
    const paneCreatedAt = now();

    // 3. Herdr falls back to $HOME for bad cwds; verify, and undo if it did.
    const actual = rootPane.cwd ?? rootPane.foreground_cwd;
    if (actual == null || !(await sameDirectory(actual))) {
      const made = created;
      await cleanup();
      created = undefined;
      throw new LaunchError(
        `Herdr started the pane in ${actual ?? "an unknown directory"} instead of ${cwd}; closed the new ${createdWorkspace ? "workspace" : "tab"} ${createdWorkspace ? made.workspaceId : made.tabId}`,
        "cwd_mismatch",
      );
    }
    if (signal.aborted) {
      await cleanup();
      const message = "Launch aborted before the agent was started; closed the new pane";
      created = undefined;
      throw new LaunchError(message, "aborted");
    }
    const target = created;

    // 4. Start the agent. Only definite rejections are retried; an ambiguous failure
    //    goes straight to polling because the command may already be typed.
    let name = makeName();
    let namesUsed = 1;
    let startOk = false;
    let startedAt = now();
    for (;;) {
      agentName = name;
      startedAt = now();
      startAttempted = true;
      try {
        AgentStartedResultSchema.parse(
          await call("agent.start", {
            name,
            kind: adapter.id,
            pane_id: target.paneId,
            args: adapter.launchArgs(config),
            timeout_ms: START_TIMEOUT_MS,
          }),
        );
        startOk = true;
        break;
      } catch (error) {
        if (signal.aborted) throw abortedError();
        if (!(error instanceof HerdrError)) {
          noteTransportFailure(error); // starts the unreachable clock; polling decides whether Herdr comes back
          break; // Unknown whether the start happened: reconcile by polling.
        }
        if (error.code === "agent_pane_busy") {
          if (now() - paneCreatedAt < BUSY_WINDOW_MS) {
            startAttempted = false; // rejected before anything was typed
            await sleep(BUSY_RETRY_MS);
            if (signal.aborted) {
              await cleanup();
              created = undefined;
              throw new LaunchError("Launch aborted before the agent was started; closed the new pane", "aborted");
            }
            continue;
          }
          throw fail("start_rejected", `Herdr kept reporting the new pane as busy: ${error.message}`);
        }
        if (error.code === "agent_name_taken" && namesUsed < MAX_NAMES) {
          name = makeName();
          namesUsed += 1;
          continue;
        }
        throw fail("start_rejected", `Herdr rejected agent.start (${error.code}): ${error.message}`);
      }
    }

    // 5. Poll until ready or a failure predicate fires.
    const deadline = startedAt + START_TIMEOUT_MS + DEADLINE_SLACK_MS;
    let registered = startOk; // the name is known to exist in Herdr
    let agentEverSet = false;
    let ghostSince: number | null = null;

    const readyOf = (info: AgentInfo): boolean =>
      info.agent === adapter.id && info.interactive_ready && (info.agent_status === "idle" || info.agent_status === "done");
    const resultOf = (info: AgentInfo): LaunchResult => ({
      agentName: name,
      terminalId: target.terminalId,
      paneId: target.paneId,
      tabId: target.tabId,
      workspaceId: target.workspaceId,
      createdWorkspace,
      cwd,
      sessionRef: info.agent_session ? { kind: info.agent_session.kind, value: info.agent_session.value } satisfies AgentSessionRef : null,
    });

    const getAgent = async (key: string): Promise<AgentInfo | null> => {
      let reply: unknown;
      try {
        reply = await call("agent.get", { target: key });
      } catch (error) {
        if (signal.aborted) throw abortedError();
        if (!(error instanceof HerdrError)) noteTransportFailure(error);
        else noteReply();
        if (isNotFound(error)) return null;
        throw error;
      }
      noteReply();
      return AgentInfoResultSchema.parse(reply).agent;
    };

    for (;;) {
      if (signal.aborted) throw abortedError();
      const tick = now();
      let byName: AgentInfo | null | undefined;
      try {
        byName = await getAgent(name);
      } catch (error) {
        if (error instanceof LaunchError) throw error;
        byName = undefined; // transient failure: try again until the deadline
      }

      if (byName) {
        registered = true;
        if (byName.terminal_id !== target.terminalId || (byName.name != null && byName.name !== name)) {
          throw fail("not_ready", `Herdr agent ${name} no longer matches the launched terminal`);
        }
        if (byName.agent) agentEverSet = true;
        if (byName.agent && byName.agent !== adapter.id) {
          throw fail("not_ready", `Herdr detected agent "${byName.agent}" in the pane instead of "${adapter.id}"`);
        }
        if (byName.agent_status === "blocked") {
          throw fail("not_ready", `Agent ${name} is blocked waiting for input before it is ready`);
        }
        if (readyOf(byName)) return resultOf(byName);

        if (byName.launch_pending && !byName.agent && !agentEverSet) {
          // GHOST: the process exited before Herdr ever detected it.
          let idle = false;
          try {
            const info = PaneProcessInfoResultSchema.parse(await call("pane.process_info", { pane_id: target.paneId })).process_info;
            idle = info.shell_pid != null && info.foreground_process_group_id === info.shell_pid;
          } catch {
            if (signal.aborted) throw abortedError();
          }
          if (!idle) ghostSince = null;
          else {
            ghostSince ??= tick;
            if (now() - ghostSince >= GHOST_MS) {
              throw await exitedError(`${adapter.id} exited right after starting`);
            }
          }
        } else {
          ghostSince = null;
        }
      } else if (byName === null) {
        // Name is gone (or never registered). Look at the pane.
        let byPane: AgentInfo | null | undefined;
        try {
          byPane = await getAgent(target.paneId);
        } catch (error) {
          if (error instanceof LaunchError) throw error;
          byPane = undefined;
        }
        if (byPane === null && registered) {
          throw await exitedError(`${adapter.id} exited before it became ready`);
        }
        if (byPane) {
          if (byPane.terminal_id !== target.terminalId || (byPane.name != null && byPane.name !== name)) {
            throw fail("not_ready", `The pane now hosts a different agent than the one launched`);
          }
          if (byPane.agent && byPane.agent !== adapter.id) {
            throw fail("not_ready", `Herdr detected agent "${byPane.agent}" in the pane instead of "${adapter.id}"`);
          }
          if (byPane.agent === adapter.id) {
            // TIMEOUT ORPHAN (or unnamed after a lost start reply): re-attach our name.
            try {
              await call("agent.rename", { target: target.paneId, name });
            } catch (error) {
              if (signal.aborted) throw abortedError();
              throw fail("timeout", `${adapter.id} is running but Herdr would not re-attach the name ${name}: ${describe(error)}`);
            }
            registered = true;
            agentEverSet = true;
            if (readyOf(byPane)) return resultOf(byPane);
            if (byPane.agent_status === "blocked") {
              throw fail("not_ready", `Agent ${name} is blocked waiting for input before it is ready`);
            }
          }
        }
      }

      if (now() >= deadline) {
        throw fail(
          "timeout",
          `Agent ${name} was not ready within ${Math.round((START_TIMEOUT_MS + DEADLINE_SLACK_MS) / 1000)}s; ${adapter.id} may still be starting`,
        );
      }
      await sleep(POLL_MS);
    }
  } catch (error) {
    if (error instanceof LaunchError) throw error;
    if (signal.aborted) throw abortedError();
    throw fail(startAttempted ? "not_ready" : "start_rejected", `Unexpected launch failure: ${describe(error)}`);
  }
}
