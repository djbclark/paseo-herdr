import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, test } from "vitest";
import { ompAdapter } from "../server/harness/omp/adapter.js";
import type { TranscriptSnapshot } from "../server/harness/types.js";
import { ProviderEventSchema } from "@getpaseo/plugin/server/provider";

const tmpRoot = join(tmpdir(), "omp-transcript-tests");
let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "omp-transcript-"));
});

afterAll(async () => {
  await rm(tmpRoot, { recursive: true, force: true });
});

async function write(name: string, lines: unknown[]): Promise<string> {
  const path = join(dir, name);
  await writeFile(path, lines.map((line) => JSON.stringify(line)).join("\n") + "\n", "utf8");
  return path;
}

async function snapshotAt(path: string, namespace = "omp:key1"): Promise<TranscriptSnapshot> {
  const reader = ompAdapter.openTranscript({ path, nativeSessionKey: namespace.slice("omp:".length) });
  try {
    return await reader.snapshot();
  } finally {
    reader.close();
  }
}

// Shapes grounded in real transcripts from ~/.omp/agent/sessions (OMP 18.4.12).
const titleRow = { type: "title", pad: 0, updatedAt: 0, title: "Old title" };
const sessionRow = {
  type: "session",
  version: 3,
  id: "01aaaaaaaa-7981-7706-a84d-4409ff4d4e6b",
  timestamp: "2026-10-06T15:56:43.777Z",
  cwd: "/home/dj",
};
const userText = (text: string) => [{ type: "text", text }];
const message = (id: string, parentId: string | null, role: string, content: unknown) => ({
  type: "message",
  id,
  parentId,
  timestamp: "2026-10-06T15:56:50.000Z",
  message: { role, content },
});
const assistantMessage = (
  id: string,
  parentId: string | null,
  content: unknown,
  stopReason = "stop",
) => ({
  type: "message",
  id,
  parentId,
  timestamp: "2026-10-06T15:56:50.000Z",
  message: { role: "assistant", content, stopReason },
});
const thinking = (text: string) => ({ type: "thinking", thinking: text });
const toolCall = (id: string, name: string) => ({
  type: "toolCall",
  id,
  name,
  arguments: { command: "ls" },
});

