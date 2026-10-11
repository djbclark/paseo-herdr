import { connect } from "node:net";
import { randomUUID } from "node:crypto";

/**
 * Minimal client for Herdr's newline-delimited JSON API over a Unix domain socket.
 *
 * Wire contract (herdr/src/api/schema.rs, response.rs, agents.rs):
 * - One request per connection: the client writes a single JSON line and the
 *   server replies with a single JSON line, then the connection is closed.
 * - Request:  `{"id":"…","method":"…","params":{…}}\n`
 * - Response: `{"id":"…","result":{…}}\n` or `{"id":"…","error":{"code":"…","message":"…"}}\n`
 * - Result is tagged by `type` (snake_case): `pong`, `agent_list`, `agent_info`,
 *   `agent_prompted`.
 *
 * Phase 0 scope: explicit socket path only. `ping`, `agent.list`, `agent.get`,
 * and `agent.prompt` (with optional `wait`). Socket resolution, subscriptions,
 * and status version checks land in Phase 1 (client workstream 1A).
 */

/** Error raised when the server replies with an `error` envelope. */
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

/**
 * Bounded per-request transport deadlines. `agent.prompt` with `wait` may block
 * the server up to `wait.timeout_ms` (callers cap this at 10s), so it gets a
 * margin on top; every other method is a quick read.
 */
const DEFAULT_REQUEST_TIMEOUT_MS = 5000;
const PROMPT_REQUEST_TIMEOUT_MS = 15000;

interface WireEnvelope {
  id: string;
  result?: unknown;
  error?: { code: string; message: string };
}

export class HerdrClient {
  constructor(private readonly socketPath: string) {}

  /**
   * Send one request over a fresh connection and resolve with the `result`
   * field of the reply. Throws `HerdrError` when the server replies with an
   * `error` envelope.
   */
  request(method: string, params: object = {}): Promise<unknown> {
    const timeoutMs = method === "agent.prompt" ? PROMPT_REQUEST_TIMEOUT_MS : DEFAULT_REQUEST_TIMEOUT_MS;
    return this.roundTrip({ id: randomUUID(), method, params }, timeoutMs);
  }

  /** Version/protocol probe (`ping`). */
  ping(): Promise<unknown> {
    return this.request("ping", {});
  }

  /** List agents (`agent.list`). */
  agentList(): Promise<unknown> {
    return this.request("agent.list", {});
  }

  /** Fetch a single agent by target (`agent.get`). */
  agentGet(target: string): Promise<unknown> {
    return this.request("agent.get", { target });
  }

  /** Send a prompt (`agent.prompt`), optionally waiting for acceptance. */
  agentPrompt(params: AgentPromptParams): Promise<unknown> {
    return this.request("agent.prompt", params);
  }

  private roundTrip(envelope: { id: string; method: string; params: object }, timeoutMs: number): Promise<unknown> {
    const payload = JSON.stringify(envelope) + "\n";
    return new Promise<unknown>((resolve, reject) => {
      const socket = connect({ path: this.socketPath });
      let buffer = "";
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        socket.destroy();
        reject(new Error(`herdr request timed out after ${timeoutMs} ms (${envelope.method})`));
      }, timeoutMs);
      const fail = (err: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        socket.destroy();
        reject(err);
      };
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
        settled = true;
        clearTimeout(timer);
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
    } catch (err) {
      throw new Error(`herdr returned invalid JSON: ${line.slice(0, 200)}`);
    }
    if (envelope.error) {
      throw new HerdrError(envelope.error.code, envelope.error.message);
    }
    return envelope.result;
  }
}
