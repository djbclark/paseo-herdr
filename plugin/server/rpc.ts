import { access, constants, stat, realpath } from "node:fs/promises";
import { basename, delimiter, isAbsolute, join } from "node:path";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import type { PaseoApi } from "@getpaseo/client";
import { herdrAgentRestartRpc, herdrChatReadyRpc, herdrOverviewRpc, herdrTargetRpc, herdrWorkspaceCreateRpc, type HerdrTarget, type OverviewAgent, type OverviewTab, type OverviewWorkspace } from "../shared/rpc.js";
import { parseBinding, sameRef, sessionRefOf, type Binding } from "./binding.js";
import { restartAgent } from "./restart.js";
import type { BoundSessions } from "./bound-sessions.js";
import { attachArgs, attachCommand } from "./herdr-commands.js";
import { resolveSocketPath } from "./herdr/socket-path.js";
import { HerdrClient } from "./herdr/client.js";
import { type AgentInfo, AgentListResultSchema, PaneProcessInfoResultSchema, PaneListResultSchema, TabListResultSchema, WorkspaceCreatedResultSchema, WorkspaceListResultSchema } from "./herdr/schema.js";
import type { ReadyTarget } from "./herdr/target.js";
import type { HarnessAdapter } from "./harness/types.js";

export interface ManagementDeps {
  readTarget(): Promise<{ target: HerdrTarget; ompEnabled: boolean }>;
  ensureReady(target: HerdrTarget): Promise<ReadyTarget>;
  /** Defaults to a fresh `HerdrClient(socketPath).request(...)`. */
  request?(socketPath: string, method: string, params?: object): Promise<unknown>;
  harnesses: readonly HarnessAdapter[];
  /** Tests: replaces the stat/realpath check; resolves the canonical directory or throws a user-facing Error. */
  checkDirectory?(path: string): Promise<string>;
  /** Absolute path of the `herdr` CLI, or null. Defaults to a PATH lookup. */
  findHerdr?(): Promise<string | null>;
  /** Tests: replaces the in-place restart. */
  restart?: typeof restartAgent;
  /** Bound chats awaiting `herdr.chat.ready`. */
  boundSessions?: BoundSessions;
  /** Environment the CLI would resolve its socket with; defaults to `process.env`. */
  env?: Readonly<Record<string, string | undefined>>;
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
  status: string;
  lastActivityAt: string;
  attention: "finished" | "error" | "permission" | null;
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
          title: agent.title ?? null, cwd: agent.cwd, status: agent.status,
          lastActivityAt: activityTime(agent.lastUserMessageAt, agent.updatedAt),
          attention: agent.requiresAttention ? agent.attentionReason ?? null : null,
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

/** A terminal can host a new native conversation after /new; keep its older chats separate. */
function liveChat(chat: HerdrChat, agents: ReadonlyMap<string, AgentInfo>, target: HerdrTarget): AgentInfo | undefined {
  if (chat.herdrSession !== target.herdrSession) return undefined;
  const agent = agents.get(chat.terminalId);
  return agent?.agent === chat.harnessId && sameRef(chat.sessionRef, sessionRefOf(agent)) ? agent : undefined;
}

/** Paseo agent id by (Herdr session, terminal id). */
export async function boundAgents(paseo: PaseoApi, harnesses: readonly HarnessAdapter[]): Promise<Map<string, string>> {
  // Set newest last, so a duplicate binding chooses the newest chat deterministically.
  return new Map((await herdrChats(paseo, harnesses)).sort(newestFirst).reverse().map((chat) => [chatKey(chat.herdrSession, chat.terminalId), chat.agentId]));
}

export function registerManagementRpcs(server: Pick<PluginServerContext, "handle">, deps: ManagementDeps): void {
  const request = deps.request ?? ((socketPath, method, params) => new HerdrClient(socketPath).request(method, params));
  const check = deps.checkDirectory ?? checkDirectory;

  server.handle(herdrTargetRpc, () => deps.readTarget());

  server.handle(herdrOverviewRpc, async (_input, { paseo }) => {
    const { target, ompEnabled } = await deps.readTarget();
    const [chatResult, readyResult] = await Promise.allSettled([
      herdrChats(paseo, deps.harnesses),
      deps.ensureReady(target),
    ]);
    const chats = chatResult.status === "fulfilled" ? chatResult.value : [];
    const chatError = chatResult.status === "rejected" ? errorMessage(chatResult.reason) : null;
    const unavailable = (error: unknown) => ({
      target, ompEnabled, connection: { status: "unavailable" as const, error: errorMessage(error) },
      workspaces: [], chatError,
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
        request(socket, "agent.list", {}).then((r) => AgentListResultSchema.parse(r).agents),
      ]);
      // Read-only detection: does each harness process have its input endpoint? (one process_info per agent)
      const inputReady = new Map(await Promise.all(agents.map(async (agent): Promise<[string, boolean | null]> => {
        const adapter = deps.harnesses.find((candidate) => candidate.id === agent.agent);
        if (!adapter?.inputReachable) return [agent.terminal_id, null];
        try {
          const process = PaneProcessInfoResultSchema.parse(await request(socket, "pane.process_info", { pane_id: agent.pane_id })).process_info;
          const pid = process.foreground_process_group_id;
          return [agent.terminal_id, pid && adapter.isOccupant(process) ? await adapter.inputReachable(pid) : null];
        } catch {
          return [agent.terminal_id, null];
        }
      })));
      const live = new Map(agents.map((agent) => [agent.terminal_id, agent]));
      const bound = new Map([...chats].sort(newestFirst).reverse()
        .filter((chat) => liveChat(chat, live, target))
        .map((chat) => [chatKey(chat.herdrSession, chat.terminalId), chat.agentId]));
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
              const adapter = deps.harnesses.find((candidate) => candidate.id === agent.agent);
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
                paseoAgentId: bound.get(chatKey(target.herdrSession, agent.terminal_id)) ?? null,
                // `herdr agent attach` resolves names and pane ids, not terminal ids.
                attachCommand: attachCommand(target.herdrSession, agent.name ?? agent.pane_id),
                attach: herdrPath ? { command: herdrPath, args: attachArgs(target.herdrSession, agent.name ?? agent.pane_id) } : null,
                inputReady: inputReady.get(agent.terminal_id) ?? null,
                canRestart: Boolean(adapter?.resumeArgs && agent.agent_session),
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
      return { target, ompEnabled, connection: { status: "connected" as const, version: ready.version, autoStarted: ready.autoStarted }, workspaces: out, chatError };
    } catch (error) {
      return unavailable(error);
    }
  });

