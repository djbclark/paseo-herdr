import { defineSettings } from "@getpaseo/plugin";
import { z } from "zod";

export const herdrSettings = defineSettings({
  id: "herdr-connection",
  scope: "host",
  version: 1,
  schema: z.object({ herdrSocketPath: z.string().default("") }),
});
