import type { NativeTurnEnd, TurnEvidence } from "./harness/types.js";
import type { AgentStatus } from "./herdr/schema.js";

/**
 * TurnTracker: pure turn-lifecycle state machine for one Herdr session.
 *
 * Inputs are Herdr `agent_status` observations, the adapter's `NativeTurnEnd`
 * for a completed transcript re-read, and reservation calls from the prompt
 * path. It emits effects (turn events, notices, prompt results) through the
 * injected `onEffect` callback; it performs no I/O and no native parsing, so it
 * is unit-testable against a table of status/end sequences.
 *
 * Model (IMPLEMENTATION.md §2 "Turn state machine"):
 * - Sequential interaction: Paseo OR terminal, never both. A `working`/`blocked`
 *   observation with no pending Paseo submission starts an autonomous
 *   (terminal-originated) turn. A `working` observation that arrives while a
 *   pending submission is still being delivered is only remembered: the
 *   delivery result (accepted/rejected) or the transcript entry decides whether
 *   the work was ours, so a later rejection is never turned into an acceptance.
 * - A prompt result is emitted once: acceptance reports its reserved turn,
 *   uncertain delivery reports the reservation without claiming acceptance.
 * - How a turn ends is the adapter's `turnEvidence` (the mode pinned at
 *   construction). "transcript": only a known `NativeTurnEnd` from a final
 *   transcript re-read following `idle`/`done` ends a turn (an interrupt can
 *   race natural completion). "status": Herdr's counters are the evidence — a
 *   `completion_seq` advance ends at once, and otherwise `idle`/`done` held
 *   past a settle window ends the turn (with an info notice when no activity
 *   was ever observed).
 * - Observer disconnection is separate from native failure; `unknown` is
 *   transient until it persists past a threshold (in status mode it is simply
 *   tolerated: panes without screen detection report it permanently, so only an accepted or uncertain turn is failed after the window).
 */

export type TurnOrigin = "paseo" | "terminal";

export interface TurnTrackerThresholds {
  /** `unknown` persisting longer than this → binding loss. */
  unknownBindingLossMs: number;
  /** Reconnect attempts give up after this long → connectivity failure. */
  reconnectGiveUpMs: number;
  /** An interrupt that has not ended the turn after this → warning notice. */
  interruptPendingMs: number;
  /** Uncertain delivery with no transcript entry settles only after native idle has held this long. */
  uncertainSettleMs: number;
  /** Status evidence: after observed activity, `idle`/`done` held this long ends the turn. */
  idleSettleMs: number;
  /** Status evidence: `idle`/`done` held this long with no observed activity ends the turn (with an info notice). */
  noActivitySettleMs: number;
  /**
   * Early-abort detection (a Stop that lands before the harness recorded the prompt): only observations at least this
   * long after the interrupt count. Normal startup lag (R17) keeps Herdr on `idle` for seconds, but there the user
   * entry is already in the transcript; this margin covers the remaining window where the key and the entry race.
   */
  earlyAbortMinAfterInterruptMs: number;
  /** Two consecutive non-working observations with no user entry must span at least this long before the turn is canceled. */
  earlyAbortSettleMs: number;
}

export const DEFAULT_TURN_THRESHOLDS: TurnTrackerThresholds = {
  unknownBindingLossMs: 30_000,
  reconnectGiveUpMs: 60_000,
  interruptPendingMs: 10_000,
  uncertainSettleMs: 15_000,
  idleSettleMs: 3_000,
  noActivitySettleMs: 15_000,
  earlyAbortMinAfterInterruptMs: 1_000,
  earlyAbortSettleMs: 1_000,
};

export type TurnEffect =
  | { type: "turn"; turnId: string; state: "started" | "completed" | "failed" | "canceled"; error?: string }
  | { type: "prompt_accepted"; clientMessageId: string; turnId: string }
  | { type: "prompt_failed"; clientMessageId: string; message: string }
  | { type: "prompt_uncertain"; clientMessageId: string; turnId: string; message?: string }
  | { type: "notice"; id: string; severity: "info" | "warning" | "error"; title: string; description?: string; dismissed?: boolean };

/** Reservation baseline: the counters Herdr reported when the prompt was admitted (status-evidence mode). */
export interface TurnBaseline {
  stateChangeSeq: number;
  completionSeq: number | null;
}

