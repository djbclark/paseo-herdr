import type { HerdrHarnessSession } from "./session.js";

/** Open sessions created by binding an existing agent, by (Herdr session, terminal id); lets management RPCs reach them. */
export class BoundSessions {
  private readonly sessions = new Set<HerdrHarnessSession>();
  add(session: HerdrHarnessSession): void { this.sessions.add(session); }
  delete(session: HerdrHarnessSession): void { this.sessions.delete(session); }
  /** Send any held history for chats bound to this agent (`herdr.chat.ready`). */
  flushHistory(herdrSession: string | null, terminalId: string): number {
    let flushed = 0;
    for (const session of this.sessions) {
      if (session.isAborted) {
        this.sessions.delete(session); // closed: prune instead of wiring removal into every close path
        continue;
      }
      const { binding } = session.state;
      if (binding.herdrSession === herdrSession && binding.terminalId === terminalId) {
        session.flushHistory();
        flushed++;
      }
    }
    return flushed;
  }
}
