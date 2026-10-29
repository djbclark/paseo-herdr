import { describe, expect, it } from "vitest";
import type { TurnEvidence } from "../server/harness/types.js";
import { TurnTracker, type TurnEffect, type TurnTrackerThresholds } from "../server/turns.js";

function makeTracker(options: { thresholds?: Partial<TurnTrackerThresholds>; mode?: TurnEvidence } = {}) {
  const effects: TurnEffect[] = [];
  let clock = 0;
  const now = () => clock;
  const tracker = new TurnTracker({
    mode: options.mode,
    now,
    thresholds: options.thresholds,
    onEffect: (effect) => effects.push(effect),
  });
  return { tracker, effects, now, advance: (ms: number) => { clock += ms; } };
}

const turnEvents = (effects: TurnEffect[]) =>
  effects.filter((effect): effect is Extract<TurnEffect, { type: "turn" }> => effect.type === "turn");

const promptResults = (effects: TurnEffect[]) =>
  effects.filter((effect): effect is Extract<TurnEffect, { type: "prompt_accepted" | "prompt_failed" | "prompt_uncertain" }> =>
    effect.type === "prompt_accepted" || effect.type === "prompt_failed" || effect.type === "prompt_uncertain");

describe("TurnTracker", () => {
  it("starts and completes a Paseo turn from reservation through native end", () => {
    const { tracker, effects } = makeTracker();
    tracker.reservePending({ turnId: "t1", clientMessageId: "m1" });
    expect(tracker.isPending).toBe(true);
    tracker.acceptPending();
    expect(effects).toEqual([
      { type: "prompt_accepted", clientMessageId: "m1", turnId: "t1" },
      { type: "turn", turnId: "t1", state: "started" },
    ]);
    tracker.observeStatus("working");
    tracker.observeStatus("idle");
    tracker.observeNativeTurnEnd("completed");
    expect(turnEvents(effects)).toEqual([
      { type: "turn", turnId: "t1", state: "started" },
      { type: "turn", turnId: "t1", state: "completed" },
    ]);
    expect(tracker.activeTurn).toBeNull();
  });

  it.each([
    ["working", true],
    ["working", false],
    ["blocked", true],
    ["blocked", false],
  ] as const)("reports one acceptance when %s races the response (response first: %s)", (status, responseFirst) => {
    const { tracker, effects } = makeTracker();
    tracker.reservePending({ turnId: "t1", clientMessageId: "m1" });
    if (responseFirst) tracker.acceptPending();
    tracker.observeStatus(status);
    if (!responseFirst) tracker.acceptPending();
    tracker.observeStatus(status);
    tracker.acceptPending();
    tracker.pendingUncertain();
    tracker.rejectPending("A late rejection cannot undo the observed turn");
    // A `blocked` observation raised while delivery was in flight may emit its notice before the acceptance.
    expect(effects.filter((effect) => effect.type !== "notice").slice(0, 2)).toEqual([
      { type: "prompt_accepted", clientMessageId: "m1", turnId: "t1" },
      { type: "turn", turnId: "t1", state: "started" },
    ]);
    expect(promptResults(effects)).toEqual([{ type: "prompt_accepted", clientMessageId: "m1", turnId: "t1" }]);
    expect(turnEvents(effects)).toEqual([{ type: "turn", turnId: "t1", state: "started" }]);
    tracker.observeStatus("idle");
    tracker.observeNativeTurnEnd("completed");
    tracker.acceptPending();
    tracker.pendingUncertain();
    tracker.rejectPending("Response arrived after native completion");
    expect(promptResults(effects)).toHaveLength(1);
    expect(turnEvents(effects)).toEqual([
      { type: "turn", turnId: "t1", state: "started" },
      { type: "turn", turnId: "t1", state: "completed" },
    ]);
  });

  it("starts an autonomous terminal turn on working with no pending submission", () => {
    const { tracker, effects } = makeTracker();
    tracker.observeStatus("working");
    expect(turnEvents(effects)).toEqual([{ type: "turn", turnId: expect.any(String), state: "started" }]);
    expect(tracker.isActive).toBe(true);
    tracker.observeStatus("done");
    tracker.observeNativeTurnEnd("completed");
    expect(turnEvents(effects)).toHaveLength(2);
    expect(promptResults(effects)).toEqual([]);
  });

  it("rejects a pending submission on definite rejection", () => {
    const { tracker, effects } = makeTracker();
    tracker.reservePending({ turnId: "t1", clientMessageId: "m1" });
    tracker.rejectPending("Agent is not idle");
    tracker.rejectPending("Duplicate rejection");
    tracker.acceptPending();
    tracker.pendingUncertain();
    expect(tracker.isPending).toBe(false);
    expect(tracker.activeTurn).toBeNull();
    expect(effects).toEqual([{ type: "prompt_failed", clientMessageId: "m1", message: "Agent is not idle" }]);
  });

  it.each(["working", "blocked"] as const)("does not resolve uncertain delivery from %s status alone", (status) => {
    const { tracker, effects } = makeTracker();
    tracker.reservePending({ turnId: "t1", clientMessageId: "m1" });
    tracker.pendingUncertain();
    tracker.pendingUncertain();
    tracker.observeStatus(status);
    tracker.observeStatus(status);
    expect(tracker.isPending).toBe(true);
    expect(tracker.isUncertain).toBe(true);
    expect(tracker.activeTurn).toBe("t1");
    expect(promptResults(effects)).toEqual([{ type: "prompt_uncertain", clientMessageId: "m1", turnId: "t1" }]);
    expect(turnEvents(effects)).toEqual([]);
  });

  it("reconciles uncertain delivery through the transcript without a second prompt result", () => {
    const { tracker, effects } = makeTracker();
    tracker.reservePending({ turnId: "t1", clientMessageId: "m1" });
    tracker.pendingUncertain();
    tracker.pendingUncertain();
    expect(effects).toEqual([{ type: "prompt_uncertain", clientMessageId: "m1", turnId: "t1" }]);
    tracker.acceptPending();
    tracker.pendingUncertain();
    expect(tracker.isActive).toBe(true);
    expect(tracker.isUncertain).toBe(false);
    expect(promptResults(effects)).toEqual([{ type: "prompt_uncertain", clientMessageId: "m1", turnId: "t1" }]);
    expect(turnEvents(effects)).toEqual([{ type: "turn", turnId: "t1", state: "started" }]);
    tracker.observeStatus("done");
    tracker.observeNativeTurnEnd("completed");
    expect(promptResults(effects)).toHaveLength(1);
    expect(turnEvents(effects)).toEqual([
      { type: "turn", turnId: "t1", state: "started" },
      { type: "turn", turnId: "t1", state: "completed" },
    ]);
  });

  it("settles uncertain delivery only after native idle holds the window from its first observation", () => {
    const { tracker, effects, advance } = makeTracker({ thresholds: { uncertainSettleMs: 15_000 } });
    tracker.reservePending({ turnId: "t1", clientMessageId: "m1" });
    tracker.pendingUncertain();
    advance(10_000);
    // The hold is measured from the first idle observation, not from the uncertainty report.
    expect(tracker.settleUncertain({ nativeIdle: true, foreignUserEntry: false })).toBe(false);
    advance(5_000);
    expect(tracker.settleUncertain({ nativeIdle: false, foreignUserEntry: false })).toBe(false); // hold broken
    expect(tracker.settleUncertain({ nativeIdle: true, foreignUserEntry: false })).toBe(false); // hold restarts
    expect(tracker.isPending).toBe(true);
    advance(15_000);
    expect(tracker.settleUncertain({ nativeIdle: true, foreignUserEntry: false })).toBe(true);
    expect(turnEvents(effects)).toEqual([
      { type: "turn", turnId: "t1", state: "started" },
      { type: "turn", turnId: "t1", state: "failed",
        error: "Paseo could not confirm the prompt reached the agent; it was not resent. Check the terminal." },
    ]);
    expect(promptResults(effects)).toEqual([{ type: "prompt_uncertain", clientMessageId: "m1", turnId: "t1" }]);
    expect(tracker.activeTurn).toBeNull();
    expect(tracker.isUncertain).toBe(false);
    tracker.reservePending({ turnId: "t2", clientMessageId: "m2" });
    expect(tracker.activeTurn).toBe("t2");
  });

  it("does not settle on the first idle observation after a long turn (F6)", () => {
    const { tracker, effects, advance } = makeTracker({ thresholds: { uncertainSettleMs: 15_000 } });
    tracker.reservePending({ turnId: "t1", clientMessageId: "m1" });
    tracker.pendingUncertain();
    // The delivery landed and the agent worked past the whole settle window without a transcript match.
    advance(16_000);
    expect(tracker.settleUncertain({ nativeIdle: true, foreignUserEntry: false })).toBe(false);
    expect(tracker.isPending).toBe(true);
    expect(turnEvents(effects)).toEqual([]);
  });

  it("settles uncertain delivery immediately when a foreign user entry appears", () => {
    const { tracker, effects } = makeTracker();
    tracker.reservePending({ turnId: "t1", clientMessageId: "m1" });
    tracker.pendingUncertain();
    expect(tracker.settleUncertain({ nativeIdle: false, foreignUserEntry: true })).toBe(true);
    expect(tracker.activeTurn).toBeNull();
    expect(turnEvents(effects).at(-1)).toMatchObject({ turnId: "t1", state: "failed" });
  });

  it("does not settle a reservation that was never reported uncertain", () => {
    const { tracker, effects } = makeTracker();
    tracker.reservePending({ turnId: "t1", clientMessageId: "m1" });
    expect(tracker.settleUncertain({ nativeIdle: true, foreignUserEntry: true })).toBe(false);
    expect(tracker.isPending).toBe(true);
    expect(effects).toEqual([]);
  });

  it("reports only prompt failure if the binding is lost before uncertainty", () => {
    const { tracker, effects } = makeTracker();
    tracker.reservePending({ turnId: "t1", clientMessageId: "m1" });
    tracker.bindingLost("The bound agent is gone");
    tracker.bindingLost("Duplicate binding loss");
    tracker.acceptPending();
    tracker.pendingUncertain();
    expect(effects).toEqual([{ type: "prompt_failed", clientMessageId: "m1", message: "The bound agent is gone" }]);
    expect(tracker.activeTurn).toBeNull();
  });

  it.each(["binding loss", "late rejection"] as const)("ends an uncertain reservation after %s without contradicting its prompt result", (failure) => {
    const { tracker, effects } = makeTracker();
    tracker.reservePending({ turnId: "t1", clientMessageId: "m1" });
    tracker.pendingUncertain();
    if (failure === "binding loss") tracker.bindingLost("The bound agent is gone");
    else tracker.rejectPending("The bound agent is gone");
    tracker.bindingLost("Duplicate binding loss");
    tracker.rejectPending("Duplicate rejection");
    tracker.acceptPending();
    tracker.pendingUncertain();
    tracker.observeNativeTurnEnd("completed");
    expect(effects).toEqual([
      { type: "prompt_uncertain", clientMessageId: "m1", turnId: "t1" },
      { type: "turn", turnId: "t1", state: "started" },
      { type: "turn", turnId: "t1", state: "failed", error: "The bound agent is gone" },
    ]);
    expect(promptResults(effects)).toHaveLength(1);
    expect(tracker.activeTurn).toBeNull();
  });

  it("tracks prompt reporting independently for each reservation", () => {
    const { tracker, effects } = makeTracker();
    tracker.reservePending({ turnId: "t1", clientMessageId: "m1" });
    tracker.pendingUncertain();
    tracker.bindingLost("The bound agent is gone");
    tracker.reservePending({ turnId: "t2", clientMessageId: "m2" });
    tracker.acceptPending();
    tracker.acceptPending();
    expect(promptResults(effects)).toEqual([
      { type: "prompt_uncertain", clientMessageId: "m1", turnId: "t1" },
      { type: "prompt_accepted", clientMessageId: "m2", turnId: "t2" },
    ]);
    expect(turnEvents(effects).at(-1)).toEqual({ type: "turn", turnId: "t2", state: "started" });
  });

  it("maps aborted → canceled and error → failed from native end", () => {
    for (const [end, state] of [["aborted", "canceled"], ["error", "failed"], ["completed", "completed"]] as const) {
      const { tracker, effects } = makeTracker();
      tracker.observeStatus("working");
      tracker.observeStatus("idle");
      tracker.observeNativeTurnEnd(end);
      tracker.observeNativeTurnEnd(end);
      expect(turnEvents(effects)).toEqual([
        { type: "turn", turnId: expect.any(String), state: "started" },
        { type: "turn", turnId: expect.any(String), state },
      ]);
      expect(tracker.activeTurn).toBeNull();
    }
  });

  it.each(["paseo", "terminal"] as const)("does not fabricate completion for a %s turn from idle/done or an unknown native outcome", (origin) => {
    const { tracker, effects } = makeTracker();
    if (origin === "paseo") {
      tracker.reservePending({ turnId: "t1", clientMessageId: "m1" });
      tracker.acceptPending();
    } else {
      tracker.observeStatus("working");
    }
    const turnId = tracker.activeTurn;
    tracker.observeStatus("idle");
    tracker.observeStatus("done");
    tracker.observeNativeTurnEnd("unknown");
    tracker.observeStatus("idle");
    tracker.observeNativeTurnEnd("unknown");
    expect(turnEvents(effects)).toEqual([{ type: "turn", turnId, state: "started" }]);
    expect(tracker.activeTurn).toBe(turnId);
    expect(tracker.isActive).toBe(true);
    tracker.observeNativeTurnEnd("aborted");
    expect(turnEvents(effects)).toEqual([
      { type: "turn", turnId, state: "started" },
      { type: "turn", turnId, state: "canceled" },
    ]);
    expect(tracker.activeTurn).toBeNull();
  });

  it.each(["idle", "pending", "uncertain"] as const)("does not fabricate a turn from native outcomes while %s", (phase) => {
    const { tracker, effects } = makeTracker();
    if (phase !== "idle") tracker.reservePending({ turnId: "t1", clientMessageId: "m1" });
    if (phase === "uncertain") tracker.pendingUncertain();
    const before = [...effects];
    for (const end of ["completed", "aborted", "error", "unknown"] as const) tracker.observeNativeTurnEnd(end);
    expect(effects).toEqual(before);
    expect(tracker.isActive).toBe(false);
    expect(tracker.isPending).toBe(phase !== "idle");
    expect(tracker.activeTurn).toBe(phase === "idle" ? null : "t1");
  });

  it("preserves an in-flight interrupt when the native outcome is unknown", () => {
    const { tracker, effects, advance } = makeTracker({ thresholds: { interruptPendingMs: 10_000 } });
    tracker.reservePending({ turnId: "t1", clientMessageId: "m1" });
    tracker.acceptPending();
    tracker.interruptRequested();
    tracker.observeStatus("idle");
    tracker.observeNativeTurnEnd("unknown");
    advance(11_000);
    tracker.observeStatus("idle");
    expect(turnEvents(effects)).toEqual([{ type: "turn", turnId: "t1", state: "started" }]);
    expect(effects.filter((effect) => effect.type === "notice" && effect.id === "interrupt-pending")).toHaveLength(1);
  });

  it("emits a blocked notice on blocked and dismisses it on leaving blocked", () => {
    const { tracker, effects } = makeTracker();
    tracker.observeStatus("working");
    tracker.observeStatus("blocked");
    expect(effects.some((e) => e.type === "notice" && e.id === "blocked" && !e.dismissed)).toBe(true);
    tracker.observeStatus("working");
    expect(effects.some((e) => e.type === "notice" && e.id === "blocked" && e.dismissed)).toBe(true);
  });

  it("emits the blocked notice once per entry into blocked, not on every observation", () => {
    const { tracker, effects } = makeTracker();
    for (let i = 0; i < 5; i++) tracker.observeStatus("blocked");
    expect(effects.filter((e) => e.type === "notice" && e.id === "blocked")).toEqual([
      { type: "notice", id: "blocked", severity: "warning", title: "Needs approval in the terminal" },
    ]);
  });

  it("re-emits the blocked notice after leaving and re-entering blocked, with one dismissal between", () => {
    const { tracker, effects } = makeTracker();
    tracker.observeStatus("blocked");
    tracker.observeStatus("blocked");
    tracker.observeStatus("working");
    tracker.observeStatus("working");
    tracker.observeStatus("blocked");
    tracker.observeStatus("blocked");
    const blocked = effects.filter((e) => e.type === "notice" && e.id === "blocked");
    expect(blocked.map((e) => e.type === "notice" && e.dismissed === true)).toEqual([false, true, false]);
    expect(blocked.filter((e) => e.type === "notice" && !e.dismissed)).toHaveLength(2);
  });

  it("treats unknown as transient until it persists past the threshold", () => {
    const { tracker, effects, advance } = makeTracker({ thresholds: { unknownBindingLossMs: 30_000 } });
    tracker.observeStatus("working");
    tracker.observeStatus("unknown");
    advance(10_000);
    tracker.observeStatus("unknown");
    expect(turnEvents(effects)).toHaveLength(1); // still just the started turn
    advance(21_000);
    tracker.observeStatus("unknown");
    expect(turnEvents(effects).at(-1)).toMatchObject({ state: "failed" });
  });

  it("keeps a turn open across disconnect and reconcile, but fails after the give-up window", () => {
    const { tracker, effects, advance } = makeTracker({ thresholds: { reconnectGiveUpMs: 60_000 } });
    tracker.observeStatus("working");
    tracker.observeConnectivityLost();
    expect(effects.some((e) => e.type === "notice" && e.id === "connectivity" && !e.dismissed)).toBe(true);
    advance(10_000);
    tracker.observeConnectivityRestored();
    expect(turnEvents(effects)).toHaveLength(1); // turn still open
    // A new disconnect of the same open turn lasts too long.
    tracker.observeStatus("working");
    tracker.observeConnectivityLost();
    advance(61_000);
    tracker.observeConnectivityRestored();
    expect(turnEvents(effects).at(-1)?.state).toBe("failed");
  });

  it("emits the connectivity notice once per loss, not on every failed reconcile", () => {
    const { tracker, effects } = makeTracker();
    tracker.observeConnectivityLost();
    tracker.observeConnectivityLost();
    tracker.observeConnectivityLost();
    expect(effects.filter((e) => e.type === "notice" && e.id === "connectivity")).toHaveLength(1);
  });

  it("emits a new connectivity notice for each loss after a restore", () => {
    const { tracker, effects } = makeTracker();
    tracker.observeConnectivityLost();
    tracker.observeConnectivityRestored();
    tracker.observeConnectivityLost();
    const notices = effects.filter((e) => e.type === "notice" && e.id === "connectivity");
    expect(notices.map((e) => e.type === "notice" && e.dismissed === true)).toEqual([false, true, false]);
  });

  it("preserves the first disconnect timestamp across repeated connectivity-loss observations", () => {
    const { tracker, effects, advance } = makeTracker({ thresholds: { reconnectGiveUpMs: 60_000 } });
    tracker.reservePending({ turnId: "t1", clientMessageId: "m1" });
    tracker.acceptPending();
    tracker.observeConnectivityLost();
    advance(40_000);
    tracker.observeConnectivityLost();
    advance(21_000);
    tracker.observeConnectivityRestored();
    expect(turnEvents(effects)).toEqual([
      { type: "turn", turnId: "t1", state: "started" },
      {
        type: "turn", turnId: "t1", state: "failed",
        error: "The observer lost Herdr and could not reconcile the in-flight turn; the agent may still be running in the terminal",
      },
    ]);
    expect(tracker.activeTurn).toBeNull();
    const before = [...effects];
    tracker.observeConnectivityRestored();
    expect(effects).toEqual(before);
  });

  it("fails an active turn with a binding-loss message on binding loss", () => {
    const { tracker, effects } = makeTracker();
    tracker.observeStatus("working");
    tracker.bindingLost("The bound agent is gone");
    expect(turnEvents(effects).at(-1)).toEqual({
      type: "turn", turnId: expect.any(String), state: "failed",
      error: "The bound agent is gone",
    });
  });

  it("emits an interrupt-pending warning without repeated keys", () => {
    const { tracker, effects, advance } = makeTracker({ thresholds: { interruptPendingMs: 10_000 } });
    tracker.observeStatus("working");
    tracker.interruptRequested();
    advance(11_000);
    tracker.observeStatus("working");
    expect(effects.filter((e) => e.type === "notice" && e.id === "interrupt-pending")).toHaveLength(1);
    advance(20_000);
    tracker.observeStatus("working");
    expect(effects.filter((e) => e.type === "notice" && e.id === "interrupt-pending")).toHaveLength(1);
  });

  it.each(["terminal", "pending", "uncertain", "accepted"] as const)("close drops a %s turn without emitting a result or terminal event", (phase) => {
    const { tracker, effects } = makeTracker();
    if (phase === "terminal") tracker.observeStatus("working");
    else tracker.reservePending({ turnId: "t1", clientMessageId: "m1" });
    if (phase === "uncertain") tracker.pendingUncertain();
    if (phase === "accepted") tracker.acceptPending();
    const before = [...effects];
    tracker.close();
    tracker.acceptPending();
    tracker.pendingUncertain();
    tracker.rejectPending("Response arrived after close");
    tracker.bindingLost("Binding disappeared after close");
    tracker.observeNativeTurnEnd("completed");
    expect(effects).toEqual(before);
    expect(tracker.activeTurn).toBeNull();
  });

  it("a rejection can skip the synthesized terminal turn (SC fold-in F2)", () => {
    const plain = makeTracker();
    plain.tracker.reservePending({ turnId: "t1", clientMessageId: "m1" });
    plain.tracker.observeStatus("working");
    plain.tracker.rejectPending("Agent is busy");
    expect(plain.effects.filter((effect) => effect.type !== "notice")).toEqual([
      { type: "prompt_failed", clientMessageId: "m1", message: "Agent is busy" },
      { type: "turn", turnId: expect.any(String), state: "started" },
    ]);
    const quiet = makeTracker();
    quiet.tracker.reservePending({ turnId: "t1", clientMessageId: "m1" });
    quiet.tracker.observeStatus("working");
    quiet.tracker.rejectPending("Agent is busy", { startTerminalTurn: false });
    expect(quiet.effects).toEqual([{ type: "prompt_failed", clientMessageId: "m1", message: "Agent is busy" }]);
    expect(quiet.tracker.activeTurn).toBeNull();
    expect(quiet.tracker.isPending).toBe(false);
  });

  it("cancelUncertain ends an uncertain reservation as canceled exactly once", () => {
    const { tracker, effects } = makeTracker();
    tracker.reservePending({ turnId: "t1", clientMessageId: "m1" });
    expect(tracker.cancelUncertain("Stopped before delivery was confirmed")).toBe(false);
    tracker.pendingUncertain();
    expect(tracker.cancelUncertain("Stopped. Paseo could not confirm delivery; nothing was resent.")).toBe(true);
    expect(turnEvents(effects)).toEqual([
      { type: "turn", turnId: "t1", state: "started" },
      { type: "turn", turnId: "t1", state: "canceled", error: "Stopped. Paseo could not confirm delivery; nothing was resent." },
    ]);
    expect(tracker.cancelUncertain("Second Stop")).toBe(false);
    expect(tracker.activeTurn).toBeNull();
    tracker.reservePending({ turnId: "t2", clientMessageId: "m2" });
    expect(tracker.activeTurn).toBe("t2");
  });

  it("an uncertain prompt result carries the adapter's message when given", () => {
    const { tracker, effects } = makeTracker();
    tracker.reservePending({ turnId: "t1", clientMessageId: "m1" });
    tracker.pendingUncertain("the companion did not answer");
    expect(promptResults(effects)).toEqual([
      { type: "prompt_uncertain", clientMessageId: "m1", turnId: "t1", message: "the companion did not answer" },
    ]);
    const bare = makeTracker();
    bare.tracker.reservePending({ turnId: "t2", clientMessageId: "m2" });
    bare.tracker.pendingUncertain();
    expect(promptResults(bare.effects)).toEqual([{ type: "prompt_uncertain", clientMessageId: "m2", turnId: "t2" }]);
  });
});

