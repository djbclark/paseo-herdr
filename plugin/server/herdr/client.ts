import { connect, type Socket } from "node:net";
import { randomUUID } from "node:crypto";
import {
  AgentInfoResultSchema,
  AgentListResultSchema,
  AgentPromptedResultSchema,
  IntegrationListResultSchema,
  PingResultSchema,
  subscriptionEventSchema,
  type AgentListResult,
  type AgentInfoResult,
  type AgentPromptedResult,
  type IntegrationListResult,
  type PingResult,
} from "./schema.js";

/**
 * Client for Herdr's newline-delimited JSON API over a Unix domain socket
 * (Windows: named pipe). Wire contract (herdr/src/api/schema.rs, response.rs):
 * one request per connection — the client writes a single JSON line and the
 * server replies with a single JSON line, then closes. `events.subscribe` keeps
 * the connection open and pushes newline-delimited events.
 */

export interface RequestOptions {
  /** Abort the in-flight request; resolves with `HerdrError` code `aborted`. */
  signal?: AbortSignal;
}

export interface SubscriptionDescriptor {
  type: string;
  [key: string]: unknown;
}

export interface SubscriptionEventEnvelope {
  /** Native event name, or synthetic observer.connected / observer.disconnected. */
  event: string;
  data: unknown;
  /** Set when events were dropped server-side (see `ReconnectOptions.onEventsLost`). */
  eventsLost?: boolean;
}

export interface HerdrSubscription {
  [Symbol.asyncIterator](): AsyncIterator<SubscriptionEventEnvelope>;
  close(): void;
}

export interface ReconnectOptions {
  /** Delay between attempts; defaults to `baseDelayMs * 2^attempt`, capped at `maxDelayMs`. */
  baseDelayMs?: number;
  maxDelayMs?: number;
  /** Bound on the number of reconnect attempts before the stream errors out. */
  maxAttempts?: number;
  /** Called once when the server reports `events_lost` (history fell behind). */
  onEventsLost?: (info: { message: string }) => void;
}

export const DEFAULT_BASE_DELAY_MS = 500;
export const DEFAULT_MAX_DELAY_MS = 5000;
export const DEFAULT_MAX_RECONNECT_ATTEMPTS = 20;

/** Error raised when the server replies with an `error` envelope (incl. `events_lost`). */
export class HerdrError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "HerdrError";
    this.code = code;
  }
}

/** `agent.prompt` wait options (herdr/src/api/schema/agents.rs: AgentPromptWaitOptions). */
export interface AgentPromptWaitOptions {
  until?: Array<"idle" | "working" | "blocked" | "done" | "unknown">;
  timeout_ms?: number;
}

/** `agent.prompt` params (herdr/src/api/schema/agents.rs: AgentPromptParams). */
export interface AgentPromptParams {
  target: string;
  text: string;
  wait?: AgentPromptWaitOptions;
}

const DEFAULT_REQUEST_TIMEOUT_MS = 5000;
const PROMPT_REQUEST_TIMEOUT_MS = 15000;

interface WireEnvelope {
  id: string;
  result?: unknown;
  error?: { code: string; message: string };
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

/**
 * Parse a `x.y.z` version into `[major, minor, patch]` when it is a plain
 * dotted triple (an optional build suffix `-…`/`+…` is accepted and ignored).
 * Returns `null` for anything else, so callers never mis-classify.
 */
export function parseVersion(version: string): [number, number, number] | null {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:$|[-+])/.exec(version);
  if (!match) return null;
  const parts = match.slice(1).map((part) => Number(part));
  if (parts.some((part) => !Number.isSafeInteger(part))) return null;
  return [parts[0], parts[1], parts[2]];
}

/** `a >= b` for dotted version triples. */
function versionAtLeast(a: [number, number, number], b: [number, number, number]): boolean {
  for (let i = 0; i < 3; i++) {
    if (a[i] > b[i]) return true;
    if (a[i] < b[i]) return false;
  }
  return true;
}

/** Minimum Herdr version the plugin supports (IMPLEMENTATION.md §1). */
export const MIN_HERDR_VERSION: [number, number, number] = [0, 9, 3];

export interface HerdrStatus {
  available: boolean;
  diagnostic?: string;
}

/**
 * Probe a client's Herdr server and installed integration (IMPLEMENTATION.md §3
 * Phase 1 `status()`): resolve → `ping` → require `version` ≥ 0.9.3 → confirm
 * the integration is installed and current/outdated (`integration.list`).
 */
