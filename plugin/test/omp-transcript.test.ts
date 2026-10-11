import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, test } from "vitest";
import { readOmpTranscript } from "../server/harness/omp/transcript.js";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "omp-transcript-"));
});

afterAll(async () => {
  await rm(tmpRoot, { recursive: true, force: true });
});

const tmpRoot = join(tmpdir(), "omp-transcript-tests");

async function write(name: string, lines: unknown[]): Promise<string> {
  const path = join(dir, name);
  await writeFile(path, lines.map((line) => JSON.stringify(line)).join("\n") + "\n", "utf8");
  return path;
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
const thinking = (text: string) => ({ type: "thinking", thinking: text });
const toolCall = (id: string, name: string) => ({
  type: "toolCall",
  id,
  name,
  arguments: { command: "ls" },
});

describe("readOmpTranscript", () => {
  test("returns items for user and assistant text on the active chain", async () => {
    const path = await write("linear.jsonl", [
      titleRow,
      sessionRow,
      message("e1", null, "user", userText("hello")),
      message("e2", "e1", "assistant", userText("hi there")),
      message("e3", "e2", "user", userText("bye")),
    ]);
    await expect(readOmpTranscript(path, "omp:key1")).resolves.toEqual([
      { id: "omp:key1:e1:user_message:0", type: "user_message", text: "hello" },
      { id: "omp:key1:e2:assistant_message:0", type: "assistant_message", text: "hi there" },
      { id: "omp:key1:e3:user_message:0", type: "user_message", text: "bye" },
    ]);
  });

  test("follows the parentId chain, skipping off-branch siblings", async () => {
    // e2b was appended first, then e2 extends e1: the chain through e2 wins
    // because it is the file's last leaf; e2b must not appear.
    const path = await write("branch.jsonl", [
      titleRow,
      sessionRow,
      message("e1", null, "user", userText("q")),
      message("e2b", "e1", "assistant", userText("stale answer")),
      message("e2", "e1", "assistant", userText("fresh answer")),
      message("e3", "e2", "user", userText("follow-up")),
    ]);
    const items = await readOmpTranscript(path, "omp:key1");
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
    await expect(readOmpTranscript(path, "omp:key1")).resolves.toEqual([
      { id: "omp:key1:e2:assistant_message:0", type: "assistant_message", text: "orphan root" },
    ]);
  });

  test("id cycle is cut off instead of looping forever", async () => {
    const path = await write("cycle.jsonl", [
      titleRow,
      sessionRow,
      message("a", null, "user", userText("a")),
      message("b", "a", "assistant", userText("b")),
      message("a", "b", "user", userText("a again")), // id collision closes the loop
    ]);
    // The last leaf reuses id "a", so the duplicate wins the id map and the
    // seen-guard halts the walk immediately: no walkable chain, no items —
    // but also no hang and no garbage in the timeline.
    await expect(readOmpTranscript(path, "omp:key1")).resolves.toEqual([]);
  });

  test("text parts join with newlines; tool calls, thinking, and other roles skip", async () => {
    const path = await write("parts.jsonl", [
      titleRow,
      sessionRow,
      message("m1", null, "user", [
        { type: "text", text: "part one" },
        { type: "text", text: "part two" },
        { type: "image", data: "x", mimeType: "image/png" },
      ]),
      message("m2", "m1", "assistant", [thinking("hmm"), toolCall("c1", "bash")]),
      message("m3", "m2", "toolResult", [userText("tool output")]),
    ]);
    await expect(readOmpTranscript(path, "omp:key1")).resolves.toEqual([
      { id: "omp:key1:m1:user_message:0", type: "user_message", text: "part one\npart two" },
    ]);
  });

  test("control rows (title, session, model_change, custom) never become items", async () => {
    const path = await write("controls.jsonl", [
      titleRow,
      sessionRow,
      {
        type: "model_change",
        id: "mc1",
        parentId: null,
        model: "ollama-cloud/glm",
      },
      { type: "custom", id: "c1", parentId: "mc1", customType: "tool_execution_start", data: {} },
      message("m1", "c1", "assistant", userText("only real text")),
    ]);
    await expect(readOmpTranscript(path, "omp:key1")).resolves.toEqual([
      { id: "omp:key1:m1:assistant_message:0", type: "assistant_message", text: "only real text" },
    ]);
  });

  test("torn final JSON line is tolerated", async () => {
    const base = [
      titleRow,
      sessionRow,
      message("e1", null, "user", userText("stable")),
    ];
    const torn = JSON.stringify(message("e2", "e1", "assistant", userText("cut off in the middle")));
    const path = join(dir, "torn.jsonl");
    await writeFile(
      path,
      base.map((line) => JSON.stringify(line)).join("\n") + "\n" + torn.slice(0, 40),
      "utf8",
    );
    await expect(readOmpTranscript(path, "omp:key1")).resolves.toEqual([
      { id: "omp:key1:e1:user_message:0", type: "user_message", text: "stable" },
    ]);
  });

  test("missing file resolves to empty list (path reported before first write)", async () => {
    const missing = join(dir, "does-not-exist.jsonl");
    await expect(readOmpTranscript(missing, "omp:key1")).resolves.toEqual([]);
  });

  test("header-only file resolves to empty list", async () => {
    const path = await write("header-only.jsonl", [sessionRow]);
    await expect(readOmpTranscript(path, "omp:key1")).resolves.toEqual([]);
  });

  test("ids are stable across reads and namespaced by the caller", async () => {
    const path = await write("stable.jsonl", [
      titleRow,
      sessionRow,
      message("e1", null, "user", userText("q")),
    ]);
    const first = await readOmpTranscript(path, "omp:sessA");
    const second = await readOmpTranscript(path, "omp:sessA");
    const otherNamespace = await readOmpTranscript(path, "omp:sessB");
    expect(second).toEqual(first);
    expect(otherNamespace[0]?.id).not.toBe(first[0]?.id);
    expect(first[0]?.id.startsWith("omp:sessA:e1:")).toBe(true);
  });

  test("empty namespace throws TypeError", async () => {
    await expect(readOmpTranscript(join(dir, "x.jsonl"), "")).rejects.toThrow(TypeError);
  });

  test("real captured transcript round-trips (fixture semantics)", async () => {
    // Minimal capture mirroring a real ~18.4.12 file: short ids, session header,
    // mixed roles, custom instrumentation rows interleaved.
    const path = await write("real-like.jsonl", [
      titleRow,
      sessionRow,
      { type: "model_change", id: "ad561dec", parentId: null, model: "ollama-cloud/glm" },
      {
        type: "model_usage",
        id: "72d3b725",
        parentId: "ad561dec",
        role: "assistant",
        model: "ollama-cloud/glm",
        usage: {},
      },
      {
        type: "custom",
        id: "06a0fac1",
        parentId: "f5669f59",
        customType: "tool_execution_start",
        data: { toolName: "bash" },
      },
      message("f5669f59", "bf082ada", "assistant", [
        thinking("The user wants an answer"),
        { type: "text", text: "Here is the answer." },
      ]),
      message("bf082ada", "cf94cd82", "user", userText("Goal: do the thing")),
      {
        type: "custom_message",
        id: "cf94cd82",
        parentId: "72d3b725",
        content: [{ type: "text", text: "injected notice" }],
        customType: "hub",
        display: true,
      },
    ]);
    await expect(readOmpTranscript(path, "omp:nk")).resolves.toEqual([
      { id: "omp:nk:bf082ada:user_message:0", type: "user_message", text: "Goal: do the thing" },
      {
        id: "omp:nk:f5669f59:assistant_message:0",
        type: "assistant_message",
        text: "Here is the answer.",
      },
    ]);
  });
});