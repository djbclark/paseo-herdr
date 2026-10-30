import { readFile } from "node:fs/promises";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { buildDiagnostics, type DiagnosticsInput } from "../server/diagnostics.js";
import { PLUGIN_VERSION } from "../server/plugin-version.js";
import { registerManagementRpcs, type ManagementDeps } from "../server/rpc.js";
import { ompAdapter } from "../server/harness/omp/adapter.js";
import { herdrDiagnosticsRpc, diagnosticsSchema, type HerdrTarget } from "../shared/rpc.js";
import { diagnosticsText } from "../client/helpers.js";
import { FakeHerdr } from "./fake-herdr.js";

let fake: FakeHerdr;
let dir: string;
beforeEach(async () => { fake = await FakeHerdr.create(); dir = await mkdtemp(join(tmpdir(), "diag-test-")); });
afterEach(async () => { await fake.close(); await rm(dir, { recursive: true, force: true }); });

const TOP_KEYS = ["agents", "companion", "counts", "herdr", "ompEnabled", "pluginVersion", "target"];

const baseTarget = (socketPath: string): HerdrTarget => ({ socketPath, herdrSession: "work", source: "settingSession", autoStart: true, autoStartDisabledReason: "not shown" });

type Handler = (input: any, ctx: any) => Promise<any>;
function setup(overrides: Partial<ManagementDeps> = {}) {
  const handlers = new Map<string, Handler>();
  registerManagementRpcs({ handle: ((c: { name: string }, h: Handler) => { handlers.set(c.name, h); }) as never }, {
    readTarget: async () => ({ target: baseTarget(fake.socketPath), ompEnabled: true }),
    ensureReady: async (t) => ({ target: t, version: "0.9.3", autoStarted: false }),
    harnesses: [ompAdapter],
    companionStatus: async () => ({ state: "missing", path: join(dir, "paseo4herdr-input.ts") }),
    env: { PATH: "/nonexistent", ANTHROPIC_API_KEY: "sk-super-secret-env-value" },
    ...overrides,
  });
  return (paseo: unknown = { agents: { list: async () => ({ entries: [], pageInfo: { hasMore: false, nextCursor: null, prevCursor: null } }) } }) =>
    handlers.get(herdrDiagnosticsRpc.name)!({}, { paseo });
}

const agentRow = (id: string, kind: string | null) => ({
  terminal_id: `t-${id}`, name: "paseo-secretname", agent: kind, agent_status: "working", workspace_id: "w1", tab_id: "tab1", pane_id: id, focused: false,
  cwd: "/home/alice/secret-project", title: "SECRET PROMPT: fix the payroll bug", terminal_title: "SECRET PROMPT", revision: 1,
});

it("plugin version constant matches package.json", async () => {
  const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")) as { version: string };
  expect(PLUGIN_VERSION).toBe(pkg.version);
});

it("herdr.diagnostics returns the bug-report shape with Herdr version, target, companion and per-agent readiness", async () => {
  fake.reply("agent.list", { type: "agent_list", agents: [agentRow("p1", "omp"), agentRow("p2", "claude")] });
  fake.reply("pane.process_info", { type: "pane_process_info", process_info: { pane_id: "p1", foreground_process_group_id: null, foreground_processes: [] } });
  const result = diagnosticsSchema.parse(await setup()());
  expect(Object.keys(result).sort()).toEqual(TOP_KEYS);
  expect(result).toEqual({
    pluginVersion: PLUGIN_VERSION,
    target: { socketPath: fake.socketPath, herdrSession: "work", source: "settingSession", autoStart: true },
    ompEnabled: true,
    herdr: { connected: true, version: "0.9.3", error: null },
    companion: { state: "missing", path: join(dir, "paseo4herdr-input.ts") },
    agents: [{ paneId: "p1", inputReady: null }, { paneId: "p2", inputReady: null }],
    counts: { agents: 2, inputReady: 0, readOnly: 0, unknown: 2 },
  });
});

