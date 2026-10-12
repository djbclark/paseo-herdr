import { join, win32 } from "node:path";
import { tmpdir } from "node:os";

/**
 * Herdr socket resolution (herdr/src/session.rs, herdr/src/config/io.rs).
 *
 * Precedence: explicit path > `HERDR_SOCKET_PATH` > `HERDR_SESSION` (named
 * session) > default session. The config directory is `$XDG_CONFIG_HOME/herdr`
 * or `~/.config/herdr` (`herdr-dev` for debug builds). Named sessions live under
 * `sessions/<name>/herdr.sock`; the default session is `<config>/herdr.sock`.
 * On Windows the client addresses the named pipe `\\.\pipe\<path>`.
 */

export interface SocketResolutionEnv {
  /** Platform to resolve for (defaults to `process.platform`). */
  readonly platform?: NodeJS.Platform;
  /** Environment map to read `HERDR_SOCKET_PATH` / `HERDR_SESSION` / `XDG_CONFIG_HOME` / `HOME` / `APPDATA` from. */
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** Home directory override (defaults to `HOME`/`USERPROFILE` from `env`). */
  readonly homeDir?: string;
  /** App directory name inside the config dir: `herdr` (release) or `herdr-dev` (debug). */
  readonly appDirName?: string;
}

export interface ResolveSocketOptions extends SocketResolutionEnv {
  /** Explicit socket path (the plugin `herdrSocketPath` setting). */
  readonly path?: string;
  /** Named session to resolve (`HERDR_SESSION`). */
  readonly session?: string;
}

function readEnv(options: SocketResolutionEnv): Record<string, string | undefined> {
  return options.env ?? (typeof process !== "undefined" ? process.env : {});
}

function isWindows(options: SocketResolutionEnv): boolean {
  const platform = options.platform ?? process.platform;
  return platform === "win32";
}

/** Wrap a filesystem socket path as a Windows named pipe address. */
function namedPipe(path: string): string {
  return path.startsWith("\\\\.\\pipe\\") ? path : `\\\\.\\pipe\\${path}`;
}

/** Resolve the config directory (`$XDG_CONFIG_HOME/<app>` or `~/.config/<app>`, Windows fallbacks). */
function configDir(options: SocketResolutionEnv): string {
  const env = readEnv(options);
  const app = options.appDirName ?? "herdr";
  const pathJoin = isWindows(options) ? win32.join : join;
  if (env.XDG_CONFIG_HOME) return pathJoin(env.XDG_CONFIG_HOME, app);
  if (isWindows(options)) {
    if (env.APPDATA) return pathJoin(env.APPDATA, app);
    const profile = env.USERPROFILE ?? env.HOME;
    if (profile) return pathJoin(profile, "AppData", "Roaming", app);
    return pathJoin(tmpdir(), app);
  }
  const home = options.homeDir ?? env.HOME;
  if (home) return pathJoin(home, ".config", app);
  return pathJoin(tmpdir(), app);
}

/**
 * Resolve the Herdr API socket path.
 *
 * @returns the filesystem path (Unix domain socket) or a Windows named-pipe
 * address. Throws when no resolution is possible (no home/config source).
 */
export function resolveSocketPath(options: ResolveSocketOptions = {}): string {
  const env = readEnv(options);
  const explicit = options.path ?? env.HERDR_SOCKET_PATH;
  const session = options.session ?? env.HERDR_SESSION;

  let resolved: string;
  const pathJoin = isWindows(options) ? win32.join : join;
  if (explicit) {
    resolved = explicit;
  } else if (session && session !== "default") {
    resolved = pathJoin(configDir(options), "sessions", session, "herdr.sock");
  } else {
    resolved = pathJoin(configDir(options), "herdr.sock");
  }
  return isWindows(options) ? namedPipe(resolved) : resolved;
}

/**
 * Herdr session name to stamp into bindings and attach/pane-read hints; `null` means the default session.
 * Precedence: configured setting > `HERDR_SESSION` > `sessions/<name>/herdr.sock` in the resolved socket path.
 */
export function herdrSessionName(options: { readonly setting?: string; readonly env?: Readonly<Record<string, string | undefined>>; readonly socketPath?: string }): string | null {
  const session = options.setting || options.env?.HERDR_SESSION;
  // "default" names the root socket in resolveSocketPath, so it is the default session here too.
  if (session) return session === "default" ? null : session;
  return options.socketPath?.match(/[\\/]sessions[\\/]([^\\/]+)[\\/]herdr\.sock$/)?.[1] ?? null;
}
