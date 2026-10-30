import type { HerdrHarnessSession } from "./session.js";

/** Live chats share pane ownership across providers and connections. */
class PaneClaims {
  private readonly sessions = new Map<string, HerdrHarnessSession>();

  claim(socketPath: string, herdrSession: string | null, terminalId: string, session: HerdrHarnessSession): (() => void) | null {
    const key = JSON.stringify([socketPath, herdrSession, terminalId]);
    const owner = this.sessions.get(key);
    // Read-only history doesn't prevent a fresh chat from binding the running agent.
    if (owner && owner !== session && !owner.isAborted && owner.state.outcome === "active") return null;
    this.sessions.set(key, session);
    return () => { if (this.sessions.get(key) === session) this.sessions.delete(key); };
  }

  move(socketPath: string, herdrSession: string | null, oldTerminalId: string, terminalId: string, session: HerdrHarnessSession): (() => void) | null {
    const release = this.claim(socketPath, herdrSession, terminalId, session);
    if (!release) return null;
    const oldKey = JSON.stringify([socketPath, herdrSession, oldTerminalId]);
    if (oldTerminalId !== terminalId && this.sessions.get(oldKey) === session) this.sessions.delete(oldKey);
    return release;
  }
}

export const paneClaims = new PaneClaims();
