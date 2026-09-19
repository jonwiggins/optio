import { closeSync, fstatSync, openSync, readSync } from "node:fs";

/**
 * Incremental reader for an append-only JSONL file (Claude Code's session
 * transcript). Remembers the byte offset consumed so far and the trailing
 * partial line, so each call only parses what was appended since the last
 * one; a file that shrank (rewritten) is re-read from the top.
 */

const READ_CHUNK = 1 << 20;

export class JsonlTail {
  private offset = 0;
  private carry = "";

  constructor(readonly path: string) {}

  /** Feed every complete new line to `onLine`. Returns the number of lines read. */
  readNew(onLine: (line: string) => void): number {
    let fd: number;
    try {
      fd = openSync(this.path, "r");
    } catch {
      return 0; // not there (yet) — the next call retries
    }
    let lines = 0;
    try {
      const size = fstatSync(fd).size;
      if (size < this.offset) {
        this.offset = 0;
        this.carry = "";
      }
      if (size === this.offset) return 0;
      const buf = Buffer.allocUnsafe(READ_CHUNK);
      while (this.offset < size) {
        const n = readSync(fd, buf, 0, READ_CHUNK, this.offset);
        if (n <= 0) break;
        this.offset += n;
        const text = this.carry + buf.toString("utf-8", 0, n);
        const parts = text.split("\n");
        this.carry = parts.pop() ?? "";
        for (const line of parts) {
          if (!line.trim()) continue;
          lines++;
          onLine(line);
        }
      }
    } finally {
      closeSync(fd);
    }
    return lines;
  }
}
