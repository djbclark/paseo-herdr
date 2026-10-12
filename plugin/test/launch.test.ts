import { afterEach, describe, expect, it } from "vitest";
import type { ProviderSessionConfig } from "@getpaseo/plugin/server/provider";
import { FakeHerdr } from "./fake-herdr.js";
import { makeFakeAdapter, FAKE_HARNESS_ID } from "./fake-harness.js";
import { HerdrClient, HerdrError } from "../server/herdr/client.js";
import { LaunchError, launchAgent, type LaunchDeps } from "../server/launch.js";

const CWD = "/work/project";
const KIND = FAKE_HARNESS_ID;
const adapter = { ...makeFakeAdapter(), launchArgs: () => ["--flag", "value with space"] };

function config(cwd = CWD): ProviderSessionConfig {
  return { cwd, env: {}, mcpServers: {}, settings: {}, persist: false };
}

function pane(over: Record<string, unknown> = {}) {
  return {
    pane_id: "p1",
    terminal_id: "term-1",
    workspace_id: "w1",
    tab_id: "t1",
    focused: false,
    cwd: CWD,
    foreground_cwd: CWD,
    agent_status: "unknown",
    revision: 1,
    ...over,
  };
}

function agent(over: Record<string, unknown> = {}) {
  return {
    terminal_id: "term-1",
    name: "paseo-aaaaaa",
    agent_status: "unknown",
    workspace_id: "w1",
    tab_id: "t1",
    pane_id: "p1",
    focused: false,
    revision: 1,
    ...over,
  };
}

/** Fake realpath: known paths resolve through the map, anything else is ENOENT. */
const realpathMap = (map: Record<string, string>) => async (path: string) => {
  if (!(path in map)) throw new Error(`ENOENT: ${path}`);
  return map[path];
};

const READY = {
  agent: KIND,
  agent_status: "idle",
  interactive_ready: true,
  agent_session: { source: "herdr:fake", agent: KIND, kind: "id", value: "sess-1" },
};

interface Call {
  method: string;
  params: Record<string, unknown>;
  at: number;
}

type Handler = (params: Record<string, unknown>, sim: Sim) => unknown;

/** Scripted Herdr with a virtual clock: sleep advances time, each request costs 50 ms. */
class Sim {
  t = 0;
  startedAt: number | undefined;
  calls: Call[] = [];
  handlers = new Map<string, Handler>();
  sleeps = 0;
  onSleep: (() => void) | undefined;
  names: string[] = ["paseo-aaaaaa", "paseo-bbbbbb", "paseo-cccccc"];
  nameIndex = 0;

  constructor() {
    this.on("pane.list", () => ({ type: "pane_list", panes: [] }));
    this.on("workspace.create", (p) => ({
      type: "workspace_created",
      workspace: { workspace_id: "w1" },
      tab: { tab_id: "t1" },
      root_pane: { pane_id: "p1", terminal_id: "term-1", workspace_id: "w1", tab_id: "t1", cwd: p.cwd, foreground_cwd: p.cwd },
    }));
    this.on("tab.create", (p) => ({
      type: "tab_created",
      tab: { tab_id: "t2", workspace_id: p.workspace_id },
      root_pane: { pane_id: "p2", terminal_id: "term-2", workspace_id: p.workspace_id, tab_id: "t2", cwd: p.cwd, foreground_cwd: p.cwd },
    }));
    this.on("agent.start", (p, sim) => {
      sim.startedAt = sim.t;
      return { type: "agent_started", agent: agent({ name: p.name, launch_pending: true }), argv: [] };
    });
    this.on("agent.get", (p, sim) => this.defaultGet(String(p.target), sim));
    this.on("pane.process_info", () => ({
      type: "pane_process_info",
      process_info: { pane_id: "p1", shell_pid: 100, foreground_process_group_id: 200, foreground_processes: [] },
    }));
    this.on("pane.read", () => ({ type: "pane_read", read: { pane_id: "p1", text: "$ cmd\n\nerror: bad flag\n\n$ \n" } }));
    this.on("workspace.close", () => ({ type: "ok" }));
    this.on("tab.close", () => ({ type: "ok" }));
    this.on("agent.rename", () => ({ type: "agent_info" }));
  }

  /** Default agent timeline relative to agent.start: detected at 500 ms, ready at 3100 ms. */
  defaultGet(target: string, sim: Sim) {
    const since = sim.t - (sim.startedAt ?? sim.t);
    const name = sim.currentName();
    if (target !== name && target !== "p1" && target !== "p2") throw new HerdrError("agent_not_found", "no such agent");
    if (since < 500) return { type: "agent_info", agent: agent({ name, launch_pending: true }) };
    if (since < 3100) return { type: "agent_info", agent: agent({ name, agent: KIND, launch_pending: true, agent_status: "unknown" }) };
    return { type: "agent_info", agent: agent({ name, ...READY }) };
  }

