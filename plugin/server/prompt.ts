import { randomUUID } from "node:crypto";
import type { ProviderPrompt } from "@getpaseo/plugin/server/provider";
import type { PromptDelivery } from "./harness/types.js";
import { AgentPromptedResultSchema } from "./herdr/schema.js";
import { HerdrError } from "./herdr/client.js";
import { sameRef, sessionRefOf, type Binding } from "./binding.js";
import type { HerdrHarnessSession } from "./session.js";

const DEFINITE_HERDR_REJECTIONS = new Set(["empty_agent_prompt", "agent_not_found", "agent_not_ready", "agent_blocked", "invalid_params", "ambiguous_agent_target"]);

/** Only server errors proven to occur before input submission are definite rejection. */
export function classifyHerdrPrompt(result: unknown, error: unknown, binding: Binding): PromptDelivery {
  if (error !== undefined) {
    return error instanceof HerdrError && DEFINITE_HERDR_REJECTIONS.has(error.code)
      ? { type: "rejected", message: error.message }
      : { type: "uncertain", message: error instanceof Error ? error.message : String(error) };
  }
  const parsed = AgentPromptedResultSchema.safeParse(result);
  if (!parsed.success || parsed.data.agent.terminal_id !== binding.terminalId ||
      parsed.data.agent.agent !== binding.harness || !sameRef(sessionRefOf(parsed.data.agent), binding.sessionRef)) {
    return { type: "uncertain", message: "The prompt response did not confirm the bound native agent" };
  }
  return { type: "accepted" };
}

export class PromptController {
  constructor(private readonly session: HerdrHarnessSession) {}

  async prompt(prompt: ProviderPrompt): Promise<void> {
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
      if (state.tracker.activeTurn || (agent.agent_status !== "idle" && agent.agent_status !== "done") || (snapshot && snapshot.turnState !== "idle")) {
        return fail("The active conversation has an unfinished or unknown turn; finish it in the terminal");
      }
      const occupant = state.binding.occupant;
      const ref = state.binding.sessionRef;
      if (!occupant || !ref) return fail("The native process identity could not be validated");
      state.pending = { clientMessageId: prompt.clientMessageId, text,
        previousUserIds: baselineUserIds };
      state.turnBaselineEndId = snapshot?.lastTurnEndId ?? null;
      state.tracker.reservePending({ turnId: randomUUID(), clientMessageId: prompt.clientMessageId });
      reserved = true;
      const outcome = await session.adapter.submitPrompt({ pid: occupant.pid, ref, instanceId: occupant.instanceId,
        paneId: agent.pane_id, terminalId: agent.terminal_id }, text, { signal: session.signal, request: session.deps.request });
      if (!session.current(generation)) return;
      if (outcome.type === "rejected") {
        state.tracker.rejectPending(outcome.message);
        state.pending = null;
      } else if (outcome.type === "uncertain") {
        state.tracker.pendingUncertain();
      } else {
        state.tracker.acceptPending();
      }
      if (outcome.type !== "rejected") void session.live.reconcile();
    } catch (error) {
      if (session.isAborted) return;
      if (reserved) state.tracker.pendingUncertain();
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
    if (state.outcome !== "active" || !state.connected || !state.tracker.isActive) { done(); return; }
    const generation = state.generation;
    try {
      const agent = await session.validateAgent();
      if (!session.current(generation) || !agent || !state.connected || !state.tracker.isActive) { done(); return; }
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
