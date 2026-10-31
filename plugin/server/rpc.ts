import { access, constants, stat, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, delimiter, isAbsolute, join } from "node:path";
import type { PluginHandlerContext, PluginServerContext } from "@getpaseo/plugin/server";

// Derived from the SDK: Paseo's compiler can't resolve @getpaseo/client in an install without node_modules.
type PaseoApi = PluginHandlerContext["paseo"];
import { herdrAgentRestartRpc, herdrChatReadyRpc, herdrDiagnosticsRpc, herdrDuplicatesArchiveRpc, herdrFoldersSuggestRpc, herdrOverviewRpc, herdrTargetRpc, herdrWorkspaceCreateRpc, type CompanionStatus, type HerdrTarget, type FolderSuggestion, type OverviewAgent, type OverviewTab, type OverviewWorkspace } from "../shared/rpc.js";
import { parseBinding, sameRef, sessionRefOf, type Binding } from "./binding.js";
import { expandHome, suggestFolders } from "./folders.js";
import { restartAgent } from "./restart.js";
import { buildDiagnostics, type DiagnosticsInput } from "./diagnostics.js";
import { PLUGIN_VERSION } from "./plugin-version.js";
import type { BoundSessions } from "./bound-sessions.js";
import { attachArgs, attachCommand } from "./herdr-commands.js";
import { resolveSocketPath } from "./herdr/socket-path.js";
import { HerdrClient } from "./herdr/client.js";
import { listPaneTargets } from "./herdr/targets.js";
import { type AgentInfo, type PaneProcessInfo, PaneProcessInfoResultSchema, PaneListResultSchema, TabListResultSchema, WorkspaceCreatedResultSchema, WorkspaceListResultSchema } from "./herdr/schema.js";
import type { ReadyTarget } from "./herdr/target.js";
import type { HarnessAdapter } from "./harness/types.js";
import { adapterAcceptsKind, createResolver, type AdapterResolver } from "./harness/resolve.js";

export interface ManagementDeps {
  /**
   * `enabled` gates an adapter's overview presence (defaults to true; `enableOmp` keeps gating
   * only `omp` until per-adapter settings exist). `ompEnabled` still feeds the client toggle.
   */
  readTarget(): Promise<{ target: HerdrTarget; ompEnabled: boolean; enabled?(adapterId: string): boolean }>;
  ensureReady(target: HerdrTarget): Promise<ReadyTarget>;
  /** Defaults to a fresh `HerdrClient(socketPath).request(...)`. */
  request?(socketPath: string, method: string, params?: object): Promise<unknown>;
  harnesses: readonly HarnessAdapter[];
  /** Adapter routing for new work (overview rows without a chat, restart); defaults to a resolver over `harnesses`. */
  resolver?: AdapterResolver;
  /** Tests: replaces the stat/realpath check; resolves the canonical directory or throws a user-facing Error. */
  checkDirectory?(path: string): Promise<string>;
  /** Tests: the daemon user's home directory for `~` expansion; defaults to `os.homedir()`. */
  homedir?(): string;
  /** Absolute path of the `herdr` CLI, or null. Defaults to a PATH lookup. */
  findHerdr?(): Promise<string | null>;
  /** Tests: replaces the in-place restart. */
  restart?: typeof restartAgent;
  /** Bound chats awaiting `herdr.chat.ready`. */
  boundSessions?: BoundSessions;
  /** Environment the CLI would resolve its socket with; defaults to `process.env`. */
  env?: Readonly<Record<string, string | undefined>>;
  /** Reads the OMP input companion's install state. Required so tests inject a fake and never read the real home. */
  companionStatus(): Promise<{ state: "current" | "outdated" | "missing" | "foreign"; path: string }>;
}

/** First executable `herdr` on PATH. Paseo terminals run commands without a shell, so pass an absolute path. */
export async function findOnPath(name: string, env: Readonly<Record<string, string | undefined>> = process.env): Promise<string | null> {
  for (const dir of (env.PATH ?? "").split(delimiter).filter(Boolean)) {
    const candidate = join(dir, name);
    if (await access(candidate, constants.X_OK).then(() => true, () => false)) return candidate;
  }
  return null;
}

const errorMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error));

export async function checkDirectory(path: string): Promise<string> {
  if (!isAbsolute(path)) throw new Error("Enter an absolute folder path");
  let real: string;
  try {
    real = await realpath(path);
    if (!(await stat(real)).isDirectory()) throw new Error("not a directory");
  } catch {
    throw new Error(`${path} is not an existing folder`);
  }
  return real;
}

/** Decode the `{version, data}` plugin persistence from a Paseo agent's persistence handle, or null. */
export function decodePluginPersistence(handle: { sessionId: string; metadata?: Record<string, unknown> } | null | undefined): { version: number; data: unknown } | null {
  if (!handle) return null;
  try {
    const raw = handle.metadata?.pluginProviderPersistence ?? (handle.sessionId.startsWith("plugin:") ? JSON.parse(handle.sessionId.slice(7)) : null);
    if (typeof raw !== "object" || raw === null || typeof (raw as { version?: unknown }).version !== "number" || !("data" in raw)) return null;
    return raw as { version: number; data: unknown };
  } catch {
    return null;
  }
}

/** A Paseo chat owned by a herdr-* provider, with the Herdr binding decoded from its persistence. */
export interface HerdrChat {
  agentId: string;
  herdrSession: string | null;
  terminalId: string;
  harness: string;
  harnessId: string;
  sessionRef: Binding["sessionRef"];
  title: string | null;
  cwd: string;
  /** Latest user message or chat update; the newest chat wins when several are bound to one agent. */
  lastActivityAt: string;
  /** The foreground process the chat was bound to, when the session had validated one (pane-mode liveness). */
  occupant?: { pid: number; tty: string | null };
}

/** Every unarchived Paseo chat owned by one of the registered harness providers. */
export async function herdrChats(paseo: PaseoApi, harnesses: readonly HarnessAdapter[]): Promise<HerdrChat[]> {
  const chats: HerdrChat[] = [];
  const byProvider = new Map(harnesses.map((adapter) => [`herdr-${adapter.id}`, adapter]));
  let cursor: string | undefined;
  for (let page = 0; page < 50; page++) {
    const result = await paseo.agents.list({ page: { limit: 200, ...(cursor ? { cursor } : {}) } });
    for (const { agent } of result.entries) {
      const adapter = byProvider.get(agent.provider);
      const persistence = adapter && !agent.archivedAt ? decodePluginPersistence(agent.persistence) : null;
      if (!adapter || !persistence) continue;
      try {
        const binding = parseBinding({ version: persistence.version, data: persistence.data as never }, adapter);
        chats.push({
          agentId: agent.id, herdrSession: binding.herdrSession, terminalId: binding.terminalId, harness: adapter.label,
          harnessId: adapter.id, sessionRef: binding.sessionRef,
          title: agent.title ?? null, cwd: agent.cwd,
          lastActivityAt: activityTime(agent.lastUserMessageAt, agent.updatedAt),
          ...(binding.occupant ? { occupant: { pid: binding.occupant.pid, tty: binding.occupant.tty } } : {}),
        });
      } catch {
        // Foreign or corrupt persistence: ignore.
      }
    }
    if (!result.pageInfo.hasMore || !result.pageInfo.nextCursor) break;
    cursor = result.pageInfo.nextCursor;
  }
  return chats;
}

const chatKey = (herdrSession: string | null, terminalId: string) => `${herdrSession ?? ""}\0${terminalId}`;
const timestamp = (iso: string) => Date.parse(iso) || 0;
const newestFirst = (a: HerdrChat, b: HerdrChat) => timestamp(b.lastActivityAt) - timestamp(a.lastActivityAt) || a.agentId.localeCompare(b.agentId);

/** Activity includes a reply arriving after the user's last message. */
function activityTime(userMessageAt: string | null | undefined, updatedAt: string): string {
  return userMessageAt && timestamp(userMessageAt) > timestamp(updatedAt) ? userMessageAt : updatedAt;
}

