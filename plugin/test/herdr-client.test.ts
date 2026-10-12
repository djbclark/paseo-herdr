import { afterEach, describe, expect, it, vi } from "vitest";
import { createServer, type Socket } from "node:net";
import { getEventListeners } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeHerdr, type FakeHandler, type FakeRequest } from "./fake-herdr.js";
import { HerdrClient, checkHerdrStatus, type SubscriptionEventEnvelope, type HerdrSubscription } from "../server/herdr/client.js";

const AGENT = {
  terminal_id: "term-1",
  name: "demo",
  agent: "omp",
  title: "Demo",
  terminal_title: null,
  terminal_title_stripped: null,
  display_agent: "omp",
  agent_status: "idle",
  state_labels: {},
  tokens: {},
  agent_session: { source: "herdr:omp", agent: "omp", kind: "path", value: "/tmp/s.jsonl" },
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
};

let fake: FakeHerdr | undefined;
const subscriptions = new Set<HerdrSubscription>();
const closeServers: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const sub of subscriptions) sub.close();
  subscriptions.clear();
  vi.useRealTimers();
  vi.restoreAllMocks();
  await fake?.close();
  fake = undefined;
  await Promise.all(closeServers.splice(0).map((close) => close()));
});

function subscribe(client: HerdrClient, ...args: Parameters<HerdrClient["subscribe"]>) {
  const sub = client.subscribe(...args);
  subscriptions.add(sub);
  return sub;
}

/** Ignore observer lifecycle only when asserting the native stream's content. */
async function nextContent(iterator: AsyncIterator<SubscriptionEventEnvelope>) {
  for (;;) {
    const result = await iterator.next();
    if (result.done || !["observer.connected", "observer.disconnected"].includes(result.value.event)) return result;
  }
}

/** Real Unix socket with explicit acknowledgement control for lifecycle tests. */
async function socketServer(handle: FakeHandler) {
  const directory = await mkdtemp(join(tmpdir(), "herdr-observer-"));
  const socketPath = join(directory, "herdr.sock");
  const sockets = new Set<Socket>();
  const requests: FakeRequest[] = [];
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    socket.setEncoding("utf8");
    let buffer = "";
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline === -1) return;
      const request = JSON.parse(buffer.slice(0, newline)) as FakeRequest;
      buffer = buffer.slice(newline + 1);
      requests.push(request);
      handle(request, socket);
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });
  closeServers.push(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  });
  return { socketPath, sockets, requests };
}

function acknowledge(socket: Socket, request: FakeRequest): void {
  socket.write(JSON.stringify({ id: request.id, result: { type: "subscription_started" } }) + "\n");
}

function loseEvents(socket: Socket, message: string): void {
  socket.end(JSON.stringify({ error: { code: "events_lost", message } }) + "\n");
}

it("opens a fresh connection per request and reads a single response line", async () => {
  fake = await FakeHerdr.create();
  fake.reply("ping", { type: "pong", version: "0.9.3", protocol: 22 });
  fake.reply("agent.list", { type: "agent_list", agents: [] });
  const client = new HerdrClient(fake.socketPath);
  await expect(client.ping()).resolves.toEqual({ type: "pong", version: "0.9.3", protocol: 22 });
  await expect(client.agentList()).resolves.toEqual({ type: "agent_list", agents: [] });
  expect(fake.requests.map((request) => request.method)).toEqual(["ping", "agent.list"]);
});

it("passes params through ping, agent.get, and agent.prompt with wait", async () => {
  fake = await FakeHerdr.create();
  fake.reply("agent.get", { type: "agent_info", agent: AGENT });
  fake.reply("agent.prompt", { type: "agent_prompted", agent: AGENT });
  const client = new HerdrClient(fake.socketPath);
  await expect(client.agentGet("term-1")).resolves.toMatchObject({ type: "agent_info", agent: { terminal_id: "term-1" } });
  await expect(client.agentPrompt({
    target: "term-1", text: "hello", wait: { until: ["working", "blocked", "idle", "done"], timeout_ms: 5000 },
  })).resolves.toMatchObject({ type: "agent_prompted" });
  expect(fake.requests[0]).toMatchObject({ method: "agent.get", params: { target: "term-1" } });
  expect(fake.requests[1]).toMatchObject({
    method: "agent.prompt",
    params: { target: "term-1", text: "hello", wait: { until: ["working", "blocked", "idle", "done"], timeout_ms: 5000 } },
  });
});

