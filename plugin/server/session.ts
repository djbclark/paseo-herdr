import { randomUUID } from "node:crypto";
import type {
  ProviderEvent,
  ProviderPrompt,
  ProviderSessionConfig,
  ProviderTimelineItem,
} from "@getpaseo/plugin/server/provider";
import type { HarnessAdapter, TranscriptReader } from "./harness/types.js";
import type { AgentInfo } from "./herdr/schema.js";
import {
  bindingOf,
  correlateItem,
  findBound,
  persistenceOf,
  sameRef,
  sessionRefOf,
  type Binding,
} from "./binding.js";
import { emptyTimelineState, seedTimeline, type TimelineRow } from "./timeline.js";

export interface HerdrRequest {
  (method: string, params?: Record<string, unknown>, options?: { signal?: AbortSignal }): Promise<unknown>;
}

export interface SessionDeps {
  adapter: HarnessAdapter;
  /** Resolve the current agent list from Herdr. */
  listAgents(signal?: AbortSignal): Promise<AgentInfo[]>;
  /** One-shot Herdr request (client.request). */
  request: HerdrRequest;
  /** Emit a provider event. */
  emit(event: ProviderEvent): void;
  /** Optional hook to stamp the resolved Herdr session name into persistence. */
  getHerdrSession?: () => string | null;
}

const CAPABILITIES = ["prompt.message", "session.list", "session.persistence"] as const;

/**
 * One Paseo session bound to a Herdr-managed harness agent. Owns the binding,
 * the transcript reader, the stable-id diff state, and the per-session abort
 * controller that guards every open/poll/close emission.
 */
export class HerdrHarnessSession {
  readonly sessionId: string;
  private readonly adapter: HarnessAdapter;
  private readonly listAgents: SessionDeps["listAgents"];
  private readonly request: HerdrRequest;
  private readonly emit: SessionDeps["emit"];
  private readonly getHerdrSession?: SessionDeps["getHerdrSession"];

  private binding: Binding;
  private reader: TranscriptReader | null = null;
  private timelineState: ReadonlyMap<string, string> = emptyTimelineState();
  private outcome: "active" | "readonly" = "active";
  private activeTurn: string | null = null;

  /** Guards all async open/poll/close emissions; aborted on close. */
  private readonly controller = new AbortController();

  constructor(sessionId: string, binding: Binding, deps: SessionDeps) {
    this.sessionId = sessionId;
    this.binding = binding;
    this.adapter = deps.adapter;
    this.listAgents = deps.listAgents;
    this.request = deps.request;
    this.emit = deps.emit;
    this.getHerdrSession = deps.getHerdrSession;
  }

  get isAborted(): boolean {
    return this.controller.signal.aborted;
  }

  get capabilities(): readonly string[] {
    return CAPABILITIES;
  }

  /** Validate the binding against the live agent list and open the transcript. */
  async open(config: ProviderSessionConfig, history: "replay" | "skip", requestId?: string): Promise<void> {
    const agents = await this.listAgents(this.controller.signal);

    // Revalidate the occupant. A missing terminal_id falls back to a unique
    // validated path match; an ambiguous or wrong occupant is read-only.
    const bound = findBound(agents, this.binding, this.adapter);
    const current = bound ? bindingOf(bound, this.adapter, this.getHerdrSession?.() ?? null) : this.recoverByPath(agents);

    if (current) {
      this.binding = { ...current, submittedMessages: this.binding.submittedMessages };
    } else {
      this.outcome = "readonly";
    }

    const locator = await this.adapter.resolveTranscript(this.binding.sessionRef, { cwd: this.binding.cwd });
    const replayRows: TimelineRow[] = [];
    // A non-null ref that the adapter cannot read (e.g. OMP `kind:"id"` from
    // `--no-session`) is a definitive, unreadable identity: read-only, unlike a
    // transient `null` ref (no session reported yet) which stays active.
    if (!locator && this.binding.sessionRef !== null) {
      this.outcome = "readonly";
    }
    if (locator) {
      this.reader = this.adapter.openTranscript(locator);
      const snapshot = await this.reader.snapshot();
      const seeded = seedTimeline(snapshot, this.binding.submittedMessages);
      this.timelineState = seeded.state;
      if (history === "replay") replayRows.push(...seeded.rows);
    } else {
      this.reader = null;
      this.timelineState = emptyTimelineState();
    }

    this.emit({
      type: "session.opened",
      requestId,
      sessionId: this.sessionId,
      restoration: "core",
      capabilities: CAPABILITIES,
      persistence: persistenceOf(this.binding),
      cwd: this.binding.cwd || config.cwd,
      title: this.binding.agentName ?? config.title,
    });

    for (const row of replayRows) this.emitRow(row);

    if (!locator || this.outcome === "readonly") {
      this.emit({
        type: "session.notice",
        sessionId: this.sessionId,
        notice: {
          id: "history-or-agent-unavailable",
          severity: "warning",
          title:
            this.outcome === "readonly" && locator === null && this.binding.sessionRef !== null
              ? "History unavailable"
              : this.outcome === "readonly"
                ? `${this.adapter.label} agent unavailable`
                : "History unavailable",
          description:
            this.outcome === "readonly" && locator === null && this.binding.sessionRef !== null
              ? "This agent reports a native session with no readable history; the conversation is read-only."
              : this.outcome === "readonly"
                ? "The bound agent is no longer present. This conversation is read-only."
                : "This agent has no readable native transcript; use your terminal for history.",
        },
      });
    }

    this.emit({ type: "session.ready", requestId, sessionId: this.sessionId });
  }