  server.handle(herdrAgentRestartRpc, async ({ terminalId, paneId }) => {
    const { target } = await deps.readTarget();
    await deps.ensureReady(target);
    const socket = target.socketPath;
    const agent = AgentListResultSchema.parse(await request(socket, "agent.list", {})).agents.find((candidate) => candidate.terminal_id === terminalId);
    const adapter = deps.harnesses.find((candidate) => candidate.id === agent?.agent);
    if (!agent || !adapter) throw new Error("The agent is no longer running in Herdr.");
    // An open chat on this agent stays read-only; the client binds a fresh chat and archives the old one.
    return (deps.restart ?? restartAgent)({ request: (method, params) => request(socket, method, params) }, adapter, { terminalId, paneId });
  });

  server.handle(herdrChatReadyRpc, async ({ terminalId }) => {
    const { target } = await deps.readTarget();
    return { flushed: deps.boundSessions?.flushHistory(target.herdrSession, terminalId) ?? 0 };
  });

  server.handle(herdrWorkspaceCreateRpc, async ({ cwd, label }) => {
    const real = await check(cwd);
    const { target } = await deps.readTarget();
    await deps.ensureReady(target);
    const name = label || basename(real) || real;
    const created = WorkspaceCreatedResultSchema.parse(await request(target.socketPath, "workspace.create", { cwd: real, label: name, focus: false }));
    return { workspaceId: created.workspace.workspace_id, label: name, cwd: real };
  });
}
