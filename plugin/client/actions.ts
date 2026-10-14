import type { PluginClientContext } from "@getpaseo/plugin/client";
import { HERDR_OMP_PROVIDER, needsHomeExpansion, validateFolder } from "./helpers.js";
import { HERDR_BIND_OPTION, NATIVE_DEFAULT_MODEL } from "../shared/model.js";
import type { OverviewAgent } from "../shared/rpc.js";

type Paseo = PluginClientContext["paseo"];

/** Reuse the folder's workspace so files, git, terminals and the new chat share one root. */
export async function createHerdrChat(
  paseo: Paseo,
  folder: string,
  /** Asks the daemon for the absolute form of a `~` path (the client can't know the daemon's home). */
  resolve?: (folder: string) => Promise<string | null>,
): Promise<string> {
  const invalid = validateFolder(folder);
  if (invalid) throw new Error(invalid);
  let cwd = folder.trim();
  if (needsHomeExpansion(cwd)) {
    const resolved = resolve ? await resolve(cwd) : null;
    if (!resolved) throw new Error("Enter an absolute folder path");
    cwd = resolved;
  }
  const workspace = await paseo.workspaces.open(cwd);
  const agent = await workspace.agents.create({ config: { provider: `${HERDR_OMP_PROVIDER}/${NATIVE_DEFAULT_MODEL}` } });
  return agent.id;
}

/**
 * One-tap "open chat" for a running agent with no chat yet: create a chat in its folder's workspace that
 * binds the existing agent (no launch), then tell the server Paseo is listening so the earlier conversation
 * arrives (IMPLEMENTATION.md C27). A failed `ready` call is harmless: the server re-sends after a fallback delay.
 */
export async function bindHerdrChat(
  paseo: Paseo,
  ready: (input: { terminalId: string }) => Promise<unknown>,
  agent: Pick<OverviewAgent, "terminalId" | "paneId" | "provider" | "cwd">,
  title: string,
): Promise<string> {
  if (!agent.provider || !agent.cwd) throw new Error("This agent can't be opened in Paseo");
  const workspace = await paseo.workspaces.open(agent.cwd);
  const chat = await workspace.agents.create({
    title,
    config: {
      provider: `${agent.provider}/${NATIVE_DEFAULT_MODEL}`,
      options: { [HERDR_BIND_OPTION]: { terminalId: agent.terminalId, paneId: agent.paneId } },
    },
  });
  await ready({ terminalId: agent.terminalId }).catch(() => undefined);
  return chat.id;
}
