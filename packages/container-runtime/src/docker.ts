import Docker from "dockerode";
import { Readable, Writable } from "node:stream";
import type { ContainerSpec, ContainerHandle, ContainerStatus, ExecSession } from "@optio/shared";
import type {
  ContainerRuntime,
  LogOptions,
  ExecOptions,
  RunAttachInput,
  RunAttachment,
  RunKillInput,
  RunStartInput,
  RunStartResult,
  RunStdinInput,
} from "./types.js";
import { execRunProtocol } from "./run-protocol.js";

export interface DockerRuntimeOptions {
  socketPath?: string;
  host?: string;
  port?: number;
}

export class DockerContainerRuntime implements ContainerRuntime {
  private docker: Docker;

  constructor(opts?: DockerRuntimeOptions) {
    this.docker = new Docker({
      socketPath: opts?.socketPath ?? "/var/run/docker.sock",
      host: opts?.host,
      port: opts?.port,
    });
  }

  async create(spec: ContainerSpec): Promise<ContainerHandle> {
    const container = await this.docker.createContainer({
      Image: spec.image,
      Cmd: spec.command,
      Env: Object.entries(spec.env).map(([k, v]) => `${k}=${v}`),
      WorkingDir: spec.workDir,
      Labels: spec.labels,
      Tty: true,
      OpenStdin: true,
      HostConfig: {
        NanoCpus: spec.cpuLimit ? this.parseCpuLimit(spec.cpuLimit) : undefined,
        Memory: spec.memoryLimit ? this.parseMemoryLimit(spec.memoryLimit) : undefined,
        Binds: spec.volumes
          ?.filter((v): v is typeof v & { hostPath: string } => !!v.hostPath)
          .map((v) => `${v.hostPath}:${v.mountPath}${v.readOnly ? ":ro" : ""}`),
        NetworkMode: spec.networkMode,
      },
    });

    await container.start();

    const info = await container.inspect();
    return {
      id: info.Id,
      name: info.Name.replace(/^\//, ""),
    };
  }

  async status(handle: ContainerHandle): Promise<ContainerStatus> {
    const container = this.docker.getContainer(handle.id);
    const info = await container.inspect();
    const dockerState = info.State;

    let state: ContainerStatus["state"];
    if (dockerState.Running) {
      state = "running";
    } else if (dockerState.ExitCode === 0 && dockerState.Status === "exited") {
      state = "succeeded";
    } else if (dockerState.Status === "exited") {
      state = "failed";
    } else if (dockerState.Status === "created") {
      state = "pending";
    } else {
      state = "unknown";
    }

    return {
      state,
      exitCode: dockerState.ExitCode ?? undefined,
      startedAt: dockerState.StartedAt ? new Date(dockerState.StartedAt) : undefined,
      finishedAt:
        dockerState.FinishedAt && dockerState.FinishedAt !== "0001-01-01T00:00:00Z"
          ? new Date(dockerState.FinishedAt)
          : undefined,
      reason: dockerState.Error || undefined,
    };
  }

  async *logs(handle: ContainerHandle, opts?: LogOptions): AsyncIterable<string> {
    const container = this.docker.getContainer(handle.id);
    const logOpts = {
      stdout: true,
      stderr: true,
      since: opts?.since ? Math.floor(opts.since.getTime() / 1000) : undefined,
      tail: opts?.tail,
      timestamps: true,
    };

    if (opts?.follow) {
      const stream = await container.logs({ ...logOpts, follow: true as const });
      const readable = stream as unknown as NodeJS.ReadableStream;
      let buffer = "";
      for await (const chunk of readable) {
        buffer += chunk.toString();
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          if (line.trim()) yield line;
        }
      }
      if (buffer.trim()) yield buffer;
    } else {
      const stream = await container.logs({ ...logOpts, follow: false as const });
      const text = stream.toString();
      for (const line of text.split("\n")) {
        if (line.trim()) yield line;
      }
    }
  }

  async exec(handle: ContainerHandle, command: string[], opts?: ExecOptions): Promise<ExecSession> {
    const container = this.docker.getContainer(handle.id);
    const exec = await container.exec({
      Cmd: command,
      AttachStdin: true,
      AttachStdout: true,
      AttachStderr: true,
      Tty: opts?.tty ?? true,
    });

    const duplex = await exec.start({
      hijack: true,
      stdin: true,
      Tty: opts?.tty ?? true,
    });

    const stdout = new Readable({
      read() {},
    });
    const stderr = new Readable({
      read() {},
    });

    if (opts?.tty ?? true) {
      duplex.on("data", (chunk: Buffer) => {
        stdout.push(chunk);
      });
    } else {
      // Without a TTY Docker multiplexes both streams over the one socket
      // (8-byte frame headers): split them, so stderr arrives as stderr.
      const out = new Writable({
        write(chunk: Buffer, _enc, cb) {
          stdout.push(chunk);
          cb();
        },
      });
      const err = new Writable({
        write(chunk: Buffer, _enc, cb) {
          stderr.push(chunk);
          cb();
        },
      });
      this.docker.modem.demuxStream(duplex, out, err);
    }
    duplex.on("end", () => {
      stdout.push(null);
      stderr.push(null);
    });

    const stdin = new Writable({
      write(chunk, _encoding, callback) {
        duplex.write(chunk);
        callback();
      },
      // Propagate `.end()` to the underlying docker exec duplex so that
      // callers can signal EOF to the in-container process (keeps behaviour
      // consistent with the kubernetes runtime).
      final(callback) {
        duplex.end();
        callback();
      },
    });

    return {
      stdin,
      stdout,
      stderr,
      resize(cols: number, rows: number) {
        exec.resize({ h: rows, w: cols }).catch(() => {});
      },
      close() {
        duplex.destroy();
        stdout.push(null);
        stderr.push(null);
      },
    };
  }

  // The run protocol (run-protocol.ts), as short execs into the container.

  startRun(handle: ContainerHandle, input: RunStartInput): Promise<RunStartResult> {
    return execRunProtocol.startRun(this, handle, input);
  }

  attachRun(handle: ContainerHandle, input: RunAttachInput): Promise<RunAttachment> {
    return execRunProtocol.attachRun(this, handle, input);
  }

  deliverStdin(handle: ContainerHandle, input: RunStdinInput): Promise<void> {
    return execRunProtocol.deliverStdin(this, handle, input);
  }

  killRun(handle: ContainerHandle, input: RunKillInput): Promise<boolean> {
    return execRunProtocol.killRun(this, handle, input);
  }

  async destroy(handle: ContainerHandle): Promise<void> {
    const container = this.docker.getContainer(handle.id);
    try {
      await container.stop({ t: 10 });
    } catch {
      // Container may already be stopped
    }
    await container.remove({ force: true });
  }

  async ping(): Promise<boolean> {
    try {
      await this.docker.ping();
      return true;
    } catch {
      return false;
    }
  }

  private parseCpuLimit(limit: string): number {
    // "2000m" -> 2000000000 nanocpus
    const match = limit.match(/^(\d+)m$/);
    if (match) return parseInt(match[1], 10) * 1_000_000;
    return parseInt(limit, 10) * 1_000_000_000;
  }

  private parseMemoryLimit(limit: string): number {
    const match = limit.match(/^(\d+)(Mi|Gi)$/);
    if (!match) return parseInt(limit, 10);
    const value = parseInt(match[1], 10);
    return match[2] === "Gi" ? value * 1024 * 1024 * 1024 : value * 1024 * 1024;
  }
}
