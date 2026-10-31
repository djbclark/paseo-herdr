import { spawn } from "node:child_process";
import type { HerdrTarget, TargetSource } from "../../shared/rpc.js";
import { HerdrClient, HerdrError, MIN_HERDR_VERSION, parseVersion } from "./client.js";
import { herdrSessionName, resolveSocketPath } from "./socket-path.js";

/**
 * P3.7A: one place that turns host settings + environment into the effective Herdr target, and makes
 * that target reachable. Shared by the provider and the management RPCs.
 *
 * Priority: `herdrSocketPath` setting > `HERDR_SOCKET_PATH` > `herdrSession` setting > `HERDR_SESSION`
 * > default session. Only an explicitly configured, non-default `herdrSession` setting (with no socket
 * setting and no `HERDR_SOCKET_PATH`) may auto-start Herdr; every other target is connect-only.
 *
 * CONTRACT FROZEN for the 3.7A/3.7B split: signatures below are consumed by `server/rpc.ts` and
 * `index.server.ts`. Change them only by agreement with the integrator.
 */

export interface TargetSettings {
  herdrSocketPath: string;
  herdrSession: string;
}

/** Pure: resolve the effective target. `env` defaults to `process.env` at the call site, never here. */
export function resolveTarget(settings: TargetSettings, env: Readonly<Record<string, string | undefined>>): HerdrTarget {
  const path = settings.herdrSocketPath.trim();
  const session = settings.herdrSession.trim();
  const source: TargetSource = path ? "settingPath" : env.HERDR_SOCKET_PATH ? "envPath" : session ? "settingSession"
    : env.HERDR_SESSION ? "envSession" : "default";
  const socketPath = resolveSocketPath({ path: path || undefined, session: session || undefined, env });
  const herdrSession = source === "settingPath" || source === "envPath" ? herdrSessionName({ socketPath })
    : source === "settingSession" ? herdrSessionName({ setting: session }) : source === "envSession" ? herdrSessionName({ env }) : null;
  const autoStart = source === "settingSession" && herdrSession !== null;
  const reasons: Record<TargetSource, string> = {
    settingPath: "A socket path is set in settings; Paseo only connects to it",
    envPath: "HERDR_SOCKET_PATH is set in the daemon environment; Paseo only connects to it",
    settingSession: "The default Herdr session is never started automatically",
    envSession: "HERDR_SESSION comes from the environment; only a session named in these settings is started automatically",
    default: "The default Herdr session is never started automatically",
  };
  return { socketPath, herdrSession, source, autoStart, autoStartDisabledReason: autoStart ? null : reasons[source] };
}

export interface ReadyTarget {
  target: HerdrTarget;
  version: string;
  /** True when this process started the Herdr server for this socket path. */
  autoStarted: boolean;
}

/** Thrown when the target can't be made reachable; `message` is user-facing and names the target. */
export class TargetUnavailableError extends Error {
  constructor(
    message: string,
    readonly target: HerdrTarget,
  ) {
    super(message);
    this.name = "TargetUnavailableError";
  }
}

export interface TargetReadinessDeps {
  /** Ping the socket; resolves with the Herdr version or rejects (HerdrError with `.code`, or a connect error). */
  ping(socketPath: string): Promise<string>;
  /** Spawn `herdr` detached for a named session with an argument array; must not wait for exit. */
  spawnServer(session: string, env: Readonly<Record<string, string | undefined>>): void;
  /** Environment the socket was resolved with; defaults to `process.env`. Herdr selectors are dropped before spawning. */
  env?: () => Readonly<Record<string, string | undefined>>;
  /** Total time to wait for a started server to answer (default 10 s) and the poll interval (default 200 ms). */
  readyTimeoutMs?: number;
  pollMs?: number;
  /** Injected for tests. */
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

/** Real ping through `HerdrClient` and real detached spawn of `herdr --session <name> server`. */
export function defaultTargetReadinessDeps(): TargetReadinessDeps {
  return {
    ping: async (socketPath) => (await new HerdrClient(socketPath).ping()).version,
    spawnServer(session, env) {
      const child = spawn("herdr", ["--session", session, "server"], { detached: true, stdio: "ignore", env: { ...env } });
      child.on("error", () => {});
      child.unref();
    },
  };
}

const ABSENT_CODES = new Set(["ENOENT", "ECONNREFUSED", "ENOTDIR"]);
const isAbsent = (error: unknown) => !(error instanceof HerdrError) && ABSENT_CODES.has((error as NodeJS.ErrnoException | undefined)?.code ?? "");
const describe = (error: unknown) => (error instanceof HerdrError ? `${error.code}: ${error.message}` : error instanceof Error ? error.message : String(error));

/**
 * Makes targets reachable. Ping first; start only when the endpoint is absent/unreachable (never on a
 * protocol/version/permission error) and only when `target.autoStart`. Concurrent calls for the same
 * socket path share one start. Readiness is bounded; failure throws `TargetUnavailableError`.
 * Remembers which socket paths it started so the UI can say so, and forgets one when a ping finds the endpoint absent. Never stops Herdr.
 */
export class TargetReadiness {
  private readonly started = new Set<string>();
  private readonly inflight = new Map<string, Promise<ReadyTarget>>();

