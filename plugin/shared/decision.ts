import { z } from "zod";

/** Timeline row that records how an approval or question was decided (P3.6). Shared by the server (emits) and the client (renders). */
export const DECISION_PLUGIN_ID = "herdr-harness";
export const DECISION_ROW_KIND = "herdr-decision";
export const DECISION_ROW_VERSION = 1;

export const DecisionRowSchema = z.object({
  kind: z.enum(["tool", "question"]),
  outcome: z.enum(["approved", "denied", "answered", "cancelled", "timed_out", "chat", "withdrawn"]),
  source: z.enum(["paseo", "terminal", "system"]),
  title: z.string(),
  /** Display name of the harness, e.g. the one that timed a question out. */
  agentLabel: z.string().optional(),
  answers: z.array(z.object({
    header: z.string(),
    selected: z.array(z.string()),
    custom: z.string().optional(),
  })).optional(),
  note: z.string().optional(),
  at: z.string(),
});
export type DecisionRowData = z.infer<typeof DecisionRowSchema>;

function where(data: DecisionRowData): string {
  return data.source === "paseo" ? "Paseo" : data.source === "terminal" ? "the terminal" : data.agentLabel ?? "the agent";
}

function describeAnswers(data: DecisionRowData): string {
  return (data.answers ?? [])
    .map((answer) => {
      const parts = [...answer.selected, ...(answer.custom ? [answer.custom] : [])];
      return `${answer.header}: ${parts.join(", ")}`;
    })
    .join("; ");
}

/** One-line human summary; the only wording the row ever shows. */
export function describeDecision(data: DecisionRowData): string {
  const at = where(data);
  switch (data.outcome) {
    case "approved": return `Approved in ${at}`;
    case "denied": return `Denied in ${at}`;
    case "answered": {
      const answers = describeAnswers(data);
      return answers ? `Answered in ${at}: ${answers}` : `Answered in ${at}`;
    }
    case "cancelled": return `Cancelled in ${at}`;
    case "timed_out": {
      const answers = describeAnswers(data);
      return `Timed out in ${at} (default option used)${answers ? `: ${answers}` : ""}`;
    }
    case "chat": return "Chat instead";
    case "withdrawn": return data.note ?? "Card withdrawn; decide in the terminal";
  }
}