/** One status-evidence observation: Herdr's status plus the counters that prove pane activity. */
export interface StatusEvidence {
  status: AgentStatus;
  /** Per-pane state-change counter; any advance is activity. */
  stateChangeSeq: number;
  /** Completed-turn counter; an advance proves a turn finished (null = none recorded). */
  completionSeq: number | null;
}

type Phase =
  | { kind: "idle" }
  | { kind: "pending"; turnId: string; clientMessageId: string; since: number; responseReported: boolean; uncertainSince: number | null; uncertainIdleSince: number | null; busyDuringDelivery: boolean; baseline: TurnBaseline | null }
  | { kind: "active"; turnId: string; origin: TurnOrigin; since: number; startSeq: number; startCompletion: number | null; activitySeen: boolean }
  | { kind: "ending"; turnId: string; origin: TurnOrigin };

export interface PendingSubmission {
  turnId: string;
  clientMessageId: string;
  /** Counters observed at admission; status-evidence turn ends are measured against it. */
  baseline?: TurnBaseline;
}

/** Truthful wording for a reservation that no evidence ever confirmed: delivery failed, nothing was resent. */
const UNCERTAIN_FAILURE = "Paseo could not confirm the prompt reached the agent; it was not resent. Check the terminal.";
/** Status evidence: the pane reported `unknown` for the whole unknown window after the turn began; the turn's fate is not knowable. */
const UNKNOWN_TURN_FAILURE = "Herdr has reported this agent's status as unknown for too long, so Paseo cannot tell whether the turn finished. Check the terminal.";

export class TurnTracker {
  private phase: Phase = { kind: "idle" };
  private lastStatus: AgentStatus = "unknown";
  private unknownSince: number | null = null;
  private disconnectedSince: number | null = null;
  private interruptedAt: number | null = null;
  private interruptNoticed = false;
  /** Consecutive qualifying early-abort observations: when the first was made and how many so far. */
  private earlyAbort: { since: number; count: number } | null = null;
  /** Status evidence: `idle`/`done` held continuously since this observation (null = not currently idle). */
  private idleSince: number | null = null;
  /** Last status-evidence counters seen; the fallback baseline for reservations admitted without one. */
  private lastSeq = 0;
  private lastCompletion: number | null = null;
  private readonly now: () => number;
  private readonly thresholds: TurnTrackerThresholds;
  private readonly onEffect: (effect: TurnEffect) => void;
  private mode: TurnEvidence;
  private readonly modePinned: boolean;

  constructor(options: {
    /** How this tracker learns turn ends; a caller that knows it passes the mode and {@link adoptEvidenceMode} cannot override it. */
    mode?: TurnEvidence;
    now?: () => number;
    thresholds?: Partial<TurnTrackerThresholds>;
    onEffect: (effect: TurnEffect) => void;
  }) {
    this.now = options.now ?? Date.now;
    this.thresholds = { ...DEFAULT_TURN_THRESHOLDS, ...options.thresholds };
    this.onEffect = options.onEffect;
    this.mode = options.mode ?? "transcript";
    this.modePinned = options.mode !== undefined;
  }

  /** Wire the adapter's `turnEvidence` into a tracker constructed without a mode; never overrides a pinned mode. */
  adoptEvidenceMode(mode: TurnEvidence): void {
    if (!this.modePinned) this.mode = mode;
  }

  get activeTurn(): string | null {
    return this.phase.kind === "idle" ? null :
      this.phase.kind === "pending" ? this.phase.turnId : this.phase.turnId;
  }

  get isPending(): boolean {
    return this.phase.kind === "pending";
  }

  get isActive(): boolean {
    return this.phase.kind === "active" || this.phase.kind === "ending";
  }

  /** Reserve a Paseo submission before `agent.prompt` is sent. */
  reservePending(submission: PendingSubmission): void {
    if (this.phase.kind !== "idle") {
      throw new Error("a turn is already in progress");
    }
    this.idleSince = null; // a new turn's idle hold must not inherit quiet time from before it started
    this.phase = { kind: "pending", turnId: submission.turnId, clientMessageId: submission.clientMessageId, since: this.now(), responseReported: false, uncertainSince: null, uncertainIdleSince: null, busyDuringDelivery: false, baseline: submission.baseline ?? null };
  }

