import { describe, expect, it } from "vitest";
import { listPaneTargets } from "../server/herdr/targets.js";
import type { HerdrRequestFn } from "../server/harness/types.js";

function agent(over: Record<string, unknown> = {}) {
  return {
    terminal_id: "t1",
    agent: "omp",
    agent_status: "idle",
    agent_session: { source: "herdr:omp", agent: "omp", kind: "path", value: "/s/a.jsonl" },
    workspace_id: "w1",
    tab_id: "w1:t1",
    pane_id: "w1:p1",
    focused: false,
    revision: 1,
    ...over,
  };
}

function rig(agents: unknown[] = [agent()]) {
  const calls: Array<{ method: string; params?: Record<string, unknown>; options?: { signal?: AbortSignal } }> = [];
  const request: HerdrRequestFn = async (method, params = {}, options) => {
    calls.push({ method, params, options });
    return { type: "agent_list", agents };
  };
  return { request, calls };
}

describe("listPaneTargets", () => {
  it("returns today's agent.list entries, including kinds with no adapter and unknown status", async () => {
    const { request } = rig([
      agent(),
      agent({ terminal_id: "t2", agent: null, agent_status: "unknown", agent_session: null, pane_id: "w1:p2" }),
    ]);
    await expect(listPaneTargets(request)).resolves.toMatchObject([
      { terminal_id: "t1", agent: "omp", agent_status: "idle", pane_id: "w1:p1", agent_session: { kind: "path", value: "/s/a.jsonl" } },
      { terminal_id: "t2", agent: null, agent_status: "unknown", pane_id: "w1:p2", agent_session: null },
    ]);
  });

  it("asks on the pinned request function and forwards the abort signal", async () => {
    const { request, calls } = rig();
    const controller = new AbortController();
    await listPaneTargets(request, { signal: controller.signal });
    expect(calls).toEqual([{ method: "agent.list", params: {}, options: { signal: controller.signal } }]);
  });

  it("rejects a reply that is not an agent_list", async () => {
    const request: HerdrRequestFn = async () => ({ type: "pong" });
    await expect(listPaneTargets(request)).rejects.toThrow();
  });
});