/** The foreground process of terminals hosting a pane-mode chat that bound a process; `null` when Herdr could not say. */
type PaneProcesses = ReadonlyMap<string, PaneProcessInfo | null>;

/**
 * Pane-mode bindings carry no native session ref, so the persisted occupant is the only evidence that the
 * agent in the terminal is still the one the chat was bound to. Reads one `pane.process_info` per such
 * terminal; a terminal nobody bound a process to costs nothing.
 */
async function paneProcesses(
  chats: readonly HerdrChat[],
  agents: ReadonlyMap<string, AgentInfo>,
  target: HerdrTarget,
  resolver: AdapterResolver,
  read: (method: string, params: Record<string, unknown>) => Promise<unknown>,
): Promise<PaneProcesses> {
  const panes = new Map<string, AgentInfo>();
  for (const chat of chats) {
    const agent = agents.get(chat.terminalId);
    if (chat.herdrSession === target.herdrSession && agent && chat.occupant && resolver.byId(chat.harnessId)?.binding === "pane") panes.set(chat.terminalId, agent);
  }
  return new Map(await Promise.all([...panes].map(async ([terminalId, agent]): Promise<[string, PaneProcessInfo | null]> => {
    try {
      const { process_info: info } = PaneProcessInfoResultSchema.parse(await read("pane.process_info", { pane_id: agent.pane_id }));
      // An alias answer (Herdr resolved a moved pane id) is not evidence about this terminal.
      return [terminalId, info.pane_id === agent.pane_id ? info : null];
    } catch {
      return [terminalId, null];
    }
  })));
}

/** The same replacement test the session applies on validation: not the harness, another pid, or another tty. */
function occupantReplaced(adapter: HarnessAdapter, occupant: NonNullable<HerdrChat["occupant"]>, info: PaneProcessInfo): boolean {
  const pid = info.foreground_process_group_id;
  return !pid || !adapter.isOccupant(info) || pid !== occupant.pid || (info.tty ?? null) !== occupant.tty;
}

/** A terminal can host a new native conversation after /new; keep its older chats separate. */
function liveChat(chat: HerdrChat, agents: ReadonlyMap<string, AgentInfo>, target: HerdrTarget, resolver: AdapterResolver, processes?: PaneProcesses): AgentInfo | undefined {
  if (chat.herdrSession !== target.herdrSession) return undefined;
  const agent = agents.get(chat.terminalId);
  if (!agent) return undefined;
  // An existing binding keeps its adapter even after the pane is later detected as another
  // kind; a pane-mode binding additionally does not pin a native session ref.
  const adapter = resolver.byId(chat.harnessId);
  if (!adapter || !adapterAcceptsKind(adapter, agent.agent)) return undefined;
  if (adapter.binding === "native-ref" && !sameRef(chat.sessionRef, sessionRefOf(agent))) return undefined;
  // A pane-mode chat whose agent was replaced in the terminal is frozen history, not the pane's live chat.
  // An unreadable pane (no entry, or null) keeps the chat live rather than guessing.
  const info = adapter.binding === "pane" && chat.occupant ? processes?.get(chat.terminalId) : null;
  if (info && chat.occupant && occupantReplaced(adapter, chat.occupant, info)) return undefined;
  return agent;
}

/** One terminal's live chats: the newest owns the row, the others are duplicates the client may archive. */
export interface ReconciledTerminal {
  owner: HerdrChat;
  duplicates: HerdrChat[];
}

/**
 * F4: reconcile the chats bound to each live Herdr agent. The owner is the newest live chat
 * (deterministic; ties by agent id); the other live chats on the same terminal are reported as
 * `duplicates` so the client can archive them — the server never archives from a read RPC.
 * Chats that are no longer live (an older native conversation after /new) stay separate.
 */
