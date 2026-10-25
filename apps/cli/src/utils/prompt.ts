import { createInterface } from "node:readline";
import { Writable } from "node:stream";

export interface Prompter {
  /** Ask one question; `hidden` answers (a password) aren't echoed. */
  ask(question: string, opts?: { hidden?: boolean }): Promise<string>;
  close(): void;
}

/**
 * Questions on the terminal: the questions go to stderr (stdout stays the
 * command's output, `--json` included), answers come from stdin — typed, or
 * piped one per line.
 */
export function createPrompter(
  opts: { input?: NodeJS.ReadableStream; output?: NodeJS.WritableStream } = {},
): Prompter {
  const input = opts.input ?? process.stdin;
  const output = opts.output ?? process.stderr;
  let muted = false;
  // readline echoes what is typed through here; a hidden answer is swallowed.
  const echo = new Writable({
    write(chunk, encoding, done) {
      if (!muted) output.write(chunk, encoding);
      done();
    },
  });
  const rl = createInterface({
    input,
    output: echo,
    terminal: Boolean((input as { isTTY?: boolean }).isTTY),
  });
  rl.on("SIGINT", () => {
    output.write("\n");
    process.exit(130);
  });
  // Buffers lines, so answers piped in together all reach their question.
  const lines = rl[Symbol.asyncIterator]();
  return {
    async ask(question, askOpts = {}) {
      output.write(question);
      muted = Boolean(askOpts.hidden);
      try {
        const { value, done } = await lines.next();
        if (done) throw new Error("No answer (stdin closed)");
        return String(value);
      } finally {
        if (muted) output.write("\n");
        muted = false;
      }
    },
    close() {
      rl.close();
    },
  };
}