it("raises HerdrError with the server's error code and message", async () => {
  fake = await FakeHerdr.create();
  fake.handle("agent.get", (request, stream) => {
    stream.end(JSON.stringify({ id: request.id, error: { code: "agent_blocked", message: "agent is blocked" } }) + "\n");
  });
  const client = new HerdrClient(fake.socketPath);
  await expect(client.agentGet("term-1")).rejects.toMatchObject({
    name: "HerdrError",
    code: "agent_blocked",
    message: "agent is blocked",
  });
});

it("rejects when the socket is closed without a response line", async () => {
  fake = await FakeHerdr.create();
  fake.handle("ping", (_request, stream) => stream.destroy());
  const client = new HerdrClient(fake.socketPath);
  await expect(client.ping()).rejects.toThrow(/closed without a response/);
});

it("rejects when no server is listening on the socket path", async () => {
  const client = new HerdrClient(join(fake?.socketPath ? fake.socketPath : tmpdir(), "missing.sock"));
  await expect(client.ping()).rejects.toThrow();
});

it("aborts an in-flight request when the signal fires", async () => {
  fake = await FakeHerdr.create();
  fake.handle("ping", () => { /* never reply */ });
  const client = new HerdrClient(fake.socketPath);
  const controller = new AbortController();
  const pending = client.ping({ signal: controller.signal });
  queueMicrotask(() => controller.abort());
  await expect(pending).rejects.toMatchObject({ name: "HerdrError", code: "aborted" });
});

it("yields subscription events in both naming shapes", async () => {
  fake = await FakeHerdr.create();
  const client = new HerdrClient(fake.socketPath);
  const sub = subscribe(client, [{ type: "pane.agent_status_changed", pane_id: "pane-1" }]);
  const iterator = sub[Symbol.asyncIterator]();
  const first = nextContent(iterator);
  await vi.waitFor(() => expect(fake!.requests.some((r) => r.method === "events.subscribe")).toBe(true));
  fake.pushEvent({ event: "pane.agent_status_changed", data: { pane_id: "pane-1", workspace_id: "w1", agent_status: "working", agent: null, title: null, display_agent: null, state_labels: {} } });
  fake.pushEvent({ event: "pane_updated", data: { type: "pane_updated", pane: { pane_id: "pane-1", terminal_id: "term-1", workspace_id: "w1", tab_id: "t1", focused: true, agent_status: "working", state_labels: {}, tokens: {}, revision: 1 } } });
  await expect(first).resolves.toMatchObject({ value: { event: "pane.agent_status_changed" } });
  const second = await nextContent(iterator);
  expect(second.value?.event).toBe("pane_updated");
  sub.close();
});

it("emits events_lost and resubscribes without replaying the request", async () => {
  fake = await FakeHerdr.create();
  const client = new HerdrClient(fake.socketPath);
  let lostInfo: { message: string } | undefined;
  const sub = subscribe(client,
    [{ type: "pane.updated" }],
    { reconnect: { baseDelayMs: 5, maxDelayMs: 5, onEventsLost: (info) => { lostInfo = info; } } },
  );
  const iterator = sub[Symbol.asyncIterator]();
  const first = nextContent(iterator);
  await vi.waitFor(() => expect(fake!.requests.filter((r) => r.method === "events.subscribe")).toHaveLength(1));
  fake.eventsLost();
  await expect(first).resolves.toMatchObject({ value: { event: "events_lost", eventsLost: true } });
  // Drive the generator to reconnect; the original input request must not be replayed.
  const second = nextContent(iterator);
  await vi.waitFor(() => expect(fake!.requests.filter((r) => r.method === "events.subscribe")).toHaveLength(2));
  fake.pushEvent({ event: "pane_updated", data: { type: "pane_updated", pane: { pane_id: "p", terminal_id: "t", workspace_id: "w", tab_id: "tb", focused: false, agent_status: "idle", state_labels: {}, tokens: {}, revision: 0 } } });
  await expect(second).resolves.toMatchObject({ value: { event: "pane_updated" } });
  expect(lostInfo?.message).toContain("fell behind");
  expect(fake!.requests.filter((r) => r.method === "ping")).toHaveLength(0);
  sub.close();
});

