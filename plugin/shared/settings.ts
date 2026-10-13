import { defineSettings } from "@getpaseo/plugin";
import { z } from "zod";

/**
 * Host-scoped plugin settings, shared by the server (registerSettings) and the client (useSettings).
 * The id and the v1 fields predate P3.7; `enableOmp` was added with a default, so stored v1 values
 * still parse and no migration is needed.
 */
export const herdrSettings = defineSettings({
  id: "herdr-connection",
  scope: "host",
  version: 1,
  schema: z.object({
    herdrSocketPath: z.string().default(""),
    herdrSession: z.string().default(""),
    /** Off: no new OMP discovery, import or launch. Open chats stay observable and can finish or stop. */
    enableOmp: z.boolean().default(true),
  }),
});
