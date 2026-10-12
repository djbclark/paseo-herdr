import { z } from "zod";

/**
 * VENDORED from paseo/packages/server/src/server/agent/providers/omp/rpc-types.ts
 * (commit 804335b). Trimmed to the message and todo shapes the history mapper
 * closure needs; session/event/command types used only by the live runtime are
 * dropped. See VENDORED.md for provenance.
 */

export const OmpImageContentSchema = z
  .object({ type: z.literal("image"), data: z.string(), mimeType: z.string() })
  .passthrough();
export const OmpTextContentSchema = z
  .object({ type: z.literal("text"), text: z.string() })
  .passthrough();
export const OmpThinkingContentSchema = z
  .object({ type: z.literal("thinking"), thinking: z.string() })
  .passthrough();
export const OmpToolCallContentSchema = z
  .object({
    type: z.literal("toolCall"),
    id: z.string(),
    name: z.string(),
    arguments: z.unknown(),
  })
  .passthrough();

export const OmpAssistantContentSchema = z.discriminatedUnion("type", [
  OmpTextContentSchema,
  OmpThinkingContentSchema,
  OmpToolCallContentSchema,
]);

const OmpUserMessageSchema = z
  .object({
    role: z.literal("user"),
    content: z.union([z.string(), z.array(z.union([OmpTextContentSchema, OmpImageContentSchema]))]),
  })
  .passthrough();
const OmpDeveloperMessageSchema = z
  .object({
    role: z.literal("developer"),
    content: z.union([z.string(), z.array(z.union([OmpTextContentSchema, OmpImageContentSchema]))]),
  })
  .passthrough();
const OmpCustomMessageSchema = z
  .object({
    role: z.literal("custom"),
    content: z.union([z.string(), z.array(z.union([OmpTextContentSchema, OmpImageContentSchema]))]),
  })
  .passthrough();
const OmpAssistantMessageSchema = z
  .object({
    role: z.literal("assistant"),
    content: z.array(OmpAssistantContentSchema),
    provider: z.string().optional(),
    model: z.string().optional(),
    responseId: z.string().optional(),
    responseModel: z.string().optional(),
    errorMessage: z.string().nullable().optional(),
    stopReason: z.string().optional(),
  })
  .passthrough();
const OmpToolResultMessageSchema = z
  .object({
    role: z.literal("toolResult"),
    toolCallId: z.string(),
    toolName: z.string(),
    content: z.unknown(),
    isError: z.boolean().optional(),
    details: z.unknown().optional(),
  })
  .passthrough();
const OmpBashExecutionMessageSchema = z
  .object({
    role: z.literal("bashExecution"),
    command: z.string(),
    output: z.string().optional(),
    exitCode: z.number().nullable().optional(),
    cancelled: z.boolean().optional(),
    timestamp: z.number(),
  })
  .passthrough();
// Roles Paseo does not render. They are listed so that a frame carrying one, such as
// agent_end, still parses; every role in OMP's RPC AgentMessage must appear in the union.
const OmpPythonExecutionMessageSchema = z
  .object({ role: z.literal("pythonExecution") })
  .passthrough();
const OmpHookMessageSchema = z.object({ role: z.literal("hookMessage") }).passthrough();
const OmpBranchSummaryMessageSchema = z.object({ role: z.literal("branchSummary") }).passthrough();
const OmpCompactionSummaryMessageSchema = z
  .object({ role: z.literal("compactionSummary") })
  .passthrough();
const OmpFileMentionMessageSchema = z.object({ role: z.literal("fileMention") }).passthrough();

export const OmpAgentMessageSchema = z.discriminatedUnion("role", [
  OmpUserMessageSchema,
  OmpDeveloperMessageSchema,
  OmpCustomMessageSchema,
  OmpAssistantMessageSchema,
  OmpToolResultMessageSchema,
  OmpBashExecutionMessageSchema,
  OmpPythonExecutionMessageSchema,
  OmpHookMessageSchema,
  OmpBranchSummaryMessageSchema,
  OmpCompactionSummaryMessageSchema,
  OmpFileMentionMessageSchema,
]);

export const OmpTodoItemSchema = z
  .object({
    content: z.string(),
    status: z.enum(["pending", "in_progress", "completed", "abandoned", "blocked"]),
    blocker: z.string().optional(),
  })
  .passthrough();
export const OmpTodoPhaseSchema = z
  .object({ name: z.string(), tasks: z.array(OmpTodoItemSchema) })
  .passthrough();
export const OmpTodoReminderEventSchema = z
  .object({ type: z.literal("todo_reminder"), todos: z.array(OmpTodoItemSchema) })
  .passthrough();

export type OmpImageContent = z.infer<typeof OmpImageContentSchema>;
export type OmpTextContent = z.infer<typeof OmpTextContentSchema>;
export type OmpThinkingContent = z.infer<typeof OmpThinkingContentSchema>;
export type OmpToolCallContent = z.infer<typeof OmpToolCallContentSchema>;
export type OmpAssistantContent = z.infer<typeof OmpAssistantContentSchema>;
export type OmpAgentMessage = z.infer<typeof OmpAgentMessageSchema>;
export type OmpTodoItem = z.infer<typeof OmpTodoItemSchema>;
export type OmpTodoPhase = z.infer<typeof OmpTodoPhaseSchema>;

/** Tool identity for a tool bridged through an MCP server; inlined from mcp-bridge.ts. */
export interface OmpBridgedToolIdentity {
  server: string;
  tool: string;
}
