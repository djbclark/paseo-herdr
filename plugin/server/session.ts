import type { ProviderConfigChanges, ProviderEvent, ProviderPrompt, ProviderSessionConfig } from "@getpaseo/plugin/server/provider";
import type { HarnessAdapter, PaneObservation, RestoredPromptOutcome, TranscriptReader, TranscriptSnapshot } from "./harness/types.js";
import { adapterAcceptsKind } from "./harness/resolve.js";
import { PaneProcessInfoResultSchema, type AgentInfo, type AgentStatus, type PaneProcessInfo } from "./herdr/schema.js";
import type { HerdrSubscription, SubscriptionDescriptor } from "./herdr/client.js";
import { persistenceOf, sameRef, sessionRefOf, type Binding } from "./binding.js";
import { emptyTimelineState, seedTimeline, type TimelineRow } from "./timeline.js";
import { TurnTracker, type TurnEffect } from "./turns.js";
import { PromptController } from "./prompt.js";
import { LiveSession } from "./live-session.js";
import type { LaunchResult } from "./launch.js";
import { attachCommand } from "./herdr-commands.js";
import { ConfigController, supportsConfigure, type ModelCache } from "./config.js";
import { ApprovalController, supportsApprovals } from "./approvals.js";
import type { PermissionResponder } from "./host.js";

export interface HerdrRequest {
  (method: string, params?: Record<string, unknown>, options?: { signal?: AbortSignal }): Promise<unknown>;
}
export interface SessionDeps {
  adapter: HarnessAdapter;
  listAgents(signal?: AbortSignal): Promise<AgentInfo[]>;
  request: HerdrRequest;
  subscribe(subscriptions: SubscriptionDescriptor[], options?: { signal?: AbortSignal }): Promise<HerdrSubscription>;
  emit(event: ProviderEvent): void;
  getHerdrSession?: () => string | null;
  /** Claim a validated terminal, releasing the previous terminal after a move. */
  claimPane?: (terminalId: string) => boolean;
  /**
   * New-work routing: whether Herdr `agent` kind `kind` routes to this session's adapter (`resolver.select(kind) === adapter`).
   * Checked on the first validation of a binding (no occupant yet), so a pane detected as a specific kind
   * after it was listed is not driven by the fallback adapter. Absent = not checked.
   */
  routesNewWork?: (kind: string | null | undefined) => boolean;
  /** Create path: launch a new agent. Absent when the provider cannot create agents. */
  launch?(config: ProviderSessionConfig, signal: AbortSignal): Promise<LaunchResult>;
  /** Install-wide model list shared by every session of the provider (catalog source). */
  modelCache?: ModelCache;
  /** Bind path: fallback wait before re-sending history if the client never calls `flushHistory` (default {@link BIND_HISTORY_FALLBACK_MS}). */
  bindHistoryDelayMs?: number;
  /** P3.6: the Paseo API handle captured from a lifecycle hook, once one has fired. */
  getPaseo?: () => PermissionResponder | null;
  /** Tests: replaces the real timer between approval polls. Must resolve on abort. */
  approvalSleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}
/**
 * Paseo subscribes to a created session only after registering it, and drops rows emitted before that
 * (plugin-provider.ts:1116, agent-manager.ts:1320). The client calls `herdr.chat.ready` once its create
 * resolves (so Paseo is listening), which flushes; this fallback covers a client that never does.
 */
export const BIND_HISTORY_FALLBACK_MS = 5000;

/** Placeholder binding for a session whose agent is still being launched. */
export function pendingBinding(adapter: HarnessAdapter, herdrSession: string | null, cwd: string): Binding {
  return { harness: adapter.id, herdrSession, terminalId: "", agentName: null, sessionRef: null, cwd, submittedMessages: {} };
}


