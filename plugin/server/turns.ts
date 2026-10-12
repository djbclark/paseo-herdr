import type { NativeTurnEnd } from "./harness/types.js";
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
 *   pending submission is reserved reconciles against that submission rather
 *   than starting a duplicate.
 * - A prompt result is emitted once: acceptance reports its reserved turn,
 *   uncertain delivery reports the reservation without claiming acceptance.
 * - A turn ends only after the adapter reports a known `NativeTurnEnd` from a final
 *   transcript re-read following `idle`/`done`; status alone never proves
 *   completion (an interrupt can race natural completion).
 * - Observer disconnection is separate from native failure; `unknown` is
 *   transient until it persists past a threshold.
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
}

export const DEFAULT_TURN_THRESHOLDS: TurnTrackerThresholds = {
  unknownBindingLossMs: 30_000,
  reconnectGiveUpMs: 60_000,
  interruptPendingMs: 10_000,
  uncertainSettleMs: 15_000,
};

export type TurnEffect =
  | { type: "turn"; turnId: string; state: "started" | "completed" | "failed" | "canceled"; error?: string }
  | { type: "prompt_accepted"; clientMessageId: string; turnId: string }
  | { type: "prompt_failed"; clientMessageId: string; message: string }
  | { type: "prompt_uncertain"; clientMessageId: string; turnId: string }
  | { type: "notice"; id: string; severity: "info" | "warning" | "error"; title: string; description?: string; dismissed?: boolean };

type Phase =
  | { kind: "idle" }
  | { kind: "pending"; turnId: string; clientMessageId: string; since: number; responseReported: boolean; uncertainSince: number | null }
  | { kind: "active"; turnId: string; origin: TurnOrigin; since: number }
  | { kind: "ending"; turnId: string; origin: TurnOrigin };

export interface PendingSubmission {
  turnId: string;
  clientMessageId: string;
}

export class TurnTracker {
  private phase: Phase = { kind: "idle" };
  private lastStatus: AgentStatus = "unknown";
  private unknownSince: number | null = null;
  private disconnectedSince: number | null = null;
  private interruptedAt: number | null = null;
  private interruptNoticed = false;
  private readonly now: () => number;
  private readonly thresholds: TurnTrackerThresholds;
  private readonly onEffect: (effect: TurnEffect) => void;

  constructor(options: {
    now?: () => number;
    thresholds?: Partial<TurnTrackerThresholds>;
    onEffect: (effect: TurnEffect) => void;
  }) {
    this.now = options.now ?? Date.now;
    this.thresholds = { ...DEFAULT_TURN_THRESHOLDS, ...options.thresholds };
    this.onEffect = options.onEffect;
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
    this.phase = { kind: "pending", turnId: submission.turnId, clientMessageId: submission.clientMessageId, since: this.now(), responseReported: false, uncertainSince: null };
  }

  /** `agent.prompt` was accepted; the pending submission becomes an active Paseo turn. */
  acceptPending(): void {
    if (this.phase.kind !== "pending") return;
    const { turnId, clientMessageId, responseReported } = this.phase;
    this.phase = { kind: "active", turnId, origin: "paseo", since: this.now() };
    if (!responseReported) this.emit({ type: "prompt_accepted", clientMessageId, turnId });
    this.emit({ type: "turn", turnId, state: "started" });
  }

  /** A definite rejection reports failure, or ends the turn if uncertainty was already reported. */
  rejectPending(message: string): void {
    if (this.phase.kind !== "pending") return;
    if (this.phase.responseReported) {
      this.bindingLost(message);
      return;
    }
    const { clientMessageId } = this.phase;
    this.phase = { kind: "idle" };
    this.emit({ type: "prompt_failed", clientMessageId, message });
  }

  /**
   * `agent.prompt` delivery is uncertain (stall/timeout). Keep the pending
   * submission so a later `working`/transcript observation can reconcile, but
   * do not claim rejection and never auto-resubmit.
   */
  pendingUncertain(): void {
    if (this.phase.kind !== "pending" || this.phase.responseReported) return;
    this.phase.responseReported = true;
    this.phase.uncertainSince = this.now();
    this.emit({ type: "prompt_uncertain", clientMessageId: this.phase.clientMessageId, turnId: this.phase.turnId });
  }

  /** Uncertain delivery is reported and not yet settled by the transcript. */
  get isUncertain(): boolean {
    return this.phase.kind === "pending" && this.phase.responseReported;
  }

  /**
   * Settle an uncertain reservation as not delivered. Only transcript evidence counts:
   * a foreign user entry proves the agent moved on; native idle held past the settle
   * window proves our entry never landed. Status alone never settles.
   */
  settleUncertain(evidence: { nativeIdle: boolean; foreignUserEntry: boolean }): boolean {
    if (this.phase.kind !== "pending" || !this.phase.responseReported) return false;
    const { turnId, uncertainSince } = this.phase;
    const idleLongEnough = evidence.nativeIdle && uncertainSince !== null &&
      this.now() - uncertainSince >= this.thresholds.uncertainSettleMs;
    if (!evidence.foreignUserEntry && !idleLongEnough) return false;
    this.phase = { kind: "idle" };
    this.emit({ type: "turn", turnId, state: "started" });
    this.emit({ type: "turn", turnId, state: "failed",
      error: "The prompt did not reach the agent (no matching entry appeared in the native transcript). It was not resent." });
    return true;
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
        // Reconcile a `working` event that raced the prompt response. An uncertain
        // reservation is settled only by its transcript entry, never by status.
        if (!this.phase.responseReported) this.acceptPending();
      } else if (this.phase.kind === "idle") {
        const turnId = `turn-${now}-${Math.random().toString(36).slice(2, 8)}`;
        this.phase = { kind: "active", turnId, origin: "terminal", since: now };
        this.emit({ type: "turn", turnId, state: "started" });
      }
    }

    if (status === "blocked") {
      // Once per entry into blocked; re-observing the same state must not spam the timeline.
      if (!this.lastWasBlocked) this.emit({
        type: "notice",
        id: "blocked",
        severity: "warning",
        title: "Needs approval in the terminal",
      });
    } else if (this.lastWasBlocked) {
      this.emit({ type: "notice", id: "blocked", severity: "warning", title: "Needs approval in the terminal", dismissed: true });
    }

    if (status === "idle" || status === "done") {
      this.tickInterrupt(now);
    }
    // Re-check an in-flight interrupt on every observation, not only idle/done.
    this.tickInterrupt(now);
  }

  private lastWasBlocked = false;

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

  /** Record an interrupt request (P2B); no repeated keys. */
  interruptRequested(): void {
    if (this.phase.kind !== "active" && this.phase.kind !== "ending") return;
    this.interruptedAt = this.now();
    this.interruptNoticed = false;
    this.tickInterrupt(this.now());
  }

  private tickInterrupt(now: number): void {
    if (this.interruptedAt === null || this.interruptNoticed) return;
    if (now - this.interruptedAt > this.thresholds.interruptPendingMs) {
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

  /** Detach: drop state without emitting a terminal event (daemon discarded the session). */
  close(): void {
    this.phase = { kind: "idle" };
    this.interruptedAt = null;
    this.disconnectedSince = null;
    this.unknownSince = null;
  }

  private emit(effect: TurnEffect): void {
    if (effect.type === "notice" && effect.id === "blocked") {
      this.lastWasBlocked = effect.dismissed ? false : true;
    }
    this.onEffect(effect);
  }
}
