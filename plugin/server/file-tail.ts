import { watch, type FSWatcher } from "node:fs";
import { open } from "node:fs/promises";
import { basename, dirname } from "node:path";

export interface FileTailSnapshot {
  lines: readonly string[];
  updatedAt?: string;
  exists: boolean;
}

/** Complete-line snapshots with incremental append reads and bounded read buffers. */
export class FileTail {
  private lines: string[] = [];
  private partial = Buffer.alloc(0);
  private header = Buffer.alloc(0);
  private offset = 0;
  private identity = "";
  private modified = 0;
  private changed = 0;
  private exists = false;
  private closed = false;
  private reads: Promise<unknown> = Promise.resolve();
  private readonly listeners = new Set<() => void>();
  private watcher?: FSWatcher;
  private timer?: NodeJS.Timeout;
  private readonly pollMs: number;

  constructor(private readonly path: string, options: { pollMs?: number } = {}) {
    this.pollMs = options.pollMs ?? 2000;
    if (!Number.isFinite(this.pollMs) || this.pollMs <= 0) throw new Error("pollMs must be positive");
  }

  snapshot(): Promise<FileTailSnapshot> {
    const read = this.reads.then(() => this.refresh());
    this.reads = read.catch(() => {});
    return read;
  }

  subscribe(listener: () => void): () => void {
    if (this.closed) throw new Error("File tail is closed");
    this.listeners.add(listener);
    if (!this.timer) {
      this.ensureWatcher();
      this.timer = setInterval(() => {
        this.ensureWatcher();
        this.notify();
      }, this.pollMs);
      this.timer.unref();
    }
    return () => {
      this.listeners.delete(listener);
      if (!this.listeners.size) this.stopWatching();
    };
  }

  close(): void {
    this.closed = true;
    this.listeners.clear();
    this.stopWatching();
  }

  private notify(): void {
    if (!this.closed) for (const listener of this.listeners) listener();
  }

  private ensureWatcher(): void {
    if (this.closed || this.watcher) return;
    try {
      this.watcher = watch(dirname(this.path), { persistent: false }, (_event, file) => {
        if (!file || file.toString() === basename(this.path)) this.notify();
      });
      this.watcher.on("error", () => {
        this.watcher?.close();
        this.watcher = undefined;
      });
    } catch {
      // Polling remains active when the parent is absent or this filesystem cannot watch.
    }
  }

  private stopWatching(): void {
    this.watcher?.close();
    this.watcher = undefined;
    clearInterval(this.timer);
    this.timer = undefined;
  }

  private reset(): void {
    this.lines = [];
    this.partial = Buffer.alloc(0);
    this.header = Buffer.alloc(0);
    this.offset = 0;
  }

  private async refresh(): Promise<FileTailSnapshot> {
    if (this.closed) throw new Error("File tail is closed");
    const file = await open(this.path, "r").catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
      return null;
    });
    if (!file) {
      this.reset();
      this.exists = false;
      this.identity = "";
      return { lines: [], exists: false };
    }
    try {
      const stat = await file.stat();
      const identity = `${stat.dev}:${stat.ino}`;
      let reset = !this.exists || this.identity !== identity || stat.size < this.offset;
      if (!reset && stat.size === this.offset &&
          (stat.mtimeMs !== this.modified || stat.ctimeMs !== this.changed)) reset = true;
      if (!reset && this.header.length) {
        const prefix = Buffer.alloc(this.header.length);
        const { bytesRead } = await file.read(prefix, 0, prefix.length, 0);
        reset = bytesRead !== prefix.length || !prefix.equals(this.header);
      }
      if (reset) this.reset();
      const buffer = Buffer.alloc(Math.min(64 * 1024, Math.max(1, stat.size - this.offset)));
      // Bound this refresh to the size observed at open; concurrent appends are read next time.
      while (this.offset < stat.size) {
        const { bytesRead } = await file.read(buffer, 0, Math.min(buffer.length, stat.size - this.offset), this.offset);
        if (!bytesRead) break;
        this.offset += bytesRead;
        const bytes = this.partial.length ? Buffer.concat([this.partial, buffer.subarray(0, bytesRead)]) : buffer.subarray(0, bytesRead);
        let start = 0;
        for (let end = bytes.indexOf(10, start); end !== -1; end = bytes.indexOf(10, start)) {
          if (!this.header.length) this.header = Buffer.from(bytes.subarray(start, end + 1));
          this.lines.push(bytes.subarray(start, end).toString("utf8").replace(/\r$/, ""));
          start = end + 1;
        }
        this.partial = Buffer.from(bytes.subarray(start));
      }
      if (this.closed) throw new Error("File tail is closed");
      this.identity = identity;
      this.exists = true;
      this.modified = stat.mtimeMs;
      this.changed = stat.ctimeMs;
      return { lines: [...this.lines], exists: true, updatedAt: stat.mtime.toISOString() };
    } finally {
      await file.close();
    }
  }
}