/** One owner for control and observation. Helpers hold only scheduling resources. */
export interface SessionState {
  binding: Binding;
  paneId: string | null;
  /** Foreground process of the pane as last validated; the pane half of an adapter's input target. */
  process: PaneProcessInfo | null;
  reader: TranscriptReader | null;
  timeline: ReadonlyMap<string, string>;
  snapshot: TranscriptSnapshot | null;
  outcome: "active" | "readonly";
  connected: boolean;
  status: AgentStatus;
  generation: number;
  admitting: boolean;
  pending: { clientMessageId: string; text: string; previousUserIds: Set<string> } | null;
  turnBaselineEndId: string | null;
  /** Herdr reported `working`/`blocked` while the current Paseo turn was open. */
  workingSeen: boolean;
  /**
   * Set when the transcript ended a Paseo turn before Herdr ever reported it working (a Stop that aborts the turn
   * within milliseconds). Herdr's late `working` for that finished turn must not open a new turn: its end is already
   * consumed, so a phantom turn could never end.
   */
  staleWorking: { endId: string | undefined; echoed: boolean } | null;
  tracker: TurnTracker;
}
const CAPABILITIES = ["prompt.message", "session.list", "session.persistence"] as const;
/** Capabilities a session of this adapter supports; provider-level negotiation uses the same list. */
export function capabilitiesFor(adapter: HarnessAdapter): readonly string[] {
  return [
    ...CAPABILITIES,
    ...(supportsConfigure(adapter) ? ["session.configure"] : []),
    ...(supportsApprovals(adapter) ? ["permission", "timeline.plugin"] : []),
  ];
}

export class HerdrHarnessSession {
  readonly state: SessionState;
  readonly controller = new AbortController();
  private readonly prompts: PromptController;
  readonly live: LiveSession;
  readonly config: ConfigController;
  readonly approvals: ApprovalController;
  /** Bind path: live timeline rows held back until the replayed history has been sent. */
  private heldRows: Array<Extract<ProviderEvent, { type: "timeline.item" }>> | null = null;
  private historyTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingHistory: TimelineRow[] | null = null;
  /** Pane-bound open: events emitted by the validation that runs before `session.opened`, replayed right after it. */
  private deferred: ProviderEvent[] | null = null;
  /**
   * `validateAgent` calls take a sequence number at the start. A call older than the last committed one never commits:
   * it returns that newer commit's agent instead (`committed`), so a caller does not read the overlap as "unavailable".
   */
  private validationSeq = 0;
  private committedSeq = 0;
  private committed: AgentInfo | null = null;
  /** Live view of this session's pane for pane-bound adapters; it follows terminal and pane moves. */
  readonly observation: PaneObservation;

  constructor(readonly sessionId: string, binding: Binding, readonly deps: SessionDeps) {
    this.state = {
      binding, paneId: null, process: null, reader: null, timeline: emptyTimelineState(), snapshot: null,
      outcome: "active", connected: false, status: "unknown", generation: 0, admitting: false,
      pending: null, turnBaselineEndId: null, workingSeen: false, staleWorking: null,
      tracker: new TurnTracker({ mode: deps.adapter.turnEvidence, onEffect: (effect) => this.applyEffect(effect) }),
    };
    const state = this.state;
    this.observation = {
      get terminalId() { return state.binding.terminalId; },
      get herdrSession() { return state.binding.herdrSession; },
      paneId: () => state.paneId,
      request: deps.request,
      signal: this.controller.signal,
    };
    this.prompts = new PromptController(this);
    this.live = new LiveSession(this);
    this.config = new ConfigController(this);
    this.approvals = new ApprovalController(this);
  }
  get adapter(): HarnessAdapter { return this.deps.adapter; }
  get signal(): AbortSignal { return this.controller.signal; }
  get isAborted(): boolean { return this.signal.aborted; }
  get capabilities(): readonly string[] { return capabilitiesFor(this.adapter); }
  current(generation: number): boolean { return !this.isAborted && this.state.generation === generation; }
  emit(event: ProviderEvent): void {
    if (this.isAborted) return;
    if (this.deferred) { this.deferred.push(event); return; }
    if (this.heldRows && event.type === "timeline.item") this.heldRows.push(event);
    else this.deps.emit(event);
  }
  /** Called after every accepted transcript snapshot: terminal-made model/thinking changes surface here. */
  onSnapshot(previous: TranscriptSnapshot | null, snapshot: TranscriptSnapshot): void { this.config.onSnapshot(previous, snapshot); }
  persist(): void { this.emit({ type: "session.persistence", sessionId: this.sessionId, persistence: persistenceOf(this.state.binding) }); }

