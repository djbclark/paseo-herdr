import { afterEach, describe, expect, it } from "vitest";
import type { AgentInfo } from "../server/herdr/schema.js";
import { bindingOf, parseBinding, persistenceOf, capSubmittedMessages } from "../server/binding.js";
import { diffTimeline, seedTimeline, emptyTimelineState } from "../server/timeline.js";
import { discoverSessions } from "../server/discovery.js";
import { HerdrHarnessSession } from "../server/session.js";
import { ProviderEventSchema, type ProviderEvent, type ProviderSessionConfig } from "@getpaseo/plugin/server/provider";
import { FakeTranscript, makeFakeAdapter, FAKE_HARNESS_ID } from "./fake-harness.js";

const config: ProviderSessionConfig = {
  cwd: "/work", env: {}, mcpServers: {}, settings: {}, persist: true,
};

function fakeAgent(overrides: Partial<AgentInfo> = {}): AgentInfo {
  return {
    terminal_id: "term-1",
    name: "fake-demo",
    agent: FAKE_HARNESS_ID,
    title: "Fake Demo",
    terminal_title: null,
    terminal_title_stripped: null,
    display_agent: "fake",
    agent_status: "idle",
    screen_detection_skipped: false,
    state_labels: {},
    tokens: {},
    agent_session: { source: `herdr:${FAKE_HARNESS_ID}`, agent: FAKE_HARNESS_ID, kind: "id", value: "fake-session-1" },
    workspace_id: "w1",
    tab_id: "t1",
    pane_id: "pane-1",
    focused: true,
    launch_pending: false,
    interactive_ready: true,
    state_change_seq: 0,
    completion_seq: null,
    cwd: "/work",
    foreground_cwd: "/work",
    revision: 0,
    ...overrides,
  };
}