  currentName(): string {
    const start = this.calls.filter((c) => c.method === "agent.start").at(-1);
    return start ? String(start.params.name) : this.names[0];
  }

  on(method: string, handler: Handler): this {
    this.handlers.set(method, handler);
    return this;
  }

  of(method: string): Call[] {
    return this.calls.filter((c) => c.method === method);
  }

  get methods(): string[] {
    return this.calls.map((c) => c.method);
  }

  deps(over: Partial<LaunchDeps> = {}): LaunchDeps {
    return {
      request: async (method, params = {}, options) => {
        if (options?.signal?.aborted) throw new HerdrError("aborted", "aborted");
        this.calls.push({ method, params, at: this.t });
        this.t += 50;
        const handler = this.handlers.get(method);
        if (!handler) throw new HerdrError("unknown_method", method);
        return handler(params, this);
      },
      now: () => this.t,
      sleep: async (ms) => {
        this.sleeps += 1;
        this.t += ms;
        this.onSleep?.();
      },
      makeName: () => this.names[this.nameIndex++ % this.names.length],
      checkDirectory: async () => {},
      ...over,
    };
  }
}

async function run(sim: Sim, signal = new AbortController().signal, cwd = CWD, deps: Partial<LaunchDeps> = {}) {
  return launchAgent(sim.deps(deps), adapter, config(cwd), signal);
}

async function failure(promise: Promise<unknown>): Promise<LaunchError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(LaunchError);
    return error as LaunchError;
  }
  throw new Error("expected launchAgent to fail");
}