export function reconcileChats(
  chats: HerdrChat[],
  live: ReadonlyMap<string, AgentInfo>,
  target: HerdrTarget,
  resolver: AdapterResolver,
  processes?: PaneProcesses,
): Map<string, ReconciledTerminal> {
  const out = new Map<string, ReconciledTerminal>();
  for (const chat of chats.filter((chat) => liveChat(chat, live, target, resolver, processes)).sort(newestFirst)) {
    const key = chatKey(chat.herdrSession, chat.terminalId);
    const entry = out.get(key);
    if (entry) entry.duplicates.push(chat);
    else out.set(key, { owner: chat, duplicates: [] });
  }
  return out;
}

/**
 * The adapter a Herdr pane's overview row belongs to: the terminal's owner chat keeps the
 * adapter it was bound with (a saved fallback chat survives the pane being detected as a
 * specific kind); a chat-less pane routes to the adapter for new work.
 */
function ownerAdapter(
  reconciled: Map<string, ReconciledTerminal>,
  agent: AgentInfo,
  target: HerdrTarget,
  resolver: AdapterResolver,
): HarnessAdapter | undefined {
  const owner = reconciled.get(chatKey(target.herdrSession, agent.terminal_id))?.owner;
  return ((owner && resolver.byId(owner.harnessId)) ?? resolver.select(agent.agent)) ?? undefined;
}

