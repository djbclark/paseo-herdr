export interface AgentSessionRef {
  kind: "path" | "id";
  value: string;
}

export interface AgentInfo {
  terminal_id: string;
  pane_id: string;
  name?: string | null;
  agent?: string | null;
  title?: string | null;
  cwd?: string | null;
  foreground_cwd?: string | null;
  agent_status: "idle" | "working" | "blocked" | "done" | "unknown";
  agent_session?: (AgentSessionRef & { agent: string; source: string }) | null;
  interactive_ready?: boolean;
}

export interface HerdrResult {
  type: string;
  [key: string]: unknown;
}