  /** `agent.prompt` was accepted; the pending submission becomes an active Paseo turn. */
  acceptPending(): void {
    if (this.phase.kind !== "pending") return;
    const { turnId, clientMessageId, responseReported, baseline } = this.phase;
    // Without an admission baseline (status mode), the last observed counters are the least-baseline that is still truthful.
    const start = baseline ?? (this.mode === "status" ? { stateChangeSeq: this.lastSeq, completionSeq: this.lastCompletion } : null);
    this.idleSince = null;
    this.phase = { kind: "active", turnId, origin: "paseo", since: this.now(),
      startSeq: start?.stateChangeSeq ?? 0, startCompletion: start?.completionSeq ?? null, activitySeen: false };
    if (!responseReported) this.emit({ type: "prompt_accepted", clientMessageId, turnId });
    this.emit({ type: "turn", turnId, state: "started" });
  }

  /**
   * A definite rejection reports failure, or ends the turn if uncertainty was already reported. Work Herdr showed
   * while the delivery was in flight was not ours (the agent refused our input), so it continues as a terminal turn —
   * unless the caller passes `{ startTerminalTurn: false }` and reconciles instead (it owns the stale-`working` echo
   * guard, which the tracker cannot see).
   */
  rejectPending(message: string, options?: { startTerminalTurn?: boolean }): void {
    if (this.phase.kind !== "pending") return;
    if (this.phase.responseReported) {
      this.bindingLost(message);
      return;
    }
    const { clientMessageId, busyDuringDelivery } = this.phase;
    this.phase = { kind: "idle" };
    this.emit({ type: "prompt_failed", clientMessageId, message });
    if (options?.startTerminalTurn === false) return;
    if (busyDuringDelivery && (this.lastStatus === "working" || this.lastStatus === "blocked")) {
      const turnId = `turn-${this.now()}-${Math.random().toString(36).slice(2, 8)}`;
      this.idleSince = null;
      this.phase = { kind: "active", turnId, origin: "terminal", since: this.now(), startSeq: this.lastSeq, startCompletion: this.lastCompletion, activitySeen: true };
      this.emit({ type: "turn", turnId, state: "started" });
    }
  }

  /**
   * `agent.prompt` delivery is uncertain (stall/timeout). Keep the pending
   * submission so a later `working`/transcript observation can reconcile, but
   * do not claim rejection and never auto-resubmit. `message` (the adapter's
   * own wording) travels on the effect for the session's notice.
   */
  pendingUncertain(message?: string): void {
    if (this.phase.kind !== "pending" || this.phase.responseReported) return;
    this.phase.responseReported = true;
    this.phase.uncertainSince = this.now();
    this.emit({ type: "prompt_uncertain", clientMessageId: this.phase.clientMessageId, turnId: this.phase.turnId, ...(message !== undefined ? { message } : {}) });
  }

  /** Uncertain delivery is reported and not yet settled by the transcript or the status evidence. */
  get isUncertain(): boolean {
    return this.phase.kind === "pending" && this.phase.responseReported;
  }

  /**
   * Settle an uncertain reservation as not delivered. Only real evidence counts: a foreign user entry proves the
   * agent moved on; native idle *held continuously* for the settle window proves our entry never landed. The hold is
   * measured from the first idle observation, not from when uncertainty was reported — an agent that worked for a
   * long turn before its first idle observation did receive input (F6).
   */
  settleUncertain(evidence: { nativeIdle: boolean; foreignUserEntry: boolean }): boolean {
    if (this.phase.kind !== "pending" || !this.phase.responseReported) return false;
    const now = this.now();
    const idleStart = evidence.nativeIdle ? (this.phase.uncertainIdleSince ??= now) : (this.phase.uncertainIdleSince = null);
    const idleLongEnough = evidence.nativeIdle && idleStart !== null && now - idleStart >= this.thresholds.uncertainSettleMs;
    if (!evidence.foreignUserEntry && !idleLongEnough) return false;
    const { turnId } = this.phase;
    this.failUncertainReservation(turnId);
    return true;
  }