  /**
   * Create path: launch a new agent, bind to it, then run the normal open flow.
   * Closing the session aborts the launch; whatever was launched stays running.
   */
  async create(config: ProviderSessionConfig, history: "replay" | "skip", requestId?: string): Promise<void> {
    if (!this.deps.launch) throw new Error("Creating agents is not supported");
    const launched = await this.deps.launch(config, this.signal);
    if (this.isAborted) return;
    this.state.binding = {
      harness: this.adapter.id,
      herdrSession: this.deps.getHerdrSession?.() ?? null,
      terminalId: launched.terminalId,
      agentName: launched.agentName,
      sessionRef: launched.sessionRef ? { kind: launched.sessionRef.kind, value: launched.sessionRef.value } : null,
      cwd: launched.cwd,
      submittedMessages: {},
    };
    try {
      await this.open(config, history, requestId);
    } catch (error) {
      // The launch succeeded, so the agent is running; the request fails but must say where it is.
      if (this.isAborted) throw error;
      const { herdrSession, agentName } = this.state.binding;
      if (!agentName) throw error;
      const text = messageOf(error);
      throw new Error(`${/[.!?]$/.test(text) ? text : `${text}.`} The agent keeps running in Herdr; attach with: ${attachCommand(herdrSession, agentName)}`);
    }
    if (this.isAborted) return;
    const readonly = this.state.outcome === "readonly";
    this.emit({ type: "session.notice", sessionId: this.sessionId, notice: {
      id: "attach", severity: "info", title: `${this.adapter.label} agent running in Herdr`,
      description: `The agent ${launched.agentName} is running in Herdr and keeps running if you close this conversation. Attach from a terminal with: ${attachCommand(this.state.binding.herdrSession, launched.agentName)}`
        + (readonly ? ". This conversation is read-only." : ""),
    } });
  }

  /**
   * Bind path: attach to an agent that is already running (the binding was set at construction), then
   * open it like an import. Paseo opens creates without history, so the earlier conversation is re-sent as live rows.
   */
  async bind(config: ProviderSessionConfig, requestId?: string): Promise<void> {
    await this.open(config, "replay-live", requestId);
    if (this.isAborted) return;
    const { herdrSession, agentName } = this.state.binding;
    const readonly = this.state.outcome === "readonly";
    this.emit({ type: "session.notice", sessionId: this.sessionId, notice: {
      id: "attach", severity: "info", title: `Opened a running ${this.adapter.label} agent`,
      description: `This conversation is attached to an agent that keeps running in Herdr if you close it. Earlier messages are shown with the time this conversation was opened.`
        + (agentName ? ` Attach from a terminal with: ${attachCommand(herdrSession, agentName)}` : "")
        + (readonly ? ". This conversation is read-only." : ""),
    } });
  }

  async open(config: ProviderSessionConfig, history: "replay" | "skip" | "replay-live", requestId?: string): Promise<void> {
    let live: TimelineRow[] = [];
    this.approvals.begin(config);
    const paneBound = this.adapter.binding === "pane";
    if (paneBound) {
      // A pane reader needs the validated pane, so validate first. Its events (a freeze notice, persistence) must
      // not reach the host before `session.opened`: hold them and replay them right after it.
      this.deferred = [];
      try { await this.validateAgent(); }
      catch (error) {
        if (!this.isAborted) this.freeze("Input companion unavailable", messageOf(error));
      }
      if (this.isAborted) { this.deferred = null; return; }
    }
    const generation = this.state.generation;
    const emitOpened = () => {
      const held = this.deferred ?? [];
      this.deferred = null;
      this.emit({ type: "session.opened", requestId, sessionId: this.sessionId, restoration: "core",
        capabilities: this.capabilities, persistence: persistenceOf(this.state.binding),
        cwd: this.state.binding.cwd || config.cwd, title: this.state.binding.agentName ?? config.title });
      for (const event of held) this.emit(event);
    };
    // A pane-bound session that failed validation has no pane to read.
    const locator = paneBound && this.state.outcome !== "active" ? null
      : await this.adapter.resolveTranscript(this.state.binding.sessionRef, { cwd: this.state.binding.cwd, ...(paneBound ? { pane: this.observation } : {}) });
    if (!this.current(generation)) { this.deferred = null; return; }
    if (locator) {
      this.state.reader = this.adapter.openTranscript(locator);
      const snapshot = await this.state.reader.snapshot();
      if (!this.current(generation)) { this.deferred = null; return; }
      this.state.snapshot = snapshot;
      this.state.turnBaselineEndId = snapshot.lastTurnEndId ?? null;
      const seeded = seedTimeline(snapshot, this.state.binding.submittedMessages);
      this.state.timeline = seeded.state;
      emitOpened();
      if (history === "replay-live") live = seeded.rows;
      if (history === "replay") for (const row of seeded.rows) {
        this.emit({ type: "timeline.item", sessionId: this.sessionId, item: row.item, timestamp: row.timestamp });
      }
    } else {
      emitOpened();
      this.freeze("History unavailable", "This agent has no readable native history; the conversation is read-only.");
    }
    if (history === "replay") this.approvals.replay();
    if (this.state.outcome === "active" && !paneBound) {
      try { await this.validateAgent(); }
      catch (error) {
        if (!this.isAborted) this.freeze("Input companion unavailable", messageOf(error));
      }
    }
    if (this.isAborted) return;
    // Only a validated occupant is asked for its live model/thinking state.
    if (this.state.outcome === "active") {
      await this.config.initialRead();
      if (this.isAborted) return;
    }
    this.emit({ type: "session.ready", requestId, sessionId: this.sessionId });
    if (this.state.outcome === "active") {
      this.state.connected = true;
      // Before the live loop: it must know whether approvals are on when it first sees a blocked agent.
      await this.approvals.initialPoll();
      if (this.isAborted) return;
      this.live.start();
    }
    if (live.length) this.replayLive(live);
  }