it("herdr.diagnostics reports input readiness and counts for an OMP agent", async () => {
  fake.reply("agent.list", { type: "agent_list", agents: [agentRow("p1", "omp")] });
  fake.reply("pane.process_info", { type: "pane_process_info", process_info: { pane_id: "p1", foreground_process_group_id: 41, foreground_processes: [{ pid: 41, name: "omp" }] } });
  const reachable = async (ready: boolean) => (await setup({ harnesses: [{ ...ompAdapter, inputReachable: async () => ready }] })());
  expect(await reachable(true)).toMatchObject({ agents: [{ paneId: "p1", inputReady: true }], counts: { agents: 1, inputReady: 1, readOnly: 0, unknown: 0 } });
  expect(await reachable(false)).toMatchObject({ agents: [{ paneId: "p1", inputReady: false }], counts: { agents: 1, inputReady: 0, readOnly: 1, unknown: 0 } });
});

it("herdr.diagnostics never leaks prompts, titles, folders, agent names or env values", async () => {
  fake.reply("agent.list", { type: "agent_list", agents: [agentRow("p1", "omp")] });
  const text = JSON.stringify(await setup()());
  for (const secret of ["SECRET PROMPT", "payroll", "/home/alice", "secretname", "sk-super-secret-env-value", "not shown", "t-p1"]) expect(text).not.toContain(secret);
});

it("herdr.diagnostics still answers when Herdr is unavailable", async () => {
  const result = await setup({ ensureReady: async () => { throw new Error(`Herdr is not running at ${fake.socketPath}`); } })();
  expect(diagnosticsSchema.parse(result)).toMatchObject({
    herdr: { connected: false, version: null, error: `Herdr is not running at ${fake.socketPath}` },
    agents: [], counts: { agents: 0, inputReady: 0, readOnly: 0, unknown: 0 },
  });
});

it("herdr.diagnostics reports a failed companion check as unknown without a path", async () => {
  fake.reply("agent.list", { type: "agent_list", agents: [] });
  const result = await setup({ companionStatus: async () => { throw new Error("EACCES: /secret/dir"); } })();
  expect(result.companion).toEqual({ state: "unknown" });
  expect(JSON.stringify(result)).not.toContain("/secret/dir");
});

it("buildDiagnostics copies allowlisted fields only, counts readiness and bounds the error text", () => {
  const input = {
    pluginVersion: "9.9.9",
    target: { ...baseTarget("/s"), apiToken: "tok-secret" },
    ompEnabled: false,
    herdr: { connected: false, version: null, error: "x".repeat(1000), env: { KEY: "v-secret" } },
    companion: { state: "outdated", path: "/e/x.ts", contents: "file-secret" },
    agents: [
      { paneId: "a", inputReady: true, prompt: "prompt-secret", cwd: "/cwd-secret", env: { K: "env-secret" } },
      { paneId: "b", inputReady: false, transcript: "transcript-secret" },
      { paneId: "c", inputReady: null },
    ],
    prompt: "top-prompt-secret",
  } as unknown as DiagnosticsInput;
  const out = buildDiagnostics(input);
  expect(Object.keys(out).sort()).toEqual(TOP_KEYS);
  expect(Object.keys(out.target).sort()).toEqual(["autoStart", "herdrSession", "socketPath", "source"]);
  expect(Object.keys(out.herdr).sort()).toEqual(["connected", "error", "version"]);
  expect(Object.keys(out.companion).sort()).toEqual(["path", "state"]);
  expect(out.agents.map((a) => Object.keys(a).sort())).toEqual([["inputReady", "paneId"], ["inputReady", "paneId"], ["inputReady", "paneId"]]);
  expect(out.counts).toEqual({ agents: 3, inputReady: 1, readOnly: 1, unknown: 1 });
  expect(out.herdr.error).toHaveLength(300);
  expect(JSON.stringify(out)).not.toMatch(/secret/);
});

it("diagnosticsText is pretty-printed JSON that round-trips", () => {
  const d = buildDiagnostics({ pluginVersion: "1", target: baseTarget("/s"), ompEnabled: true, herdr: { connected: true, version: "0.9.3", error: null }, companion: { state: "current" }, agents: [] });
  const text = diagnosticsText(d);
  expect(text).toContain("\n  \"pluginVersion\": \"1\"");
  expect(JSON.parse(text)).toEqual(d);
});
