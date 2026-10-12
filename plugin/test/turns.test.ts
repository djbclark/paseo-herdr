import { describe, expect, it } from "vitest";
import { TurnTracker, type TurnEffect, type TurnTrackerThresholds } from "../server/turns.js";

function makeTracker(options: { thresholds?: Partial<TurnTrackerThresholds> } = {}) {
  const effects: TurnEffect[] = [];
  let clock = 0;
  const now = () => clock;
  const tracker = new TurnTracker({
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
    expect(effects.slice(0, 2)).toEqual([
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

  it("settles uncertain delivery only after native idle holds past the window", () => {
    const { tracker, effects, advance } = makeTracker({ thresholds: { uncertainSettleMs: 15_000 } });
    tracker.reservePending({ turnId: "t1", clientMessageId: "m1" });
    tracker.pendingUncertain();
    advance(10_000);
    expect(tracker.settleUncertain({ nativeIdle: true, foreignUserEntry: false })).toBe(false);
    advance(5_000);
    expect(tracker.settleUncertain({ nativeIdle: false, foreignUserEntry: false })).toBe(false);
    expect(tracker.isPending).toBe(true);
    expect(tracker.settleUncertain({ nativeIdle: true, foreignUserEntry: false })).toBe(true);
    expect(turnEvents(effects)).toEqual([
      { type: "turn", turnId: "t1", state: "started" },
      { type: "turn", turnId: "t1", state: "failed", error: expect.stringContaining("was not resent") },
    ]);
    expect(promptResults(effects)).toEqual([{ type: "prompt_uncertain", clientMessageId: "m1", turnId: "t1" }]);
    expect(tracker.activeTurn).toBeNull();
    expect(tracker.isUncertain).toBe(false);
    tracker.reservePending({ turnId: "t2", clientMessageId: "m2" });
    expect(tracker.activeTurn).toBe("t2");
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
});