export async function checkHerdrStatus(
  client: Pick<HerdrClient, "ping" | "integrationList">,
  integration: string,
): Promise<HerdrStatus> {
  let ping: PingResult;
  try {
    ping = await client.ping();
  } catch (error) {
    return { available: false, diagnostic: `Herdr not running: ${String(error)}` };
  }
  const version = parseVersion(ping.version);
  if (!version || !versionAtLeast(version, MIN_HERDR_VERSION)) {
    return { available: false, diagnostic: "Herdr 0.9.3 or newer required" };
  }
  let list: IntegrationListResult;
  try {
    list = await client.integrationList();
  } catch (error) {
    return { available: false, diagnostic: `Could not read installed integrations: ${String(error)}` };
  }
  const info = list.integrations.find((entry) => entry.target === integration);
  if (!info) {
    return { available: false, diagnostic: `Herdr integration "${integration}" is not installed (herdr integration install ${integration})` };
  }
  if (info.state === "outdated") {
    return { available: true, diagnostic: `Herdr integration "${integration}" is outdated; reinstall with herdr integration install ${integration}` };
  }
  if (info.state !== "current") {
    return { available: false, diagnostic: `Herdr integration "${integration}" is not installed (herdr integration install ${integration})` };
  }
  return { available: true };
}

export class HerdrClient {
  constructor(private readonly socketPath: string) {}

  /**
   * Send one request over a fresh connection and resolve with the `result`
   * field of the reply. Throws `HerdrError` for a server `error` envelope and
   * `{code:"aborted"}` when `options.signal` fires.
   */
  request(method: string, params: object = {}, options: RequestOptions = {}): Promise<unknown> {
    const timeoutMs = method === "agent.prompt" ? PROMPT_REQUEST_TIMEOUT_MS : DEFAULT_REQUEST_TIMEOUT_MS;
    return this.roundTrip({ id: randomUUID(), method, params }, timeoutMs, options.signal);
  }

  /** Version/protocol probe (`ping`). */
  ping(options?: RequestOptions): Promise<PingResult> {
    return this.request("ping", {}, options).then((result) => PingResultSchema.parse(result));
  }

  /** List agents (`agent.list`). */
  agentList(options?: RequestOptions): Promise<AgentListResult> {
    return this.request("agent.list", {}, options).then((result) => AgentListResultSchema.parse(result));
  }

  /** Fetch a single agent by target (`agent.get`). */
  agentGet(target: string, options?: RequestOptions): Promise<AgentInfoResult> {
    return this.request("agent.get", { target }, options).then((result) => AgentInfoResultSchema.parse(result));
  }

  /** Send a prompt (`agent.prompt`), optionally waiting for acceptance. */
  agentPrompt(params: AgentPromptParams, options?: RequestOptions): Promise<AgentPromptedResult> {
    return this.request("agent.prompt", params, options).then((result) => AgentPromptedResultSchema.parse(result));
  }

  /** List integrations (`integration.list`). */
  integrationList(options?: RequestOptions): Promise<IntegrationListResult> {
    return this.request("integration.list", {}, options).then((result) => IntegrationListResultSchema.parse(result));
  }

  /** Fetch process info for a pane (`pane.process_info`). */
  paneProcessInfo(paneId: string, options?: RequestOptions): Promise<unknown> {
    return this.request("pane.process_info", { pane_id: paneId }, options);
  }

  /** Send keys to a pane (`pane.send_keys`; used for the interrupt key). */
  paneSendKeys(paneId: string, keys: readonly string[], options?: RequestOptions): Promise<unknown> {
    return this.request("pane.send_keys", { pane_id: paneId, keys: [...keys] }, options);
  }