  /** Re-send history as live rows once the host is listening; rows that arrive meanwhile queue behind it. */
  private replayLive(rows: TimelineRow[]): void {
    this.heldRows = [];
    this.pendingHistory = rows;
    this.historyTimer = setTimeout(() => this.flushHistory(), this.deps.bindHistoryDelayMs ?? BIND_HISTORY_FALLBACK_MS);
  }

  /** Bind path: send the held history now (the host is subscribed). Idempotent; a no-op for other sessions. */
  flushHistory(): void {
    if (this.historyTimer) clearTimeout(this.historyTimer);
    this.historyTimer = null;
    const rows = this.pendingHistory;
    const held = this.heldRows ?? [];
    this.pendingHistory = null;
    this.heldRows = null;
    if (!rows || this.isAborted) return;
    for (const row of rows) this.emit({ type: "timeline.item", sessionId: this.sessionId, item: row.item, timestamp: row.timestamp });
    for (const event of held) this.emit(event);
  }

  /**
   * After an early-abort cancel the harness may have restored the prompt into its input box. Ask it once to drop that
   * text; keep anything else. Never retried; uncertainty is reported to the user rather than resolved by guessing.
   */
  async discardRestoredPrompt(text: string, generation: number): Promise<void> {
    const occupant = this.state.binding.occupant;
    const ref = this.state.binding.sessionRef;
    const label = this.adapter.label;
    let outcome: RestoredPromptOutcome = "unsupported";
    try {
      if (this.adapter.discardRestoredPrompt && occupant && (this.adapter.binding === "pane" || ref)) {
        const { paneId, process } = this.state;
        outcome = await this.adapter.discardRestoredPrompt({ pid: occupant.pid, ref, instanceId: occupant.instanceId,
          ...(paneId && process ? { pane: { paneId, terminalId: this.state.binding.terminalId, process } } : {}) }, text, this.signal);
      }
    } catch { /* the adapter could not tell: same as unsupported */ }
    if (outcome === "cleared" || !this.current(generation)) return;
    if (!this.adapter.discardRestoredPrompt) {
      // This harness cannot discard text, and it submits by typing into the terminal: the message was typed and may
      // still sit in the input box, or the harness may have recorded it late. Deny nothing.
      this.emit({ type: "session.notice", sessionId: this.sessionId, notice: {
        id: "restored-prompt", severity: "info",
        title: `${label} may not have received your message`,
        description: "The message was typed into the terminal and may still be in the input box. Check the terminal before sending it again.",
      } });
      return;
    }
    // "kept" is a companion's authenticated answer that the input box still holds text, which need not be ours;
    // anything else (unknown, unsupported, a throw) says nothing about the input box.
    const kept = outcome === "kept";
    this.emit({ type: "session.notice", sessionId: this.sessionId, notice: {
      id: "restored-prompt", severity: "info",
      title: kept ? `${label} kept text in its input box` : `${label} may have kept your message in its input box`,
      description: `${kept ? "The input box was not cleared, and the text in it may not be your message." : "If the message was not sent, it may still be in the input box."} To remove it, clear the input box in the terminal (Herdr screen, then ⋯, then Open in terminal).`,
    } });
  }

