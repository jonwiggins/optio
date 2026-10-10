import type { ContainerSpec, ContainerHandle, ContainerStatus, ExecSession } from "@optio/shared";
import type { Readable } from "node:stream";

export interface LogOptions {
  follow?: boolean;
  since?: Date;
  tail?: number;
}

export interface ExecOptions {
  tty?: boolean;
  cols?: number;
  rows?: number;
}

/** A signal `killRun` may send to a run's process group. */
export type RunSignal = "TERM" | "KILL" | "INT" | "HUP";

export interface RunStartInput {
  /** Optio's id for the run (a task, Job run, turn or review run id). */
  runId: string;
  /** The run's directory in the container (its run home). */
  runDir: string;
  /**
   * The start script: the caller's setup, ending with `superviseAgent()`
   * (run-protocol.ts), which launches the agent detached and prints
   * `__OPTIO_RUN_STARTED__:<pid>`.
   */
  script: string;
  /**
   * The run's first stdin lines (for Claude Code, the first stream-json user
   * message), written to the run's stdin file before the agent starts.
   */
  initialStdin: string;
}

export interface RunStartResult {
  /** The supervisor's pid: a process-group leader in the container. */
  pid: number;
  /** What the start script printed before the agent launched (setup lines). */
  output: string;
}

export interface RunAttachInput {
  runId: string;
  runDir: string;
  /** Stream the output file from this byte offset (0 = from the start). */
  fromByte: number;
}

/** How an attachment ended. */
export type RunExit =
  /** The agent exited; `exit` holds its code. */
  | { kind: "exited"; code: number }
  /** The run's files or supervisor are gone (the pod restarted). */
  | { kind: "lost" }
  /** The attachment was closed, or its exec dropped, while the agent may still run. */
  | { kind: "detached"; reason: "closed" | "stream-ended" };

export interface RunAttachment {
  /** The output file's bytes from `fromByte` on, exactly, as they arrive. */
  output: Readable;
  /** Resolves once `output` has ended. */
  exit: Promise<RunExit>;
  /** Detach: sever the exec. The agent keeps running. */
  close(): void;
}

export interface RunStdinInput {
  runId: string;
  runDir: string;
  /** One line, without its newline. */
  line: string;
}

export interface RunKillInput {
  runId: string;
  runDir: string;
  signal: RunSignal;
}

export interface ContainerRuntime {
  create(spec: ContainerSpec): Promise<ContainerHandle>;
  status(handle: ContainerHandle): Promise<ContainerStatus>;
  logs(handle: ContainerHandle, opts?: LogOptions): AsyncIterable<string>;
  exec(handle: ContainerHandle, command: string[], opts?: ExecOptions): Promise<ExecSession>;
  destroy(handle: ContainerHandle): Promise<void>;
  ping(): Promise<boolean>;

  // The run protocol (run-protocol.ts): an agent run that no API process has
  // to stay attached to.

  /** Starts a run: runs the start script, which launches the agent detached. */
  startRun(handle: ContainerHandle, input: RunStartInput): Promise<RunStartResult>;
  /** Attaches to a run's output from a byte offset until the agent exits. */
  attachRun(handle: ContainerHandle, input: RunAttachInput): Promise<RunAttachment>;
  /** Appends a line to the run's stdin. */
  deliverStdin(handle: ContainerHandle, input: RunStdinInput): Promise<void>;
  /** Signals the run's process group; true when something was there to signal. */
  killRun(handle: ContainerHandle, input: RunKillInput): Promise<boolean>;
}
