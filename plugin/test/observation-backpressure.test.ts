import { afterEach, expect, it, vi } from "vitest";
import { HerdrHarnessSession, type SessionDeps } from "../server/session.js";
import { bindingOf } from "../server/binding.js";
import { HerdrClient, type HerdrSubscription, type SubscriptionEventEnvelope } from "../server/herdr/client.js";
import type { AgentInfo } from "../server/herdr/schema.js";
import { FakeTranscript, makeFakeAdapter } from "./fake-harness.js";
import { FakeHerdr } from "./fake-herdr.js";

const config = { cwd: "/work", env: {}, mcpServers: {}, settings: {}, persist: true };
function makeAgent(): AgentInfo {
  return { terminal_id: "terminal", pane_id: "pane", agent: "fake", name: "demo", agent_status: "idle",
    agent_session: { source: "herdr:fake", agent: "fake", kind: "id", value: "fake-session-1" },
    workspace_id: "w", tab_id: "t", focused: true, screen_detection_skipped: false,
    state_labels: {}, tokens: {}, launch_pending: false, interactive_ready: true,
    state_change_seq: 0, completion_seq: null, cwd: "/work", revision: 0 };
}

const sessions: HerdrHarnessSession[] = [];
const subscriptions = new Set<HerdrSubscription>();
let fake: FakeHerdr | undefined;
afterEach(async () => {
  for (const session of sessions.splice(0)) session.close();
  for (const sub of subscriptions) sub.close();
  subscriptions.clear();
  vi.useRealTimers();
  await fake?.close();
  fake = undefined;
});

/** A session whose notification stream the test drives; `calls` records the burst size seen by each reconcile. */
async function setup() {
  vi.useFakeTimers();
  const agent = makeAgent();
  const store = new FakeTranscript();
  store.set([{ id: "old-user", kind: "user", text: "old question" }, { id: "old-end", kind: "assistant", text: "old answer" }]);
  const adapter = makeFakeAdapter(store);
  const calls: number[] = [];
  let pushed = 0;
  let block = false;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const queue: SubscriptionEventEnvelope[] = [];
  let wake: (() => void) | undefined;
  let closed = false;
  const session = new HerdrHarnessSession("local", bindingOf(agent, adapter, null), {
    adapter,
    listAgents: async () => { calls.push(pushed); if (block) await gate; return [agent]; },
    request: async (method) => {
      if (method === "pane.process_info") return { type: "pane_process_info", process_info: {
        pane_id: agent.pane_id, foreground_process_group_id: 100, tty: "/dev/pts/fake",
        foreground_processes: [{ pid: 100, name: "fake" }],
      } };
      return { type: "agent_prompted", agent };
    },
    subscribe: async () => ({
      [Symbol.asyncIterator]: async function* () {
        while (!closed) {
          if (!queue.length) await new Promise<void>((resolve) => { wake = resolve; });
          if (closed) return;
          const event = queue.shift();
          if (event) yield event;
        }
      },
      close() { closed = true; wake?.(); },
    }),
    emit: () => {},
  } satisfies SessionDeps);
  sessions.push(session);
  await session.open(config, "skip");
  await session.live.reconcile();
  return {
    session, calls,
    base: calls.length,
    notify(event: string): void { pushed++; queue.push({ event, data: undefined }); wake?.(); },
    block() { block = true; },
    release() { block = false; release(); },
  };
}

it("collapses a notification burst into a few reconciles and still observes the final state", async () => {
  const rig = await setup();
  const total = 500;
  for (let i = 0; i < total; i++) {
    rig.notify("pane_updated");
    await vi.advanceTimersByTimeAsync(1);
  }
  await vi.advanceTimersByTimeAsync(400);
  const reconciles = rig.calls.length - rig.base;
  // 500 notifications over ~500ms: bounded by the cadence cap, never one reconcile per notification.
  expect(reconciles).toBeGreaterThan(0);
  expect(reconciles).toBeLessThanOrEqual(5);
  // The last reconcile started after the last notification, so the final state was read.
  expect(rig.calls.at(-1)).toBe(total);
});

it("lets the first notification after a quiet spell through at once", async () => {
  const rig = await setup();
  await vi.advanceTimersByTimeAsync(1000);
  const before = rig.calls.length;
  rig.notify("pane_updated");
  await vi.advanceTimersByTimeAsync(0);
  expect(rig.calls.length).toBe(before + 1);
});

it("keeps at most one reconcile waiting behind a running one", async () => {
  const rig = await setup();
  rig.block();
  const running = rig.session.live.reconcile();
  await vi.advanceTimersByTimeAsync(0);
  const waiting = Array.from({ length: 50 }, () => rig.session.live.reconcile());
  expect(new Set(waiting).size).toBe(1);
  rig.release();
  await Promise.all([running, ...waiting]);
  expect(rig.calls.length - rig.base).toBe(2);
});