  /**
   * Stop on an unconfirmed delivery while the agent is idle: end the reservation as canceled without guessing
   * whether the agent took the prompt (nothing is resent, and no interrupt key is sent).
   */
  cancelUncertain(message: string): boolean {
    if (this.phase.kind !== "pending" || !this.phase.responseReported) return false;
    const { turnId } = this.phase;
    this.phase = { kind: "idle" };
    this.interruptedAt = null;
    this.interruptNoticed = false;
    this.emit({ type: "turn", turnId, state: "started" });
    this.emit({ type: "turn", turnId, state: "canceled", error: message });
    return true;
  }

  private failUncertainReservation(turnId: string): void {
    this.phase = { kind: "idle" };
    this.interruptedAt = null;
    this.interruptNoticed = false;
    this.emit({ type: "turn", turnId, state: "started" });
    this.emit({ type: "turn", turnId, state: "failed", error: UNCERTAIN_FAILURE });
  }

  /** A fresh Herdr status observation. */
  observeStatus(status: AgentStatus): void {
    const now = this.now();
    this.lastStatus = status;

    if (status === "unknown") {
      if (this.unknownSince === null) this.unknownSince = now;
      if (now - this.unknownSince > this.thresholds.unknownBindingLossMs) {
        this.unknownSince = null;
        this.bindingLost("The Herdr agent status has been unknown for too long; input is disabled");
      }
      return;
    }
    this.unknownSince = null;

    if (status === "working" || status === "blocked") {
      if (this.phase.kind === "pending") {
        // The delivery result decides ownership: remember the status but do not accept while it is in flight, or a
        // later definite rejection would be lost. An uncertain reservation is settled only by its transcript entry.
        if (!this.phase.responseReported) this.phase.busyDuringDelivery = true;
      } else if (this.phase.kind === "idle") {
        const turnId = `turn-${now}-${Math.random().toString(36).slice(2, 8)}`;
        this.phase = { kind: "active", turnId, origin: "terminal", since: now, startSeq: this.lastSeq, startCompletion: this.lastCompletion, activitySeen: true };
        this.emit({ type: "turn", turnId, state: "started" });
      }
    }

    // The blocked notice: raised once per entry into blocked, dismissed once on leaving it.
    this.noteBlocked(status);

    if (status === "idle" || status === "done") {
      this.tickInterrupt(now);
    }
    // Re-check an in-flight interrupt on every observation, not only idle/done.
    this.tickInterrupt(now);
  }

  private lastWasBlocked = false;

  /** The blocked-notice pair: raise once per entry into blocked, dismiss once on leaving it. */
  private noteBlocked(status: AgentStatus): void {
    if (status === "blocked") {
      if (!this.lastWasBlocked) this.emit({
        type: "notice",
        id: "blocked",
        severity: "warning",
        title: "Needs approval in the terminal",
      });
    } else if (this.lastWasBlocked) {
      this.emit({ type: "notice", id: "blocked", severity: "warning", title: "Needs approval in the terminal", dismissed: true });
    }
  }