describe("launchAgent", () => {
  it("creates a workspace and starts the agent (happy path)", async () => {
    const sim = new Sim();
    const result = await run(sim);

    expect(result).toEqual({
      agentName: "paseo-aaaaaa",
      terminalId: "term-1",
      paneId: "p1",
      tabId: "t1",
      workspaceId: "w1",
      createdWorkspace: true,
      cwd: CWD,
      sessionRef: { kind: "id", value: "sess-1" },
    });
    expect(sim.methods.slice(0, 3)).toEqual(["pane.list", "workspace.create", "agent.start"]);
    expect(sim.of("workspace.create")[0].params).toEqual({ cwd: CWD, label: "project", focus: false });
    expect(sim.of("agent.start")[0].params).toEqual({
      name: "paseo-aaaaaa",
      kind: KIND,
      pane_id: "p1",
      args: ["--flag", "value with space"],
      timeout_ms: 30000,
    });
    expect(sim.of("agent.get").every((c) => c.params.target === "paseo-aaaaaa")).toBe(true);
    expect(sim.of("agent.get").length).toBeGreaterThan(5);
    expect(sim.methods).not.toContain("workspace.close");
    expect(sim.methods).not.toContain("tab.close");
  });

  it("only queries pane.process_info while the launch is pending and the agent unset", async () => {
    const sim = new Sim();
    await run(sim);
    const detectedAt = sim.startedAt! + 500;
    expect(sim.of("pane.process_info").every((c) => c.at < detectedAt + 100)).toBe(true);
  });

  it("reuses a workspace whose pane cwd matches (normalized) by creating a tab", async () => {
    const sim = new Sim().on("pane.list", () => ({
      type: "pane_list",
      panes: [pane({ workspace_id: "wX", cwd: "/elsewhere" }), pane({ pane_id: "pq", workspace_id: "wY", cwd: `${CWD}/` })],
    }));
    sim.on("agent.get", (p, s) => {
      const base = s.defaultGet(String(p.target), s) as { agent: Record<string, unknown> };
      return { type: "agent_info", agent: { ...base.agent, terminal_id: "term-2", pane_id: "p2", workspace_id: "wY", tab_id: "t2" } };
    });
    const result = await run(sim);

    expect(sim.methods.slice(0, 3)).toEqual(["pane.list", "tab.create", "agent.start"]);
    expect(sim.of("tab.create")[0].params).toEqual({ workspace_id: "wY", cwd: CWD, focus: false, label: "paseo" });
    expect(sim.of("agent.start")[0].params.pane_id).toBe("p2");
    expect(result).toMatchObject({ createdWorkspace: false, workspaceId: "wY", tabId: "t2", paneId: "p2", terminalId: "term-2" });
    expect(sim.methods).not.toContain("workspace.create");
  });

  it("reuses a workspace whose pane cwd is a symlink to the requested cwd", async () => {
    const sim = new Sim()
      .on("pane.list", () => ({ type: "pane_list", panes: [pane({ workspace_id: "wL", cwd: "/link/project", foreground_cwd: "/link/project" })] }))
      .on("agent.get", (p, s) => {
        const base = s.defaultGet(String(p.target), s) as { agent: Record<string, unknown> };
        return { type: "agent_info", agent: { ...base.agent, terminal_id: "term-2", pane_id: "p2", workspace_id: "wL", tab_id: "t2" } };
      });
    const result = await run(sim, undefined, CWD, { realpath: realpathMap({ "/link/project": CWD, [CWD]: CWD }) });

    expect(sim.methods.slice(0, 3)).toEqual(["pane.list", "tab.create", "agent.start"]);
    expect(result).toMatchObject({ createdWorkspace: false, workspaceId: "wL", paneId: "p2" });
    expect(sim.methods).not.toContain("tab.close");
  });

  describe("invalid cwd", () => {
    it("rejects a relative cwd without creating anything", async () => {
      const sim = new Sim();
      const error = await failure(run(sim, undefined, "relative/dir"));
      expect(error.code).toBe("invalid_cwd");
      expect(error.resources).toBeUndefined();
      expect(sim.calls).toEqual([]);
    });

    it("rejects a missing or non-directory path", async () => {
      const sim = new Sim();
      const error = await failure(run(sim, undefined, CWD, { checkDirectory: async () => { throw new Error("ENOENT"); } }));
      expect(error.code).toBe("invalid_cwd");
      expect(error.resources).toBeUndefined();
      expect(sim.calls).toEqual([]);
    });

    it("default directory check uses the filesystem", async () => {
      const sim = new Sim();
      const error = await failure(launchAgent({ ...sim.deps(), checkDirectory: undefined }, adapter, config("/definitely/not/here"), new AbortController().signal));
      expect(error.code).toBe("invalid_cwd");
      expect(sim.calls).toEqual([]);
    });
  });

  describe("cwd fallback", () => {
    it("closes the created workspace and fails with cwd_mismatch", async () => {
      const sim = new Sim().on("workspace.create", () => ({
        type: "workspace_created",
        workspace: { workspace_id: "w9" },
        tab: { tab_id: "t9" },
        root_pane: { pane_id: "p9", terminal_id: "term-9", workspace_id: "w9", tab_id: "t9", cwd: "/home/dj", foreground_cwd: "/home/dj" },
      }));
      const error = await failure(run(sim));
      expect(error.code).toBe("cwd_mismatch");
      expect(error.resources).toBeUndefined();
      expect(sim.methods).toEqual(["pane.list", "workspace.create", "workspace.close"]);
      expect(sim.of("workspace.close")[0].params).toEqual({ workspace_id: "w9" });
    });

    it("closes only the created tab when reusing a workspace", async () => {
      const sim = new Sim()
        .on("pane.list", () => ({ type: "pane_list", panes: [pane({ workspace_id: "wY" })] }))
        .on("tab.create", () => ({
          type: "tab_created",
          tab: { tab_id: "t7", workspace_id: "wY" },
          root_pane: { pane_id: "p7", terminal_id: "term-7", workspace_id: "wY", tab_id: "t7", cwd: "/home/dj" },
        }));
      const error = await failure(run(sim));
      expect(error.code).toBe("cwd_mismatch");
      expect(sim.methods).toEqual(["pane.list", "tab.create", "tab.close"]);
      expect(sim.of("tab.close")[0].params).toEqual({ tab_id: "t7" });
    });

    const reportingCwd = (cwd: string) => new Sim()
      .on("workspace.create", () => ({
        type: "workspace_created",
        workspace: { workspace_id: "w9" },
        tab: { tab_id: "t9" },
        root_pane: { pane_id: "p9", terminal_id: "term-9", workspace_id: "w9", tab_id: "t9", cwd, foreground_cwd: cwd },
      }))
      .on("agent.get", (p, s) => {
        const base = s.defaultGet(String(p.target), s) as { agent: Record<string, unknown> };
        return { type: "agent_info", agent: { ...base.agent, terminal_id: "term-9", pane_id: "p9", workspace_id: "w9", tab_id: "t9" } };
      });

    it("accepts a reported cwd whose realpath equals the requested cwd's realpath", async () => {
      const sim = reportingCwd("/link/project");
      const result = await run(sim, undefined, CWD, { realpath: realpathMap({ "/link/project": CWD, [CWD]: CWD }) });
      expect(result).toMatchObject({ createdWorkspace: true, workspaceId: "w9", cwd: CWD });
      expect(sim.methods).not.toContain("workspace.close");
      expect(sim.methods).not.toContain("tab.close");
    });

    it("keeps cwd_mismatch and cleans up when the realpaths differ or cannot be resolved", async () => {
      const differing = reportingCwd("/home/dj");
      const error = await failure(run(differing, undefined, CWD, { realpath: realpathMap({ "/home/dj": "/home/dj", [CWD]: CWD }) }));
      expect(error.code).toBe("cwd_mismatch");
      expect(differing.methods).toEqual(["pane.list", "workspace.create", "workspace.close"]);

      const unresolvable = reportingCwd("/home/dj");
      const second = await failure(run(unresolvable, undefined, CWD, { realpath: realpathMap({ [CWD]: CWD }) }));
      expect(second.code).toBe("cwd_mismatch");
      expect(unresolvable.methods).toEqual(["pane.list", "workspace.create", "workspace.close"]);
    });
  });

  describe("agent.start rejections", () => {
    it("retries agent_pane_busy with the same name and pane, then succeeds", async () => {
      let busy = 3;
      const sim = new Sim();
      const original = sim.handlers.get("agent.start")!;
      sim.on("agent.start", (p, s) => {
        if (busy-- > 0) throw new HerdrError("agent_pane_busy", "busy");
        return original(p, s);
      });
      const result = await run(sim);
      expect(result.agentName).toBe("paseo-aaaaaa");
      const starts = sim.of("agent.start");
      expect(starts).toHaveLength(4);
      expect(new Set(starts.map((c) => JSON.stringify(c.params))).size).toBe(1);
      expect(sim.methods).not.toContain("tab.close");
      expect(sim.methods).not.toContain("workspace.close");
    });

    it("gives up on agent_pane_busy after 2 s", async () => {
      const sim = new Sim().on("agent.start", () => {
        throw new HerdrError("agent_pane_busy", "pane busy");
      });
      const error = await failure(run(sim));
      expect(error.code).toBe("start_rejected");
      expect(error.resources).toMatchObject({ paneId: "p1", terminalId: "term-1", workspaceId: "w1", tabId: "t1" });
      expect(error.message).toContain("pane p1");
      const starts = sim.of("agent.start");
      const first = sim.of("workspace.create")[0].at + 50;
      expect(starts.at(-1)!.at - first).toBeGreaterThanOrEqual(2000 - 300);
      expect(starts.at(-1)!.at - first).toBeLessThan(2000 + 300);
      expect(starts.length).toBeGreaterThan(5);
      expect(sim.methods).not.toContain("agent.get");
      expect(sim.methods).not.toContain("workspace.close");
    });

    it("picks a new name on agent_name_taken", async () => {
      const sim = new Sim();
      const original = sim.handlers.get("agent.start")!;
      sim.on("agent.start", (p, s) => {
        if (p.name === "paseo-aaaaaa") throw new HerdrError("agent_name_taken", "taken");
        return original(p, s);
      });
      const result = await run(sim);
      expect(result.agentName).toBe("paseo-bbbbbb");
      expect(sim.of("agent.start").map((c) => c.params.name)).toEqual(["paseo-aaaaaa", "paseo-bbbbbb"]);
    });

    it("gives up after three taken names", async () => {
      const sim = new Sim().on("agent.start", () => {
        throw new HerdrError("agent_name_taken", "taken");
      });
      const error = await failure(run(sim));
      expect(error.code).toBe("start_rejected");
      expect(sim.of("agent.start").map((c) => c.params.name)).toEqual(["paseo-aaaaaa", "paseo-bbbbbb", "paseo-cccccc"]);
    });

    it("maps any other HerdrError to start_rejected with resources", async () => {
      const sim = new Sim().on("agent.start", () => {
        throw new HerdrError("unsupported_agent_kind", "nope");
      });
      const error = await failure(run(sim));
      expect(error.code).toBe("start_rejected");
      expect(error.message).toContain("unsupported_agent_kind");
      expect(error.resources?.paneId).toBe("p1");
      expect(sim.of("agent.start")).toHaveLength(1);
    });
  });

  it("never repeats agent.start after a transport error and reconciles by polling", async () => {
    const sim = new Sim();
    const original = sim.handlers.get("agent.start")!;
    sim.on("agent.start", (p, s) => {
      original(p, s); // the start did happen server-side...
      throw new Error("socket closed before reply"); // ...but the reply was lost
    });
    const result = await run(sim);
    expect(result.agentName).toBe("paseo-aaaaaa");
    expect(sim.of("agent.start")).toHaveLength(1);
    expect(sim.of("agent.get").length).toBeGreaterThan(3);
    expect(sim.methods).not.toContain("tab.close");
    expect(sim.methods).not.toContain("workspace.close");
  });

  it("does not start twice when the start reply is lost and nothing ever appears", async () => {
    const sim = new Sim()
      .on("agent.start", () => {
        throw new Error("socket closed");
      })
      .on("agent.get", () => {
        throw new HerdrError("agent_not_found", "none");
      });
    const error = await failure(run(sim));
    expect(error.code).toBe("timeout");
    expect(sim.of("agent.start")).toHaveLength(1);
    expect(error.resources?.agentName).toBe("paseo-aaaaaa");
    expect(sim.methods).not.toContain("workspace.close");
  });

  it("adopts an unnamed running agent found by pane after a lost start reply", async () => {
    let renamed = false;
    const sim = new Sim()
      .on("agent.start", () => {
        throw new Error("socket closed");
      })
      .on("agent.rename", () => {
        renamed = true;
        return { type: "agent_info" };
      })
      .on("agent.get", (p) => {
        if (p.target === "paseo-aaaaaa" && !renamed) throw new HerdrError("agent_not_found", "none");
        return { type: "agent_info", agent: agent({ name: renamed ? "paseo-aaaaaa" : null, ...READY }) };
      });
    const result = await run(sim);
    expect(result.agentName).toBe("paseo-aaaaaa");
    expect(sim.of("agent.start")).toHaveLength(1);
    expect(sim.of("agent.rename")[0].params).toEqual({ target: "p1", name: "paseo-aaaaaa" });
  });

  describe("unreachable Herdr", () => {
    const refused = () => Object.assign(new Error("connect ECONNREFUSED /tmp/herdr.sock"), { code: "ECONNREFUSED" });

    it("fails with unreachable well before the deadline when polling gets no replies for 5 s", async () => {
      const sim = new Sim().on("agent.get", (p, s) => {
        if (s.t - s.startedAt! < 800) return s.defaultGet(String(p.target), s);
        throw refused();
      });
      const error = await failure(run(sim));
      expect(error.code).toBe("unreachable");
      expect(error.message).toContain("Herdr became unreachable during launch");
      expect(error.message).toContain("ECONNREFUSED");
      expect(error.message).toContain("inspect the pane with: herdr pane read p1");
      expect(error.message).not.toContain("attach");
      expect(error.resources).toMatchObject({ paneId: "p1", agentName: "paseo-aaaaaa" });
      const elapsed = sim.t - sim.startedAt!;
      expect(elapsed).toBeGreaterThanOrEqual(5_000);
      expect(elapsed).toBeLessThan(7_000);
      expect(sim.of("agent.start")).toHaveLength(1);
      expect(sim.methods).not.toContain("workspace.close");
    });

    it("survives a transient transport error followed by a reply", async () => {
      let failures = 0;
      const sim = new Sim().on("agent.get", (p, s) => {
        if (s.t - s.startedAt! > 1_000 && failures < 3) {
          failures += 1;
          throw refused();
        }
        return s.defaultGet(String(p.target), s);
      });
      const result = await run(sim);
      expect(result.agentName).toBe("paseo-aaaaaa");
      expect(failures).toBe(3);
    });

    it("restarts the 5 s clock after any reply, including an error reply", async () => {
      // Transport failures totalling > 5 s, but split by an error reply: never 5 s in a row.
      const sim = new Sim().on("agent.get", (p, s) => {
        const since = s.t - s.startedAt!;
        if (since < 3_000) throw refused();
        if (since < 3_300) throw new HerdrError("internal_error", "busy");
        if (since < 6_000) throw refused();
        return s.defaultGet(String(p.target), s);
      });
      const result = await run(sim);
      expect(result.agentName).toBe("paseo-aaaaaa");
    });

    it("also fails with unreachable when the start reply is lost and Herdr stays down", async () => {
      const sim = new Sim()
        .on("agent.start", () => {
          throw refused();
        })
        .on("agent.get", () => {
          throw refused();
        });
      const error = await failure(run(sim));
      expect(error.code).toBe("unreachable");
      expect(sim.of("agent.start")).toHaveLength(1);
      expect(sim.t).toBeLessThan(8_000);
      expect(sim.methods).not.toContain("workspace.close");
    });
  });

  describe("recovery commands in failure messages", () => {
    const neverReady = () =>
      new Sim().on("agent.get", (p) => ({ type: "agent_info", agent: agent({ name: String(p.target), agent: KIND, launch_pending: true }) }));
    const exited = () =>
      new Sim().on("agent.get", (p, s) => {
        if (s.t - s.startedAt! < 800) return s.defaultGet(String(p.target), s);
        throw new HerdrError("agent_not_found", "gone");
      });

    it("attach hint carries --session only for a named session", async () => {
      const unnamed = await failure(run(neverReady()));
      expect(unnamed.message).toContain("attach with: herdr agent attach paseo-aaaaaa");
      expect(unnamed.message).not.toContain("--session");
      const named = await failure(run(neverReady(), undefined, CWD, { herdrSession: "paseo-spike-e" }));
      expect(named.message).toContain("attach with: herdr --session paseo-spike-e agent attach paseo-aaaaaa");
      const explicitNull = await failure(run(neverReady(), undefined, CWD, { herdrSession: null }));
      expect(explicitNull.message).not.toContain("--session");
    });

    it("quotes unusual session names", async () => {
      const error = await failure(run(neverReady(), undefined, CWD, { herdrSession: "my session" }));
      expect(error.message).toContain("herdr --session 'my session' agent attach paseo-aaaaaa");
    });

    it("exited suggests reading the pane, never attaching", async () => {
      const plain = await failure(run(exited()));
      expect(plain.code).toBe("exited");
      expect(plain.message).toContain("inspect the pane with: herdr pane read p1");
      expect(plain.message).not.toContain("attach");
      const named = await failure(run(exited(), undefined, CWD, { herdrSession: "paseo-spike-e" }));
      expect(named.message).toContain("inspect the pane with: herdr --session paseo-spike-e pane read p1");
      expect(named.message).not.toContain("attach");
    });
  });

  it("detects the agent exiting after it was seen (EXIT) and includes pane output", async () => {
    const sim = new Sim();
    sim.on("agent.get", (p, s) => {
      const since = s.t - s.startedAt!;
      if (since < 800) return s.defaultGet(String(p.target), s);
      throw new HerdrError("agent_not_found", "gone");
    });
    const error = await failure(run(sim));
    expect(error.code).toBe("exited");
    expect(error.message).toContain("error: bad flag");
    expect(error.message).toContain("pane p1");
    expect(error.resources).toMatchObject({ paneId: "p1", agentName: "paseo-aaaaaa" });
    expect(sim.of("agent.get").some((c) => c.params.target === "p1")).toBe(true);
    expect(sim.of("pane.read")[0].params).toMatchObject({ pane_id: "p1" });
    expect(sim.methods).not.toContain("workspace.close");
    expect(sim.methods).not.toContain("tab.close");
  });

  it("still reports EXIT when the diagnostic pane.read fails", async () => {
    const sim = new Sim().on("pane.read", () => {
      throw new HerdrError("pane_not_found", "x");
    });
    sim.on("agent.get", (p, s) => {
      if (s.t - s.startedAt! < 800) return s.defaultGet(String(p.target), s);
      throw new HerdrError("agent_not_found", "gone");
    });
    const error = await failure(run(sim));
    expect(error.code).toBe("exited");
  });

  it("detects a GHOST (process gone before Herdr noticed it) after 1.5 s of an idle shell", async () => {
    const sim = new Sim();
    sim.on("agent.get", (p, s) => ({ type: "agent_info", agent: agent({ name: String(p.target), launch_pending: true }) }));
    sim.on("pane.process_info", () => ({
      type: "pane_process_info",
      process_info: { pane_id: "p1", shell_pid: 100, foreground_process_group_id: 100, foreground_processes: [] },
    }));
    const error = await failure(run(sim));
    expect(error.code).toBe("exited");
    expect(error.message).toContain("error: bad flag");
    const elapsed = sim.t - sim.startedAt!;
    expect(elapsed).toBeGreaterThanOrEqual(1500);
    expect(elapsed).toBeLessThan(3000);
    expect(sim.methods).not.toContain("workspace.close");
  });

  it("does not call a pending launch a ghost while the foreground process differs from the shell", async () => {
    const sim = new Sim();
    sim.on("agent.get", (p, s) => {
      const since = s.t - s.startedAt!;
      if (since < 2500) return { type: "agent_info", agent: agent({ name: String(p.target), launch_pending: true }) };
      return { type: "agent_info", agent: agent({ name: String(p.target), ...READY }) };
    });
    const result = await run(sim);
    expect(result.agentName).toBe("paseo-aaaaaa");
    expect(sim.of("pane.process_info").length).toBeGreaterThan(0);
  });

  it("adopts a TIMEOUT ORPHAN via agent.rename and treats it as ready", async () => {
    let renamed = false;
    const sim = new Sim();
    sim.on("agent.rename", () => {
      renamed = true;
      return { type: "agent_info" };
    });
    sim.on("agent.get", (p, s) => {
      const since = s.t - s.startedAt!;
      const detected = agent({ name: "paseo-aaaaaa", agent: KIND, launch_pending: true });
      if (since < 31_000 || (p.target === "paseo-aaaaaa" && !renamed && since >= 31_000)) {
        if (p.target === "paseo-aaaaaa" && since >= 30_000 && !renamed) throw new HerdrError("agent_not_found", "cleared");
        if (p.target === "p1" && since >= 30_000) return { type: "agent_info", agent: agent({ name: null, ...READY }) };
        return { type: "agent_info", agent: detected };
      }
      return { type: "agent_info", agent: agent({ name: "paseo-aaaaaa", ...READY }) };
    });
    const result = await run(sim);
    expect(result.agentName).toBe("paseo-aaaaaa");
    expect(result.sessionRef).toEqual({ kind: "id", value: "sess-1" });
    expect(sim.of("agent.rename")).toHaveLength(1);
    expect(sim.of("agent.rename")[0].params).toEqual({ target: "p1", name: "paseo-aaaaaa" });
    expect(sim.of("agent.start")).toHaveLength(1);
    expect(sim.t - sim.startedAt!).toBeGreaterThanOrEqual(30_000);
  });

  it("times out when the agent never becomes ready", async () => {
    const sim = new Sim();
    sim.on("agent.get", (p) => ({ type: "agent_info", agent: agent({ name: String(p.target), agent: KIND, launch_pending: true }) }));
    const error = await failure(run(sim));
    expect(error.code).toBe("timeout");
    expect(error.resources).toMatchObject({ agentName: "paseo-aaaaaa", paneId: "p1" });
    expect(error.message).toContain("herdr agent attach paseo-aaaaaa");
    expect(sim.t - sim.startedAt!).toBeGreaterThanOrEqual(31_000);
    expect(sim.methods).not.toContain("workspace.close");
  });

  it("fails fast when the agent is blocked", async () => {
    const sim = new Sim();
    sim.on("agent.get", (p) => ({ type: "agent_info", agent: agent({ name: String(p.target), agent: KIND, agent_status: "blocked", launch_pending: true }) }));
    const error = await failure(run(sim));
    expect(error.code).toBe("not_ready");
    expect(error.resources?.agentName).toBe("paseo-aaaaaa");
    expect(sim.t - sim.startedAt!).toBeLessThan(1000);
    expect(sim.methods).not.toContain("workspace.close");
  });

  it("fails fast when Herdr detects a different agent kind", async () => {
    const sim = new Sim();
    sim.on("agent.get", (p) => ({ type: "agent_info", agent: agent({ name: String(p.target), agent: "other", launch_pending: true }) }));
    const error = await failure(run(sim));
    expect(error.code).toBe("not_ready");
    expect(error.message).toContain("other");
  });

  it("fails fast when the terminal behind the name changed", async () => {
    const sim = new Sim();
    sim.on("agent.get", (p) => ({ type: "agent_info", agent: agent({ name: String(p.target), terminal_id: "term-other", agent: KIND }) }));
    const error = await failure(run(sim));
    expect(error.code).toBe("not_ready");
  });

  describe("abort", () => {
    it("stops polling immediately without closing anything", async () => {
      const controller = new AbortController();
      const sim = new Sim();
      sim.onSleep = () => {
        if (sim.sleeps === 3) controller.abort();
      };
      const error = await failure(run(sim, controller.signal));
      expect(error.code).toBe("aborted");
      expect(error.resources).toMatchObject({ paneId: "p1", terminalId: "term-1", agentName: "paseo-aaaaaa" });
      expect(sim.of("agent.get")).toHaveLength(3);
      expect(sim.methods).not.toContain("workspace.close");
      expect(sim.methods).not.toContain("tab.close");
      expect(sim.of("agent.start")).toHaveLength(1);
    });

    it("maps an aborted in-flight agent.start to aborted and never closes or restarts", async () => {
      const controller = new AbortController();
      const sim = new Sim().on("agent.start", () => {
        controller.abort();
        throw new HerdrError("aborted", "aborted");
      });
      const error = await failure(run(sim, controller.signal));
      expect(error.code).toBe("aborted");
      expect(error.resources?.agentName).toBe("paseo-aaaaaa");
      expect(sim.of("agent.start")).toHaveLength(1);
      expect(sim.methods).not.toContain("workspace.close");
      expect(sim.methods).not.toContain("tab.close");
    });

    it("aborts before anything is created when the signal is already aborted", async () => {
      const controller = new AbortController();
      controller.abort();
      const sim = new Sim();
      const error = await failure(run(sim, controller.signal));
      expect(error.code).toBe("aborted");
      expect(error.resources).toBeUndefined();
      expect(sim.methods).toEqual([]);
    });
  });

  it("wraps unexpected create failures into LaunchError", async () => {
    const sim = new Sim().on("workspace.create", () => {
      throw new HerdrError("workspace_create_failed", "boom");
    });
    const error = await failure(run(sim));
    expect(error.code).toBe("start_rejected");
    expect(error.resources).toBeUndefined();
  });
});