describe("neutral core", () => {
  it("binds, persists, and re-parses with the fake adapter", () => {
    const adapter = makeFakeAdapter();
    const agent = fakeAgent();
    const binding = bindingOf(agent, adapter, null);
    expect(binding.harness).toBe(FAKE_HARNESS_ID);
    expect(binding.sessionRef).toEqual({ kind: "id", value: "fake-session-1" });
    const persistence = persistenceOf(binding);
    const parsed = parseBinding(persistence, adapter);
    expect(parsed.sessionRef).toEqual({ kind: "id", value: "fake-session-1" });
    expect(parsed.terminalId).toBe("term-1");
  });

  it("rejects persistence belonging to another harness", () => {
    const adapter = makeFakeAdapter();
    const agent = fakeAgent();
    const binding = bindingOf(agent, adapter, null);
    const persistence = {
      ...persistenceOf(binding),
      data: { ...(persistenceOf(binding).data as Record<string, unknown>), harness: "omp" },
    };
    expect(() => parseBinding(persistence, adapter)).toThrow("belongs to another harness");
  });

  it("caps submitted messages at 256", () => {
    const submitted: Record<string, string> = {};
    for (let i = 0; i < 300; i++) submitted[`msg-${i}`] = `client-${i}`;
    const capped = capSubmittedMessages(submitted);
    expect(Object.keys(capped)).toHaveLength(256);
    expect(capped["msg-43"]).toBeUndefined();
    expect(capped["msg-44"]).toBe("client-44");
    expect(capped["msg-299"]).toBe("client-299");
  });

  it("diffTimeline emits only new/changed rows", () => {
    const snapshot = {
      items: [
        { id: "fake:1", type: "user_message" as const, text: "a" },
        { id: "fake:2", type: "assistant_message" as const, text: "b" },
      ],
      timestamps: { "fake:1": "t1", "fake:2": "t2" },
      turnState: "idle" as const,
      chainHead: "fake:2",
      chainIds: ["fake:1", "fake:2"],
      extendsPrevious: () => true,
    };
    const seeded = seedTimeline(snapshot);
    expect(seeded.rows).toHaveLength(2);
    const changed = diffTimeline(
      { ...snapshot, items: [...snapshot.items, { id: "fake:3", type: "assistant_message" as const, text: "c" }], timestamps: { ...snapshot.timestamps, "fake:3": "t3" }, chainIds: ["fake:1", "fake:2", "fake:3"], chainHead: "fake:3" },
      seeded.state,
    );
    expect(changed).toHaveLength(1);
    expect(changed[0].item.id).toBe("fake:3");
    expect(emptyTimelineState().size).toBe(0);
  });

  it("attaches clientMessageId to correlated user rows", () => {
    const snapshot = {
      items: [{ id: "fake:u", type: "user_message" as const, text: "hi" }],
      timestamps: {},
      turnState: "working" as const,
      chainHead: "fake:u",
      chainIds: ["fake:u"],
      extendsPrevious: () => true,
    };
    const seeded = seedTimeline(snapshot, { "fake:u": "client-1" });
    expect(seeded.rows[0].item).toMatchObject({ clientMessageId: "client-1" });
  });

  it("discovers path-less fake sessions without a readable transcript", async () => {
    const adapter = makeFakeAdapter();
    const agent = fakeAgent({ agent_session: null });
    const summaries = await discoverSessions(adapter, [agent], { type: "sessions", requestId: "list", cwd: "/work" });
    expect(summaries).toHaveLength(1);
    expect(summaries[0].description).toBe("Fake in Herdr · pane pane-1 · idle · history unavailable");
  });

  it("discovers id-backed fake sessions with a readable transcript", async () => {
    const store = new FakeTranscript();
    store.set([
      { id: "u1", kind: "user", text: "hello" },
      { id: "a1", kind: "assistant", text: "world" },
    ]);
    const adapter = makeFakeAdapter(store);
    const agent = fakeAgent();
    const summaries = await discoverSessions(adapter, [agent], { type: "sessions", requestId: "list" });
    expect(summaries).toHaveLength(1);
    // Harness and pane identify the agent; the last prompt helps tell conversations apart.
    expect(summaries[0].description).toBe("Fake in Herdr · pane pane-1 · idle — “hello”");
  });

  it("session open replays items and closes without a turn event", async () => {
    const store = new FakeTranscript();
    store.set([
      { id: "u1", kind: "user", text: "hello" },
      { id: "a1", kind: "assistant", text: "world" },
    ]);
    const adapter = makeFakeAdapter(store);
    const agent = fakeAgent();
    const events: ProviderEvent[] = [];
    const binding = bindingOf(agent, adapter, null);
    const session = new HerdrHarnessSession("local", binding, {
      adapter,
      listAgents: async () => [agent],
      request: async () => ({ type: "pane_process_info", process_info: {
        pane_id: "pane-1", foreground_process_group_id: 100, tty: "/dev/pts/fake",
        foreground_processes: [{ pid: 100, name: "fake" }],
      } }),
      subscribe: async () => ({ [Symbol.asyncIterator]: async function* () {}, close() {} }),
      emit: (event) => events.push(event),
    });
    await session.open(config, "replay");
    const opened = events.find((event) => event.type === "session.opened");
    expect(opened).toBeDefined();
    const replayItems = events.filter((event) => event.type === "timeline.item");
    expect(replayItems).toHaveLength(2);
    expect(events.some((event) => event.type === "session.ready")).toBe(true);
    for (const event of events) expect(() => ProviderEventSchema.parse(event)).not.toThrow();
    session.close();
    expect(session.isAborted).toBe(true);
    expect(events.some((event) => event.type === "session.turn")).toBe(false);
  });

  it("opens read-only when the bound agent is gone", async () => {
    const adapter = makeFakeAdapter();
    const agent = fakeAgent();
    const events: ProviderEvent[] = [];
    const binding = bindingOf(agent, adapter, null);
    const session = new HerdrHarnessSession("local", binding, {
      adapter,
      listAgents: async () => [],
      request: async () => ({ type: "pane_process_info", process_info: {
        pane_id: "pane-1", foreground_process_group_id: 100, tty: "/dev/pts/fake",
        foreground_processes: [{ pid: 100, name: "fake" }],
      } }),
      subscribe: async () => ({ [Symbol.asyncIterator]: async function* () {}, close() {} }),
      emit: (event) => events.push(event),
    });
    await session.open(config, "replay");
    expect(events.some((event) => event.type === "session.notice" && event.notice.title.includes("unavailable"))).toBe(true);
    expect(events.some((event) => event.type === "session.ready")).toBe(true);
  });

  it("opens read-only for a definitive but unreadable session ref (fake path ref)", async () => {
    const adapter = makeFakeAdapter();
    // The fake adapter only reads `kind:"id"`; a `kind:"path"` ref is definitive
    // but unreadable, mirroring OMP `--no-session` (`kind:"id"`).
    const agent = fakeAgent({
      agent_session: { source: "herdr:fake", agent: FAKE_HARNESS_ID, kind: "path", value: "/unreadable.jsonl" },
    });
    const events: ProviderEvent[] = [];
    const binding = bindingOf(agent, adapter, null);
    const session = new HerdrHarnessSession("local", binding, {
      adapter,
      listAgents: async () => [agent],
      request: async () => ({ type: "pane_process_info", process_info: {
        pane_id: "pane-1", foreground_process_group_id: 100, tty: "/dev/pts/fake",
        foreground_processes: [{ pid: 100, name: "fake" }],
      } }),
      subscribe: async () => ({ [Symbol.asyncIterator]: async function* () {}, close() {} }),
      emit: (event) => events.push(event),
    });
    await session.open(config, "replay");
    expect(events.some((event) => event.type === "session.notice" && event.notice.title === "History unavailable")).toBe(true);
    // Read-only: the input gate must refuse a prompt.
    await session.prompt({
      clientMessageId: "m1",
      delivery: "auto",
      input: { type: "message", content: [{ type: "text", text: "hello" }] },
    });
    expect(events.some((event) => event.type === "session.prompt_result" && event.result.type === "failed")).toBe(true);
  });
});


