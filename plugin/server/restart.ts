import type { HarnessAdapter } from "./harness/types.js";
import { randomBytes } from "node:crypto";
import { HerdrError } from "./herdr/client.js";
import { AgentListResultSchema, AgentStartedResultSchema, PaneProcessInfoResultSchema, type AgentInfo } from "./herdr/schema.js";

/**
 * In-place restart of an idle harness agent so it loads extensions installed after it started (R35):
 * stop the process, then start the harness again in the same pane, resuming the same native session.
 * The terminal id, pane and session stay the same, so its Paseo chat keeps its binding. Never force-kills,
 * and never retries a start that might have succeeded.
 */

export interface RestartDeps {
  request(method: string, params?: Record<string, unknown>): Promise<unknown>;
  /** Default: `process.kill`. */
  signal?(pid: number, signal: NodeJS.Signals): void;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export class RestartError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RestartError";
  }
}

const EXIT_TIMEOUT_MS = 5_000;
const BUSY_WINDOW_MS = 3_000;
const READY_TIMEOUT_MS = 30_000;
const POLL_MS = 150;

export async function restartAgent(deps: RestartDeps, adapter: HarnessAdapter, target: { terminalId: string; paneId: string }): Promise<{ pid: number }> {
  const launch = adapter.launch;
  if (!launch) throw new RestartError(`${adapter.label} agents can't be restarted from Paseo.`);
  const kind = launch.kind;
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const kill = deps.signal ?? ((pid: number, signal: NodeJS.Signals) => process.kill(pid, signal));
  const agents = async () => AgentListResultSchema.parse(await deps.request("agent.list", {})).agents;
  const foreground = async () => PaneProcessInfoResultSchema.parse(await deps.request("pane.process_info", { pane_id: target.paneId })).process_info;

  const agent = (await agents()).find((candidate) => candidate.terminal_id === target.terminalId);
  if (!agent) throw new RestartError("The agent is no longer running in Herdr.");
  if (agent.agent !== kind) throw new RestartError(`This pane no longer runs ${adapter.label}.`);
  if (agent.pane_id !== target.paneId) throw new RestartError("The agent moved to another pane; refresh and try again.");
  if (agent.agent_status !== "idle" && agent.agent_status !== "done") {
    throw new RestartError(`Only an idle or finished agent can be restarted; this one is ${agent.agent_status}.`);
  }
  const ref = agent.agent_session;
  if (!ref) throw new RestartError(`${adapter.label} reports no saved session for this agent, so a restart couldn't resume it.`);
  if (!adapter.resumeArgs) throw new RestartError(`${adapter.label} agents can't be restarted from Paseo.`);
  const args = adapter.resumeArgs({ kind: ref.kind, value: ref.value });

  const before = await foreground();
  const pid = before.foreground_process_group_id;
  if (!pid || !adapter.isOccupant(before)) throw new RestartError(`The pane's foreground process isn't ${adapter.label}; nothing was changed.`);
  kill(pid, "SIGTERM");
  for (const deadline = now() + EXIT_TIMEOUT_MS; ;) {
    await sleep(POLL_MS);
    if (!adapter.isOccupant(await foreground())) break;
    if (now() >= deadline) throw new RestartError(`${adapter.label} didn't exit within ${EXIT_TIMEOUT_MS / 1000} s; nothing was started. Check the pane in a terminal.`);
  }

  // The pane is back at its shell; Herdr may still report the old agent for a moment (agent_pane_busy).
  // Manually started agents can be unnamed, but Herdr's agent.start requires a name.
  const params = { kind, pane_id: target.paneId, timeout_ms: READY_TIMEOUT_MS, args,
    name: agent.name ?? `paseo-${randomBytes(6).toString("hex")}` };
  let startError: unknown;
  for (const deadline = now() + BUSY_WINDOW_MS; ;) {
    try {
      AgentStartedResultSchema.parse(await deps.request("agent.start", params));
      break;
    } catch (error) {
      // A timed-out reply does not prove the start failed. Observe the process
      // below; never send agent.start again after an uncertain outcome.
      if (!(error instanceof HerdrError) || error.code === "timeout" || error.code === "agent_not_ready") {
        startError = error;
        break;
      }
      if (!(error instanceof HerdrError && error.code === "agent_pane_busy") || now() >= deadline) {
        throw new RestartError(`${adapter.label} stopped, but starting it again failed: ${error instanceof Error ? error.message : String(error)}. Run \`${[kind, ...args].join(" ")}\` in the pane.`);
      }
      await sleep(POLL_MS);
    }
  }

  for (const deadline = now() + READY_TIMEOUT_MS; ;) {
    await sleep(POLL_MS);
    const restarted: AgentInfo | undefined = (await agents()).find((candidate) => candidate.pane_id === target.paneId);
    if (restarted?.terminal_id === target.terminalId && restarted.agent === kind &&
        restarted.agent_session?.kind === ref.kind && restarted.agent_session.value === ref.value &&
        (restarted.agent_status === "idle" || restarted.agent_status === "done")) {
      const after = await foreground();
      const nextPid = after.foreground_process_group_id;
      if (after.pane_id === target.paneId && nextPid && nextPid !== pid && adapter.isOccupant(after)) {
        // Resumed agents can remain launch_pending in Herdr even with a working
        // TUI. The process-local companion proves that input is actually enabled.
        const identity = await adapter.inspectInput({ pid: nextPid, ref: { kind: ref.kind, value: ref.value } }).catch(() => null);
        if (identity?.pid === nextPid) return { pid: nextPid };
      }
    }
    if (now() >= deadline) throw new RestartError(`${adapter.label} was started again but input couldn't be verified after ${READY_TIMEOUT_MS / 1000} s; check the pane in a terminal.${startError ? ` Start response: ${String(startError)}` : ""}`);
  }
}