  prompt(prompt: ProviderPrompt): Promise<void> { return this.prompts.prompt(prompt); }
  interrupt(requestId: string): Promise<void> { return this.prompts.interrupt(requestId); }
  configure(requestId: string, changes: ProviderConfigChanges): Promise<void> { return this.config.configure(requestId, changes); }
  close(): void {
    this.controller.abort();
    if (this.historyTimer) clearTimeout(this.historyTimer);
    this.historyTimer = null;
    this.heldRows = null;
    this.pendingHistory = null;
    this.config.close();
    this.approvals.close();
    this.state.generation++;
    this.live.stop();
    this.state.reader?.close();
    this.state.reader = null;
    this.state.pending = null;
    this.state.tracker.close();
  }

  /** Refresh terminal, native session, foreground leader and process-local nonce. */
  async validateAgent(moveRetry = false, seq = ++this.validationSeq): Promise<AgentInfo | null> {
    const generation = this.state.generation;
    const agents = await this.deps.listAgents(this.signal);
    if (!this.current(generation) || this.state.outcome !== "active") return null;
    const binding = this.state.binding;
    let agent = agents.find((candidate) => candidate.terminal_id === binding.terminalId);
    const nativeRef = this.adapter.binding === "native-ref";
    if (agent && (!adapterAcceptsKind(this.adapter, agent.agent) || (nativeRef && !sameRef(sessionRefOf(agent), binding.sessionRef)))) {
      const changedSession = adapterAcceptsKind(this.adapter, agent.agent) && nativeRef && !sameRef(sessionRefOf(agent), binding.sessionRef);
      this.freeze(changedSession ? "The native session changed" : "The bound agent was replaced",
        changedSession ? "The old conversation is frozen. Open Import session, choose the Herdr provider and import the current native conversation separately. Do not import it through the native provider: that creates a second process." : "The bound foreground agent changed; no input will be sent to its replacement.");
      return null;
    }
    // First validation of a binding (an import or bind never validated): new-work routing decides the adapter.
    // An existing occupant binding keeps `adapterAcceptsKind`, so a saved fallback chat survives a later detection.
    if (agent && !binding.occupant && this.deps.routesNewWork && !this.deps.routesNewWork(agent.agent)) {
      this.freeze(`This pane is handled by another provider`,
        `Herdr detects ${agent.agent ? `a ${agent.agent} agent` : "another agent"} in this pane, so ${this.adapter.label} will not drive it. This conversation is read-only; import the pane again to use the matching provider.`);
      return null;
    }
    if (!agent) {
      // Recovery by native ref only exists for native-ref bindings; a pane binding with a missing terminal is gone.
      const matches = nativeRef ? agents.filter((candidate) => adapterAcceptsKind(this.adapter, candidate.agent) && sameRef(sessionRefOf(candidate), binding.sessionRef)) : [];
      // Recovery never trusts a native path alone; require retained process evidence below.
      if (matches.length !== 1 || !binding.occupant) {
        this.freeze(`${this.adapter.label} agent unavailable`, "The bound agent is no longer present or recovery is ambiguous; this conversation is read-only.");
        return null;
      }
      agent = matches[0];
    }
    if (nativeRef && !binding.sessionRef) {
      this.freeze("History unavailable", "This agent has no readable native history; the conversation is read-only.");
      return null;
    }
    const result = PaneProcessInfoResultSchema.parse(await this.deps.request("pane.process_info", { pane_id: agent.pane_id }, { signal: this.signal }));
    if (!this.current(generation) || this.state.outcome !== "active") return null;
    const process = result.process_info;
    const pid = process.foreground_process_group_id;
    if (process.pane_id !== agent.pane_id) {
      // Herdr resolves an old pane id to its new location after a move. The move
      // can happen between agent.list and process_info; re-read both identities
      // instead of treating an alias response as a replaced process.
      if (!moveRetry) return this.validateAgent(true, seq);
      // A newer commit already proved the pane reachable: this older observation must not mark it disconnected.
      if (seq < this.committedSeq) return this.committed;
      this.state.connected = false;
      this.state.tracker.observeConnectivityLost();
      return null;
    }
    if (!pid || !this.adapter.isOccupant(process)) {
      this.freeze("The bound agent was replaced", "The foreground process is not the bound harness; input is disabled.");
      return null;
    }
    const previous = binding.occupant;
    if (previous && (previous.pid !== pid || previous.tty !== (process.tty ?? null))) {
      this.freeze("The bound agent was replaced", "The foreground process identity changed; no input will be sent to the replacement.");
      return null;
    }
    const identity = await this.adapter.inspectInput({ pid, ref: binding.sessionRef,
      pane: { paneId: agent.pane_id, terminalId: agent.terminal_id, process } }, this.signal);
    if (!this.current(generation) || this.state.outcome !== "active") return null;
    if (identity.pid !== pid || (previous && previous.instanceId !== identity.instanceId)) {
      this.freeze("The bound agent was replaced", "The process-local input identity changed; no input will be sent to the replacement.");
      return null;
    }
    // A validation that started earlier but finished after a later one must not move the claim or state back. It
    // returns what the later one committed (the session is still active here, so that commit did not freeze it).
    if (seq < this.committedSeq) return this.committed;
    this.committedSeq = seq;
    if (this.deps.claimPane && !this.deps.claimPane(agent.terminal_id)) {
      this.freeze(`This ${this.adapter.label} agent is already open in another conversation`,
        "This conversation is read-only; the other conversation keeps control of the running agent.");
      return null;
    }
    const moved = binding.terminalId !== agent.terminal_id || this.state.paneId !== agent.pane_id;
    binding.occupant = { pid, tty: process.tty ?? null, instanceId: identity.instanceId };
    binding.terminalId = agent.terminal_id;
    this.state.paneId = agent.pane_id;
    this.state.process = process;
    this.state.status = agent.agent_status;
    if (!previous || moved) this.persist();
    if (moved) this.live.paneChanged();
    this.committed = agent;
    return agent;
  }

