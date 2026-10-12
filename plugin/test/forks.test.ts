import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProviderEventSchema, type ProviderEvent } from "@getpaseo/plugin/server/provider";
import { findOmpForks } from "../server/harness/omp/forks.js";
import { ompAdapter } from "../server/harness/omp/adapter.js";
import { FORK_SCAN_INTERVAL_MS } from "../server/forks.js";
import { HerdrHarnessSession } from "../server/session.js";
import { bindingOf } from "../server/binding.js";
import type { AgentInfo } from "../server/herdr/schema.js";
import type { NativeFork } from "../server/harness/types.js";
import { FakeTranscript, makeFakeAdapter } from "./fake-harness.js";

const pad = " ".repeat(180);
const header = (id: string, parentSession?: string) => [
  JSON.stringify({ type: "title", v: 1, title: "t", pad }),
  JSON.stringify({ type: "session", version: 3, id, timestamp: "2026-10-12T00:00:00.000Z", cwd: "/w", ...(parentSession ? { parentSession } : {}) }),
  JSON.stringify({ type: "model_change", id: "m1", parentId: null }),
].join("\n") + "\n";

describe("omp findForks", () => {
  let dir: string;
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "forks-")); });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });
  const own = () => join(dir, "own.jsonl");
  const locator = () => ({ path: own(), nativeSessionKey: own() });

  it("finds a sibling naming our session as parent", async () => {
    await writeFile(own(), header("S1"));
    await writeFile(join(dir, "fork.jsonl"), header("S2", "S1"));
    expect(await ompAdapter.findForks!(locator())).toEqual([{ path: join(dir, "fork.jsonl"), sessionId: "S2" }]);
  });

  it("ignores unrelated parents, our own file, root sessions and garbage", async () => {
    await writeFile(own(), header("S1", "S0"));
    await writeFile(join(dir, "other.jsonl"), header("S3", "S9"));
    await writeFile(join(dir, "root.jsonl"), header("S4"));
    await writeFile(join(dir, "garbage.jsonl"), "\u0000\u0001 not json\n{\"type\":");
    await writeFile(join(dir, "empty.jsonl"), "");
    await writeFile(join(dir, "notes.txt"), header("S5", "S1"));
    await mkdir(join(dir, "dir.jsonl"));
    expect(await findOmpForks(locator())).toEqual([]);
  });

  it("returns [] when our own file is missing or has no header", async () => {
    await writeFile(join(dir, "fork.jsonl"), header("S2", "S1"));
    expect(await findOmpForks(locator())).toEqual([]);
    await writeFile(own(), "garbage\n");
    expect(await findOmpForks(locator())).toEqual([]);
  });

  it("skips files much older than ours, reads only the head of large files", async () => {
    await writeFile(own(), header("S1"));
    await writeFile(join(dir, "old.jsonl"), header("S2", "S1"));
    const old = new Date(Date.now() - 24 * 3600_000);
    await utimes(join(dir, "old.jsonl"), old, old);
    await writeFile(join(dir, "big.jsonl"), header("S3", "S1") + "x".repeat(5_000_000));
    expect(await findOmpForks(locator())).toEqual([{ path: join(dir, "big.jsonl"), sessionId: "S3" }]);
  });
});