  /**
   * Status-evidence mode (`turnEvidence: "status"`): one Herdr observation with its activity counters replaces
   * {@link observeStatus}. Turn ownership still comes from reservations, but turn *ends* come from the counters:
   * a `completion_seq` advance ends at once (a fast turn that finished between polls), otherwise `idle`/`done`
   * held past `idleSettleMs` (after observed activity) or `noActivitySettleMs` (with an info notice) ends the
   * turn. All work observed after an accepted send belongs to the Paseo turn (the wave-2 ruling), so a pending
   * uncertain reservation accepts as soon as the pane shows work or any state change. `unknown` is tolerated
   * without starting or ending anything (panes without screen detection report it permanently); an accepted or uncertain
   * turn still fails once `unknown` has lasted `unknownBindingLossMs`.
   */
  observeStatusEvidence(evidence: StatusEvidence): void {
    if (this.mode !== "status") return;
    const now = this.now();
    this.lastStatus = evidence.status;
    const seqAdvanced = evidence.stateChangeSeq > this.lastSeq;
    this.lastSeq = evidence.stateChangeSeq;
    this.lastCompletion = evidence.completionSeq;

    if (evidence.status === "unknown") {
      // No turn starts or ends from `unknown` itself, and no idle window is held through it (panes without screen
      // detection report it permanently). But an accepted or uncertain turn must not wait forever on a pane that
      // stays unknown: past the long unknown window it ends as failed, and the binding stays usable.
      this.idleSince = null;
      if (this.phase.kind === "pending" && this.phase.responseReported) this.phase.uncertainIdleSince = null;
      if (this.unknownSince === null) this.unknownSince = now;
      if (this.unknownStatusExpired(now)) {
        this.unknownSince = null;
        this.bindingLost(UNKNOWN_TURN_FAILURE);
      }
      return;
    }
    this.unknownSince = null;

    const busy = evidence.status === "working" || evidence.status === "blocked";
    // The idle hold needs continuous quiet: work (or any state change while idle) restarts the clock.
    if (busy || seqAdvanced) this.idleSince = null;
    if (!busy && this.idleSince === null) this.idleSince = now;

    if (this.phase.kind === "pending") {
      if (!this.phase.responseReported) {
        // The delivery result decides ownership: remember the status but do not accept while it is in flight.
        if (busy) this.phase.busyDuringDelivery = true;
      } else if (busy || this.phase.busyDuringDelivery || this.uncertainEvidenceAdvanced(evidence, seqAdvanced)) {
        this.acceptPending();
        // acceptPending clears the idle hold for a fresh turn; this observation is itself idle, so the hold (and an
        // already-advanced completion counter) must be judged by the settle below, not a poll later.
        if (!busy) this.idleSince = now;
      } else {
        // Idle with no state change: keep waiting; only continuous idle for the full window settles it as failed.
        if (this.phase.uncertainIdleSince === null) this.phase.uncertainIdleSince = now;
        if (now - this.phase.uncertainIdleSince >= this.thresholds.uncertainSettleMs) {
          this.failUncertainReservation(this.phase.turnId);
        }
      }
    } else if (this.phase.kind === "idle" && busy) {
      const turnId = `turn-${now}-${Math.random().toString(36).slice(2, 8)}`;
      this.phase = { kind: "active", turnId, origin: "terminal", since: now,
        startSeq: evidence.stateChangeSeq, startCompletion: evidence.completionSeq, activitySeen: true };
      this.emit({ type: "turn", turnId, state: "started" });
    }

    this.noteBlocked(evidence.status);

    if (this.phase.kind === "active") {
      if (busy) this.phase.activitySeen = true;
      if (evidence.status === "idle" || evidence.status === "done") this.settleActiveFromStatus(now, evidence);
    }

    this.tickInterrupt(now);
  }

  /** A turn the status counters have yet to settle: accepted/ending, or an uncertain reservation. */
  private get turnAwaitsEvidence(): boolean {
    return this.phase.kind === "active" || this.phase.kind === "ending" ||
      (this.phase.kind === "pending" && this.phase.responseReported);
  }

  private unknownStatusExpired(now: number): boolean {
    return this.unknownSince !== null && this.turnAwaitsEvidence &&
      now - this.unknownSince >= this.thresholds.unknownBindingLossMs;
  }

  /**
   * Evidence that an uncertain reservation's prompt reached the agent. Measured against the admission baseline, so
   * work done while the send was still in flight (counters moved before `pendingUncertain`) still counts; with no
   * baseline only an advance since the previous observation is available.
   */
  private uncertainEvidenceAdvanced(evidence: StatusEvidence, seqAdvanced: boolean): boolean {
    if (this.phase.kind !== "pending") return false;
    const baseline = this.phase.baseline;
    if (!baseline) return seqAdvanced;
    return evidence.stateChangeSeq > baseline.stateChangeSeq ||
      (evidence.completionSeq !== null && (baseline.completionSeq === null || evidence.completionSeq > baseline.completionSeq));
  }

