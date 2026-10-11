import { createServer, type Server } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { HerdrClient, HerdrError } from "../server/herdr/client.js";

/** In-process fake of Herdr's newline-delimited JSON API over a real Unix socket. */
interface RequestLog {
  id: string;
  method: string;
  params: Record<string, unknown>;
}

let server: Server | undefined;
let directory: string | undefined;
let socketPath = "";
let requests: RequestLog[] = [];

const replies = new Map<string, (request: RequestLog) => { result?: unknown; error?: { code: string; message: string } }>();

function listen(socket: string): Promise<void> {
  return new Promise<void>((resolve) => server?.listen(socket, resolve));
}

function reply(request: RequestLog): { id: string; result?: unknown; error?: { code: string; message: string } } {
  const handler = replies.get(request.method);
  const body = handler ? handler(request) : { error: { code: "unknown_method", message: `unknown method: ${request.method}` } };
  return { id: request.id, ...body };
}

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "herdr-client-"));
  socketPath = join(directory, "herdr.sock");
  requests = [];
  replies.clear();
  server = createServer((stream) => {
    let buffer = "";
    stream.setEncoding("utf8");
    stream.on("data", (chunk: string) => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline === -1) return;
      const raw = buffer.slice(0, newline);
      const parsed = JSON.parse(raw) as RequestLog;
      requests.push(parsed);
      stream.end(JSON.stringify(reply(parsed)) + "\n");
    });
  });
  await listen(socketPath);
});

afterEach(async () => {
  if (server) await new Promise<void>((resolve) => server?.close(() => resolve()));
  if (directory) await rm(directory, { recursive: true, force: true });
  server = undefined;
  directory = undefined;
});

it("opens a fresh connection per request and reads a single response line", async () => {
  replies.set("ping", () => ({ result: { type: "pong", version: "0.9.3", protocol: 22 } }));
  replies.set("agent.list", () => ({ result: { type: "agent_list", agents: [] } }));
  const client = new HerdrClient(socketPath);
  await expect(client.ping()).resolves.toEqual({ type: "pong", version: "0.9.3", protocol: 22 });
  await expect(client.agentList()).resolves.toEqual({ type: "agent_list", agents: [] });
  expect(requests.map((request) => request.method)).toEqual(["ping", "agent.list"]);
});

it("passes params through ping, agent.get, and agent.prompt with wait", async () => {
  replies.set("agent.get", (request) => ({ result: { type: "agent_info", agent: { terminal_id: request.params.target } } }));
  replies.set("agent.prompt", (request) => ({ result: { type: "agent_prompted", agent: { terminal_id: request.params.target } } }));
  const client = new HerdrClient(socketPath);
  await expect(client.agentGet("term-1")).resolves.toEqual({
    type: "agent_info", agent: { terminal_id: "term-1" },
  });
  await expect(client.agentPrompt({
    target: "term-1", text: "hello", wait: { until: ["working", "blocked", "idle", "done"], timeout_ms: 5000 },
  })).resolves.toEqual({ type: "agent_prompted", agent: { terminal_id: "term-1" } });
  expect(requests[0]).toMatchObject({ method: "agent.get", params: { target: "term-1" } });
  expect(requests[1]).toMatchObject({
    method: "agent.prompt",
    params: { target: "term-1", text: "hello", wait: { until: ["working", "blocked", "idle", "done"], timeout_ms: 5000 } },
  });
});

it("raises HerdrError with the server's error code and message", async () => {
  replies.set("agent.get", () => ({ error: { code: "agent_blocked", message: "agent is blocked" } }));
  const client = new HerdrClient(socketPath);
  await expect(client.agentGet("term-1")).rejects.toMatchObject({
    name: "HerdrError",
    code: "agent_blocked",
    message: "agent is blocked",
  });
});

it("rejects when the socket is closed without a response line", async () => {
  server?.close();
  server = createServer((stream) => {
    stream.on("data", () => stream.destroy());
  });
  await listen(socketPath);
  const client = new HerdrClient(socketPath);
  await expect(client.ping()).rejects.toThrow(/closed without a response/);
});

it("rejects when no server is listening on the socket path", async () => {
  const client = new HerdrClient(join(directory ?? tmpdir(), "missing.sock"));
  await expect(client.ping()).rejects.toThrow();
});

it("times out when the server holds the connection open without replying", async () => {
  server?.close();
  server = createServer((stream) => {
    // Accept the request but never write a response line.
    stream.on("data", () => {});
  });
  await listen(socketPath);
  const client = new HerdrClient(socketPath);
  await expect(client.ping()).rejects.toThrow(/timed out after \d+ ms/);
}, 10000);
