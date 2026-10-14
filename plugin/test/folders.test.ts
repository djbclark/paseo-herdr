import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { registerManagementRpcs, type ManagementDeps } from "../server/rpc.js";
import { expandHome, resolveQuery, splitParent, TYPED_LIMIT } from "../server/folders.js";
import { herdrFoldersSuggestRpc, herdrWorkspaceCreateRpc, type HerdrTarget } from "../shared/rpc.js";
import { ompAdapter } from "../server/harness/omp/adapter.js";
import { FakeHerdr } from "./fake-herdr.js";

let fake: FakeHerdr;
let home: string;
beforeEach(async () => {
  fake = await FakeHerdr.create();
  home = await mkdtemp(join(tmpdir(), "folders-home-"));
  for (const d of ["Projects/alpha", "Projects/Beta", "Projects/gamma-alpha", "Projects/.hidden", "Projects/alps", "docs"]) await mkdir(join(home, d), { recursive: true });
  await writeFile(join(home, "Projects/alpha-file"), "x");
});
afterEach(async () => { await fake.close(); await rm(home, { recursive: true, force: true }); });

type Handler = (input: any, ctx: any) => Promise<any>;
function setup(overrides: Partial<ManagementDeps> = {}) {
  const handlers = new Map<string, Handler>();
  const target: HerdrTarget = { socketPath: fake.socketPath, herdrSession: "work", source: "settingSession", autoStart: false, autoStartDisabledReason: null };
  registerManagementRpcs({ handle: ((c: { name: string }, h: Handler) => { handlers.set(c.name, h); }) as never }, {
    readTarget: async () => ({ target, ompEnabled: true }),
    ensureReady: async (t) => ({ target: t, version: "0.9.3", autoStarted: false }),
    harnesses: [ompAdapter],
    homedir: () => home,
    ...overrides,
  });
  return (query: string, paseo: unknown = {}) => handlers.get(herdrFoldersSuggestRpc.name)!({ query }, { paseo });
}
const paths = (r: { folders: { path: string }[] }) => r.folders.map((f) => f.path);

describe("path helpers", () => {
  it("expands only a leading ~ or ~/", () => {
    expect(expandHome("~", "/h")).toBe("/h");
    expect(expandHome("~/a/b", "/h")).toBe("/h/a/b");
    expect(expandHome("~x/a", "/h")).toBe("~x/a");
    expect(expandHome("/a/~", "/h")).toBe("/a/~");
  });
  it("resolves absolute queries and rejects relative ones", () => {
    expect(resolveQuery("~/a/../b/", "/h")).toBe("/h/b");
    expect(resolveQuery("/x//y/", "/h")).toBe("/x/y");
    expect(resolveQuery("rel/x", "/h")).toBeNull();
  });
  it("splits parent and segment", () => {
    expect(splitParent("/a/b/")).toEqual({ parent: "/a/b/", segment: "" });
    expect(splitParent("/a/b")).toEqual({ parent: "/a/", segment: "b" });
    expect(splitParent("/a")).toEqual({ parent: "/", segment: "a" });
  });
});