describe("launchAgent against the fake Herdr socket", () => {
  let fake: FakeHerdr | undefined;
  afterEach(async () => {
    await fake?.close();
    fake = undefined;
  });

  it("creates, starts (after a name collision) and becomes ready over the real wire", async () => {
    fake = await FakeHerdr.create();
    let started = 0;
    fake
      .reply("pane.list", { type: "pane_list", panes: [] })
      .reply("workspace.create", {
        type: "workspace_created",
        workspace: { workspace_id: "w1" },
        tab: { tab_id: "t1" },
        root_pane: { pane_id: "p1", terminal_id: "term-1", workspace_id: "w1", tab_id: "t1", cwd: CWD, foreground_cwd: CWD },
      })
      .handle("agent.start", (request, stream) => {
        started += 1;
        if (started === 1) {
          stream.end(JSON.stringify({ id: request.id, error: { code: "agent_name_taken", message: "taken" } }) + "\n");
          return;
        }
        stream.end(JSON.stringify({ id: request.id, result: { type: "agent_started", agent: agent({ name: request.params.name, launch_pending: true }) } }) + "\n");
      })
      .handle("agent.get", (request, stream) => {
        stream.end(JSON.stringify({ id: request.id, result: { type: "agent_info", agent: agent({ name: request.params.target, ...READY }) } }) + "\n");
      });
    const client = new HerdrClient(fake.socketPath);
    const names = ["paseo-first", "paseo-second"];
    const result = await launchAgent(
      { request: (m, p, o) => client.request(m, p, o), makeName: () => names.shift()!, checkDirectory: async () => {} },
      adapter,
      config(),
      new AbortController().signal,
    );
    expect(result).toMatchObject({ agentName: "paseo-second", paneId: "p1", createdWorkspace: true, sessionRef: { kind: "id", value: "sess-1" } });
    expect(fake.requestsFor("agent.start").map((r) => r.params.name)).toEqual(["paseo-first", "paseo-second"]);
    expect(fake.requestsFor("agent.get")[0].params).toEqual({ target: "paseo-second" });
  });

  it("maps agent_not_found from the real client to EXIT after the name was seen", async () => {
    fake = await FakeHerdr.create();
    let gets = 0;
    fake
      .reply("pane.list", { type: "pane_list", panes: [] })
      .reply("workspace.create", {
        type: "workspace_created",
        workspace: { workspace_id: "w1" },
        tab: { tab_id: "t1" },
        root_pane: { pane_id: "p1", terminal_id: "term-1", workspace_id: "w1", tab_id: "t1", cwd: CWD },
      })
      .reply("agent.start", { type: "agent_started", agent: agent({ name: "paseo-x", launch_pending: true }) })
      .reply("pane.read", { type: "pane_read", read: { pane_id: "p1", text: "\nboom: unknown flag\n" } })
      .handle("agent.get", (request, stream) => {
        gets += 1;
        if (gets === 1) {
          stream.end(JSON.stringify({ id: request.id, result: { type: "agent_info", agent: agent({ name: "paseo-x", agent: KIND, launch_pending: true }) } }) + "\n");
        } else {
          stream.end(JSON.stringify({ id: request.id, error: { code: "agent_not_found", message: "gone" } }) + "\n");
        }
      });
    const client = new HerdrClient(fake.socketPath);
    const error = await failure(
      launchAgent(
        { request: (m, p, o) => client.request(m, p, o), makeName: () => "paseo-x", checkDirectory: async () => {} },
        adapter,
        config(),
        new AbortController().signal,
      ),
    );
    expect(error.code).toBe("exited");
    expect(error.message).toContain("boom: unknown flag");
  });
});