it("resets the reconnect budget after a successful resubscribe so separate outages do not accumulate", async () => {
  fake = await FakeHerdr.create();
  const client = new HerdrClient(fake.socketPath);
  const sub = subscribe(client, [{ type: "pane.updated" }], { reconnect: { baseDelayMs: 5, maxDelayMs: 5, maxAttempts: 2 } });
  const iterator = sub[Symbol.asyncIterator]();
  let pending = nextContent(iterator);
  await vi.waitFor(() => expect(fake!.requests.filter((r) => r.method === "events.subscribe")).toHaveLength(1));
  // Three independent outages, each shorter than the 2-attempt budget; a per-outage
  // bound keeps the stream alive, a lifetime bound would throw on the third.
  for (let outage = 0; outage < 3; outage++) {
    fake!.eventsLost();
    const lost = await pending;
    expect(lost.value).toMatchObject({ event: "events_lost", eventsLost: true });
    pending = nextContent(iterator);
    await vi.waitFor(() => expect(fake!.requests.filter((r) => r.method === "events.subscribe")).toHaveLength(outage + 2));
    fake!.pushEvent({ event: "pane_updated", data: { type: "pane_updated", pane: { pane_id: "p", terminal_id: "t", workspace_id: "w", tab_id: "tb", focused: false, agent_status: "idle", state_labels: {}, tokens: {}, revision: 0 } } });
    const reconnected = await pending;
    expect(reconnected.value).toMatchObject({ event: "pane_updated" });
    pending = nextContent(iterator);
  }
  sub.close();
});

it("closing during the connect await leaves no open subscription socket", async () => {
  fake = await FakeHerdr.create();
  const client = new HerdrClient(fake.socketPath);
  const sub = subscribe(client, [{ type: "pane.updated" }], { reconnect: { baseDelayMs: 5, maxDelayMs: 5 } });
  const iterator = sub[Symbol.asyncIterator]();
  const first = nextContent(iterator);
  await vi.waitFor(() => expect(fake!.requests.some((r) => r.method === "events.subscribe")).toBe(true));
  // Close while a resubscribe connect is pending: the fresh socket must be torn down.
  fake!.eventsLost();
  const firstResult = await first;
  expect(firstResult.value?.event).toBe("events_lost");
  const second = nextContent(iterator);
  sub.close();
  await expect(second).resolves.toMatchObject({ done: true });
  expect(fake!.openSubscriptions).toHaveLength(0);
});

