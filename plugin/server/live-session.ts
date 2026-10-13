import type { HerdrSubscription, SubscriptionEventEnvelope } from "./herdr/client.js";
import { diffTimeline, hashItem } from "./timeline.js";
import type { HerdrHarnessSession } from "./session.js";
import { ForkWatcher } from "./forks.js";

/** Scheduling only: binding, turn, connectivity and transcript state live in SessionState. */
export class LiveSession {
  private running = false;
  private timer: NodeJS.Timeout | undefined;
  private readerUnsubscribe: (() => void) | null = null;
  private streamController: AbortController | null = null;
  private streamEpoch = 0;
  private queue: Promise<void> = Promise.resolve();
  private readonly forks: ForkWatcher;

  constructor(private readonly session: HerdrHarnessSession) { this.forks = new ForkWatcher(session); }
  start(): void {
    if (this.running || this.session.isAborted) return;
    this.running = true;
    this.readerUnsubscribe = this.session.state.reader?.subscribe(() => { void this.reconcile(); }) ?? null;
    this.subscribePane();
    this.timer = setInterval(() => { void this.reconcile(); }, 2000);
    this.forks.start();
    void this.reconcile();
  }
  stop(): void {
    this.running = false;
    this.streamEpoch++;
    this.streamController?.abort();
    this.streamController = null;
    this.readerUnsubscribe?.();
    this.readerUnsubscribe = null;
    clearInterval(this.timer);
    this.timer = undefined;
    this.forks.stop();
  }
  paneChanged(): void { if (this.running) this.subscribePane(); }

  private subscribePane(): void {
    const session = this.session;
    const paneId = session.state.paneId;
    if (!paneId) return;
    this.streamController?.abort();
    const controller = new AbortController();
    this.streamController = controller;
    const epoch = ++this.streamEpoch;
    const abort = () => controller.abort();
    session.signal.addEventListener("abort", abort, { once: true });
    void (async () => {
      let handle: HerdrSubscription | null = null;
      try {
        handle = await session.deps.subscribe([
          { type: "pane.agent_status_changed", pane_id: paneId },
          { type: "pane.updated" }, { type: "pane.moved" }, { type: "pane.agent_detected" },
        ], { signal: controller.signal });
        if (controller.signal.aborted || epoch !== this.streamEpoch) return;
        for await (const event of handle) {
          if (controller.signal.aborted || epoch !== this.streamEpoch) return;
          await this.onEvent(event, paneId);
        }
      } catch {
        if (!controller.signal.aborted && epoch === this.streamEpoch) this.disconnected();
      } finally {
        handle?.close();
        session.signal.removeEventListener("abort", abort);
      }
    })();
  }

  private disconnected(): void {
    if (this.session.isAborted || this.session.state.outcome !== "active") return;
    this.session.state.connected = false;
    this.session.state.tracker.observeConnectivityLost();
  }

  private async onEvent(event: SubscriptionEventEnvelope, subscribedPane: string): Promise<void> {
    if (event.event === "observer.disconnected" || event.eventsLost || event.event === "events_lost") {
      this.disconnected();
      return;
    }
    // Even a valid socket acknowledgement is not a validated native session.
    if (event.event === "observer.connected") { await this.reconcile(); return; }
    const data = event.data as Record<string, unknown> | undefined;
    if (event.event === "pane.agent_status_changed" || event.event === "pane_agent_status_changed") {
      const paneId = typeof data?.pane_id === "string" ? data.pane_id : subscribedPane;
      if (paneId !== this.session.state.paneId) return;
    }
    // Lifecycle events are deliberately re-resolved by terminal identity. Never
    // mutate our native ref from a global event for another pane.
    await this.reconcile();
  }