describe("TurnTracker (status evidence)", () => {
  const reserve = (tracker: TurnTracker, turnId = "t1") =>
    tracker.reservePending({ turnId, clientMessageId: `m-${turnId}`, baseline: { stateChangeSeq: 0, completionSeq: null } });
  const evidence = (status: Parameters<TurnTracker["observeStatusEvidence"]>[0]["status"], stateChangeSeq = 0, completionSeq: number | null = null) =>
    ({ status, stateChangeSeq, completionSeq });

  it("ends an accepted turn only after idle holds the settle window (2.9 s no, 3.0 s yes)", () => {
    const { tracker, effects, advance } = makeTracker({ mode: "status", thresholds: { idleSettleMs: 3_000, noActivitySettleMs: 15_000 } });
    reserve(tracker);
    tracker.acceptPending();
    tracker.observeStatusEvidence(evidence("working", 1));
    tracker.observeStatusEvidence(evidence("idle", 1));
    advance(2_900);
    tracker.observeStatusEvidence(evidence("idle", 1));
    expect(turnEvents(effects)).toEqual([{ type: "turn", turnId: "t1", state: "started" }]);
    advance(100);
    tracker.observeStatusEvidence(evidence("idle", 1));
    expect(turnEvents(effects)).toEqual([
      { type: "turn", turnId: "t1", state: "started" },
      { type: "turn", turnId: "t1", state: "completed" },
    ]);
    expect(effects.filter((effect) => effect.type === "notice")).toEqual([]);
  });

  it("restarts the idle clock when work interrupts the hold", () => {
    const { tracker, effects, advance } = makeTracker({ mode: "status", thresholds: { idleSettleMs: 3_000, noActivitySettleMs: 15_000 } });
    reserve(tracker);
    tracker.acceptPending();
    tracker.observeStatusEvidence(evidence("idle", 1));   // hold starts
    advance(2_000);
    tracker.observeStatusEvidence(evidence("working", 1)); // hold broken
    advance(500);
    tracker.observeStatusEvidence(evidence("idle", 1));    // hold restarts
    advance(2_900);
    tracker.observeStatusEvidence(evidence("idle", 1));
    expect(turnEvents(effects)).toHaveLength(1);
    advance(100);
    tracker.observeStatusEvidence(evidence("idle", 1));
    expect(turnEvents(effects)).toHaveLength(2);
  });

  it("ends at once when completionSeq advanced at the first idle poll (a turn that finished between polls)", () => {
    const { tracker, effects } = makeTracker({ mode: "status" });
    tracker.reservePending({ turnId: "t1", clientMessageId: "m1", baseline: { stateChangeSeq: 4, completionSeq: 2 } });
    tracker.acceptPending();
    tracker.observeStatusEvidence(evidence("done", 4, 3));
    expect(turnEvents(effects)).toEqual([
      { type: "turn", turnId: "t1", state: "started" },
      { type: "turn", turnId: "t1", state: "completed" },
    ]);
  });

  it("a stateChangeSeq advance alone settles on the short window, with no notice", () => {
    const { tracker, effects, advance } = makeTracker({ mode: "status", thresholds: { idleSettleMs: 3_000, noActivitySettleMs: 15_000 } });
    tracker.reservePending({ turnId: "t1", clientMessageId: "m1", baseline: { stateChangeSeq: 5, completionSeq: null } });
    tracker.acceptPending();
    tracker.observeStatusEvidence(evidence("idle", 6));
    advance(3_000);
    tracker.observeStatusEvidence(evidence("idle", 6));
    expect(turnEvents(effects)).toEqual([
      { type: "turn", turnId: "t1", state: "started" },
      { type: "turn", turnId: "t1", state: "completed" },
    ]);
    expect(effects.filter((effect) => effect.type === "notice" && effect.id === "no-activity")).toEqual([]);
  });

  it("with no evidence at all, settles on the long window with an info notice", () => {
    const { tracker, effects, advance } = makeTracker({ mode: "status", thresholds: { idleSettleMs: 3_000, noActivitySettleMs: 15_000 } });
    tracker.reservePending({ turnId: "t1", clientMessageId: "m1", baseline: { stateChangeSeq: 5, completionSeq: null } });
    tracker.acceptPending();
    tracker.observeStatusEvidence(evidence("idle", 5));
    advance(14_900);
    tracker.observeStatusEvidence(evidence("idle", 5));
    expect(turnEvents(effects)).toHaveLength(1);
    advance(100);
    tracker.observeStatusEvidence(evidence("idle", 5));
    expect(turnEvents(effects)).toEqual([
      { type: "turn", turnId: "t1", state: "started" },
      { type: "turn", turnId: "t1", state: "completed" },
    ]);
    expect(effects.filter((effect) => effect.type === "notice")).toEqual([
      { type: "notice", id: "no-activity", severity: "info", title: "Turn ended with no activity observed",
        description: expect.stringContaining("no state change") },
    ]);
  });

  it("a terminal-originated turn uses the same end rules", () => {
    const { tracker, effects, advance } = makeTracker({ mode: "status", thresholds: { idleSettleMs: 3_000, noActivitySettleMs: 15_000 } });
    tracker.observeStatusEvidence(evidence("working", 3));
    expect(turnEvents(effects)).toEqual([{ type: "turn", turnId: expect.any(String), state: "started" }]);
    tracker.observeStatusEvidence(evidence("idle", 4));
    advance(3_000);
    tracker.observeStatusEvidence(evidence("idle", 4));
    expect(turnEvents(effects)).toEqual([
      { type: "turn", turnId: expect.any(String), state: "started" },
      { type: "turn", turnId: expect.any(String), state: "completed" },
    ]);
    expect(promptResults(effects)).toEqual([]);
  });

  it("accepts an uncertain reservation when the pane shows work", () => {
    const { tracker, effects } = makeTracker({ mode: "status" });
    reserve(tracker);
    tracker.pendingUncertain();
    tracker.observeStatusEvidence(evidence("working", 1));
    expect(tracker.isActive).toBe(true);
    expect(promptResults(effects)).toEqual([{ type: "prompt_uncertain", clientMessageId: "m-t1", turnId: "t1" }]);
    expect(turnEvents(effects)).toEqual([{ type: "turn", turnId: "t1", state: "started" }]);
  });

  it("accepts an uncertain reservation on a state-change advance alone", () => {
    const { tracker, effects } = makeTracker({ mode: "status" });
    reserve(tracker);
    tracker.observeStatusEvidence(evidence("idle", 0)); // counters observed during delivery
    tracker.pendingUncertain();
    tracker.observeStatusEvidence(evidence("idle", 1)); // the pane moved without a status flip
    expect(tracker.isActive).toBe(true);
    expect(turnEvents(effects)).toEqual([{ type: "turn", turnId: "t1", state: "started" }]);
  });

  it("fails an uncertain reservation only after idle holds the full window", () => {
    const { tracker, effects, advance } = makeTracker({ mode: "status", thresholds: { uncertainSettleMs: 15_000 } });
    reserve(tracker);
    tracker.pendingUncertain();
    tracker.observeStatusEvidence(evidence("idle", 0));
    advance(14_900);
    tracker.observeStatusEvidence(evidence("idle", 0));
    expect(tracker.isUncertain).toBe(true);
    advance(100);
    tracker.observeStatusEvidence(evidence("idle", 0));
    expect(turnEvents(effects)).toEqual([
      { type: "turn", turnId: "t1", state: "started" },
      { type: "turn", turnId: "t1", state: "failed",
        error: "Paseo could not confirm the prompt reached the agent; it was not resent. Check the terminal." },
    ]);
    expect(tracker.activeTurn).toBeNull();
  });

  it("tolerates an unknown status without ending a turn or running the binding-loss clock", () => {
    const { tracker, effects, advance } = makeTracker({ mode: "status", thresholds: { unknownBindingLossMs: 30_000, idleSettleMs: 3_000, noActivitySettleMs: 15_000 } });
    tracker.observeStatusEvidence(evidence("working", 2));
    advance(31_000);
    tracker.observeStatusEvidence(evidence("unknown", 2));
    tracker.observeStatusEvidence(evidence("unknown", 2));
    expect(turnEvents(effects)).toEqual([{ type: "turn", turnId: expect.any(String), state: "started" }]);
    expect(tracker.isActive).toBe(true);
    tracker.observeStatusEvidence(evidence("done", 3, 1));
    expect(turnEvents(effects)).toEqual([
      { type: "turn", turnId: expect.any(String), state: "started" },
      { type: "turn", turnId: expect.any(String), state: "completed" },
    ]);
  });

  it("records an interrupt for an uncertain reservation and keeps it through acceptance", () => {
    const { tracker, effects, advance } = makeTracker({ mode: "status", thresholds: { interruptPendingMs: 10_000 } });
    reserve(tracker);
    tracker.pendingUncertain();
    tracker.interruptRequested(); // valid on pending+reported; no notice yet
    expect(effects.filter((effect) => effect.type === "notice")).toEqual([]);
    tracker.observeStatusEvidence(evidence("working", 1));
    advance(10_500);
    tracker.observeStatusEvidence(evidence("working", 1));
    expect(effects.filter((effect) => effect.type === "notice" && effect.id === "interrupt-pending")).toHaveLength(1);
  });

  it("nextDeadline exposes the earliest settle boundary, and null when nothing is time-sensitive", () => {
    const { tracker, advance } = makeTracker({ mode: "status", thresholds: { idleSettleMs: 3_000, noActivitySettleMs: 15_000, uncertainSettleMs: 15_000 } });
    expect(tracker.nextDeadline).toBeNull();
    tracker.observeStatusEvidence(evidence("idle", 0));
    reserve(tracker);
    tracker.acceptPending();
    expect(tracker.nextDeadline).toBeNull(); // never observed idle while active
    tracker.observeStatusEvidence(evidence("idle", 1)); // activity: seq advanced past the baseline
    expect(tracker.nextDeadline).toBe(3_000);
    advance(3_000);
    tracker.observeStatusEvidence(evidence("idle", 1));
    expect(tracker.activeTurn).toBeNull();
    expect(tracker.nextDeadline).toBeNull();
    tracker.reservePending({ turnId: "t2", clientMessageId: "m2" });
    tracker.pendingUncertain();
    expect(tracker.nextDeadline).toBeNull(); // not idle yet
    tracker.observeStatusEvidence(evidence("idle", 1));
    expect(tracker.nextDeadline).toBe(18_000); // 3_000 + 15_000 held from the first idle observation
  });

  it("observeStatusEvidence is inert in transcript mode", () => {
    const { tracker, effects } = makeTracker();
    tracker.observeStatusEvidence(evidence("working", 5, 9));
    expect(effects).toEqual([]);
    expect(tracker.activeTurn).toBeNull();
  });
});