  constructor(private readonly deps: TargetReadinessDeps) {}

  ensureReady(target: HerdrTarget): Promise<ReadyTarget> {
    const existing = this.inflight.get(target.socketPath);
    if (existing) return existing;
    const run = this.run(target).finally(() => this.inflight.delete(target.socketPath));
    this.inflight.set(target.socketPath, run);
    return run;
  }

  /** True when this process auto-started the server at `socketPath`. */
  startedHere(socketPath: string): boolean {
    return this.started.has(socketPath);
  }

  private async checked(target: HerdrTarget): Promise<ReadyTarget> {
    const version = await this.deps.ping(target.socketPath);
    const parsed = parseVersion(version);
    if (!parsed || compare(parsed, MIN_HERDR_VERSION) < 0) {
      throw new TargetUnavailableError(`Herdr at ${target.socketPath} is version ${version}; ${MIN_HERDR_VERSION.join(".")} or newer is required`, target);
    }
    return { target, version, autoStarted: this.started.has(target.socketPath) };
  }

  private async run(target: HerdrTarget): Promise<ReadyTarget> {
    try {
      return await this.checked(target);
    } catch (error) {
      if (error instanceof TargetUnavailableError) throw error;
      if (!isAbsent(error)) throw new TargetUnavailableError(`Herdr at ${target.socketPath} is not usable: ${describe(error)}`, target);
      // The endpoint is gone, so any Herdr this process started earlier is dead: whatever answers next is not that one.
      this.started.delete(target.socketPath);
      if (!target.autoStart || !target.herdrSession) {
        throw new TargetUnavailableError(`Herdr is not running at ${target.socketPath} (${describe(error)}). ${target.autoStartDisabledReason ?? "Auto-start is off for this target"}`, target);
      }
      return this.start(target, error);
    }
  }

  private async start(target: HerdrTarget, cause: unknown): Promise<ReadyTarget> {
    const { HERDR_SOCKET_PATH: _path, HERDR_SESSION: _session, ...env } = (this.deps.env ?? (() => process.env))();
    try {
      this.deps.spawnServer(target.herdrSession!, env);
    } catch (error) {
      throw new TargetUnavailableError(`Could not start Herdr session "${target.herdrSession}" for ${target.socketPath}: ${describe(error)}`, target);
    }
    this.started.add(target.socketPath);
    const now = this.deps.now ?? Date.now;
    const sleep = this.deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
    const deadline = now() + (this.deps.readyTimeoutMs ?? 10_000);
    let last: unknown = cause;
    for (;;) {
      await sleep(this.deps.pollMs ?? 200);
      try {
        return await this.checked(target);
      } catch (error) {
        if (error instanceof TargetUnavailableError) throw error;
        if (!isAbsent(error)) throw new TargetUnavailableError(`Herdr at ${target.socketPath} is not usable: ${describe(error)}`, target);
        last = error;
      }
      if (now() >= deadline) {
        throw new TargetUnavailableError(`Started Herdr session "${target.herdrSession}" but ${target.socketPath} did not answer in time (${describe(last)})`, target);
      }
    }
  }
}

function compare(a: readonly number[], b: readonly number[]): number {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] - b[i];
  return 0;
}
