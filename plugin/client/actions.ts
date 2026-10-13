import type { PluginClientContext } from "@getpaseo/plugin/client";
import { HERDR_OMP_PROVIDER, validateFolder } from "./helpers.js";
import { NATIVE_DEFAULT_MODEL } from "../shared/model.js";

/** Reuse the folder's workspace so files, git, terminals and the new chat share one root. */
export async function createHerdrChat(paseo: PluginClientContext["paseo"], folder: string): Promise<string> {
  const invalid = validateFolder(folder);
  if (invalid) throw new Error(invalid);
  const workspace = await paseo.workspaces.open(folder.trim());
  const agent = await workspace.agents.create({ config: { provider: `${HERDR_OMP_PROVIDER}/${NATIVE_DEFAULT_MODEL}` } });
  return agent.id;
}
