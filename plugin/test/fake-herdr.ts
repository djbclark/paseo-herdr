import { createServer, type Server, type Socket } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * In-process fake of Herdr's newline-delimited JSON API over a real Unix
 * socket. One request per connection; `events.subscribe` keeps its socket open
 * so tests can push events and simulate `events_lost`/drops.
 */

export interface FakeRequest {
  id: string;
  method: string;
  params: Record<string, unknown>;
}

export type FakeReply =
  | { result: unknown }
  | { error: { code: string; message: string } };

export type FakeHandler = (request: FakeRequest, socket: Socket) => void;

export class FakeHerdr {
  readonly socketPath: string;
  readonly requests: FakeRequest[] = [];
  readonly openSubscriptions: Socket[] = [];

  private server: Server;
  private directory: string;
  private handlers = new Map<string, FakeHandler>();
  private closed = false;

  private constructor(directory: string, socketPath: string, server: Server) {
    this.directory = directory;
    this.socketPath = socketPath;
    this.server = server;
  }

  static async create(): Promise<FakeHerdr> {
    const directory = await mkdtemp(join(tmpdir(), "fake-herdr-"));
    const socketPath = join(directory, "herdr.sock");
    let fake: FakeHerdr;
    const server = createServer((stream) => {
      let buffer = "";
      stream.setEncoding("utf8");
      stream.on("data", (chunk: string) => {
        buffer += chunk;
        const newline = buffer.indexOf("\n");
        if (newline === -1) return;
        const raw = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        let request: FakeRequest;
        try {
          request = JSON.parse(raw) as FakeRequest;
        } catch {
          stream.destroy();
          return;
        }
        fake.requests.push(request);
        if (request.method === "events.subscribe") {
          fake.openSubscriptions.push(stream);
          stream.write(JSON.stringify({ id: request.id, result: { type: "subscription_started" } }) + "\n");
          return;
        }
        const handler = fake.handlers.get(request.method);
        if (handler) handler(request, stream);
        else stream.end(JSON.stringify({ id: request.id, error: { code: "unknown_method", message: `unknown method: ${request.method}` } }) + "\n");
      });
    });
    fake = new FakeHerdr(directory, socketPath, server);
    await new Promise<void>((resolve) => server.listen(socketPath, resolve));
    return fake;
  }

  /** Register a handler that must reply (or keep the socket open) for a method. */
  handle(method: string, handler: FakeHandler): this {
    this.handlers.set(method, handler);
    return this;
  }

  /** Convenience: reply with a fixed result envelope. */
  reply(method: string, result: unknown): this {
    return this.handle(method, (request, stream) => {
      stream.end(JSON.stringify({ id: request.id, result }) + "\n");
    });
  }

  /** Convenience: reply with a Herdr error envelope. */
  replyError(method: string, code: string, message = code): this {
    return this.handle(method, (request, stream) => {
      stream.end(JSON.stringify({ id: request.id, error: { code, message } }) + "\n");
    });
  }

  /** Requests recorded so far for one method, in arrival order. */
  requestsFor(method: string): FakeRequest[] {
    return this.requests.filter((request) => request.method === method);
  }

  /** Write a raw JSON line to every open `events.subscribe` socket. */
  pushEvent(value: unknown): void {
    for (const stream of [...this.openSubscriptions]) {
      stream.write(JSON.stringify(value) + "\n");
    }
  }

  /** Send an `events_lost` error envelope and drop all subscription sockets. */
  eventsLost(message = "event subscription fell behind retained history; resubscribe and resync with session.snapshot"): void {
    for (const stream of [...this.openSubscriptions]) {
      stream.end(JSON.stringify({ error: { code: "events_lost", message } }) + "\n");
    }
    this.openSubscriptions.length = 0;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    for (const stream of this.openSubscriptions) stream.destroy();
    this.openSubscriptions.length = 0;
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
    await rm(this.directory, { recursive: true, force: true });
  }
}
