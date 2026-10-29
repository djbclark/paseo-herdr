import { expect, it } from "vitest";
import { RestartError, restartAgent } from "../server/restart.js";
import { HerdrError } from "../server/herdr/client.js";
import { ompAdapter as realOmpAdapter } from "../server/harness/omp/adapter.js";
const ompAdapter = { ...realOmpAdapter, inspectInput: async ({ pid }: { pid: number }) => ({ pid, instanceId: "restarted" }) };

const SESSION = { source: "herdr:omp", agent: "omp", kind: "path", value: "/s/a.jsonl" };
const agentInfo = (over: object = {}) => ({ terminal_id: "t1", name: null, agent: "omp", agent_status: "idle", agent_session: SESSION,
  workspace_id: "w1", tab_id: "w1:t1", pane_id: "w1:p1", focused: false, interactive_ready: true, revision: 1, ...over });
const proc = (pid: number, name: string) => ({ type: "pane_process_info", process_info: { pane_id: "w1:p1", foreground_process_group_id: pid, foreground_processes: [{ pid, name }] } });

/** Scripted Herdr: OMP (pid 10) until SIGTERM, then the shell, then OMP again (pid 20) once started. */
function rig(options: { name?: string; status?: string; exits?: boolean; startErrors?: Error[]; restartedRef?: typeof SESSION; ready?: boolean; kind?: string } = {}) {
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
      if (method === "agent.list") return { type: "agent_list", agents: phase === "shell" ? [] : [agentInfo({ agent: options.kind ?? "omp", name: options.name ?? null,
        ...(phase === "new" ? { agent_session: options.restartedRef ?? SESSION, interactive_ready: options.ready ?? true } : {}),
        agent_status: phase === "old" ? options.status ?? "idle" : "idle" })] };
      if (method === "pane.process_info") return phase === "old" ? proc(10, "omp") : phase === "shell" ? proc(5, "zsh") : proc(20, "omp");
      if (method === "agent.start") {
        if (typeof params?.name !== "string" || !/^[a-z][a-z0-9_-]{0,31}$/.test(params.name)) {
          throw new HerdrError("invalid_params", "agent.start requires a valid name");
        }
        const error = startErrors.shift();
        if (error && !(error instanceof HerdrError)) phase = "new";
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
  expect(calls.find((call) => call.method === "agent.start")?.params?.name).toMatch(/^paseo-[a-f0-9]+$/);
});

it("preserves the existing agent name on restart", async () => {
  const { deps, calls } = rig({ name: "reviewer" });
  await restartAgent(deps, ompAdapter, { terminalId: "t1", paneId: "w1:p1" });
  expect(calls.find((call) => call.method === "agent.start")?.params?.name).toBe("reviewer");
});

it("reconciles an uncertain start with the companion even when Herdr readiness lags, without starting twice", async () => {
  const { deps, calls } = rig({ startErrors: [new Error("socket timed out")], ready: false });
  await expect(restartAgent(deps, ompAdapter, { terminalId: "t1", paneId: "w1:p1" })).resolves.toEqual({ pid: 20 });
  expect(calls.filter(c => c.method === "agent.start")).toHaveLength(1);
});

it("does not report success for a different native session or an unavailable input companion", async () => {
  const changed = rig({ restartedRef: { ...SESSION, value: "/s/replaced.jsonl" } });
  await expect(restartAgent(changed.deps, ompAdapter, { terminalId: "t1", paneId: "w1:p1" })).rejects.toThrow(/input couldn't be verified/);
  const missing = rig();
  await expect(restartAgent(missing.deps, { ...ompAdapter, inspectInput: async () => { throw new Error("missing"); } },
    { terminalId: "t1", paneId: "w1:p1" })).rejects.toThrow(/input couldn't be verified/);
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

it("starts the agent with launch.kind when it differs from the adapter id", async () => {
  const { deps, calls, signals } = rig({ kind: "omp-tui" });
  const kindAdapter = { ...ompAdapter, launch: { kind: "omp-tui", args: () => [] } };
  await expect(restartAgent(deps, kindAdapter, { terminalId: "t1", paneId: "w1:p1" })).resolves.toEqual({ pid: 20 });
  expect(calls.find((call) => call.method === "agent.start")?.params).toMatchObject({ kind: "omp-tui" });
  expect(signals).toEqual([10]);
});

it("refuses an adapter without launch before any request or signal", async () => {
  const { deps, calls, signals } = rig();
  const bindOnly = { ...ompAdapter, launch: undefined };
  await expect(restartAgent(deps, bindOnly, { terminalId: "t1", paneId: "w1:p1" })).rejects.toThrow(/can't be restarted/);
  expect(calls).toEqual([]);
  expect(signals).toEqual([]);
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