describe("subscription observer lifecycle", () => {
  it("waits for each transport ack, orders Unix socket loss before reconnect, and never replays input", async () => {
    const held: Array<{ request: FakeRequest; socket: Socket }> = [];
    const server = await socketServer((request, socket) => {
      if (request.method === "events.subscribe") held.push({ request, socket });
      else socket.end(JSON.stringify({ id: request.id, result: { type: "agent_prompted", agent: AGENT } }) + "\n");
    });
    const client = new HerdrClient(server.socketPath);
    const descriptors = [{ type: "pane.updated", pane_id: "pane-1" }];
    const sub = subscribe(client, descriptors, { reconnect: { baseDelayMs: 0, maxDelayMs: 0 } });
    const iterator = sub[Symbol.asyncIterator]();
    const initial = iterator.next();
    const initialSettled = vi.fn();
    void initial.then(initialSettled);
    await vi.waitFor(() => expect(held).toHaveLength(1));
    expect(initialSettled).not.toHaveBeenCalled();
    acknowledge(held[0].socket, held[0].request);
    await expect(initial).resolves.toEqual({ done: false, value: { event: "observer.connected", data: undefined } });

    const before = { event: "pane.future_event", data: { pane_id: "pane-1", nested: [1, "before", null] } };
    held[0].socket.write(JSON.stringify(before) + "\n");
    await expect(iterator.next()).resolves.toEqual({ done: false, value: before });
    await client.agentPrompt({ target: "term-1", text: "send exactly once" });

    const disconnected = iterator.next();
    held[0].socket.destroy();
    await expect(disconnected).resolves.toEqual({ done: false, value: { event: "observer.disconnected", data: undefined } });
    const reconnected = iterator.next();
    const reconnectSettled = vi.fn();
    void reconnected.then(reconnectSettled);
    await vi.waitFor(() => expect(held).toHaveLength(2));
    expect(reconnectSettled).not.toHaveBeenCalled();
    acknowledge(held[1].socket, held[1].request);
    await expect(reconnected).resolves.toEqual({ done: false, value: { event: "observer.connected", data: undefined } });
    const after = { event: "pane.future_event", data: { pane_id: "pane-1", nested: [2, "after", null] } };
    held[1].socket.write(JSON.stringify(after) + "\n");
    await expect(iterator.next()).resolves.toEqual({ done: false, value: after });
    expect(server.requests.map((request) => request.method)).toEqual(["events.subscribe", "agent.prompt", "events.subscribe"]);
    expect(held.map(({ request }) => request.params)).toEqual([{ subscriptions: descriptors }, { subscriptions: descriptors }]);
    expect(held[1].request.id).not.toBe(held[0].request.id);
  });

  it("preserves events_lost across failed reconnect acks, and signals its callback once per outage", async () => {
    const held: Array<{ request: FakeRequest; socket: Socket }> = [];
    const server = await socketServer((request, socket) => {
      held.push({ request, socket });
      if (held.length === 1) acknowledge(socket, request);
    });
    const onEventsLost = vi.fn();
    const sub = subscribe(new HerdrClient(server.socketPath), [{ type: "pane.updated" }], {
      reconnect: { baseDelayMs: 0, maxDelayMs: 0, onEventsLost },
    });
    const iterator = sub[Symbol.asyncIterator]();
    await expect(iterator.next()).resolves.toEqual({ done: false, value: { event: "observer.connected", data: undefined } });
    loseEvents(held[0].socket, "first retained-history gap");
    await expect(iterator.next()).resolves.toEqual({ done: false, value: { event: "observer.disconnected", data: undefined } });
    await expect(iterator.next()).resolves.toEqual({ done: false, value: { event: "events_lost", data: undefined, eventsLost: true } });
    expect(onEventsLost).toHaveBeenCalledExactlyOnceWith({ message: "first retained-history gap" });

    const failedAck = iterator.next();
    await vi.waitFor(() => expect(held).toHaveLength(2));
    loseEvents(held[1].socket, "still behind before ack");
    await expect(failedAck).resolves.toEqual({ done: false, value: { event: "events_lost", data: undefined, eventsLost: true } });
    expect(onEventsLost).toHaveBeenCalledTimes(1);
    const reconnected = iterator.next();
    await vi.waitFor(() => expect(held).toHaveLength(3));
    acknowledge(held[2].socket, held[2].request);
    await expect(reconnected).resolves.toEqual({ done: false, value: { event: "observer.connected", data: undefined } });
    const native = { event: "pane.future_event", data: { retained: true } };
    held[2].socket.write(JSON.stringify(native) + "\n");
    await expect(iterator.next()).resolves.toEqual({ done: false, value: native });

    loseEvents(held[2].socket, "independent retained-history gap");
    await expect(iterator.next()).resolves.toEqual({ done: false, value: { event: "observer.disconnected", data: undefined } });
    await expect(iterator.next()).resolves.toEqual({ done: false, value: { event: "events_lost", data: undefined, eventsLost: true } });
    expect(onEventsLost).toHaveBeenCalledTimes(2);
    expect(onEventsLost).toHaveBeenLastCalledWith({ message: "independent retained-history gap" });
    expect(server.requests.map((request) => request.method)).toEqual(["events.subscribe", "events.subscribe", "events.subscribe"]);
  });

  it("signals a pre-ack events_lost even when no retry remains, then rejects with the real error", async () => {
    const server = await socketServer((_request, socket) => loseEvents(socket, "cannot retain history"));
    const onEventsLost = vi.fn();
    const sub = subscribe(new HerdrClient(server.socketPath), [{ type: "pane.updated" }], {
      reconnect: { maxAttempts: 0, onEventsLost },
    });
    const iterator = sub[Symbol.asyncIterator]();
    await expect(iterator.next()).resolves.toEqual({ done: false, value: { event: "observer.disconnected", data: undefined } });
    await expect(iterator.next()).resolves.toEqual({ done: false, value: { event: "events_lost", data: undefined, eventsLost: true } });
    await expect(iterator.next()).rejects.toMatchObject({ name: "HerdrError", code: "events_lost", message: "cannot retain history" });
    expect(onEventsLost).toHaveBeenCalledExactlyOnceWith({ message: "cannot retain history" });
    expect(server.requests).toHaveLength(1);
  });

  it("does not retry invalid_params or turn a rejected subscription into a connected observer", async () => {
    const server = await socketServer((request, socket) => {
      socket.end(JSON.stringify({ id: request.id, error: { code: "invalid_params", message: "unknown subscription type" } }) + "\n");
    });
    const controller = new AbortController();
    const sub = subscribe(new HerdrClient(server.socketPath), [{ type: "invalid" }], {
      signal: controller.signal, reconnect: { baseDelayMs: 0, maxDelayMs: 0, maxAttempts: 3 },
    });
    const iterator = sub[Symbol.asyncIterator]();
    await expect(iterator.next()).resolves.toEqual({ done: false, value: { event: "observer.disconnected", data: undefined } });
    await expect(iterator.next()).rejects.toMatchObject({ name: "HerdrError", code: "invalid_params", message: "unknown subscription type" });
    await expect(iterator.next()).resolves.toEqual({ done: true, value: undefined });
    expect(server.requests).toHaveLength(1);
    expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
  });

  it("exhausts exactly the retry budget and rejects with the final server failure", async () => {
    let attempt = 0;
    const server = await socketServer((request, socket) => {
      socket.end(JSON.stringify({ id: request.id, error: { code: "unavailable", message: "failed attempt " + ++attempt } }) + "\n");
    });
    const sub = subscribe(new HerdrClient(server.socketPath), [{ type: "pane.updated" }], {
      reconnect: { baseDelayMs: 0, maxDelayMs: 0, maxAttempts: 2 },
    });
    const iterator = sub[Symbol.asyncIterator]();
    await expect(iterator.next()).resolves.toEqual({ done: false, value: { event: "observer.disconnected", data: undefined } });
    await expect(iterator.next()).rejects.toMatchObject({ name: "HerdrError", code: "unavailable", message: "failed attempt 3" });
    expect(server.requests).toHaveLength(3);
  });

  it.each([
    ["malformed JSON", "not json\n", "returned invalid ack"],
    ["wrong result", JSON.stringify({ result: { type: "pong" } }) + "\n", "did not acknowledge with subscription_started"],
  ])("fails a %s ack without synthesizing a successful connection", async (_name, reply, message) => {
    const server = await socketServer((_request, socket) => socket.end(reply));
    const sub = subscribe(new HerdrClient(server.socketPath), [{ type: "pane.updated" }], { reconnect: { maxAttempts: 0 } });
    const iterator = sub[Symbol.asyncIterator]();
    await expect(iterator.next()).resolves.toEqual({ done: false, value: { event: "observer.disconnected", data: undefined } });
    await expect(iterator.next()).rejects.toThrow(message);
    expect(server.requests).toHaveLength(1);
  });

  it.each([
    ["close", "initial"], ["abort", "initial"], ["close", "reconnect"], ["abort", "reconnect"],
  ] as const)("settles pending next on %s before the %s ack and closes the socket", async (stop, phase) => {
    const held: Socket[] = [];
    const server = await socketServer((request, socket) => {
      held.push(socket);
      if (phase === "reconnect" && held.length === 1) acknowledge(socket, request);
    });
    const controller = new AbortController();
    const sub = subscribe(new HerdrClient(server.socketPath), [{ type: "pane.updated" }], {
      signal: controller.signal, reconnect: { baseDelayMs: 0, maxDelayMs: 0 },
    });
    const iterator = sub[Symbol.asyncIterator]();
    let pending = iterator.next();
    if (phase === "reconnect") {
      await expect(pending).resolves.toMatchObject({ value: { event: "observer.connected" } });
      held[0].destroy();
      await expect(iterator.next()).resolves.toMatchObject({ value: { event: "observer.disconnected" } });
      pending = iterator.next();
    }
    const requestCount = phase === "initial" ? 1 : 2;
    await vi.waitFor(() => expect(held).toHaveLength(requestCount));
    if (stop === "close") sub.close();
    else controller.abort();
    await expect(pending).resolves.toEqual({ done: true, value: undefined });
    await vi.waitFor(() => expect(server.sockets.size).toBe(0));
    expect(server.requests).toHaveLength(requestCount);
    expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
  });

  it.each(["close", "abort"] as const)("settles a %s during the initial connect without sending a request", async (stop) => {
    const server = await socketServer((_request, socket) => socket.destroy());
    const controller = new AbortController();
    const sub = subscribe(new HerdrClient(server.socketPath), [{ type: "pane.updated" }], { signal: controller.signal });
    const pending = sub[Symbol.asyncIterator]().next();
    if (stop === "close") sub.close();
    else controller.abort();
    await expect(pending).resolves.toEqual({ done: true, value: undefined });
    expect(server.requests).toHaveLength(0);
    await vi.waitFor(() => expect(server.sockets.size).toBe(0));
    expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
  });

  it.each([
    ["close", "paused"], ["abort", "paused"], ["close", "waiting"], ["abort", "waiting"],
  ] as const)("settles %s with retry %s and leaves no reconnect timer or abort listener", async (stop, phase) => {
    let socket: Socket | undefined;
    const server = await socketServer((request, stream) => {
      socket = stream;
      acknowledge(stream, request);
    });
    const controller = new AbortController();
    const sub = subscribe(new HerdrClient(server.socketPath), [{ type: "pane.updated" }], {
      signal: controller.signal, reconnect: { baseDelayMs: 10_000, maxDelayMs: 10_000 },
    });
    const iterator = sub[Symbol.asyncIterator]();
    await expect(iterator.next()).resolves.toMatchObject({ value: { event: "observer.connected" } });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    loseEvents(socket!, "retry cancellation");
    await expect(iterator.next()).resolves.toMatchObject({ value: { event: "observer.disconnected" } });
    await expect(iterator.next()).resolves.toMatchObject({ value: { event: "events_lost", eventsLost: true } });
    expect(vi.getTimerCount()).toBe(0);
    let pending: Promise<IteratorResult<SubscriptionEventEnvelope>> | undefined;
    if (phase === "waiting") {
      pending = iterator.next();
      await Promise.resolve();
      expect(vi.getTimerCount()).toBe(1);
    }
    if (stop === "close") sub.close();
    else controller.abort();
    expect(vi.getTimerCount()).toBe(0);
    await expect(pending ?? iterator.next()).resolves.toEqual({ done: true, value: undefined });
    await vi.advanceTimersByTimeAsync(20_000);
    expect(vi.getTimerCount()).toBe(0);
    expect(server.requests).toHaveLength(1);
    expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
  });

  it("does not yield buffered native events after close while paused on the connected signal", async () => {
    const server = await socketServer((request, socket) => {
      acknowledge(socket, request);
      socket.write(JSON.stringify({ event: "pane.future_event", data: { buffered: true } }) + "\n");
    });
    const sub = subscribe(new HerdrClient(server.socketPath), [{ type: "pane.updated" }]);
    const iterator = sub[Symbol.asyncIterator]();
    await expect(iterator.next()).resolves.toMatchObject({ value: { event: "observer.connected" } });
    sub.close();
    await expect(iterator.next()).resolves.toEqual({ done: true, value: undefined });
    await vi.waitFor(() => expect(server.sockets.size).toBe(0));
  });
});