  /** Status-evidence end rules for an active turn whose latest observation is `idle`/`done` (`idleSince` set). */
  private settleActiveFromStatus(now: number, evidence: StatusEvidence): void {
    if (this.phase.kind !== "active" || this.idleSince === null) return;
    const { turnId, startSeq, startCompletion, activitySeen } = this.phase;
    const completionAdvanced = evidence.completionSeq !== null &&
      (startCompletion === null || evidence.completionSeq > startCompletion);
    const sawActivity = activitySeen || evidence.stateChangeSeq > startSeq;
    const idleHeld = now - this.idleSince;
    const viaCompletion = completionAdvanced;
    const viaIdle = sawActivity && idleHeld >= this.thresholds.idleSettleMs;
    const viaNoActivity = !sawActivity && idleHeld >= this.thresholds.noActivitySettleMs;
    if (!viaCompletion && !viaIdle && !viaNoActivity) return;
    // A pending interrupt means the turn was stopped (the status counters cannot tell a stop from a natural end).
    const state = this.interruptedAt !== null ? "canceled" : "completed";
    this.phase = { kind: "idle" };
    this.interruptedAt = null;
    this.interruptNoticed = false;
    this.earlyAbort = null;
    this.emit({ type: "turn", turnId, state });
    if (viaNoActivity && state === "completed") {
      // Nothing but idle was ever observed: the "turn" may only be slow to start, so the heuristic is labelled.
      this.emit({
        type: "notice",
        id: "no-activity",
        severity: "info",
        title: "Turn ended with no activity observed",
        description: `Herdr stayed idle with no state change for ${Math.round(this.thresholds.noActivitySettleMs / 1000)} seconds, so the turn was marked complete. A slow-starting agent may have been missed; check the terminal if this looks wrong.`,
      });
    }
  }

  /** A final transcript re-read produced a native outcome for the open turn. */
  observeNativeTurnEnd(end: NativeTurnEnd): void {
    if (end === "unknown") return;
    if (this.phase.kind === "active") {
      this.phase = { kind: "ending", turnId: this.phase.turnId, origin: this.phase.origin };
    }
    if (this.phase.kind !== "ending") return;
    const { turnId } = this.phase;
    this.phase = { kind: "idle" };
    this.interruptedAt = null;
    this.interruptNoticed = false;
    const state = end === "aborted" ? "canceled" : end === "error" ? "failed" : "completed";
    this.emit({ type: "turn", turnId, state });
  }

  /** The bound pane/agent disappeared or was replaced. */
  bindingLost(message: string): void {
    if (this.phase.kind === "active" || this.phase.kind === "ending") {
      const { turnId } = this.phase;
      this.phase = { kind: "idle" };
      this.emit({ type: "turn", turnId, state: "failed", error: message });
    } else if (this.phase.kind === "pending") {
      const { turnId, clientMessageId, responseReported } = this.phase;
      this.phase = { kind: "idle" };
      if (responseReported) {
        this.emit({ type: "turn", turnId, state: "started" });
        this.emit({ type: "turn", turnId, state: "failed", error: message });
      } else {
        this.emit({ type: "prompt_failed", clientMessageId, message });
      }
    }
  }

  /** The observer lost its connection to Herdr (not a native failure). */
  observeConnectivityLost(): void {
    if (this.disconnectedSince !== null) return;
    this.disconnectedSince = this.now();
    this.emit({
      type: "notice",
      id: "connectivity",
      severity: "warning",
      title: "Lost connection to Herdr",
      description: "Input is suspended until the connection is restored.",
    });
  }

  /** The observer reconnected; reconcile rather than deciding an outcome. */
  observeConnectivityRestored(): void {
    if (this.disconnectedSince === null) return;
    const elapsed = this.now() - this.disconnectedSince;
    this.disconnectedSince = null;
    this.emit({ type: "notice", id: "connectivity", severity: "warning", title: "Lost connection to Herdr", dismissed: true });
    if (this.phase.kind === "active" || this.phase.kind === "ending") {
      if (elapsed > this.thresholds.reconnectGiveUpMs) {
        const { turnId } = this.phase;
        this.phase = { kind: "idle" };
        this.emit({
          type: "turn", turnId, state: "failed",
          error: "The observer lost Herdr and could not reconcile the in-flight turn; the agent may still be running in the terminal",
        });
      }
      // Otherwise keep the turn open and let a status/transcript re-read settle it.
    }
  }

  /** Record an interrupt request (P2B); no repeated keys. Also valid on an uncertain reservation, whose turn may
   *  have started without an observation yet: the interrupt stays armed through the eventual acceptance. */
  interruptRequested(): void {
    if (this.phase.kind !== "active" && this.phase.kind !== "ending" &&
        !(this.phase.kind === "pending" && this.phase.responseReported)) return;
    this.interruptedAt = this.now();
    this.interruptNoticed = false;
    this.earlyAbort = null;
    this.tickInterrupt(this.now());
  }

