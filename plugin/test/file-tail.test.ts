import { mkdtemp, writeFile, appendFile, rm, rename, open, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, it, vi } from "vitest";
import { FileTail } from "../server/file-tail.js";

const roots: string[] = [];
const tails: FileTail[] = [];
afterEach(async () => {
  for (const tail of tails.splice(0)) tail.close();
  vi.useRealTimers();
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});
async function setup() {
  const root = await mkdtemp(join(tmpdir(), "herdr-file-tail-"));
  roots.push(root);
  const path = join(root, "session.jsonl");
  const tail = new FileTail(path, { pollMs: 20 });
  tails.push(tail);
  return { root, path, tail };
}

it("waits for a missing transcript and preserves partial UTF-8 records across appends", async () => {
  const { path, tail } = await setup();
  expect(await tail.snapshot()).toEqual({ lines: [], exists: false });
  const row = Buffer.from('{"text":"é"}\n');
  const split = row.indexOf(Buffer.from("é")) + 1;
  await writeFile(path, row.subarray(0, split));
  expect((await tail.snapshot()).lines).toEqual([]);
  await appendFile(path, row.subarray(split));
  expect((await tail.snapshot()).lines).toEqual(['{"text":"é"}']);
  await appendFile(path, '{"next":true}\n{"partial":');
  expect((await tail.snapshot()).lines).toEqual(['{"text":"é"}', '{"next":true}']);
  await appendFile(path, '1}\n');
  expect((await tail.snapshot()).lines).toEqual(['{"text":"é"}', '{"next":true}', '{"partial":1}']);
});

it("re-reads equal-size title rewrites even when messages also append", async () => {
  const { path, tail } = await setup();
  await writeFile(path, 'old title\nmessage\n');
  const before = await tail.snapshot();
  const file = await open(path, "r+");
  await file.write('new title\n', 0, "utf8");
  await file.close();
  await appendFile(path, 'reply\n');
  expect((await tail.snapshot()).lines).toEqual(['new title', 'message', 'reply']);
  expect(before.lines).toEqual(['old title', 'message']);
  const rewrite = await open(path, "r+");
  await rewrite.write('end title\n', 0, "utf8");
  await rewrite.close();
  expect((await tail.snapshot()).lines).toEqual(['end title', 'message', 'reply']);
});

it("drops stale records after truncation, inode replacement, and deletion", async () => {
  const { root, path, tail } = await setup();
  await writeFile(path, 'header\nold\ntrailing\n');
  await tail.snapshot();
  await writeFile(path, 'header\n');
  expect((await tail.snapshot()).lines).toEqual(['header']);
  const replacement = join(root, "replacement");
  await writeFile(replacement, 'header\nnew\n');
  await rename(replacement, path);
  expect((await tail.snapshot()).lines).toEqual(['header', 'new']);
  await rm(path);
  expect(await tail.snapshot()).toEqual({ lines: [], exists: false });
  await writeFile(path, 'created\n');
  expect((await tail.snapshot()).lines).toEqual(['created']);
});

it("serializes simultaneous snapshots without duplicate lines", async () => {
  const { path, tail } = await setup();
  const row = "x".repeat(80_000);
  await writeFile(path, `${row}\nlast\n`);
  const snapshots = await Promise.all([tail.snapshot(), tail.snapshot(), tail.snapshot()]);
  for (const snapshot of snapshots) expect(snapshot.lines).toEqual([row, "last"]);
});

it("polls a missing parent, observes late creation, and stops notifications on close", async () => {
  const { root } = await setup();
  const parent = join(root, "late");
  const path = join(parent, "session");
  const tail = new FileTail(path, { pollMs: 20 });
  tails.push(tail);
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  const notify = vi.fn();
  tail.subscribe(notify);
  await mkdir(parent);
  await writeFile(path, 'ready\n');
  vi.advanceTimersByTime(20);
  expect(notify).toHaveBeenCalled();
  expect((await tail.snapshot()).lines).toEqual(['ready']);
  tail.close();
  notify.mockClear();
  await appendFile(path, 'later\n');
  vi.advanceTimersByTime(60);
  expect(notify).not.toHaveBeenCalled();
  await expect(tail.snapshot()).rejects.toThrow("closed");
});