  private serialize(work: () => Promise<void>): Promise<void> {
    const next = this.queue.catch(() => {}).then(work);
    this.queue = next;
    return next;
  }
  readTranscript(): Promise<void> { return this.serialize(() => this.doReadTranscript()); }
  reconcile(): Promise<void> {
    return this.serialize(async () => {
      const session = this.session;
      if (session.isAborted || session.state.outcome !== "active") return;
      const generation = session.state.generation;
      try {
        const agent = await session.validateAgent();
        if (!agent || !session.current(generation)) return;
        const state = session.state;
        if (!state.tracker.activeTurn && (agent.agent_status === "working" || agent.agent_status === "blocked")) {
          state.turnBaselineEndId = state.snapshot?.lastTurnEndId ?? null;
        }
        const working = agent.agent_status === "working";
        const echo = state.staleWorking;
        if (!state.tracker.activeTurn && echo && working && state.snapshot?.lastTurnEndId === echo.endId) {
          // Late `working` for a turn the transcript already ended: no news, so no phantom turn.
          echo.echoed = true;
          state.tracker.observeStatus("idle");
        } else {
          if (echo?.echoed && !working) state.staleWorking = null;
          state.tracker.observeStatus(agent.agent_status);
          if (state.tracker.activeTurn && (working || agent.agent_status === "blocked")) state.workingSeen = true;
        }
        await this.doReadTranscript();
        if (!session.current(generation) || state.outcome !== "active") return;
        state.connected = true;
        state.tracker.observeConnectivityRestored();
      } catch {
        if (session.current(generation)) this.disconnected();
      }
    });
  }

  private async doReadTranscript(): Promise<void> {
    const session = this.session;
    const state = session.state;
    const reader = state.reader;
    if (!reader || session.isAborted || state.outcome !== "active") return;
    const generation = state.generation;
    const snapshot = await reader.snapshot();
    if (!session.current(generation) || state.reader !== reader || state.outcome !== "active") return;
    const previous = state.snapshot;
    if (previous && !snapshot.extendsPrevious(previous)) {
      session.freeze("The native conversation branched", "The old timeline and identity are frozen. Use Import session with the Herdr provider to import the current conversation separately; do not use the native provider on the same file.");
      return;
    }
    const oldUserIds = new Set(previous?.items.filter((item) => item.type === "user_message").map((item) => item.id) ?? []);
    const newUsers = snapshot.items.filter((item) => item.type === "user_message" && !oldUserIds.has(item.id));
    const pending = state.pending;
    if (pending) {
      const user = snapshot.items.find((item) => item.type === "user_message" && !pending.previousUserIds.has(item.id) && item.text === pending.text);
      if (user) {
        if (state.binding.submittedMessages[user.id] !== pending.clientMessageId) {
          state.binding.submittedMessages[user.id] = pending.clientMessageId;
          session.persist();
        }
        state.tracker.acceptPending();
      } else if (state.tracker.isUncertain) {
        // Only the transcript can prove an uncertain prompt arrived; status alone never settles it.
        const foreignUserEntry = snapshot.items.some((item) => item.type === "user_message" && !pending.previousUserIds.has(item.id) && item.text !== pending.text);
        const nativeIdle = (state.status === "idle" || state.status === "done") && snapshot.turnState === "idle";
        if (state.tracker.settleUncertain({ nativeIdle, foreignUserEntry })) {
          state.pending = null;
          if (foreignUserEntry && !state.tracker.activeTurn) {
            state.turnBaselineEndId = previous?.lastTurnEndId ?? null;
            state.tracker.observeStatus("working");
            state.tracker.observeStatus(state.status);
          }
        }
      }
    } else if (newUsers.length && !state.tracker.activeTurn) {
      state.turnBaselineEndId = previous?.lastTurnEndId ?? null;
      state.tracker.observeStatus("working");
      state.tracker.observeStatus(state.status);
    }
    const rows = diffTimeline(snapshot, state.timeline, state.binding.submittedMessages);
    const nextTimeline = new Map(state.timeline);
    const rawById = new Map(snapshot.items.map((item) => [item.id, item]));
    for (const row of rows) {
      session.emit({ type: "timeline.item", sessionId: session.sessionId, item: row.item, timestamp: row.timestamp });
      const raw = rawById.get(row.item.id);
      if (raw) nextTimeline.set(raw.id, hashItem(raw));
    }
    state.timeline = nextTimeline;
    state.snapshot = snapshot;
    if (state.staleWorking && snapshot.lastTurnEndId !== state.staleWorking.endId) state.staleWorking = null;
    session.onSnapshot(previous, snapshot);
    if (state.tracker.isActive && (state.status === "idle" || state.status === "done") &&
        snapshot.turnState === "idle" && snapshot.lastTurnEndId && snapshot.lastTurnEndId !== state.turnBaselineEndId &&
        snapshot.lastTurnEnd && snapshot.lastTurnEnd !== "unknown") {
      state.tracker.observeNativeTurnEnd(snapshot.lastTurnEnd);
      state.staleWorking = state.workingSeen ? null : { endId: snapshot.lastTurnEndId, echoed: false };
      state.workingSeen = false;
      state.pending = null;
      state.turnBaselineEndId = snapshot.lastTurnEndId;
    }
  }
}