  /**
   * Open a long-lived `events.subscribe` stream and yield each pushed event.
   * The subscription connection stays open until the returned close function is
   * called or the abort signal fires. Reconnects with exponential backoff when
   * the socket drops; a server `events_lost` error invokes `onEventsLost` once
   * and re-subscribes (the caller is responsible for reconciling via
   * `session.snapshot`). Synthetic `observer.disconnected` marks transport/event
   * loss; `observer.connected` follows each `subscription_started` ack, including
   * the initial one. An ack does not imply reconciled state or input readiness.
   * Input requests are never replayed.
   */
  subscribe(
    subscriptions: SubscriptionDescriptor[],
    options: { signal?: AbortSignal; reconnect?: ReconnectOptions } = {},
  ): HerdrSubscription {
    const signal = options.signal;
    const reconnect = {
      baseDelayMs: options.reconnect?.baseDelayMs ?? DEFAULT_BASE_DELAY_MS,
      maxDelayMs: options.reconnect?.maxDelayMs ?? DEFAULT_MAX_DELAY_MS,
      maxAttempts: options.reconnect?.maxAttempts ?? DEFAULT_MAX_RECONNECT_ATTEMPTS,
      onEventsLost: options.reconnect?.onEventsLost,
    };

    let closed = false;
    let currentSocket: Socket | undefined;
    let retryTimer: NodeJS.Timeout | undefined;
    let wake: (() => void) | undefined;

    const self = this;

    const destroyCurrent = () => {
      if (currentSocket) {
        currentSocket.destroy();
        currentSocket = undefined;
      }
    };
    const close = () => {
      closed = true;
      signal?.removeEventListener("abort", close);
      destroyCurrent();
      wake?.();
    };
    if (signal) {
      if (signal.aborted) close();
      else signal.addEventListener("abort", close, { once: true });
    }

    function waitToReconnect(delay: number): Promise<void> {
      return new Promise<void>((resolve) => {
        if (closed) {
          resolve();
          return;
        }
        const finish = () => {
          clearTimeout(retryTimer);
          retryTimer = undefined;
          wake = undefined;
          resolve();
        };
        wake = finish;
        retryTimer = setTimeout(finish, delay);
      });
    }

    /** Feed complete newline-delimited lines from a socket into the queue. */
    function attachReader(sock: Socket, lines: AsyncQueue<string>): void {
      let buffer = "";
      sock.setEncoding("utf8");
      sock.on("data", (chunk: string) => {
        buffer += chunk;
        let newline = buffer.indexOf("\n");
        while (newline !== -1) {
          const line = buffer.slice(0, newline);
          buffer = buffer.slice(newline + 1);
          lines.push(line);
          newline = buffer.indexOf("\n");
        }
      });
      sock.on("error", (error) => lines.pushError(error));
      sock.on("close", () => lines.pushError(new Error("herdr subscription socket closed")));
    }

    async function* run(): AsyncGenerator<SubscriptionEventEnvelope> {
      const params = { subscriptions };
      let attempt = 0;
      let disconnected = false;
      let lostSignaled = false;
      try {
        while (!closed) {
          const lines = new AsyncQueue<string>();
          try {
            const sock = await connectSubscription(lines);
            if (closed) return;
            sock.write(JSON.stringify({ id: randomUUID(), method: "events.subscribe", params }) + "\n");
            const ack = await lines.next();
            if (closed) return;
            if (ack.error) throw ack.error;
            self.assertAck(ack.value);
            attempt = 0;
            disconnected = false;
            lostSignaled = false;
            yield { event: "observer.connected", data: undefined };

            while (!closed) {
              const item = await lines.next();
              if (closed) return;
              if (item.error) throw item.error;
              const line = item.value;
              if (line === undefined) break;
              const envelope = self.parseEnvelope(line);
              if (envelope) {
                yield envelope;
              } else {
                // Server errors end this subscription, including events_lost.
                throw self.parseError(line) ?? new Error(`herdr subscription returned unexpected line: ${line.slice(0, 200)}`);
              }
            }
            return;
          } catch (error) {
            destroyCurrent();
            if (closed) return;
            if (isAbortError(error)) return;
            if (!disconnected) {
              disconnected = true;
              yield { event: "observer.disconnected", data: undefined };
            }
            if (closed) return;
            if (error instanceof HerdrError && error.code === "events_lost") {
              if (!lostSignaled) {
                lostSignaled = true;
                reconnect.onEventsLost?.({ message: error.message });
              }
              yield { event: "events_lost", data: undefined, eventsLost: true };
            }
            if (closed) return;
            const reconnectable = !(error instanceof HerdrError && error.code === "invalid_params");
            if (!reconnectable || attempt >= reconnect.maxAttempts) throw error;
            attempt++;
            const delay = Math.min(reconnect.baseDelayMs * 2 ** (attempt - 1), reconnect.maxDelayMs);
            await waitToReconnect(delay);
          }
        }
      } finally {
        close();
      }
    }

    async function connectSubscription(lines: AsyncQueue<string>): Promise<Socket> {
      return new Promise<Socket>((resolve, reject) => {
        const sock = connect({ path: self.socketPath });
        currentSocket = sock;
        attachReader(sock, lines);
        let settled = false;
        sock.once("close", () => {
          if (settled) return;
          settled = true;
          reject(new HerdrError("aborted", "herdr subscription closed before connect"));
        });
        sock.once("error", (error) => {
          if (settled) return;
          settled = true;
          reject(error);
        });
        sock.once("connect", () => {
          if (settled) return;
          settled = true;
          resolve(sock);
        });
      });
    }

    const iterator = run();
    return { [Symbol.asyncIterator]: () => iterator, close };
  }

