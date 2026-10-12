import { basename } from "node:path";
import type { NativeFork, TranscriptLocator } from "./harness/types.js";
import { sameRef, sessionRefOf } from "./binding.js";
import type { HerdrHarnessSession } from "./session.js";

export const FORK_SCAN_INTERVAL_MS = 30_000;

/**
 * P3.5B fork warning. Watches for sibling native sessions forked off the bound
 * one by another process (R23) via `adapter.findForks` and emits one notice
 * per fork (R20: notices are permanent, so never repeat). Never changes the
 * binding or outcome; a fork made by our own pane is the existing
 * native-session-change freeze, not a warning.
 */
export class ForkWatcher {
  private timer: NodeJS.Timeout | undefined;
  private running = false;
  private scanning = false;
  private locator: TranscriptLocator | null = null;
  /** Fork paths already reported (or recognised as the pane's own). */
  private readonly seen = new Set<string>();
  /** Fork paths seen in exactly one scan so far; notified only if still foreign on the next scan. */
  private readonly pending = new Set<string>();

  constructor(private readonly session: HerdrHarnessSession) {}

  start(): void {
    if (this.running || !this.session.adapter.findForks) return;
    this.running = true;
    this.timer = setInterval(() => { void this.scan(); }, FORK_SCAN_INTERVAL_MS);
    this.timer.unref();
    void this.scan();
  }

  stop(): void {
    this.running = false;
    clearInterval(this.timer);
    this.timer = undefined;
  }

  private async scan(): Promise<void> {
    const session = this.session;
    const find = session.adapter.findForks;
    if (!find || this.scanning || !this.running) return;
    if (session.isAborted || session.state.outcome !== "active" || !session.state.reader) return;
    this.scanning = true;
    const generation = session.state.generation;
    const usable = () => this.running && session.current(generation) && session.state.outcome === "active";
    try {
      const { binding } = session.state;
      if (!this.locator) {
        this.locator = await session.adapter.resolveTranscript(binding.sessionRef, { cwd: binding.cwd });
        if (!usable()) return;
      }
      if (!this.locator) return;
      const found = await find.call(session.adapter, this.locator, session.signal);
      if (!usable()) return;
      const present = new Set(found.map((fork) => fork.path));
      for (const path of this.pending) if (!present.has(path)) this.pending.delete(path);
      const fresh = found.filter((fork) => !this.seen.has(fork.path));
      if (fresh.length === 0) return;
      // Herdr's reported ref can lag a pane-run /fork by a few seconds, so a fork is only
      // reported once it survives two consecutive scans while still not the pane's own ref.
      const own = await this.paneNativeRef();
      if (!own || !usable()) { this.pending.clear(); return; }
      for (const fork of fresh) {
        if (own.has(fork.path) || own.has(fork.sessionId)) {
          this.seen.add(fork.path);
          this.pending.delete(fork.path);
        } else if (!this.pending.has(fork.path)) {
          this.pending.add(fork.path);
        } else {
          this.pending.delete(fork.path);
          this.seen.add(fork.path);
          this.notify(fork);
        }
      }
    } catch {
      // Best effort: a failed scan is retried on the next tick.
    } finally {
      this.scanning = false;
    }
  }

  /**
   * Values Herdr reports for our pane's native session, or null when the pane's
   * state is unknown or has already diverged from the binding (the freeze path
   * owns that case, so no warning is due).
   */
  private async paneNativeRef(): Promise<Set<string> | null> {
    const session = this.session;
    const { binding } = session.state;
    const agents = await session.deps.listAgents(session.signal);
    const agent = agents.find((candidate) => candidate.terminal_id === binding.terminalId);
    if (!agent) return null;
    const ref = sessionRefOf(agent);
    if (!sameRef(ref, binding.sessionRef)) return null;
    return new Set(ref ? [ref.value] : []);
  }

  private notify(fork: NativeFork): void {
    this.session.emit({ type: "session.notice", sessionId: this.session.sessionId, notice: {
      id: `fork-${fork.sessionId}`, severity: "warning", title: "Conversation continued in another process",
      description: `Another process opened this conversation and continued in a separate copy (${basename(fork.path)}). That copy isn't followed here; this conversation stays on the original file.`,
    } });
  }
}
