import { afterEach, describe, expect, it, vi } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeHerdr } from "./fake-herdr.js";
import { HerdrClient, checkHerdrStatus } from "../server/herdr/client.js";

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
afterEach(async () => {
  await fake?.close();
  fake = undefined;
});

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
  const sub = client.subscribe([{ type: "pane.agent_status_changed", pane_id: "pane-1" }]);
  const iterator = sub[Symbol.asyncIterator]();
  const first = iterator.next();
  await vi.waitFor(() => expect(fake!.requests.some((r) => r.method === "events.subscribe")).toBe(true));
  fake.pushEvent({ event: "pane.agent_status_changed", data: { pane_id: "pane-1", workspace_id: "w1", agent_status: "working", agent: null, title: null, display_agent: null, state_labels: {} } });
  fake.pushEvent({ event: "pane_updated", data: { type: "pane_updated", pane: { pane_id: "pane-1", terminal_id: "term-1", workspace_id: "w1", tab_id: "t1", focused: true, agent_status: "working", state_labels: {}, tokens: {}, revision: 1 } } });
  await expect(first).resolves.toMatchObject({ value: { event: "pane.agent_status_changed" } });
  const second = await iterator.next();
  expect(second.value?.event).toBe("pane_updated");
  sub.close();
});

it("emits events_lost and resubscribes without replaying the request", async () => {
  fake = await FakeHerdr.create();
  const client = new HerdrClient(fake.socketPath);
  let lostInfo: { message: string } | undefined;
  const sub = client.subscribe(
    [{ type: "pane.updated" }],
    { reconnect: { baseDelayMs: 5, maxDelayMs: 5, onEventsLost: (info) => { lostInfo = info; } } },
  );
  const iterator = sub[Symbol.asyncIterator]();
  const first = iterator.next();
  await vi.waitFor(() => expect(fake!.requests.filter((r) => r.method === "events.subscribe")).toHaveLength(1));
  fake.eventsLost();
  await expect(first).resolves.toMatchObject({ value: { event: "events_lost", eventsLost: true } });
  // Drive the generator to reconnect; the original input request must not be replayed.
  const second = iterator.next();
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
  const sub = client.subscribe([{ type: "pane.updated" }], { reconnect: { baseDelayMs: 5, maxDelayMs: 5, maxAttempts: 2 } });
  const iterator = sub[Symbol.asyncIterator]();
  let pending = iterator.next();
  await vi.waitFor(() => expect(fake!.requests.filter((r) => r.method === "events.subscribe")).toHaveLength(1));
  // Three independent outages, each shorter than the 2-attempt budget; a per-outage
  // bound keeps the stream alive, a lifetime bound would throw on the third.
  for (let outage = 0; outage < 3; outage++) {
    fake!.eventsLost();
    const lost = await pending;
    expect(lost.value).toMatchObject({ event: "events_lost", eventsLost: true });
    pending = iterator.next();
    await vi.waitFor(() => expect(fake!.requests.filter((r) => r.method === "events.subscribe")).toHaveLength(outage + 2));
    fake!.pushEvent({ event: "pane_updated", data: { type: "pane_updated", pane: { pane_id: "p", terminal_id: "t", workspace_id: "w", tab_id: "tb", focused: false, agent_status: "idle", state_labels: {}, tokens: {}, revision: 0 } } });
    const reconnected = await pending;
    expect(reconnected.value).toMatchObject({ event: "pane_updated" });
    pending = iterator.next();
  }
  sub.close();
});

it("closing during the connect await leaves no open subscription socket", async () => {
  fake = await FakeHerdr.create();
  const client = new HerdrClient(fake.socketPath);
  const sub = client.subscribe([{ type: "pane.updated" }], { reconnect: { baseDelayMs: 5, maxDelayMs: 5 } });
  const iterator = sub[Symbol.asyncIterator]();
  const first = iterator.next();
  await vi.waitFor(() => expect(fake!.requests.some((r) => r.method === "events.subscribe")).toBe(true));
  // Close while a resubscribe connect is pending: the fresh socket must be torn down.
  fake!.eventsLost();
  const firstResult = await first;
  expect(firstResult.value?.event).toBe("events_lost");
  const second = iterator.next();
  sub.close();
  await expect(second).resolves.toMatchObject({ done: true });
  expect(fake!.openSubscriptions).toHaveLength(0);
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