  private assertAck(line: string | undefined): void {
    if (line === undefined) throw new Error("herdr subscription closed before ack");
    let parsed: { result?: { type?: string }; error?: { code: string; message: string } };
    try {
      parsed = JSON.parse(line);
    } catch {
      throw new Error(`herdr subscription returned invalid ack: ${line.slice(0, 200)}`);
    }
    if (parsed.error) throw new HerdrError(parsed.error.code, parsed.error.message);
    if (parsed.result?.type !== "subscription_started") {
      throw new Error("herdr subscription did not acknowledge with subscription_started");
    }
  }

  private parseEnvelope(line: string): SubscriptionEventEnvelope | null {
    const parsed = subscriptionEventSchema.safeParse(JSON.parse(line));
    if (parsed.success) {
      return { event: parsed.data.event, data: parsed.data.data };
    }
    return null;
  }

  private parseError(line: string): HerdrError | null {
    let parsed: WireEnvelope;
    try {
      parsed = JSON.parse(line) as WireEnvelope;
    } catch {
      return null;
    }
    if (parsed.error) return new HerdrError(parsed.error.code, parsed.error.message);
    return null;
  }

  private roundTrip(envelope: { id: string; method: string; params: object }, timeoutMs: number, signal?: AbortSignal): Promise<unknown> {
    if (signal?.aborted) return Promise.reject(new HerdrError("aborted", "herdr request aborted"));
    const payload = JSON.stringify(envelope) + "\n";
    return new Promise<unknown>((resolve, reject) => {
      const socket = connect({ path: this.socketPath });
      let buffer = "";
      let settled = false;
      let timer: NodeJS.Timeout | undefined;
      const cleanup = () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
      };
      const fail = (err: unknown) => {
        if (settled) return;
        settled = true;
        cleanup();
        socket.destroy();
        reject(err);
      };
      const onAbort = () => {
        if (settled) return;
        settled = true;
        cleanup();
        socket.destroy();
        reject(new HerdrError("aborted", "herdr request aborted"));
      };
      timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        cleanup();
        socket.destroy();
        reject(new Error(`herdr request timed out after ${timeoutMs} ms (${envelope.method})`));
      }, timeoutMs);
      signal?.addEventListener("abort", onAbort, { once: true });
      socket.setEncoding("utf8");
      socket.on("error", fail);
      socket.on("close", () => {
        if (!settled) fail(new Error("herdr socket closed without a response"));
      });
      socket.on("connect", () => socket.write(payload));
      socket.on("data", (chunk: string) => {
        buffer += chunk;
        const newline = buffer.indexOf("\n");
        if (newline === -1) return;
        const line = buffer.slice(0, newline);
        if (settled) return;
        settled = true;
        cleanup();
        socket.end();
        try {
          resolve(this.parseResponse(line));
        } catch (err) {
          reject(err);
        }
      });
    });
  }

  private parseResponse(line: string): unknown {
    let envelope: WireEnvelope;
    try {
      envelope = JSON.parse(line) as WireEnvelope;
    } catch {
      throw new Error(`herdr returned invalid JSON: ${line.slice(0, 200)}`);
    }
    if (envelope.error) {
      throw new HerdrError(envelope.error.code, envelope.error.message);
    }
    return envelope.result;
  }
}

/** Minimal bounded async queue used by the subscription stream. */
class AsyncQueue<T> {
  private items: Array<{ value: T } | { error: unknown }> = [];
  private waiting: Array<(item: { value: T } | { error: unknown }) => void> = [];

  push(value: T): void {
    this.deliver({ value });
  }

  pushError(error: unknown): void {
    this.deliver({ error });
  }

  next(): Promise<{ value?: T; error?: unknown }> {
    const item = this.items.shift();
    if (item) {
      return Promise.resolve("value" in item ? { value: item.value } : { error: item.error });
    }
    return new Promise((resolve) => this.waiting.push(resolve));
  }

  private deliver(item: { value: T } | { error: unknown }): void {
    const waiter = this.waiting.shift();
    if (waiter) waiter(item);
    else this.items.push(item);
  }
}
