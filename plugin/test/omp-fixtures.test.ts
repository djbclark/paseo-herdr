import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { ompAdapter } from "../server/harness/omp/adapter.js";
import type { TranscriptSnapshot } from "../server/harness/types.js";

/**
 * Behavioral coverage against scrubbed real OMP transcripts (see
 * `fixtures/omp/manifest.json` for provenance and scrubbing rules).
 *
 * These tests assert only consumer-visible adapter mapping: replayed timeline
 * item text/tool state, the native turn outcome, the turn-state derivation,
 * and the observed native ancestry chain. IDs come from the preserved
 * source entries; no source-text assertions and no non-empty/wiring checks.
 */

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "omp");

interface CaseSpec {
  readonly file: string;
  readonly outcome: string;
  readonly turnState: "idle" | "working" | "unknown";
  readonly lastTurnEndId: string;
  readonly itemTypes: readonly string[];
  readonly nativeChainIds: readonly string[];
}

const CASES: readonly CaseSpec[] = [
  {
    file: "plain-chat.jsonl",
    outcome: "completed",
    turnState: "idle",
    lastTurnEndId: "4a5100b7",
    itemTypes: ["user_message", "assistant_message"],
    nativeChainIds: ["90f8dd32", "8cc06acd", "39a407d5", "821d5c25", "4a5100b7", "540f91d4"],
  },
  {
    file: "thinking-tools.jsonl",
    outcome: "completed",
    turnState: "idle",
    lastTurnEndId: "43926997",
    itemTypes: ["user_message", "reasoning", "tool_call", "assistant_message"],
    nativeChainIds: [
      "66bdc059", "5824a487", "8d5dedf3", "e4f37584", "3e42b200",
      "642d762d", "8f060cc5", "35aba334", "43926997",
    ],
  },
  {
    file: "compaction.jsonl",
    outcome: "completed",
    turnState: "idle",
    lastTurnEndId: "3d50dbfc",
    itemTypes: [
      "user_message", "assistant_message", "user_message", "assistant_message",
      "compaction", "user_message", "assistant_message",
    ],
    nativeChainIds: [
      "27bedd00", "b1d852d0", "678c9185", "d1414419", "3ea41fdc",
      "856cff11", "44706af8", "0cebace6", "b820f7df", "ce50c669",
      "1bb28154", "14a20015", "3d50dbfc",
    ],
  },
  {
    file: "abort-empty.jsonl",
    outcome: "aborted",
    turnState: "idle",
    lastTurnEndId: "82cdeda1",
    itemTypes: [
      "user_message", "assistant_message", "user_message", "reasoning",
      "assistant_message", "user_message", "assistant_message", "user_message",
    ],
    nativeChainIds: [
      "cc7897d9", "c510a3f0", "df737607", "93c912cc", "00854ea5",
      "7cd13556", "d4e4901e", "117e4a86", "034ebd7a", "9c765b7f",
      "d108c85f", "54a47408", "82cdeda1", "e657b634",
    ],
  },
  {
    file: "error-empty-prefix.jsonl",
    outcome: "error",
    turnState: "idle",
    lastTurnEndId: "af11fd33",
    itemTypes: ["user_message"],
    nativeChainIds: [
      "d2959012", "fbb9bb5e", "5e41c1fe", "ece96fb6", "5b580534",
      "a1f57501", "485fc907", "dbe5d597", "af11fd33",
    ],
  },
  {
    file: "abort-partial-prefix.jsonl",
    outcome: "aborted",
    turnState: "idle",
    lastTurnEndId: "8659baa5",
    itemTypes: ["user_message", "assistant_message", "user_message", "assistant_message"],
    nativeChainIds: [
      "695e4ca3", "3a526e04", "0acfaab9", "887b270a", "c871e8f9",
      "63036aee", "082b2cad", "21f1cf4d", "8659baa5",
    ],
  },
  {
    file: "custom-message-visible.jsonl",
    outcome: "completed",
    turnState: "idle",
    lastTurnEndId: "59d672c1",
    itemTypes: [
      "user_message", "reasoning", "tool_call", "tool_call", "assistant_message",
      "user_message", "tool_call", "assistant_message", "notification", "assistant_message",
    ],
    nativeChainIds: [
      "0f7ea605", "52450510", "a850fe5a", "e9a6428e", "5fd92fc4", "af98d1aa", "5bdbabdd",
      "d7de1c30", "f5ccecea", "59514729", "a29cf95b", "9c763a8c", "ed5905e5", "15151317",
      "86da0b76", "8f430db4", "0bc401ff", "64520173", "12af6181", "59d672c1",
    ],
  },
];

async function snapshot(file: string): Promise<TranscriptSnapshot> {
  const reader = ompAdapter.openTranscript({ path: join(FIXTURES, file), nativeSessionKey: file });
  try {
    return await reader.snapshot();
  } finally {
    reader.close();
  }
}