describe("ForkWatcher", () => {
  const sessions: HerdrHarnessSession[] = [];
  afterEach(() => { for (const session of sessions.splice(0)) session.close(); vi.useRealTimers(); });

  function makeAgent(value = "fake-session-1"): AgentInfo {
    return { terminal_id: "terminal", pane_id: "pane", agent: "fake", name: "demo", agent_status: "idle",
      agent_session: { source: "herdr:fake", agent: "fake", kind: "id", value },
      workspace_id: "w", tab_id: "t", focused: true, screen_detection_skipped: false,
      state_labels: {}, tokens: {}, launch_pending: false, interactive_ready: true,
      state_change_seq: 0, completion_seq: null, cwd: "/work", revision: 0 };
  }

  async function setup() {
    vi.useFakeTimers();
    const state = { agent: makeAgent(), forks: [] as NativeFork[], calls: 0 };
    const store = new FakeTranscript();
    store.set([{ id: "u", kind: "user", text: "q" }, { id: "a", kind: "assistant", text: "r" }]);
    const adapter = { ...makeFakeAdapter(store), findForks: async () => { state.calls++; return state.forks; } };
    const events: ProviderEvent[] = [];
    const session = new HerdrHarnessSession("local", bindingOf(state.agent, adapter, null), {
      adapter, listAgents: async () => [state.agent],
      request: async () => ({ type: "pane_process_info", process_info: {
        pane_id: "pane", foreground_process_group_id: 100, tty: "/dev/pts/fake",
        foreground_processes: [{ pid: 100, name: "fake" }] } }),
      subscribe: async () => ({ [Symbol.asyncIterator]: async function* () {}, close() {} }),
      emit: (event) => events.push(event),
    });
    sessions.push(session);
    await session.open({ cwd: "/work", env: {}, mcpServers: {}, settings: {}, persist: true }, "skip");
    const notices = () => events.filter((e) => e.type === "session.notice" && e.notice.id.startsWith("fork-"));
    const tick = () => vi.advanceTimersByTimeAsync(FORK_SCAN_INTERVAL_MS);
    return { state, session, events, notices, tick };
  }

  it("emits one warning per fork and never repeats", async () => {
    const { state, events, notices, tick } = await setup();
    await vi.advanceTimersByTimeAsync(0);
    expect(notices()).toHaveLength(0);
    state.forks = [{ path: "/s/fork-b.jsonl", sessionId: "B" }];
    await tick();
    expect(notices()).toHaveLength(0);
    await tick();
    expect(notices()).toHaveLength(1);
    expect(notices()[0]).toMatchObject({ type: "session.notice", notice: {
      id: "fork-B", severity: "warning", title: "Conversation continued in another process" } });
    expect((notices()[0] as { notice: { description: string } }).notice.description).toContain("fork-b.jsonl");
    state.forks = [...state.forks, { path: "/s/fork-c.jsonl", sessionId: "C" }];
    await tick();
    expect(notices()).toHaveLength(1);
    await tick();
    expect(notices().map((e) => (e as { notice: { id: string } }).notice.id)).toEqual(["fork-B", "fork-C"]);
    for (const event of events) expect(() => ProviderEventSchema.parse(event)).not.toThrow();
  });

  it("scans immediately on start and notifies on the second sighting", async () => {
    const { state, notices } = await setup();
    state.forks = [{ path: "/s/x.jsonl", sessionId: "X" }];
    expect(notices()).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(FORK_SCAN_INTERVAL_MS);
    expect(notices()).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(FORK_SCAN_INTERVAL_MS);
    expect(notices()).toHaveLength(1);
  });

  it("fork seen once then gone → no notice", async () => {
    const { state, notices, tick } = await setup();
    await vi.advanceTimersByTimeAsync(0);
    state.forks = [{ path: "/s/fork.jsonl", sessionId: "B" }];
    await tick();
    state.forks = [];
    await tick();
    await tick();
    expect(notices()).toHaveLength(0);
    // Reappearing starts a fresh sighting rather than inheriting the old one.
    state.forks = [{ path: "/s/fork.jsonl", sessionId: "B" }];
    await tick();
    expect(notices()).toHaveLength(0);
    await tick();
    expect(notices()).toHaveLength(1);
  });

  it("fork seen in scan 1 that becomes the pane's own ref by scan 2 → no notice", async () => {
    const { state, notices, tick } = await setup();
    await vi.advanceTimersByTimeAsync(0);
    // Scan 1: Herdr still reports the pane's old ref, so the new fork looks foreign.
    state.forks = [{ path: "/s/fork.jsonl", sessionId: "B" }];
    await tick();
    expect(notices()).toHaveLength(0);
    // Scan 2: Herdr's ref has caught up to the fork the pane itself created.
    state.agent = makeAgent("B");
    await tick();
    await tick();
    expect(notices()).toHaveLength(0);
  });

  it("does not scan or notify when read-only or closed", async () => {
    const { state, session, notices, tick } = await setup();
    await vi.advanceTimersByTimeAsync(0);
    session.freeze("x", "y");
    const before = state.calls;
    state.forks = [{ path: "/s/fork.jsonl", sessionId: "B" }];
    await tick();
    await tick();
    expect(state.calls).toBe(before);
    expect(notices()).toHaveLength(0);
  });

  it("stop() ends scanning", async () => {
    const { state, session, notices, tick } = await setup();
    await vi.advanceTimersByTimeAsync(0);
    session.live.stop();
    const before = state.calls;
    state.forks = [{ path: "/s/fork.jsonl", sessionId: "B" }];
    await tick();
    expect(state.calls).toBe(before);
    expect(notices()).toHaveLength(0);
  });

  it("skips the pane's own fork (the native ref changed)", async () => {
    const { state, notices, tick } = await setup();
    state.agent = makeAgent("B");
    state.forks = [{ path: "/s/fork.jsonl", sessionId: "B" }];
    await tick();
    await tick();
    expect(notices()).toHaveLength(0);
  });

  it("skips a fork whose path or id is the ref Herdr reports for the pane", async () => {
    const { state, session, notices, tick } = await setup();
    await vi.advanceTimersByTimeAsync(0);
    // Same binding ref as the pane reports, and the fork is that very session.
    state.forks = [{ path: "/s/fork.jsonl", sessionId: "fake-session-1" }];
    await tick();
    expect(notices()).toHaveLength(0);
    expect(session.state.outcome).toBe("active");
  });

  it("does not change binding or outcome", async () => {
    const { state, session, tick } = await setup();
    const ref = { ...session.state.binding.sessionRef };
    state.forks = [{ path: "/s/fork.jsonl", sessionId: "B" }];
    await tick();
    expect(session.state.binding.sessionRef).toEqual(ref);
    expect(session.state.outcome).toBe("active");
  });
});