describe("checkHerdrStatus", () => {
  it("reports available when version is current and integration is installed", async () => {
    fake = await FakeHerdr.create();
    fake.reply("ping", { type: "pong", version: "0.9.3", protocol: 22 });
    fake.reply("integration.list", { type: "integration_list", integrations: [{ target: "omp", label: "omp", command: "omp", available: true, state: "current" }] });
    const client = new HerdrClient(fake.socketPath);
    await expect(checkHerdrStatus(client, "omp")).resolves.toEqual({ available: true });
  });

  it("reports outdated integration as available with a diagnostic", async () => {
    fake = await FakeHerdr.create();
    fake.reply("ping", { type: "pong", version: "0.9.3", protocol: 22 });
    fake.reply("integration.list", { type: "integration_list", integrations: [{ target: "omp", label: "omp", command: "omp", available: true, state: "outdated" }] });
    const client = new HerdrClient(fake.socketPath);
    await expect(checkHerdrStatus(client, "omp")).resolves.toEqual({
      available: true,
      diagnostic: 'Herdr integration "omp" is outdated; reinstall with herdr integration install omp',
    });
  });

  it("reports unavailable for missing integration", async () => {
    fake = await FakeHerdr.create();
    fake.reply("ping", { type: "pong", version: "0.9.3", protocol: 22 });
    fake.reply("integration.list", { type: "integration_list", integrations: [] });
    const client = new HerdrClient(fake.socketPath);
    await expect(checkHerdrStatus(client, "omp")).resolves.toEqual({
      available: false,
      diagnostic: 'Herdr integration "omp" is not installed (herdr integration install omp)',
    });
  });

  it("reports unavailable for an old Herdr version", async () => {
    fake = await FakeHerdr.create();
    fake.reply("ping", { type: "pong", version: "0.9.2", protocol: 21 });
    const client = new HerdrClient(fake.socketPath);
    await expect(checkHerdrStatus(client, "omp")).resolves.toEqual({
      available: false,
      diagnostic: "Herdr 0.9.3 or newer required",
    });
  });

  it("reports unavailable when the server is not running", async () => {
    const client = new HerdrClient("/nonexistent/herdr.sock");
    const result = await checkHerdrStatus(client, "omp");
    expect(result.available).toBe(false);
    expect(result.diagnostic).toContain("Herdr not running");
  });
});
