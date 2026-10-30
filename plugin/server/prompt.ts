import { randomUUID } from "node:crypto";
import type { ProviderPrompt } from "@getpaseo/plugin/server/provider";
import type { PromptDelivery } from "./harness/types.js";
import { AgentPromptedResultSchema, type AgentSessionRef } from "./herdr/schema.js";
import { HerdrError } from "./herdr/client.js";
import { sameRef, sessionRefOf } from "./binding.js";
import type { HerdrHarnessSession } from "./session.js";

const DEFINITE_HERDR_REJECTIONS = new Set(["empty_agent_prompt", "agent_not_found", "agent_not_ready", "agent_blocked", "invalid_params", "ambiguous_agent_target"]);

export interface PromptExpectation {
  terminalId: string;
  /** The bound native session the reply must name; null (pane-bound sessions) accepts whatever ref the agent reports. */
  sessionRef: AgentSessionRef | null;
  /** Whether the reply's Herdr `agent` kind belongs to the bound adapter. */
  accepts(kind: string | null | undefined): boolean;
}

/** Only server errors proven to occur before input submission are definite rejection. */
export function classifyHerdrPrompt(result: unknown, error: unknown, expect: PromptExpectation): PromptDelivery {
  if (error !== undefined) {
    return error instanceof HerdrError && DEFINITE_HERDR_REJECTIONS.has(error.code)
      ? { type: "rejected", message: error.message }
      : { type: "uncertain", message: error instanceof Error ? error.message : String(error) };
  }
  const parsed = AgentPromptedResultSchema.safeParse(result);
  if (!parsed.success || parsed.data.agent.terminal_id !== expect.terminalId || !expect.accepts(parsed.data.agent.agent) ||
      (expect.sessionRef !== null && !sameRef(sessionRefOf(parsed.data.agent), expect.sessionRef))) {
    return { type: "uncertain", message: "The prompt response did not confirm the bound native agent" };
  }
  return { type: "accepted" };
}

export class PromptController {
  /** The submission being admitted/delivered; a Stop that arrives meanwhile waits for it (see `interrupt`). */
  private inFlight: Promise<void> | null = null;

  constructor(private readonly session: HerdrHarnessSession) {}

  async prompt(prompt: ProviderPrompt): Promise<void> {
    const run = this.admit(prompt);
    this.inFlight = run;
    try { await run; }
    finally { if (this.inFlight === run) this.inFlight = null; }
  }

