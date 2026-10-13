import { expect, it } from "vitest";
import { RestartError, restartAgent } from "../server/restart.js";
import { HerdrError } from "../server/herdr/client.js";
import { ompAdapter } from "../server/harness/omp/adapter.js";

const SESSION = { source: "herdr:omp", agent: "omp", kind: "path", value: "/s/a.jsonl" };
const agentInfo = (over: object = {}) => ({ terminal_id: "t1", name: null, agent: "omp", agent_status: "idle", agent_session: SESSION,
  workspace_id: "w1", tab_id: "w1:t1", pane_id: "w1:p1", focused: false, interactive_ready: true, revision: 1, ...over });
const proc = (pid: number, name: string) => ({ type: "pane_process_info", process_info: { pane_id: "w1:p1", foreground_process_group_id: pid, foreground_processes: [{ pid, name }] } });

/** Scripted Herdr: OMP (pid 10) until SIGTERM, then the shell, then OMP again (pid 20) once started. */
function rig(options: { status?: string; exits?: boolean; startErrors?: HerdrError[] } = {}) {
  const calls: Array<{ method: string; params?: Record<string, unknown> }> = [];
  const signals: number[] = [];
  let phase: "old" | "shell" | "new" = "old";
  const startErrors = [...(options.startErrors ?? [])];
  let clock = 0;
  const deps = {
    now: () => clock,
    sleep: async (ms: number) => { clock += ms; },
    signal: (pid: number) => { signals.push(pid); if (options.exits !== false) phase = "shell"; },
    request: async (method: string, params?: Record<string, unknown>) => {
      calls.push({ method, params });
      if (method === "agent.list") return { type: "agent_list", agents: phase === "shell" ? [] : [agentInfo({ agent_status: phase === "old" ? options.status ?? "idle" : "idle" })] };
      if (method === "pane.process_info") return phase === "old" ? proc(10, "omp") : phase === "shell" ? proc(5, "zsh") : proc(20, "omp");
      if (method === "agent.start") {
        const error = startErrors.shift();
        if (error) throw error;
        phase = "new";
        return { type: "agent_started", agent: agentInfo({ launch_pending: true }) };
      }
      throw new Error(`unexpected ${method}`);
    },
  };
  return { deps, calls, signals };
}

it("stops the idle agent and resumes the same session in the same pane", async () => {
  const { deps, calls, signals } = rig();
  await expect(restartAgent(deps, ompAdapter, { terminalId: "t1", paneId: "w1:p1" })).resolves.toEqual({ pid: 20 });
  expect(signals).toEqual([10]);
  expect(calls.find((call) => call.method === "agent.start")?.params).toMatchObject({ kind: "omp", pane_id: "w1:p1", args: ["--resume", "/s/a.jsonl"] });
});

it("refuses a working agent without touching it", async () => {
  const { deps, signals, calls } = rig({ status: "working" });
  await expect(restartAgent(deps, ompAdapter, { terminalId: "t1", paneId: "w1:p1" })).rejects.toThrow(/idle or finished.*working/);
  expect(signals).toEqual([]);
  expect(calls.some((call) => call.method === "agent.start")).toBe(false);
});

it("never starts a second process when the old one doesn't exit", async () => {
  const { deps, calls } = rig({ exits: false });
  await expect(restartAgent(deps, ompAdapter, { terminalId: "t1", paneId: "w1:p1" })).rejects.toThrow(/didn't exit.*nothing was started/);
  expect(calls.some((call) => call.method === "agent.start")).toBe(false);
});

it("retries only while Herdr still reports the pane busy", async () => {
  const busy = rig({ startErrors: [new HerdrError("agent_pane_busy", "busy"), new HerdrError("agent_pane_busy", "busy")] });
  await expect(restartAgent(busy.deps, ompAdapter, { terminalId: "t1", paneId: "w1:p1" })).resolves.toEqual({ pid: 20 });
  expect(busy.calls.filter((call) => call.method === "agent.start")).toHaveLength(3);

  const failed = rig({ startErrors: [new HerdrError("invalid_request", "bad args")] });
  const error = await restartAgent(failed.deps, ompAdapter, { terminalId: "t1", paneId: "w1:p1" }).catch((e: unknown) => e);
  expect(error).toBeInstanceOf(RestartError);
  expect(String(error)).toMatch(/starting it again failed.*omp --resume \/s\/a.jsonl/);
  expect(failed.calls.filter((call) => call.method === "agent.start")).toHaveLength(1);
});

it("refuses an agent that moved panes or has no saved session", async () => {
  const moved = rig();
  await expect(restartAgent(moved.deps, ompAdapter, { terminalId: "t1", paneId: "w1:p9" })).rejects.toThrow(/moved to another pane/);
  const noSession = rig();
  const request = noSession.deps.request;
  noSession.deps.request = async (method, params) => method === "agent.list"
    ? { type: "agent_list", agents: [agentInfo({ agent_session: null })] } : request(method, params);
  await expect(restartAgent(noSession.deps, ompAdapter, { terminalId: "t1", paneId: "w1:p1" })).rejects.toThrow(/no saved session/);
  expect(noSession.signals).toEqual([]);
});
