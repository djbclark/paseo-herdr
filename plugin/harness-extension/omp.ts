// paseo-herdr OMP input companion. Installed into OMP's extensions directory by paseo-herdr/plugin (npm run install:omp-companion); do not edit the installed copy.
// All identity, readiness and draft checks, and the public sendUserMessage
// handoff, run synchronously in the TUI process. Draft bytes never leave it.
import net from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

interface NativeRef { kind: "path" | "id"; value: string; }
interface InputContext {
  mode: string;
  hasUI: boolean;
  agent: { kind: string };
  isIdle(): boolean;
  hasPendingMessages(): boolean;
  ui: {
    getEditorText(): unknown;
    notify(message: string, type: "error"): void;
  };
  sessionManager: { getSessionFile(): unknown; getSessionId(): unknown };
}
interface CompanionApi {
  on(event: "session_start" | "session_switch" | "session_shutdown", handler: (event: unknown, ctx: InputContext) => void): void;
  sendUserMessage(content: string): void;
}
interface InputState {
  ref: NativeRef | null;
  mode: string;
  hasUI: boolean;
  isMain: boolean;
  isIdle: boolean;
  hasPending: boolean;
  hasDraft: boolean | null;
}

function nativeRef(ctx: InputContext): NativeRef | null {
  try {
    const file = ctx.sessionManager.getSessionFile();
    if (typeof file === "string" && (path.posix.isAbsolute(file) || path.win32.isAbsolute(file))) {
      return { kind: "path", value: file };
    }
    const id = ctx.sessionManager.getSessionId();
    if (typeof id === "string" && id.length > 0) return { kind: "id", value: id };
  } catch { /* Unknown native identity must never admit a prompt. */ }
  return null;
}