  private async admit(prompt: ProviderPrompt): Promise<void> {
    const session = this.session;
    const state = session.state;
    if (session.isAborted) return;
    const fail = (message: string) => session.emit({ type: "session.prompt_result", sessionId: session.sessionId,
      clientMessageId: prompt.clientMessageId, result: { type: "failed", error: { message } } });
    if (state.outcome !== "active") return fail("This conversation is read-only; import the current native session separately to continue");
    if (!state.connected) return fail("Input is suspended until Herdr and the bound native session are reconciled");
    if (state.admitting || state.tracker.activeTurn) return fail("Agent is already working");
    if (prompt.delivery !== "auto" || prompt.input.type !== "message" || prompt.input.content.some((part) => part.type !== "text")) {
      return fail("Only plain-text messages are supported");
    }
    const text = prompt.input.content.filter((part) => part.type === "text").map((part) => part.text).join("\n");
    if (!text.trim()) return fail("Prompt cannot be empty");
    // This reservation is synchronous: no second request can pass while preflight awaits I/O.
    state.admitting = true;
    const generation = state.generation;
    let reserved = false;
    try {
      const agent = await session.validateAgent();
      if (!session.current(generation) || !agent || !state.connected) {
        if (!session.isAborted) fail("The bound native agent is unavailable; input was not sent");
        return;
      }
      await session.live.readTranscript();
      if (!session.current(generation) || !state.connected) {
        if (!session.isAborted) fail("The conversation changed before delivery; input was not sent");
        return;
      }
      const snapshot = state.snapshot;
      const baselineUserIds = new Set(snapshot?.items.filter((item) => item.type === "user_message").map((item) => item.id) ?? []);
      // Status evidence: the pane's screen is not a native turn state, so only Herdr's own idle/done gates input.
      const nativeBusy = session.adapter.turnEvidence === "transcript" && snapshot !== null && snapshot.turnState !== "idle";
      if (state.tracker.activeTurn || (agent.agent_status !== "idle" && agent.agent_status !== "done") || nativeBusy) {
        return fail("The active conversation has an unfinished or unknown turn; finish it in the terminal");
      }
      const occupant = state.binding.occupant;
      const ref = state.binding.sessionRef;
      const processInfo = state.process;
      if (!occupant || !processInfo || (session.adapter.binding === "native-ref" && !ref)) return fail("The native process identity could not be validated");
      state.pending = { clientMessageId: prompt.clientMessageId, text,
        previousUserIds: baselineUserIds };
      state.turnBaselineEndId = snapshot?.lastTurnEndId ?? null;
      // No turn is active here (checked above): a `working` flag left by an earlier uncertain or cancelled delivery is stale.
      state.workingSeen = false;
      state.tracker.reservePending({ turnId: randomUUID(), clientMessageId: prompt.clientMessageId,
        baseline: { stateChangeSeq: agent.state_change_seq, completionSeq: agent.completion_seq ?? null } });
      reserved = true;
      const outcome = await session.adapter.submitPrompt({ pid: occupant.pid, ref, instanceId: occupant.instanceId,
        paneId: agent.pane_id, terminalId: agent.terminal_id,
        pane: { paneId: agent.pane_id, terminalId: agent.terminal_id, process: processInfo } }, text, { signal: session.signal, request: session.deps.request });
      if (!session.current(generation)) return;
      if (outcome.type === "rejected") {
        // A definite rejection starts no terminal turn here: the tracker cannot see the stale-`working` echo guard, so
        // the reconcile below lets Herdr's real status decide whether the pane is busy with someone else's work.
        state.tracker.rejectPending(outcome.message, { startTerminalTurn: false });
        state.workingSeen = false;
        state.pending = null;
        await session.live.reconcile();
      } else {
        if (outcome.type === "uncertain") state.tracker.pendingUncertain(outcome.message);
        else state.tracker.acceptPending();
        void session.live.reconcile();
      }
    } catch (error) {
      if (session.isAborted) return;
      if (reserved) state.tracker.pendingUncertain(error instanceof Error ? error.message : String(error));
      else fail(error instanceof Error ? error.message : String(error));
    } finally {
      state.admitting = false;
    }
  }

  async interrupt(requestId: string): Promise<void> {
    const session = this.session;
    const state = session.state;
    const done = () => session.emit({ type: "request.completed", requestId });
    if (session.isAborted) return;
    // A Stop pressed while the prompt is still being delivered applies to that turn once it starts;
    // a rejected delivery has no turn to stop, an uncertain one is handled below.
    if (this.inFlight) await this.inFlight.catch(() => undefined);
    if (session.isAborted) return;
    const stoppable = () => state.tracker.isActive || state.tracker.isUncertain;
    if (state.outcome !== "active" || !state.connected || !stoppable()) { done(); return; }
    const generation = state.generation;
    try {
      const agent = await session.validateAgent();
      if (!session.current(generation) || !agent || !state.connected || !stoppable()) { done(); return; }
      if (state.tracker.isUncertain && agent.agent_status !== "working" && agent.agent_status !== "blocked") {
        // Paseo never learned whether the prompt arrived, and Herdr shows the pane idle: send no key (a bare ctrl+c
        // can exit some harnesses), never resubmit, and release the reservation so the next prompt is admitted.
        if (agent.agent_status === "idle" || agent.agent_status === "done") {
          if (state.tracker.cancelUncertain("Stopped. Paseo could not confirm delivery; nothing was resent.")) {
            state.pending = null;
            state.workingSeen = false;
          }
        }
        done();
        return;
      }
      await session.deps.request("pane.send_keys", { pane_id: agent.pane_id, keys: [...session.adapter.interruptKeys] }, { signal: session.signal });
      if (!session.current(generation)) return;
      state.tracker.interruptRequested();
    } catch (error) {
      if (session.isAborted) return;
      session.emit({ type: "session.notice", sessionId: session.sessionId, notice: {
        id: "interrupt-failed", severity: "error", title: "Interrupt could not be delivered",
        description: error instanceof Error ? error.message : String(error),
      } });
    }
    done();
  }
}