describe("herdr.folders.suggest", () => {
  it("lists only directories by prefix, then substring, case-insensitively, hiding dot-directories", async () => {
    const suggest = setup();
    expect(paths(await suggest(`${home}/Projects/AL`))).toEqual([`${home}/Projects/alpha`, `${home}/Projects/alps`, `${home}/Projects/gamma-alpha`]);
    const all = await suggest(`${home}/Projects/`);
    expect(paths(all)).toEqual([`${home}/Projects/alpha`, `${home}/Projects/alps`, `${home}/Projects/Beta`, `${home}/Projects/gamma-alpha`]);
    expect(paths(await suggest(`${home}/Projects/.`))).toEqual([`${home}/Projects/.hidden`]);
    expect(all.folders.every((f: { source: string }) => f.source === "filesystem")).toBe(true);
  });
  it("follows symlinks to directories", async () => {
    await symlink(join(home, "docs"), join(home, "Projects/linked"));
    expect(paths(await setup()(`${home}/Projects/lin`))).toEqual([`${home}/Projects/linked`]);
  });
  it("returns an empty list for a missing or unreadable parent and a file parent", async () => {
    const suggest = setup();
    expect((await suggest(`${home}/nope/x`)).folders).toEqual([]);
    expect((await suggest(`${home}/Projects/alpha-file/x`)).folders).toEqual([]);
  });
  it("expands ~ with the daemon's home and reports the resolved path", async () => {
    const suggest = setup();
    const r = await suggest("~/Proj");
    expect(paths(r)).toEqual([`${home}/Projects`]);
    expect(r.resolved).toBe(`${home}/Proj`);
    expect(paths(await suggest("~/Projects/be"))).toEqual([`${home}/Projects/Beta`]);
    const bare = await suggest("~");
    expect(bare.resolved).toBe(home);
    expect(paths(bare)).toEqual([`${home}/docs`, `${home}/Projects`]);
  });
  it("caps the list", async () => {
    for (let i = 0; i < 30; i++) await mkdir(join(home, `many/d${String(i).padStart(2, "0")}`), { recursive: true });
    expect((await setup()(`${home}/many/`)).folders).toHaveLength(TYPED_LIMIT);
  });
  it("blank query lists known folders from Herdr then Paseo, deduped and capped", async () => {
    const pane = (id: string, cwd: string) => ({ pane_id: id, terminal_id: `t-${id}`, workspace_id: "w1", tab_id: "tab", focused: false, cwd, agent_status: "idle", revision: 1 });
    fake.reply("pane.list", { type: "pane_list", panes: [pane("p1", "/work/a"), pane("p2", "/work/b")] });
    fake.reply("agent.list", { type: "agent_list", agents: [{ terminal_id: "t-p1", name: null, agent: "omp", agent_status: "idle", workspace_id: "w1", tab_id: "tab", pane_id: "p1", focused: false, cwd: "/work/a", revision: 1 }] });
    const workspaces = { list: async () => ({ entries: [{ workspaceDirectory: "/work/b" }, { projectRootPath: "/work/c" }, { workspaceDirectory: "/work/d" }] }) };
    const r = await setup()("  ", { workspaces });
    expect(r.resolved).toBeNull();
    expect(r.folders).toEqual([
      { path: "/work/a", source: "herdr" }, { path: "/work/b", source: "herdr" },
      { path: "/work/c", source: "paseo" }, { path: "/work/d", source: "paseo" },
    ]);
    const many = { list: async () => ({ entries: Array.from({ length: 40 }, (_, i) => ({ workspaceDirectory: `/p/${i}` })) }) };
    expect((await setup()("", { workspaces: many })).folders).toHaveLength(15);
  });
  it("merges matching known folders after disk matches, keeping their source and not duplicating", async () => {
    const workspaces = { list: async () => ({ entries: [{ workspaceDirectory: `${home}/Projects/alpha` }, { workspaceDirectory: "/elsewhere/alpha-two" }, { workspaceDirectory: "/x/unrelated" }] }) };
    const r = await setup()(`${home}/Projects/al`, { workspaces });
    expect(r.folders).toEqual([
      { path: `${home}/Projects/alpha`, source: "paseo" },
      { path: `${home}/Projects/alps`, source: "filesystem" },
      { path: `${home}/Projects/gamma-alpha`, source: "filesystem" },
    ]);
    expect(paths(await setup()("alpha-t", { workspaces }))).toEqual(["/elsewhere/alpha-two"]);
  });
  it("tolerates Herdr and Paseo being unavailable", async () => {
    fake.replyError("pane.list", "down");
    const r = await setup()("", { workspaces: { list: async () => { throw new Error("no"); } } });
    expect(r).toEqual({ resolved: null, folders: [] });
    expect((await setup({ readTarget: async () => { throw new Error("no target"); } })(`${home}/doc`)).folders).toEqual([{ path: `${home}/docs`, source: "filesystem" }]);
  });
});

describe("herdr.workspace.create with ~", () => {
  it("expands ~ before checking the directory", async () => {
    fake.handle("workspace.create", (req, s) => s.end(JSON.stringify({ id: req.id, result: { type: "workspace_created", workspace: { workspace_id: "w9" }, tab: { tab_id: "t9" }, root_pane: { pane_id: "p", terminal_id: "tt", workspace_id: "w9", tab_id: "t9" } } }) + "\n"));
    const handlers = new Map<string, Handler>();
    registerManagementRpcs({ handle: ((c: { name: string }, h: Handler) => { handlers.set(c.name, h); }) as never }, {
      readTarget: async () => ({ target: { socketPath: fake.socketPath, herdrSession: null, source: "default", autoStart: false, autoStartDisabledReason: null }, ompEnabled: true }),
      ensureReady: async (t) => ({ target: t, version: "0.9.3", autoStarted: false }),
      harnesses: [ompAdapter], homedir: () => home,
    });
    const out = await handlers.get(herdrWorkspaceCreateRpc.name)!({ cwd: "~/docs" }, {});
    expect(out).toMatchObject({ label: "docs" });
    expect(out.cwd).toMatch(/docs$/);
    expect(fake.requestsFor("workspace.create")[0].params).toMatchObject({ label: "docs" });
  });
});
