import type {
  ProviderCatalog, ProviderConfigChanges, ProviderConfigState, ProviderModel,
} from "@getpaseo/plugin/server/provider";
import type { ConfigTarget, HarnessAdapter, HarnessConfig, HarnessModel, TranscriptSnapshot } from "./harness/types.js";
import type { HerdrHarnessSession } from "./session.js";
import { NATIVE_DEFAULT_MODEL } from "../shared/model.js";

/** Session config (model and thinking selection) needs both halves of the adapter contract. */
export function supportsConfigure(adapter: HarnessAdapter): boolean {
  return typeof adapter.readConfig === "function" && typeof adapter.configure === "function";
}

export const CATALOG_STALE_MS = 5 * 60 * 1000;
const READ_TIMEOUT_MS = 8000;
const REFRESH_TIMEOUT_MS = 4000;

/** Install-wide model list from the most recent successful config read of any session. */
export class ModelCache {
  private config: HarnessConfig | null = null;
  private readAt = 0;
  update(config: HarnessConfig): void { this.config = config; this.readAt = Date.now(); }
  get models(): readonly HarnessModel[] | null { return this.config?.models ?? null; }
  get empty(): boolean { return this.config === null; }
  get stale(): boolean { return this.config === null || Date.now() - this.readAt > CATALOG_STALE_MS; }

  catalog(): ProviderCatalog {
    const config = this.config;
    if (!config) return { models: [{ id: NATIVE_DEFAULT_MODEL, label: "Configured default", isDefault: true }], modes: [] };
    const labelCount = new Map<string, number>();
    for (const model of config.models) labelCount.set(model.label, (labelCount.get(model.label) ?? 0) + 1);
    const models = config.models.map((model): ProviderModel => ({
      id: model.id,
      label: (labelCount.get(model.label) ?? 0) > 1 ? `${model.label} (${model.provider})` : model.label,
      description: model.provider,
      ...(model.contextWindow !== undefined ? { contextWindowMaxTokens: model.contextWindow } : {}),
      ...(model.thinkingLevels.length
        ? { thinkingOptions: [{ id: "off", label: "Off" }, ...model.thinkingLevels.map((level) => ({ id: level, label: level }))] }
        : {}),
      ...(model.defaultThinkingLevel ? { defaultThinkingOptionId: model.defaultThinkingLevel } : {}),
      ...(config.model === model.id ? { isDefault: true } : {}),
    }));
    return { models, modes: [] };
  }
}

interface Selection { model: string | null; thinkingLevel: string | null; }
interface PendingRequest { answered: boolean; }

function withTimeout<T>(work: (signal: AbortSignal) => Promise<T>, parent: AbortSignal, ms: number): Promise<T> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  parent.addEventListener("abort", abort, { once: true });
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => { controller.abort(); reject(new Error("Timed out reading the agent configuration")); }, ms);
  });
  return Promise.race([work(controller.signal), timeout]).finally(() => {
    clearTimeout(timer);
    parent.removeEventListener("abort", abort);
  });
}

/** Model and thinking selection state of one session; the session owns it, the adapter performs the I/O. */
export class ConfigController {
  readonly cache: ModelCache;
  private config: HarnessConfig | null = null;
  private selection: Selection | null = null;
  private emittedKey: string | null = null;
  private readonly answers = new Map<PendingRequest, (message: string, code: string) => void>();

  constructor(private readonly session: HerdrHarnessSession) {
    this.cache = session.deps.modelCache ?? new ModelCache();
  }

  private get adapter(): HarnessAdapter { return this.session.adapter; }
  private models(): readonly HarnessModel[] | null { return this.config?.models ?? this.cache.models; }
  private target(): ConfigTarget | null {
    const { occupant, sessionRef } = this.session.state.binding;
    return occupant && sessionRef ? { pid: occupant.pid, ref: sessionRef, instanceId: occupant.instanceId } : null;
  }

  /** Map the known selection to Paseo's config state. */
  private stateOf(selection: Selection): ProviderConfigState {
    const model = selection.model ? this.models()?.find((candidate) => candidate.id === selection.model) : undefined;
    let thinkingOption: string | undefined;
    if (model) {
      if (model.thinkingLevels.length) {
        const level = selection.thinkingLevel;
        thinkingOption = level !== null && model.thinkingLevels.includes(level) ? level : "off";
      }
    } else if (selection.model && selection.thinkingLevel !== null) {
      thinkingOption = selection.thinkingLevel;
    }
    return { ...(selection.model ? { model: selection.model } : {}), ...(thinkingOption !== undefined ? { thinkingOption } : {}),
      models: [], modes: [], thinkingOptions: [], settings: [] };
  }

  /** Emit `session.config` for the current selection; `force` re-emits an unchanged one. */
  private publish(force = false): boolean {
    if (!this.selection) return false;
    const state = this.stateOf(this.selection);
    const key = JSON.stringify([state.model ?? null, state.thinkingOption ?? null]);
    if (!force && key === this.emittedKey) return false;
    this.emittedKey = key;
    this.session.emit({ type: "session.config", sessionId: this.session.sessionId, config: state });
    return true;
  }

  /** Read live config through the adapter. Returns null (never throws) when unavailable. */
  private async read(timeoutMs: number): Promise<HarnessConfig | null> {
    const target = this.target();
    const readConfig = this.adapter.readConfig?.bind(this.adapter);
    if (!target || !readConfig || this.session.isAborted) return null;
    try {
      const config = await withTimeout((signal) => readConfig(target, signal), this.session.signal, timeoutMs);
      if (this.session.isAborted) return null;
      this.cache.update(config);
      return config;
    } catch { return null; }
  }