describe("OMP adapter replay", () => {
  test("returns Phase 0 text ids for user and assistant text on the active chain", async () => {
    const path = await write("linear.jsonl", [
      titleRow,
      sessionRow,
      message("e1", null, "user", userText("hello")),
      assistantMessage("e2", "e1", userText("hi there"), "stop"),
      message("e3", "e2", "user", userText("bye")),
    ]);
    const snapshot = await snapshotAt(path);
    expect(snapshot.items).toEqual([
      { id: "omp:key1:e1:user_message:0", type: "user_message", text: "hello" },
      { id: "omp:key1:e2:assistant_message:0", type: "assistant_message", text: "hi there" },
      { id: "omp:key1:e3:user_message:0", type: "user_message", text: "bye" },
    ]);
    expect(snapshot.title).toBe("Old title");
  });

  test("follows the parentId chain, skipping off-branch siblings", async () => {
    const path = await write("branch.jsonl", [
      titleRow,
      sessionRow,
      message("e1", null, "user", userText("q")),
      message("e2b", "e1", "assistant", userText("stale answer")),
      message("e2", "e1", "assistant", userText("fresh answer")),
      message("e3", "e2", "user", userText("follow-up")),
    ]);
    const items = (await snapshotAt(path)).items;
    expect(items.map((item) => ("text" in item ? item.text : null))).toEqual([
      "q",
      "fresh answer",
      "follow-up",
    ]);
    expect(items.map((item) => item.id)).not.toContain("omp:key1:e2b:assistant_message:0");
  });

  test("dangling parentId ends the walk instead of throwing", async () => {
    const path = await write("dangling.jsonl", [
      titleRow,
      sessionRow,
      message("e2", "missing-parent", "assistant", userText("orphan root")),
    ]);
    expect((await snapshotAt(path)).items).toEqual([
      { id: "omp:key1:e2:assistant_message:0", type: "assistant_message", text: "orphan root" },
    ]);
  });

  test("id cycle is cut off instead of looping forever", async () => {
    const path = await write("cycle.jsonl", [
      titleRow,
      sessionRow,
      message("a", null, "user", userText("a")),
      message("b", "a", "assistant", userText("b")),
      message("a", "b", "user", userText("a again")),
    ]);
    expect((await snapshotAt(path)).items).toEqual([]);
  });

  test("replays thinking and tool calls with stable tool ids", async () => {
    const callId = "call-1";
    const path = await write("tools.jsonl", [
      titleRow,
      sessionRow,
      message("m1", null, "user", userText("run ls")),
      assistantMessage("m2", "m1", [thinking("planning"), toolCall(callId, "bash")], "toolUse"),
      {
        type: "message",
        id: "m3",
        parentId: "m2",
        timestamp: "2026-10-06T15:56:50.000Z",
        message: { role: "toolResult", toolCallId: callId, toolName: "bash", content: userText("tool output") },
      },
      assistantMessage("m4", "m3", userText("done"), "stop"),
    ]);
    const snapshot = await snapshotAt(path);
    const items = snapshot.items;
    expect(items.map((item) => item.type)).toEqual([
      "user_message",
      "reasoning",
      "tool_call",
      "assistant_message",
    ]);
    const reasoning = items.find((item) => item.type === "reasoning");
    expect(reasoning && "text" in reasoning && reasoning.text).toBe("planning");
    // The running and completed tool rows share the stable :tool:<callId> id;
    // mapping keeps only the terminal (completed) state, so the live diff never
    // re-emits a superseded running row.
    const toolRows = items.filter((item) => item.type === "tool_call");
    expect(toolRows).toHaveLength(1);
    expect(toolRows[0].id).toBe(`omp:key1:m2:tool:${callId}`);
    expect(toolRows[0]).toMatchObject({ status: "completed" });
    expect(snapshot.lastTurnEnd).toBe("completed");
  });

  test("maps a compaction row and an aborted stopReason outcome", async () => {
    const path = await write("compaction.jsonl", [
      titleRow,
      sessionRow,
      message("u1", null, "user", userText("long context")),
      assistantMessage("a1", "u1", userText("reply"), "stop"),
      { type: "compaction", id: "c1", parentId: "a1", tokensBefore: 17921, tokensAfter: 21422 },
      message("u2", "c1", "user", userText("after compaction")),
      assistantMessage("a2", "u2", userText("partial"), "aborted"),
    ]);
    const snapshot = await snapshotAt(path);
    expect(snapshot.items.some((item) => item.type === "compaction")).toBe(true);
    expect(snapshot.items.find((item) => item.type === "compaction")).toMatchObject({
      id: "omp:key1:c1:compaction:0",
      status: "completed",
      preTokens: 17921,
    });
    expect(snapshot.lastTurnEnd).toBe("aborted");
  });

  test("torn final JSON line is tolerated", async () => {
    const base = [titleRow, sessionRow, message("e1", null, "user", userText("stable"))];
    const torn = JSON.stringify(message("e2", "e1", "assistant", userText("cut off in the middle")));
    const path = join(dir, "torn.jsonl");
    await writeFile(
      path,
      base.map((line) => JSON.stringify(line)).join("\n") + "\n" + torn.slice(0, 40),
      "utf8",
    );
    expect((await snapshotAt(path)).items).toEqual([
      { id: "omp:key1:e1:user_message:0", type: "user_message", text: "stable" },
    ]);
  });

  test("missing file resolves to empty list", async () => {
    expect((await snapshotAt(join(dir, "does-not-exist.jsonl"))).items).toEqual([]);
  });

  test("header-only file resolves to empty list", async () => {
    const path = await write("header-only.jsonl", [sessionRow]);
    expect((await snapshotAt(path)).items).toEqual([]);
  });

  test("ids are stable across reads and namespaced by the session key", async () => {
    const path = await write("stable.jsonl", [
      titleRow,
      sessionRow,
      message("e1", null, "user", userText("q")),
    ]);
    const first = await snapshotAt(path, "omp:sessA");
    const second = await snapshotAt(path, "omp:sessA");
    const other = await snapshotAt(path, "omp:sessB");
    expect(second.items).toEqual(first.items);
    expect(other.items[0]?.id).not.toBe(first.items[0]?.id);
    expect(first.items[0]?.id.startsWith("omp:sessA:e1:")).toBe(true);
  });

  test("chain ids are stable and extendsPrevious accepts a prefix extension", async () => {
    const path = await write("extend.jsonl", [
      titleRow,
      sessionRow,
      message("e1", null, "user", userText("q")),
      message("e2", "e1", "assistant", userText("a")),
    ]);
    const first = await snapshotAt(path);
    await writeFile(
      path,
      [
        titleRow,
        sessionRow,
        message("e1", null, "user", userText("q")),
        message("e2", "e1", "assistant", userText("a")),
        message("e3", "e2", "user", userText("follow up")),
      ]
        .map((line) => JSON.stringify(line))
        .join("\n") + "\n",
      "utf8",
    );
    const second = await snapshotAt(path);
    expect(second.chainIds.slice(0, 2)).toEqual(first.chainIds);
    expect(second.extendsPrevious(first)).toBe(true);
  });

  test("non-content telemetry rows (credential_pin etc.) never become items", async () => {
    const path = await write("telemetry.jsonl", [
      titleRow,
      sessionRow,
      message("u1", null, "user", userText("hello")),
      assistantMessage("a1", "u1", userText("hi"), "stop"),
      { type: "credential_pin", id: "cp1", parentId: "a1", provider: "openai-codex", hash: "abc" },
      { type: "model_usage", id: "mu1", parentId: "cp1", role: "assistant", model: "gpt", usage: {} },
      { type: "service_tier_change", id: "st1", parentId: "mu1", serviceTier: null },
    ]);
    const snapshot = await snapshotAt(path);
    expect(snapshot.items.map((item) => item.type)).toEqual(["user_message", "assistant_message"]);
    expect(snapshot.items.some((item) => ("text" in item && (item.text as string).includes("Unsupported")))).toBe(false);
  });

  test("every replayed item passes the provider event schema", async () => {
    const path = await write("schema.jsonl", [
      titleRow,
      sessionRow,
      message("u1", null, "user", userText("question")),
      assistantMessage("a1", "u1", [thinking("hmm"), toolCall("call-1", "bash")], "toolUse"),
      {
        type: "message",
        id: "r1",
        parentId: "a1",
        timestamp: "2026-10-06T15:56:50.000Z",
        message: { role: "toolResult", toolCallId: "call-1", toolName: "bash", content: userText("output") },
      },
      message("a2", "r1", "assistant", userText("answer")),
      { type: "compaction", id: "c1", parentId: "a2", tokensBefore: 100 },
    ]);
    const snapshot = await snapshotAt(path);
    for (const item of snapshot.items) {
      expect(() =>
        ProviderEventSchema.parse({ type: "timeline.item", sessionId: "s", item }),
      ).not.toThrow();
    }
  });
});