export function registerManagementRpcs(server: Pick<PluginServerContext, "handle">, deps: ManagementDeps): void {
  const request = deps.request ?? ((socketPath, method, params) => new HerdrClient(socketPath).request(method, params));
  const check = deps.checkDirectory ?? checkDirectory;
  const home = () => (deps.homedir ?? homedir)();
  const resolver = deps.resolver ?? createResolver(deps.harnesses);
  const targets = (socketPath: string) => (method: string, params?: Record<string, unknown>) => request(socketPath, method, params);

  /** Folders Herdr's workspaces and agents are in on the configured target; empty when Herdr is unavailable. */
  const herdrFolders = async (): Promise<string[]> => {
    try {
      const { target } = await deps.readTarget();
      const [agents, panes] = await Promise.all([
        listPaneTargets(targets(target.socketPath)).then((listed) => listed.map((a) => a.cwd ?? a.foreground_cwd)),
        request(target.socketPath, "pane.list", {}).then((r) => PaneListResultSchema.parse(r).panes.map((p) => p.cwd ?? p.foreground_cwd)),
      ]);
      return [...agents, ...panes].filter((cwd): cwd is string => typeof cwd === "string" && isAbsolute(cwd));
    } catch {
      return [];
    }
  };
  /** Directories of Paseo's own workspaces, when the handler context exposes the Paseo API. */
  const paseoFolders = async (paseo: PaseoApi | undefined): Promise<string[]> => {
    try {
      const result = await paseo?.workspaces?.list({ page: { limit: 100 } });
      return (result?.entries ?? []).map((w) => w.workspaceDirectory ?? w.projectRootPath).filter((dir): dir is string => Boolean(dir) && isAbsolute(dir));
    } catch {
      return [];
    }
  };

  /** Read-only detection: does each harness process have its input endpoint? (one process_info per agent) */
  const readInputReady = async (
    socket: string,
    agents: readonly AgentInfo[],
    reconciled: Map<string, ReconciledTerminal>,
    target: HerdrTarget,
    enabled: (adapterId: string) => boolean,
  ): Promise<Map<string, boolean | null>> =>
    new Map(await Promise.all(agents.map(async (agent): Promise<[string, boolean | null]> => {
      const adapter = ownerAdapter(reconciled, agent, target, resolver);
      if (!adapter?.inputReachable || !enabled(adapter.id)) return [agent.terminal_id, null];
      try {
        const process = PaneProcessInfoResultSchema.parse(await request(socket, "pane.process_info", { pane_id: agent.pane_id })).process_info;
        const pid = process.foreground_process_group_id;
        return [agent.terminal_id, pid && adapter.isOccupant(process) ? await adapter.inputReachable(pid) : null];
      } catch {
        return [agent.terminal_id, null];
      }
    })));

  /** A failing check is reported as `unknown` rather than failing the overview. */
  const readCompanion = (): Promise<CompanionStatus> =>
    deps.companionStatus().then((status): CompanionStatus => ({ state: status.state, path: status.path }), (): CompanionStatus => ({ state: "unknown" }));

  server.handle(herdrTargetRpc, async () => {
    const { target, ompEnabled } = await deps.readTarget();
    return { target, ompEnabled };
  });

  server.handle(herdrFoldersSuggestRpc, async ({ query }, { paseo }) => {
    const [fromHerdr, fromPaseo] = await Promise.all([herdrFolders(), paseoFolders(paseo)]);
    const known: FolderSuggestion[] = [
      ...fromHerdr.map((path) => ({ path, source: "herdr" as const })),
      ...fromPaseo.map((path) => ({ path, source: "paseo" as const })),
    ];
    return suggestFolders(query, home(), known);
  });

  server.handle(herdrOverviewRpc, async ({ noAutoStart }, { paseo }) => {
    const { target, ompEnabled, enabled: enabledFor } = await deps.readTarget();
    const enabled = (adapterId: string) => enabledFor?.(adapterId) ?? true;
    const [chatResult, readyResult] = await Promise.allSettled([
      herdrChats(paseo, deps.harnesses),
      deps.ensureReady(noAutoStart ? { ...target, autoStart: false, autoStartDisabledReason: "This check never starts Herdr" } : target),
    ]);
    const chats = chatResult.status === "fulfilled" ? chatResult.value : [];
    const chatError = chatResult.status === "rejected" ? errorMessage(chatResult.reason) : null;
    const companion = await readCompanion();
    const unavailable = (error: unknown) => ({
      target, ompEnabled, connection: { status: "unavailable" as const, error: errorMessage(error) },
      companion, workspaces: [], chatError,
    });
    if (readyResult.status === "rejected") return unavailable(readyResult.reason);
    const ready = readyResult.value;
    try {
      const socket = target.socketPath;
      // `herdr --session <name>` must reach this same socket, or the terminal would attach elsewhere.
      const herdrPath = resolveSocketPath({ session: target.herdrSession ?? undefined, env: { ...(deps.env ?? process.env), HERDR_SOCKET_PATH: undefined, HERDR_SESSION: undefined } }) === socket
        ? await (deps.findHerdr ?? (() => findOnPath("herdr", deps.env)))()
        : null;
      const [workspaces, tabs, panes, agents] = await Promise.all([
        request(socket, "workspace.list", {}).then((r) => WorkspaceListResultSchema.parse(r).workspaces),
        request(socket, "tab.list", {}).then((r) => TabListResultSchema.parse(r).tabs),
        request(socket, "pane.list", {}).then((r) => PaneListResultSchema.parse(r).panes),
        listPaneTargets(targets(socket)),
      ]);
      const live = new Map(agents.map((agent) => [agent.terminal_id, agent]));
      const reconciled = reconcileChats(chats, live, target, resolver, await paneProcesses(chats, live, target, resolver, (method, params) => request(socket, method, params)));
      const inputReady = await readInputReady(socket, agents, reconciled, target, enabled);
      const tabNumber = new Map(tabs.map((tab) => [tab.tab_id, tab.number]));
      const out: OverviewWorkspace[] = [...workspaces].sort((a, b) => a.number - b.number).map((workspace) => {
        const firstPane = panes
          .filter((pane) => pane.workspace_id === workspace.workspace_id)
          .sort((a, b) => (tabNumber.get(a.tab_id) ?? 0) - (tabNumber.get(b.tab_id) ?? 0))[0];
        const overviewTabs: OverviewTab[] = tabs
          .filter((tab) => tab.workspace_id === workspace.workspace_id)
          .sort((a, b) => a.number - b.number)
          .map((tab) => ({
            tabId: tab.tab_id,
            number: tab.number,
            label: tab.label,
            focused: tab.focused,
            status: tab.agent_status,
            agents: agents.filter((agent) => agent.tab_id === tab.tab_id).map((agent): OverviewAgent => {
              // A disabled adapter is hidden (no provider link, no restart); its bound chats stay openable.
              const resolved = ownerAdapter(reconciled, agent, target, resolver);
              const adapter = resolved && enabled(resolved.id) ? resolved : undefined;
              const bound = reconciled.get(chatKey(target.herdrSession, agent.terminal_id));
              return {
                terminalId: agent.terminal_id,
                paneId: agent.pane_id,
                name: agent.name ?? null,
                title: agent.terminal_title_stripped ?? agent.title ?? agent.terminal_title ?? null,
                kind: agent.agent ?? null,
                harness: adapter?.label ?? null,
                provider: adapter ? `herdr-${adapter.id}` : null,
                status: agent.agent_status,
                cwd: agent.cwd ?? agent.foreground_cwd ?? null,
                paseoAgentId: bound?.owner.agentId ?? null,
                duplicateChatIds: bound?.duplicates.map((chat) => chat.agentId) ?? [],
                // `herdr agent attach` resolves names and pane ids, not terminal ids.
                attachCommand: attachCommand(target.herdrSession, agent.name ?? agent.pane_id),
                attach: herdrPath ? { command: herdrPath, args: attachArgs(target.herdrSession, agent.name ?? agent.pane_id) } : null,
                inputReady: inputReady.get(agent.terminal_id) ?? null,
                canRestart: Boolean(adapter?.launch && adapter.resumeArgs && agent.agent_session),
              };
            }),
          }));
        return {
          workspaceId: workspace.workspace_id,
          number: workspace.number,
          label: workspace.label,
          focused: workspace.focused,
          cwd: firstPane?.cwd ?? firstPane?.foreground_cwd ?? null,
          status: workspace.agent_status,
          tabs: overviewTabs,
        };
      });
      return { target, ompEnabled, connection: { status: "connected" as const, version: ready.version, autoStarted: ready.autoStarted }, companion, workspaces: out, chatError };
    } catch (error) {
      return unavailable(error);
    }
  });

  server.handle(herdrDiagnosticsRpc, async (_input, { paseo }) => {
    const { target, ompEnabled, enabled: enabledFor } = await deps.readTarget();
    const enabled = (adapterId: string) => enabledFor?.(adapterId) ?? true;
    const companion = await readCompanion();
    let herdr: DiagnosticsInput["herdr"] = { connected: false, version: null, autoStarted: false, error: null };
    let agents: DiagnosticsInput["agents"] = [];
    try {
      const ready = await deps.ensureReady(target);
      herdr = { connected: true, version: ready.version, autoStarted: ready.autoStarted, error: null };
      const socket = target.socketPath;
      const listed = await listPaneTargets(targets(socket));
      const chats = await herdrChats(paseo, deps.harnesses).catch((): HerdrChat[] => []);
      const live = new Map(listed.map((agent): [string, AgentInfo] => [agent.terminal_id, agent]));
      const reconciled = reconcileChats(chats, live, target, resolver, await paneProcesses(chats, live, target, resolver, (method, params) => request(socket, method, params)));
      const inputReady = await readInputReady(socket, listed, reconciled, target, enabled);
      agents = listed.map((agent) => ({ paneId: agent.pane_id, inputReady: inputReady.get(agent.terminal_id) ?? null }));
    } catch (error) {
      herdr = { ...herdr, error: errorMessage(error) };
    }
    return buildDiagnostics({ pluginVersion: PLUGIN_VERSION, target, ompEnabled, herdr, companion, agents });
  });

  server.handle(herdrDuplicatesArchiveRpc, async ({ terminalId, paneId, ownerId, ids }, { paseo }) => {
    const { target } = await deps.readTarget();
    // A button tap must not spawn Herdr: an unreachable Herdr fails the call with its real reason.
    await deps.ensureReady({ ...target, autoStart: false, autoStartDisabledReason: "This check never starts Herdr" });
    const socket = target.socketPath;
    const agents = await listPaneTargets(targets(socket));
    let chats: HerdrChat[];
    try { chats = await herdrChats(paseo, deps.harnesses); }
    catch (error) { throw new Error(`Paseo's chat list is unavailable (${errorMessage(error)}), so the chats can't be checked.`); }
    const live = new Map(agents.map((candidate): [string, AgentInfo] => [candidate.terminal_id, candidate]));
    const reconciled = reconcileChats(chats, live, target, resolver, await paneProcesses(chats, live, target, resolver, (method, params) => request(socket, method, params)));
    if (live.get(terminalId)?.pane_id !== paneId) return { skip: "agent-gone" as const, archived: [], failures: [] };
    const bound = reconciled.get(chatKey(target.herdrSession, terminalId));
    if (bound?.owner.agentId !== ownerId) return { skip: "owner-changed" as const, archived: [], failures: [] };
    const stillDuplicates = new Set(bound.duplicates.map((chat) => chat.agentId));
    const wanted = [...new Set(ids)].filter((id) => stillDuplicates.has(id));
    if (wanted.length === 0) return { skip: "none-left" as const, archived: [], failures: [] };
    const results = await Promise.allSettled(wanted.map((id) => paseo.agents.ref(id).archive()));
    return {
      skip: null,
      archived: wanted.filter((_id, index) => results[index]!.status === "fulfilled"),
      failures: results.flatMap((result, index) => (result.status === "rejected" ? [{ id: wanted[index]!, error: errorMessage(result.reason) }] : [])),
    };
  });

  server.handle(herdrAgentRestartRpc, async ({ terminalId, paneId }, { paseo }) => {
    const { target, enabled: enabledFor } = await deps.readTarget();
    await deps.ensureReady(target);
    const socket = target.socketPath;
    const agents = await listPaneTargets(targets(socket));
    const agent = agents.find((candidate) => candidate.terminal_id === terminalId);
    if (!agent) throw new Error("The agent is no longer running in Herdr.");
    // Same routing as the overview row: the owner chat's adapter if one exists, else new-work routing.
    // Without the chat list the owner is unknown and `select` could pick a different adapter than the
    // overview offered, so a failed listing refuses the restart instead of guessing.
    let chats: HerdrChat[];
    try { chats = await herdrChats(paseo, deps.harnesses); }
    catch (error) { throw new Error(`Can't restart this agent: Paseo's chat list is unavailable (${errorMessage(error)}), so the adapter that owns it is unknown. Try again.`); }
    const live = new Map(agents.map((candidate): [string, AgentInfo] => [candidate.terminal_id, candidate]));
    const reconciled = reconcileChats(chats, live, target, resolver, await paneProcesses(chats, live, target, resolver, (method, params) => request(socket, method, params)));
    const adapter = ownerAdapter(reconciled, agent, target, resolver);
    if (!adapter) throw new Error("The agent is no longer running in Herdr.");
    // The overview hides a disabled adapter's restart; a stale row or a direct call must not bypass that.
    if (!(enabledFor?.(adapter.id) ?? true)) throw new Error(`${adapter.label} is turned off in the Herdr plugin settings`);
    // An open chat on this agent stays read-only; the client binds a fresh chat and archives the old one.
    return (deps.restart ?? restartAgent)({ request: (method, params) => request(socket, method, params) }, adapter, { terminalId, paneId });
  });

  server.handle(herdrChatReadyRpc, async ({ terminalId }) => {
    const { target } = await deps.readTarget();
    return { flushed: deps.boundSessions?.flushHistory(target.herdrSession, terminalId) ?? 0 };
  });

  server.handle(herdrWorkspaceCreateRpc, async ({ cwd, label }) => {
    const real = await check(expandHome(cwd.trim(), home()));
    const { target } = await deps.readTarget();
    await deps.ensureReady(target);
    const name = label || basename(real) || real;
    const created = WorkspaceCreatedResultSchema.parse(await request(target.socketPath, "workspace.create", { cwd: real, label: name, focus: false }));
    return { workspaceId: created.workspace.workspace_id, label: name, cwd: real };
  });
}
