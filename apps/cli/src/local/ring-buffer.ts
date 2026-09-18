/**
 * Byte ring buffer for terminal scrollback. Appends drop the oldest bytes
 * once the capacity is exceeded.
 */
export class RingBuffer {
  private chunks: Buffer[] = [];
  private total = 0;

  constructor(private readonly capacity: number) {}

  append(chunk: Buffer): void {
    if (chunk.length === 0) return;
    this.chunks.push(chunk);
    this.total += chunk.length;
    while (this.total > this.capacity && this.chunks.length > 0) {
      const first = this.chunks[0];
      const excess = this.total - this.capacity;
      if (first.length <= excess) {
        this.chunks.shift();
        this.total -= first.length;
      } else {
        this.chunks[0] = first.subarray(excess);
        this.total -= excess;
      }
    }
  }

  get size(): number {
    return this.total;
  }

  toBuffer(): Buffer {
    return Buffer.concat(this.chunks);
  }

  /** The last `bytes` bytes (or everything, when smaller). */
  tail(bytes: number): Buffer {
    if (this.total <= bytes) return this.toBuffer();
    const out: Buffer[] = [];
    let needed = bytes;
    for (let i = this.chunks.length - 1; i >= 0 && needed > 0; i--) {
      const chunk = this.chunks[i];
      if (chunk.length <= needed) {
        out.unshift(chunk);
        needed -= chunk.length;
      } else {
        out.unshift(chunk.subarray(chunk.length - needed));
        needed = 0;
      }
    }
    return Buffer.concat(out);
  }
}