describe("OMP captured fixtures", () => {
  for (const spec of CASES) {
    test(`${spec.file} maps to deterministic items, outcome, and ancestry`, async () => {
      const snap = await snapshot(spec.file);
      expect(snap.items.map((item) => item.type)).toEqual([...spec.itemTypes]);
      expect(snap.lastTurnEnd).toBe(spec.outcome);
      expect(snap.turnState).toBe(spec.turnState);
      expect(snap.lastTurnEndId).toBe(spec.lastTurnEndId);
      expect(snap.chainIds).toEqual([...spec.nativeChainIds]);
      expect(snap.chainHead).toBe(spec.nativeChainIds.at(-1));
    });
  }

  test("plain chat preserves user and assistant text and stable entry IDs", async () => {
    const snap = await snapshot("plain-chat.jsonl");
    expect(snap.items.map((item) => ("text" in item ? item.text : null))).toEqual([
      "For G1 plain replay verification only, reply exactly with G1 plain reply 742. Do not use tools.",
      "G1 plain reply 742",
    ]);
    expect(snap.items[0].id).toBe("omp:plain-chat.jsonl:821d5c25:user_message:0");
    expect(snap.items[1].id).toBe("omp:plain-chat.jsonl:4a5100b7:assistant_message:0");
  });

  test("thinking and tools reconcile running and completed rows under one stable id", async () => {
    const snap = await snapshot("thinking-tools.jsonl");
    const tools = snap.items.filter((item) => item.type === "tool_call");
    expect(tools).toHaveLength(1);
    expect(tools.map((item) => item.id)).toHaveLength(new Set(tools.map((item) => item.id)).size);
    expect(tools.map((item) => item.status)).toEqual(["completed"]);
    for (const completed of tools) {
      expect(completed.detail.type).toBe("plain_text");
      if (completed.detail.type === "plain_text") {
        expect(completed.detail.text).toContain("G1 tool marker 815");
      }
    }
    const reasoning = snap.items.find((item) => item.type === "reasoning");
    expect(reasoning && "text" in reasoning && reasoning.text).toContain("Bash Command");
  });

  test("compaction maps a completed row with token counts from the native entry", async () => {
    const snap = await snapshot("compaction.jsonl");
    expect(snap.items.find((item) => item.type === "compaction")).toEqual({
      id: "omp:compaction.jsonl:ce50c669:compaction:0",
      type: "compaction",
      status: "completed",
      preTokens: 17921,
    });
  });

  test("an aborted empty reply adds no text for its own entry", async () => {
    const snap = await snapshot("abort-empty.jsonl");
    expect(snap.lastTurnEnd).toBe("aborted");
    // The aborted assistant entry produced no visible text, so no assistant
    // row carries its native entry id; the last rendered text is the prior turn.
    const assistantRows = snap.items.filter((item) => item.type === "assistant_message");
    expect(assistantRows.some((item) => item.id.includes("82cdeda1"))).toBe(false);
    expect(assistantRows.at(-1)).toMatchObject({ text: "p2 terminal ok" });
    // The aborted assistant entry stays visible in the ancestry chain.
    expect(snap.chainIds).toContain("82cdeda1");
  });

  test("an error reply yields an error outcome and no assistant text row", async () => {
    const snap = await snapshot("error-empty-prefix.jsonl");
    expect(snap.lastTurnEnd).toBe("error");
    expect(snap.items.some((item) => item.type === "assistant_message")).toBe(false);
    expect(snap.chainIds).toContain("af11fd33");
  });

  test("an aborted partial reply keeps its truncated text with the continuation scrubbed", async () => {
    const snap = await snapshot("abort-partial-prefix.jsonl");
    const partial = snap.items.filter((item) => item.type === "assistant_message").at(-1);
    expect(partial).toMatchObject({
      text: "Lighthouses are among humanity’s oldest devices for making dangerous places legible.\n[scrubbed unrelated essay continuation]",
    });
    expect(partial!.id).toContain("8659baa5");
  });

  test("a trailing tool result reports a working turn with no resolved outcome", async () => {
    const snap = await snapshot("thinking-tools-working.jsonl");
    expect(snap.turnState).toBe("working");
    expect(snap.lastTurnEnd).toBeUndefined();
    expect(snap.lastTurnEndId).toBeUndefined();
    expect(snap.items.at(-1)).toMatchObject({ type: "tool_call", status: "completed" });
  });

  test("a header-only /new session replays nothing and is idle with no outcome", async () => {
    const snap = await snapshot("new-header-only.jsonl");
    expect(snap.items).toEqual([]);
    expect(snap.turnState).toBe("idle");
    expect(snap.lastTurnEnd).toBeUndefined();
    expect(snap.lastTurnEndId).toBeUndefined();
    expect(snap.chainIds).toEqual(["0f7ea605", "52450510"]);
  });

  test("a displayable custom message maps to a notification row; hidden ones stay suppressed", async () => {
    const snap = await snapshot("custom-message-visible.jsonl");
    expect(snap.items.filter((item) => item.type === "notification")).toEqual([{
      id: "omp:custom-message-visible.jsonl:12af6181:notification:0",
      type: "notification",
      level: "info",
      message: "Background job bg_2 has completed. Resume your work using the result below.",
    }]);
    // eager-todo-prelude (display:false) stays in the native chain but renders no row.
    expect(snap.chainIds).toContain("5fd92fc4");
    expect(snap.items.some((item) => item.id.includes("5fd92fc4"))).toBe(false);
    // The notice starts a turn with no user entry; its reply is the native turn end.
    expect(snap.items.at(-1)).toMatchObject({ type: "assistant_message", id: "omp:custom-message-visible.jsonl:59d672c1:assistant_message:0" });
  });

  test("scrubbed fixtures carry no personal paths, credentials, or hidden injection text", async () => {
    for (const spec of [...CASES, { file: "new-header-only.jsonl" }]) {
      const raw = await readFile(join(FIXTURES, spec.file), "utf8");
      expect(raw).not.toMatch(/\/home\/|~\/|ollama\.com\/api|encrypted_content|paseo-spike/);
      expect(raw).not.toMatch(/Consider calling `todo`/);
    }
  });
});