  freeze(title: string, description: string): void {
    if (this.isAborted || this.state.outcome === "readonly") return;
    this.state.outcome = "readonly";
    this.state.connected = false;
    this.state.generation++;
    this.state.tracker.bindingLost(description);
    this.state.pending = null;
    this.live.stop();
    this.state.reader?.close();
    this.state.reader = null;
    this.approvals.withdrawAll(title);
    this.emit({ type: "session.notice", sessionId: this.sessionId, notice: {
      id: "history-or-agent-unavailable", severity: "warning", title, description,
    } });
  }

  private applyEffect(effect: TurnEffect): void {
    if (effect.type === "turn") {
      this.emit({ type: "session.turn", sessionId: this.sessionId, turnId: effect.turnId, state: effect.state,
        ...(effect.error ? { error: { message: effect.error } } : {}) });
    } else if (effect.type === "prompt_failed") {
      this.emit({ type: "session.prompt_result", sessionId: this.sessionId, clientMessageId: effect.clientMessageId,
        result: { type: "failed", error: { message: effect.message } } });
    } else if (effect.type === "prompt_accepted" || effect.type === "prompt_uncertain") {
      this.emit({ type: "session.prompt_result", sessionId: this.sessionId, clientMessageId: effect.clientMessageId,
        result: { type: "turn", turnId: effect.turnId } });
      if (effect.type === "prompt_uncertain") this.emit({ type: "session.notice", sessionId: this.sessionId,
        notice: { id: "prompt-uncertain", severity: "warning", title: "Prompt delivery is uncertain",
          description: `${effect.message ? `${effect.message}${/[.!?]$/.test(effect.message) ? "" : "."} ` : ""}The prompt may still reach the agent; it was not resubmitted. Check the attached terminal.` } });
    } else if (effect.type === "notice") {
      // With approvals on, the cards replace the "needs approval in the terminal" notice; dismissals always pass.
      if (effect.id === "blocked" && !effect.dismissed && this.approvals.enabled === "on") return;
      this.emit({ type: "session.notice", sessionId: this.sessionId, notice: {
        ...effect, ...(effect.id === "blocked" ? { description: this.adapter.blockedHint } : {}),
      } });
    }
  }
}
export function messageOf(error: unknown): string { return error instanceof Error ? error.message : String(error); }