export default function ompInputCompanion(pi: CompanionApi): void {
  // A new extension instance (including an explicit operator reload) invalidates
  // every prior input identity, even when the OS process PID stays the same.
  const instanceId = randomUUID();
  const directory = path.join(os.tmpdir(), `omp-input-${process.pid}`);
  const socketPath = path.join(directory, "sock");
  const connections = new Set<net.Socket>();
  let ctx: InputContext | null = null;
  let server: net.Server | null = null;
  let directoryIdentity: fs.Stats | null = null;
  let socketIdentity: fs.Stats | null = null;
  let started = false;
  let ready = false;

  function snapshot(): InputState | null {
    if (!ctx) return null;
    try {
      let hasDraft: boolean | null = null;
      // RPC's inert getEditorText() is not an authoritative editor check.
      if (ctx.mode === "tui" && ctx.hasUI === true && ctx.agent.kind === "main") {
        try {
          const text = ctx.ui.getEditorText();
          if (typeof text === "string") hasDraft = text.length !== 0;
        } catch { /* Unknown editor state is not empty. */ }
      }
      return {
        ref: nativeRef(ctx),
        mode: ctx.mode,
        hasUI: ctx.hasUI,
        isMain: ctx.agent.kind === "main",
        isIdle: ctx.isIdle(),
        hasPending: ctx.hasPendingMessages(),
        hasDraft,
      };
    } catch { return null; }
  }

  function handle(value: unknown, socket: net.Socket): void {
    const request = typeof value === "object" && value !== null && !Array.isArray(value)
      ? value as Record<string, unknown> : {};
    const state = snapshot();
    const identity = { nonce: request.nonce, pid: process.pid, instanceId, ref: state?.ref ?? null };
    const respond = (result: Record<string, unknown>) => {
      socket.end(`${JSON.stringify({ ...identity, ...result })}\n`);
    };
    const refuse = (code: string, message: string) => respond({ type: "rejected", code, message });
    const ref = request.ref;
    if (typeof request.nonce !== "string" || request.nonce.length === 0 ||
        (request.op !== "inspect" && request.op !== "submit") ||
        typeof ref !== "object" || ref === null || Array.isArray(ref)) {
      refuse("bad_request", "Invalid OMP input companion request.");
      return;
    }
    if (request.pid !== process.pid || (request.op === "submit" && request.instanceId !== instanceId)) {
      refuse("identity_mismatch", "The OMP input process instance changed; reconnect before sending another prompt.");
      return;
    }
    if (!state) {
      refuse("no_session", "The OMP session state is unavailable.");
      return;
    }
    const expected = ref as Record<string, unknown>;
    if (!state.ref || expected.kind !== state.ref.kind || expected.value !== state.ref.value) {
      refuse("ref_mismatch", "The OMP native session changed; reconnect before sending another prompt.");
      return;
    }
    if (request.op === "inspect") {
      respond({ type: "inspected", ...state });
      return;
    }
    if (state.mode !== "tui" || state.hasUI !== true || state.isMain !== true) {
      refuse("not_interactive", "OMP input requires an interactive main TUI session.");
      return;
    }
    if (state.isIdle !== true) {
      refuse("not_idle", "OMP is working; wait until it is idle before sending a prompt.");
      return;
    }
    if (state.hasPending !== false) {
      refuse("pending_messages", "OMP has pending messages; wait for them to finish before sending a prompt.");
      return;
    }
    if (state.hasDraft === null) {
      refuse("editor_unknown", "OMP editor state is unavailable; the terminal draft has not been changed.");
      return;
    }
    if (state.hasDraft !== false) {
      refuse("editor_not_empty", "OMP has a terminal draft. Send or remove that draft in the terminal before sending a Paseo prompt; it has not been changed.");
      return;
    }
    if (typeof request.text !== "string" || request.text.length === 0) {
      refuse("empty_text", "Prompt text must not be empty.");
      return;
    }
    // No await, terminal keys, editor mutation, normalization, or template
    // expansion between the authoritative checks above and this exact handoff.
    try {
      pi.sendUserMessage(request.text);
    } catch {
      respond({ type: "uncertain", message: "OMP failed during the prompt handoff; delivery is uncertain. Do not retry automatically." });
      return;
    }
    respond({ type: "accepted" });
  }

  function removeOwnedDirectory(): void {
    if (!directoryIdentity) return;
    try {
      const current = fs.lstatSync(directory);
      if (!current.isDirectory() || current.dev !== directoryIdentity.dev || current.ino !== directoryIdentity.ino) return;
      if (socketIdentity && fs.existsSync(socketPath)) {
        const socket = fs.lstatSync(socketPath);
        if (!socket.isSocket() || socket.dev !== socketIdentity.dev || socket.ino !== socketIdentity.ino) return;
        fs.unlinkSync(socketPath);
      }
      // Never recursively remove a stale or replacement instance's directory.
      fs.rmdirSync(directory);
    } catch { /* Crash remnants or unexpected files stay untouched. */ }
  }

  function closeEndpoint(): void {
    ready = false;
    for (const socket of connections) socket.destroy();
    if (server?.listening) server.close(removeOwnedDirectory);
    else removeOwnedDirectory();
  }

  pi.on("session_start", (_event, context) => {
    ctx = context;
    if (started) return;
    started = true;
    try {
      // Exclusive creation: a reused PID never unlinks another instance's
      // endpoint or adopts a directory/symlink it did not create.
      fs.mkdirSync(directory, { mode: 0o700 });
      directoryIdentity = fs.lstatSync(directory);
      fs.chmodSync(directory, 0o700);
      server = net.createServer((socket) => {
        if (!ready) { socket.destroy(); return; }
        connections.add(socket);
        socket.once("close", () => connections.delete(socket));
        socket.on("error", () => { socket.destroy(); });
        socket.setEncoding("utf8");
        socket.setTimeout(3000, () => socket.destroy());
        let buffer = "";
        let handled = false;
        socket.on("data", (chunk: string) => {
          if (handled) return;
          buffer += chunk;
          const newline = buffer.indexOf("\n");
          if (newline < 0) return;
          handled = true;
          let request: unknown;
          try { request = JSON.parse(buffer.slice(0, newline)); }
          catch { socket.end('{"type":"rejected","code":"bad_request","message":"Invalid JSON request."}\n'); return; }
          handle(request, socket);
        });
      });
      server.on("error", () => {
        closeEndpoint();
        ctx?.ui.notify("Paseo OMP input companion could not bind its private socket; this session is read-only. Existing endpoints are left untouched.", "error");
      });
      server.listen(socketPath, () => {
        try {
          socketIdentity = fs.lstatSync(socketPath);
          fs.chmodSync(socketPath, 0o600);
          ready = true;
        } catch {
          closeEndpoint();
          ctx?.ui.notify("Paseo OMP input companion could not secure its private socket; this session is read-only.", "error");
        }
      });
    } catch {
      closeEndpoint();
      ctx.ui.notify("Paseo OMP input companion could not create its private process directory; this session is read-only. Existing endpoints are left untouched.", "error");
    }
  });
  pi.on("session_switch", (_event, context) => { ctx = context; });
  pi.on("session_shutdown", () => {
    ctx = null;
    closeEndpoint();
  });
}
