import { createServer, type Server } from "node:net";
import { mkdtemp, writeFile, rm, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createHerdrProvider } from "../server/provider.js";
import { ompAdapter } from "../server/harness/omp/adapter.js";
import { ProviderEventSchema, type ProviderEvent, type ProviderSessionConfig } from "@getpaseo/plugin/server/provider";

const config: ProviderSessionConfig = {
  cwd: "/work", env: {}, mcpServers: {}, settings: {}, persist: true,
};
let server: Server | undefined;
let directory: string | undefined;
afterEach(async () => {
  if (server) await new Promise<void>((resolve) => server?.close(() => resolve()));
  if (directory) await rm(directory, { recursive: true, force: true });
  server = undefined;
  directory = undefined;
});

it("imports an active OMP chain and sends a prompt only to its bound idle pane", async () => {
  directory = await mkdtemp(join(tmpdir(), "herdr-provider-"));
  const transcript = join(directory, "session.jsonl");
  const socket = join(directory, "herdr.sock");
  await writeFile(transcript, [
    JSON.stringify({ type: "session", id: "native" }),
    JSON.stringify({ type: "message", id: "u1", parentId: null, message: { role: "user", content: [{ type: "text", text: "Hello" }] } }),
    JSON.stringify({ type: "message", id: "a1", parentId: "u1", message: { role: "assistant", content: [{ type: "text", text: "Hi" }] } }),
    "",
  ].join("\n"));
  const modifiedAt = new Date("2026-10-11T17:05:00.000Z");
  await utimes(transcript, modifiedAt, modifiedAt);
  const agent = {
    terminal_id: "term-1", pane_id: "pane-1", agent: "omp", name: "demo", cwd: "/work",
    agent_status: "idle", agent_session: { source: "herdr:omp", agent: "omp", kind: "path", value: transcript },
  };
  const sent: Array<{ method: string; params: Record<string, unknown> }> = [];
  server = createServer((stream) => {
    let bytes = "";
    stream.setEncoding("utf8");
    stream.on("data", (chunk: string) => {
      bytes += chunk;
      if (!bytes.includes("\n")) return;
      const request = JSON.parse(bytes.slice(0, bytes.indexOf("\n"))) as { id: string; method: string; params: Record<string, unknown> };
      sent.push({ method: request.method, params: request.params });
      const result = request.method === "ping" ? { type: "pong", version: "0.9.3", protocol: 22 } :
        request.method === "agent.list" ? { type: "agent_list", agents: [agent] } :
        request.method === "agent.prompt" ? { type: "agent_prompted", agent } : { type: "unknown" };
      stream.end(JSON.stringify({ id: request.id, result }) + "\n");
    });
  });
  await new Promise<void>((resolve) => server?.listen(socket, resolve));
  const provider = createHerdrProvider(ompAdapter, async () => socket);
  expect(await provider.status?.({})).toEqual({ available: true });
  const connection = await provider.connect({ versions: [1], capabilities: ["session.list", "session.persistence", "prompt.message"] });
  const events: ProviderEvent[] = [];
  connection.onEvent((event) => events.push(ProviderEventSchema.parse(event)));
  await connection.send({ type: "sessions", requestId: "list", cwd: "/work" });
  await vi.waitFor(() => expect(events.find((event) => event.type === "sessions")).toBeDefined());
  const listing = events.find((event) => event.type === "sessions");
  if (!listing || listing.type !== "sessions") throw new Error("Missing session list");
  expect(listing.sessions).toHaveLength(1);
  expect(listing.sessions[0].updatedAt).toBe(modifiedAt.toISOString());
  await connection.send({ type: "session.open", requestId: "open", sessionId: "local", config,
    persistence: listing.sessions[0].persistence, history: "replay" });
  await vi.waitFor(() => expect(events.find((event) => event.type === "session.ready")).toBeDefined());
  expect(events.flatMap((event) => event.type === "timeline.item" && "text" in event.item ? [event.item.text] : []))
    .toEqual(["Hello", "Hi"]);
  expect(events.find((event) => event.type === "timeline.item" && event.item.type === "user_message")).toMatchObject({
    item: { text: "Hello" },
  });
  await connection.send({ type: "session.prompt", sessionId: "local", prompt: {
    clientMessageId: "message-1", delivery: "auto", input: { type: "message", content: [{ type: "text", text: "Next" }] },
  } });
  await vi.waitFor(() => expect(sent.some((request) => request.method === "agent.prompt")).toBe(true));
  expect(sent.find((request) => request.method === "agent.prompt")?.params).toMatchObject({ target: "pane-1", text: "Next" });
  await writeFile(transcript, [
    JSON.stringify({ type: "session", id: "native" }),
    JSON.stringify({ type: "message", id: "u1", parentId: null, message: { role: "user", content: [{ type: "text", text: "Hello" }] } }),
    JSON.stringify({ type: "message", id: "a1", parentId: "u1", message: { role: "assistant", content: [{ type: "text", text: "Hi" }] } }),
    JSON.stringify({ type: "message", id: "u2", parentId: "a1", message: { role: "user", content: [{ type: "text", text: "dNext" }] } }),
    JSON.stringify({ type: "message", id: "a2", parentId: "u2", message: { role: "assistant", content: [{ type: "text", text: "Done" }] } }),
    "",
  ].join("\n"));
  await vi.waitFor(() => expect(events.some((event) => event.type === "session.turn" && event.state === "completed")).toBe(true), { timeout: 2500 });
  const committed = events.find((event) => event.type === "timeline.item" && event.item.type === "user_message" && event.item.id.includes(":u2:"));
  expect(committed).toMatchObject({ item: { text: "dNext", clientMessageId: "message-1" } });
  expect(events.some((event) => event.type === "session.notice" && event.notice.title === "Native prompt text differed")).toBe(true);
  const persisted = events.find((event) => event.type === "session.persistence");
  if (!persisted || persisted.type !== "session.persistence") throw new Error("Missing native message correlation");
  await connection.send({ type: "session.close", sessionId: "local", requestId: "close" });
  await vi.waitFor(() => expect(events.some((event) => event.type === "request.completed" && event.requestId === "close")).toBe(true));
  await connection.send({ type: "session.open", requestId: "reopen", sessionId: "local", config,
    persistence: persisted.persistence, history: "replay" });
  await vi.waitFor(() => expect(events.some((event) => event.type === "session.ready" && event.requestId === "reopen")).toBe(true));
  const replayed = events.filter((event) => event.type === "timeline.item" && event.item.type === "user_message" && event.item.id.includes(":u2:"));
  expect(replayed).toHaveLength(2);
  expect(replayed[1]).toMatchObject({ item: { clientMessageId: "message-1" } });
  agent.agent_status = "working";
  await connection.send({ type: "session.prompt", sessionId: "local", prompt: {
    clientMessageId: "message-2", delivery: "auto", input: { type: "message", content: [{ type: "text", text: "Too soon" }] },
  } });
  await vi.waitFor(() => expect(events.some((event) => event.type === "session.prompt_result" &&
    event.clientMessageId === "message-2" && event.result.type === "failed")).toBe(true));
  expect(sent.filter((request) => request.method === "agent.prompt")).toHaveLength(1);
  await connection.close();
});