it("treats a local resync marker as a reason to take one fresh snapshot, not as a lost connection", async () => {
  const rig = await setup();
  await vi.advanceTimersByTimeAsync(1000);
  const before = rig.calls.length;
  rig.notify("observer.resync");
  await vi.advanceTimersByTimeAsync(0);
  expect(rig.calls.length).toBe(before + 1);
  expect(rig.session.state.connected).toBe(true);
});

const customEvent = (n: number) => ({ event: "custom", data: { n } });
const nOf = (envelope: SubscriptionEventEnvelope) => (envelope.data as { n: number }).n;

async function openStream() {
  fake = await FakeHerdr.create();
  const sub = new HerdrClient(fake.socketPath).subscribe([{ type: "pane.updated" }], { reconnect: { baseDelayMs: 5, maxDelayMs: 5 } });
  subscriptions.add(sub);
  const iterator = sub[Symbol.asyncIterator]();
  await expect(iterator.next()).resolves.toMatchObject({ value: { event: "observer.connected" } });
  return { fake, iterator };
}

it("drops the oldest queued notifications on overflow and reports them once as a resync", async () => {
  const { fake: herdr, iterator } = await openStream();
  const total = 5000;
  // The consumer is not pulling: everything lands in the client's queue.
  for (let i = 0; i < total; i++) herdr.pushEvent(customEvent(i));
  // Real socket I/O, so fake timers cannot help: give the socket time to deliver the burst while nothing consumes it.
  await new Promise((resolve) => setTimeout(resolve, 300));
  const seen: SubscriptionEventEnvelope[] = [];
  for (;;) {
    const result = await iterator.next();
    seen.push(result.value as SubscriptionEventEnvelope);
    if (result.value?.event === "custom" && nOf(result.value) === total - 1) break;
  }
  expect(seen[0].event).toBe("observer.resync");
  expect(seen.filter((envelope) => envelope.event === "observer.resync")).toHaveLength(1);
  const kept = seen.slice(1).map(nOf);
  expect(kept.length).toBeLessThan(total);
  expect(kept.length).toBeLessThanOrEqual(1024);
  // What survives is the newest contiguous tail.
  expect(kept[0]).toBe(total - kept.length);
});

it("also bounds the queue by total queued characters: a few large lines evict the oldest, reported once", async () => {
  const { fake: herdr, iterator } = await openStream();
  const total = 200; // far below the line-count cap
  const pad = "x".repeat(200 * 1024); // under the line size cap; 200 of them is ~40 MiB against a 16 MiB budget
  for (let i = 0; i < total; i++) herdr.pushEvent({ event: "custom", data: { n: i, pad } });
  await new Promise((resolve) => setTimeout(resolve, 1000));
  const seen: SubscriptionEventEnvelope[] = [];
  for (;;) {
    const result = await iterator.next();
    seen.push(result.value as SubscriptionEventEnvelope);
    if (result.value?.event === "custom" && nOf(result.value) === total - 1) break;
  }
  expect(seen[0].event).toBe("observer.resync");
  expect(seen.filter((envelope) => envelope.event === "observer.resync")).toHaveLength(1);
  const kept = seen.slice(1).map(nOf);
  expect(kept.length).toBeLessThan(total);
  expect(kept.length * pad.length).toBeLessThanOrEqual(16 * 1024 * 1024);
  // What survives is the newest contiguous tail.
  expect(kept[0]).toBe(total - kept.length);
});

it("does not buffer an oversized line: it is dropped, reported once, and the stream carries on", async () => {
  const { fake: herdr, iterator } = await openStream();
  const stream = herdr.openSubscriptions[0];
  // 3 MiB with no newline: the buffer must not keep it.
  const first = iterator.next();
  stream.write("x".repeat(3 * 1024 * 1024));
  await expect(first).resolves.toMatchObject({ value: { event: "observer.resync" } });
  // The newline ends the discarded line; the next line is read normally.
  const second = iterator.next();
  stream.write(`tail-of-the-oversized-line\n${JSON.stringify(customEvent(1))}\n`);
  await expect(second).resolves.toMatchObject({ value: { event: "custom", data: { n: 1 } } });
  // A complete oversized line followed by a normal one.
  const third = iterator.next();
  stream.write(`${"y".repeat(2 * 1024 * 1024)}\n${JSON.stringify(customEvent(2))}\n`);
  await expect(third).resolves.toMatchObject({ value: { event: "observer.resync" } });
  await expect(iterator.next()).resolves.toMatchObject({ value: { event: "custom", data: { n: 2 } } });
});
