const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

export class Spinner {
  private interval: ReturnType<typeof setInterval> | null = null;
  private frameIdx = 0;
  private message: string;

  constructor(message: string) {
    this.message = message;
  }

  start(): this {
    if (!process.stderr.isTTY) return this;
    this.interval = setInterval(() => {
      const frame = FRAMES[this.frameIdx % FRAMES.length];
      process.stderr.write(`\r${frame} ${this.message}`);
      this.frameIdx++;
    }, 80);
    return this;
  }

  stop(finalMessage?: string): void {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
      process.stderr.write("\r" + " ".repeat(this.message.length + 4) + "\r");
    }
    if (finalMessage) {
      process.stderr.write(finalMessage + "\n");
    }
  }
}