  private adopt(config: HarnessConfig): void {
    this.config = config;
    this.selection = { model: config.model, thinkingLevel: config.thinkingLevel };
  }

  /** After a successful open validation: read once and announce the selection. Optional UX, so failures are silent. */
  async initialRead(): Promise<void> {
    if (!supportsConfigure(this.adapter)) return;
    const config = await this.read(READ_TIMEOUT_MS);
    if (!config) return;
    this.adopt(config);
    this.publish();
  }

  /** Catalog refresh: updates the shared model list only, never this session's selection. */
  async refreshModels(): Promise<boolean> {
    if (!supportsConfigure(this.adapter) || this.session.state.outcome !== "active" || !this.session.state.connected) return false;
    return (await this.read(REFRESH_TIMEOUT_MS)) !== null;
  }

  /** Terminal-made changes arrive through the transcript; compare against the previous snapshot, then dedupe against what was emitted. */
  onSnapshot(previous: TranscriptSnapshot | null, snapshot: TranscriptSnapshot): void {
    if (!this.models()) return;
    const modelChanged = snapshot.model !== undefined && snapshot.model !== previous?.model;
    // "off" and null both mean off/cleared.
    const level = (value: string | null | undefined) => value === "off" ? null : value;
    const thinkingChanged = snapshot.thinkingLevel !== undefined && level(snapshot.thinkingLevel) !== level(previous?.thinkingLevel);
    if (!modelChanged && !thinkingChanged) return;
    const current = this.selection ?? { model: null, thinkingLevel: null };
    this.selection = {
      model: modelChanged && snapshot.model !== undefined ? snapshot.model : current.model,
      thinkingLevel: thinkingChanged && snapshot.thinkingLevel !== undefined ? snapshot.thinkingLevel : current.thinkingLevel,
    };
    this.publish();
  }

  /** `session.configure`: answers the request exactly once, success only after the fresh config was announced. */
  async configure(requestId: string, changes: ProviderConfigChanges): Promise<void> {
    const session = this.session;
    const state = session.state;
    const request: PendingRequest = { answered: false };
    const fail = (message: string, code: string) => {
      if (request.answered) return;
      request.answered = true;
      session.deps.emit({ type: "request.failed", requestId, error: { message, code } });
    };
    const complete = () => {
      if (request.answered) return;
      request.answered = true;
      session.deps.emit({ type: "request.completed", requestId });
    };
    this.answers.set(request, fail);
    let reserved = false;
    try {
      if (session.isAborted) return fail("The conversation was closed", "closed");
      if (!supportsConfigure(this.adapter)) return fail("Changing the model or thinking level is not supported", "unsupported");
      if (state.outcome !== "active") return fail("This conversation is read-only; model and thinking level cannot be changed", "read_only");
      if (!state.connected) return fail("Herdr and the bound native session are not reconciled; try again shortly", "disconnected");
      if (state.admitting || state.tracker.activeTurn || state.pending) return fail("The agent is working; change the model between turns", "busy");
      if ((changes.mode !== undefined && changes.mode !== null) || Object.keys(changes.settings ?? {}).length) {
        return fail("Only the model and the thinking level can be changed", "unsupported");
      }
      const model = changes.model ?? undefined;
      const thinkingLevel = changes.thinkingOption ?? undefined;
      // Same reservation as a prompt: nothing else may start while the change is applied.
      state.admitting = true;
      reserved = true;
      const generation = state.generation;
      const agent = await session.validateAgent();
      if (session.isAborted) return fail("The conversation was closed", "closed");
      if (!session.current(generation) || !agent || !state.connected) {
        return fail("The bound native agent is unavailable; nothing was changed", state.outcome === "active" ? "disconnected" : "read_only");
      }
      await session.live.readTranscript();
      if (!session.current(generation) || !state.connected) {
        return fail(session.isAborted ? "The conversation was closed" : "The conversation changed before the request; nothing was changed", session.isAborted ? "closed" : "disconnected");
      }
      if (state.tracker.activeTurn || (agent.agent_status !== "idle" && agent.agent_status !== "done") ||
          (state.snapshot && state.snapshot.turnState !== "idle")) {
        return fail("The agent is working or its turn state is unknown; change the model between turns", "busy");
      }
      const target = this.target();
      if (!target) return fail("The native process identity could not be validated", "disconnected");
      if (model === undefined && thinkingLevel === undefined) { complete(); return; }
      const result = await this.adapter.configure!(target, {
        ...(model !== undefined ? { model } : {}), ...(thinkingLevel !== undefined ? { thinkingLevel } : {}),
      }, session.signal);
      if (session.isAborted) return fail("The conversation was closed", "closed");
      if (result.type === "configured") {
        this.cache.update(result.config);
        this.adopt(result.config);
        this.publish(true);
        complete();
      } else if (result.type === "rejected") {
        fail(result.message, result.code);
      } else {
        // The change may have applied; settle the request first, then reconcile best-effort.
        fail(`${result.message} The change may have been applied; check the agent.`, "uncertain");
        const fresh = await this.read(READ_TIMEOUT_MS);
        if (fresh) { this.adopt(fresh); this.publish(); }
      }
    } catch (error) {
      fail(session.isAborted ? "The conversation was closed" : error instanceof Error ? error.message : String(error),
        session.isAborted ? "closed" : "failed");
    } finally {
      if (reserved) state.admitting = false;
      this.answers.delete(request);
    }
  }

  /** Session close: every request still waiting is answered once. */
  close(): void {
    for (const [request, fail] of this.answers) if (!request.answered) fail("The conversation was closed", "closed");
  }
}
