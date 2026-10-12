/// <reference lib="es2024.promise" />
// One connection and one fresh request nonce per operation; never retry a
// prompt. Once socket.write is attempted, only an authenticated, well-formed
// companion reply can establish acceptance or a definite refusal.
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { AgentSessionRef } from "../../herdr/schema.js";

const REPLY_TIMEOUT_MS = 3000;
const MAX_REPLY_CHARS = 65536;
const REFUSAL_CODES: Record<string, true | undefined> = {
  bad_request: true,
  identity_mismatch: true,
  no_session: true,
  ref_mismatch: true,
  not_interactive: true,
  not_idle: true,
  pending_messages: true,
  editor_unknown: true,
  editor_not_empty: true,
  empty_text: true,
};

export type OmpInputDelivery =
  | { type: "accepted" }
  | { type: "rejected"; message: string }
  | { type: "uncertain"; message: string };
export interface OmpInputIdentity { pid: number; instanceId: string; }
interface SocketRoundTrip { wrote: boolean; line?: string; message?: string; }

function roundTrip(pid: number, request: Record<string, unknown>, signal?: AbortSignal): Promise<SocketRoundTrip> {
  if (signal?.aborted) return Promise.resolve({ wrote: false, message: "OMP input was aborted before sending." });
  const payload = `${JSON.stringify(request)}\n`;
  const { promise, resolve } = Promise.withResolvers<SocketRoundTrip>();
  let socket: net.Socket;
  try {
    socket = net.createConnection({ path: path.join(os.tmpdir(), `omp-input-${pid}`, "sock") });
  } catch (error) {
    resolve({ wrote: false, message: `OMP input socket could not connect: ${error instanceof Error ? error.message : String(error)}` });
    return promise;
  }
  let wrote = false;
  let settled = false;
  let buffer = "";
  const finish = (result: Omit<SocketRoundTrip, "wrote">) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
    socket.destroy();
    resolve({ ...result, wrote });
  };
  const abort = () => finish({ message: "OMP input was aborted." });
  const timer = setTimeout(() => finish({ message: "OMP input companion reply timed out." }), REPLY_TIMEOUT_MS);
  signal?.addEventListener("abort", abort, { once: true });
  socket.setEncoding("utf8");
  socket.on("error", (error) => finish({ message: `OMP input socket failed: ${error.message}` }));
  socket.on("connect", () => {
    if (settled) return;
    if (signal?.aborted) { abort(); return; }
    // Even a synchronous write failure might have partially delivered bytes.
    // Set this before write, not its callback, to avoid a false rejection.
    wrote = true;
    try { socket.write(payload); }
    catch (error) { finish({ message: `OMP input write failed: ${error instanceof Error ? error.message : String(error)}` }); }
  });
  socket.on("data", (chunk: string) => {
    buffer += chunk;
    if (buffer.length > MAX_REPLY_CHARS) { finish({ message: "OMP input companion reply was malformed (too large)." }); return; }
    const newline = buffer.indexOf("\n");
    if (newline >= 0) finish({ line: buffer.slice(0, newline) });
  });
  socket.on("end", () => finish({ message: "OMP input companion closed without a complete reply." }));
  socket.on("close", () => finish({ message: "OMP input companion connection closed without a complete reply." }));
  if (signal?.aborted) abort();
  return promise;
}

function parseReply(line: string): Record<string, unknown> {
  let value: unknown;
  try { value = JSON.parse(line); }
  catch { throw new Error("OMP input companion returned malformed JSON."); }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("OMP input companion returned a malformed reply.");
  }
  return value as Record<string, unknown>;
}

function replyMatches(reply: Record<string, unknown>, pid: number, ref: AgentSessionRef, nonce: string, instanceId?: string): boolean {
  const native = reply.ref;
  if (typeof native !== "object" || native === null || Array.isArray(native)) return false;
  const observed = native as Record<string, unknown>;
  return reply.pid === pid && reply.nonce === nonce &&
    typeof reply.instanceId === "string" && reply.instanceId.length > 0 &&
    (instanceId === undefined || reply.instanceId === instanceId) &&
    observed.kind === ref.kind && observed.value === ref.value;
}

/** Establish input identity without requiring the editor to be empty or idle. */
export async function inspectOmpInput(pid: number, ref: AgentSessionRef, signal?: AbortSignal): Promise<OmpInputIdentity> {
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error("OMP input requires a valid foreground process PID.");
  const nonce = randomUUID();
  const result = await roundTrip(pid, { op: "inspect", nonce, pid, ref }, signal);
  if (result.line === undefined) {
    throw new Error(`The required OMP input companion is unavailable; this session is read-only. Install it with npm run install:omp-companion in paseo-herdr/plugin, then restart the OMP agent (OMP loads extensions only at startup). Existing sessions are never restarted automatically. ${result.message ?? "No reply received."}`);
  }
  const reply = parseReply(result.line);
  if (!replyMatches(reply, pid, ref, nonce)) throw new Error("OMP input companion identity does not match this process and native session; this session is read-only.");
  if (reply.type === "rejected" && typeof reply.message === "string" && reply.message.length > 0) throw new Error(reply.message);
  if (reply.type !== "inspected" || reply.mode !== "tui" || reply.hasUI !== true || reply.isMain !== true ||
      typeof reply.isIdle !== "boolean" || typeof reply.hasPending !== "boolean" ||
      (typeof reply.hasDraft !== "boolean" && reply.hasDraft !== null)) {
    throw new Error("OMP input companion is not an interactive main TUI session with readable state; this session is read-only.");
  }
  return { pid, instanceId: reply.instanceId as string };
}

/** A definite pre-write failure is rejected; any ambiguous post-write state is uncertain. */
export async function submitOmpInput(pid: number, ref: AgentSessionRef, instanceId: string, text: string, signal?: AbortSignal): Promise<OmpInputDelivery> {
  if (!Number.isSafeInteger(pid) || pid <= 0 || typeof instanceId !== "string" || instanceId.length === 0) {
    return { type: "rejected", message: "OMP input requires a valid process instance; reconnect before sending a prompt." };
  }
  if (typeof text !== "string" || text.length === 0) return { type: "rejected", message: "Prompt text must not be empty." };
  const nonce = randomUUID();
  const result = await roundTrip(pid, { op: "submit", nonce, pid, ref, instanceId, text }, signal);
  if (result.line === undefined) {
    return { type: result.wrote ? "uncertain" : "rejected", message: result.message ?? "OMP input companion did not reply." };
  }
  let reply: Record<string, unknown>;
  try { reply = parseReply(result.line); }
  catch (error) { return { type: "uncertain", message: error instanceof Error ? error.message : String(error) }; }
  if (!replyMatches(reply, pid, ref, nonce, instanceId)) {
    return { type: "uncertain", message: "OMP input reply identity changed or did not match the request; delivery is uncertain. Do not retry automatically." };
  }
  if (reply.type === "accepted") return { type: "accepted" };
  if (reply.type === "rejected" && typeof reply.code === "string" && Object.hasOwn(REFUSAL_CODES, reply.code) &&
      typeof reply.message === "string" && reply.message.length > 0) {
    return { type: "rejected", message: reply.message };
  }
  if (reply.type === "uncertain" && typeof reply.message === "string" && reply.message.length > 0) {
    return { type: "uncertain", message: reply.message };
  }
  return { type: "uncertain", message: "OMP input companion returned an unrecognized reply; delivery is uncertain. Do not retry automatically." };
}