  /**
   * A Stop was sent for an accepted Paseo turn whose user entry never reached the transcript, and Herdr reports the
   * agent not working: the harness aborted the turn before recording it, so no native end will ever arrive. After the
   * interrupt has had `earlyAbortMinAfterInterruptMs` to take effect and two consecutive such observations span
   * `earlyAbortSettleMs`, cancel the turn exactly once. Returns "canceled" when it ended the turn, "watching" while the
   * evidence is accumulating (the caller should observe again after the settle window), otherwise "none".
   */
  observeEarlyAbort(input: { status: AgentStatus; entryMissing: boolean }, message: string): "none" | "watching" | "canceled" {
    if (this.phase.kind !== "active" || this.phase.origin !== "paseo" || this.interruptedAt === null ||
        !input.entryMissing || (input.status !== "idle" && input.status !== "done")) {
      this.earlyAbort = null;
      return "none";
    }
    const now = this.now();
    if (now - this.interruptedAt < this.thresholds.earlyAbortMinAfterInterruptMs) { this.earlyAbort = null; return "watching"; }
    if (!this.earlyAbort) { this.earlyAbort = { since: now, count: 1 }; return "watching"; }
    this.earlyAbort.count++;
    if (this.earlyAbort.count < 2 || now - this.earlyAbort.since < this.thresholds.earlyAbortSettleMs) return "watching";
    const { turnId } = this.phase;
    this.phase = { kind: "idle" };
    this.interruptedAt = null;
    this.interruptNoticed = false;
    this.earlyAbort = null;
    this.emit({ type: "turn", turnId, state: "canceled", error: message });
    return "canceled";
  }

  private tickInterrupt(now: number): void {
    if (this.interruptedAt === null || this.interruptNoticed) return;
    if (now - this.interruptedAt >= this.thresholds.interruptPendingMs) {
      this.interruptNoticed = true;
      this.emit({
        type: "notice",
        id: "interrupt-pending",
        severity: "warning",
        title: "Interrupt has not ended the turn",
        description: "The agent may be between input and response; check the attached terminal.",
      });
    }
  }

  /**
   * Earliest time at which a fresh observation could resolve pending state: an idle-held turn settle boundary
   * (with or without observed activity), an uncertain reservation's continuous-idle settle, or an interrupt that
   * has waited long enough for its warning. Null when nothing is time-sensitive. The session arms one reconcile
   * timer for it, so a settle fires on the boundary instead of waiting for the poll interval.
   */
  get nextDeadline(): number | null {
    let deadline: number | null = null;
    const consider = (candidate: number) => { if (deadline === null || candidate < deadline) deadline = candidate; };
    if (this.phase.kind === "active" && this.idleSince !== null) {
      const active = this.phase.activitySeen || this.lastSeq > this.phase.startSeq;
      consider(this.idleSince + (active ? this.thresholds.idleSettleMs : this.thresholds.noActivitySettleMs));
    } else if (this.phase.kind === "pending" && this.phase.responseReported && this.phase.uncertainIdleSince !== null) {
      consider(this.phase.uncertainIdleSince + this.thresholds.uncertainSettleMs);
    }
    if (this.mode === "status" && this.unknownSince !== null && this.turnAwaitsEvidence) {
      consider(this.unknownSince + this.thresholds.unknownBindingLossMs);
    }
    if (this.interruptedAt !== null && !this.interruptNoticed) consider(this.interruptedAt + this.thresholds.interruptPendingMs);
    return deadline;
  }

  /** Detach: drop state without emitting a terminal event (daemon discarded the session). */
  close(): void {
    this.phase = { kind: "idle" };
    this.interruptedAt = null;
    this.disconnectedSince = null;
    this.unknownSince = null;
    this.idleSince = null;
  }

  private emit(effect: TurnEffect): void {
    if (effect.type === "notice" && effect.id === "blocked") {
      this.lastWasBlocked = effect.dismissed ? false : true;
    }
    this.onEffect(effect);
  }
}