  /** Send a text prompt and follow the committed native turn to completion. */
  async prompt(prompt: ProviderPrompt): Promise<void> {
    if (this.controller.signal.aborted) return;
    const fail = (message: string): void => {
      this.emit({
        type: "session.prompt_result",
        sessionId: this.sessionId,
        clientMessageId: prompt.clientMessageId,
        result: { type: "failed", error: { message } },
      });
    };

    if (this.outcome !== "active") return fail("The Herdr agent binding has changed; input is disabled");
    if (this.activeTurn) return fail("Agent is already working");
    if (prompt.delivery !== "auto" || prompt.input.type !== "message" ||
        prompt.input.content.some((part) => part.type !== "text")) {
      return fail("Only plain-text messages are supported");
    }
    const text = prompt.input.content.filter((part) => part.type === "text").map((part) => part.text).join("\n");
    if (!text.trim()) return fail("Prompt cannot be empty");

    const agent = findBound(await this.listAgents(this.controller.signal), this.binding, this.adapter);
    if (!agent) return fail("The Herdr agent binding has changed; input is disabled");
    if (agent.agent_status !== "idle" && agent.agent_status !== "done") {
      return fail("Agent is not idle; use your terminal to finish its current turn");
    }

    const before = await this.snapshotItems();
    const previousAssistantIds = new Set(before.filter((item) => item.type === "assistant_message").map((item) => item.id));
    const previousUserIds = new Set(before.filter((item) => item.type === "user_message").map((item) => item.id));

    let result: unknown;
    try {
      result = await this.request("agent.prompt", {
        target: agent.pane_id,
        text,
        wait: { until: ["working", "blocked", "idle", "done"], timeout_ms: 10000 },
      }, { signal: this.controller.signal });
    } catch (error) {
      if (this.controller.signal.aborted) return;
      return fail(error instanceof Error ? error.message : String(error));
    }
    void result;

    const turnId = randomUUID();
    this.activeTurn = turnId;
    this.emit({
      type: "session.prompt_result",
      sessionId: this.sessionId,
      clientMessageId: prompt.clientMessageId,
      result: { type: "turn", turnId },
    });
    this.emit({ type: "session.turn", sessionId: this.sessionId, turnId, state: "started" });

    // P0 polling: follow status until the committed native turn lands.
    void this.followTurn(turnId, text, prompt.clientMessageId, previousAssistantIds, previousUserIds);
  }

  /** Detach: stop the reader and abort all in-flight emissions. */
  close(): void {
    this.controller.abort();
    this.reader?.close();
    this.reader = null;
  }

  private async followTurn(
    turnId: string,
    text: string,
    clientMessageId: string,
    previousAssistantIds: Set<string>,
    previousUserIds: Set<string>,
  ): Promise<void> {
    try {
      for (let attempt = 0; attempt < 120; attempt++) {
        if (this.controller.signal.aborted) return;
        await new Promise((resolve) => setTimeout(resolve, 1000));
        if (this.controller.signal.aborted) return;

        const current = findBound(await this.listAgents(this.controller.signal), this.binding, this.adapter);
        if (!current) throw new Error("The Herdr agent binding changed during the turn");
        if (current.agent_status === "working" || current.agent_status === "blocked") continue;
        if (current.agent_status !== "idle" && current.agent_status !== "done") continue;

        const items = await this.snapshotItems();
        if (!items.some((item) => item.type === "assistant_message" && !previousAssistantIds.has(item.id))) continue;

        const committedUser = items.find((item) => item.type === "user_message" && !previousUserIds.has(item.id));
        if (committedUser?.type === "user_message") {
          this.binding.submittedMessages[committedUser.id] = clientMessageId;
          this.emit({ type: "session.persistence", sessionId: this.sessionId, persistence: persistenceOf(this.binding) });
          if (committedUser.text !== text) {
            this.emit({
              type: "session.notice",
              sessionId: this.sessionId,
              notice: {
                id: `prompt-text-${committedUser.id}`,
                severity: "warning",
                title: "Native prompt text differed",
                description: "The harness submitted different text than the Paseo composer; check the attached terminal for a pending draft.",
              },
            });
          }
        }

        for (const item of items) {
          this.emit({
            type: "timeline.item",
            sessionId: this.sessionId,
            item: correlateItem(item, this.binding.submittedMessages),
          });
        }
        this.emit({ type: "session.turn", sessionId: this.sessionId, turnId, state: "completed" });
        this.activeTurn = null;
        return;
      }
      throw new Error("Turn status could not be confirmed; inspect the attached terminal");
    } catch (error) {
      if (this.controller.signal.aborted) return;
      this.emit({
        type: "session.turn",
        sessionId: this.sessionId,
        turnId,
        state: "failed",
        error: { message: error instanceof Error ? error.message : String(error) },
      });
      this.activeTurn = null;
    }
  }

  /** Read the current transcript snapshot's timeline items (empty when no reader). */
  private async snapshotItems(): Promise<ProviderTimelineItem[]> {
    if (!this.reader) return [];
    const snapshot = await this.reader.snapshot();
    return snapshot.items;
  }

  private emitRow(row: TimelineRow): void {
    this.emit({ type: "timeline.item", sessionId: this.sessionId, item: row.item, timestamp: row.timestamp });
  }

  /** Unique validated path recovery when `terminal_id` is gone. */
  private recoverByPath(agents: readonly AgentInfo[]): Binding | null {
    if (!this.binding.sessionRef) return null;
    const matches = agents.filter(
      (agent) => agent.agent === this.adapter.id && sameRef(this.binding.sessionRef, sessionRefOf(agent)),
    );
    return matches.length === 1 ? bindingOf(matches[0], this.adapter, this.getHerdrSession?.() ?? null) : null;
  }
}