describe("model and thinking level from the active chain", () => {
  const modelChange = (id: string, parentId: string | null, model: string, role?: string) => ({
    type: "model_change", id, parentId, timestamp: "2026-10-06T15:56:50.000Z", model,
    ...(role === undefined ? {} : { role }), resolvedModelIsFallback: role === "fallback",
  });
  const thinkingChange = (id: string, parentId: string | null, thinkingLevel: string | null) => ({
    type: "thinking_level_change", id, parentId, timestamp: "2026-10-06T15:56:50.000Z", thinkingLevel, configured: thinkingLevel,
  });

  test("the last role-less or default model_change wins; fallback and other roles are ignored", async () => {
    const path = await write("models.jsonl", [
      sessionRow,
      modelChange("m1", null, "p/start"),
      modelChange("m2", "m1", "p/chosen", "default"),
      modelChange("m3", "m2", "p/backup", "fallback"),
      modelChange("m4", "m3", "p/small", "smol"),
    ]);
    expect((await snapshotAt(path)).model).toBe("p/chosen");
  });

  test("a chain with only fallback model_change entries records no model", async () => {
    const path = await write("fallback-only.jsonl", [
      sessionRow,
      modelChange("m1", null, "p/backup", "fallback"),
      message("u1", "m1", "user", userText("hi")),
    ]);
    const snapshot = await snapshotAt(path);
    expect(snapshot.model).toBeUndefined();
    expect(snapshot.thinkingLevel).toBeUndefined();
  });

  test("a null thinking level (off/cleared) is kept distinct from none recorded", async () => {
    const path = await write("thinking-null.jsonl", [
      sessionRow,
      thinkingChange("t1", null, "high"),
      thinkingChange("t2", "t1", null),
    ]);
    expect((await snapshotAt(path)).thinkingLevel).toBeNull();
  });

  test("entries on an abandoned branch do not count", async () => {
    const path = await write("branch.jsonl", [
      sessionRow,
      modelChange("m1", null, "p/root"),
      modelChange("m2", "m1", "p/abandoned"),
      thinkingChange("t2", "m2", "max"),
      // New active leaf branches from m1, so m2/t2 are off the active chain.
      thinkingChange("t3", "m1", "low"),
    ]);
    const snapshot = await snapshotAt(path);
    expect(snapshot.model).toBe("p/root");
    expect(snapshot.thinkingLevel).toBe("low");
  });
});
