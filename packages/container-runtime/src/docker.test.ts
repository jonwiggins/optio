import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ContainerSpec } from "@optio/shared";

/* ------------------------------------------------------------------ */
/* Mock dockerode                                                     */
/* ------------------------------------------------------------------ */

const mockContainer = {
  start: vi.fn().mockResolvedValue(undefined),
  inspect: vi.fn(),
  logs: vi.fn(),
  exec: vi.fn(),
  stop: vi.fn().mockResolvedValue(undefined),
  remove: vi.fn().mockResolvedValue(undefined),
};

const mockDocker = {
  createContainer: vi.fn().mockResolvedValue(mockContainer),
  getContainer: vi.fn().mockReturnValue(mockContainer),
  ping: vi.fn().mockResolvedValue("OK"),
};

vi.mock("dockerode", () => ({
  default: vi.fn().mockImplementation(function () {
    return mockDocker;
  }),
}));

import Docker from "dockerode";
import { DockerContainerRuntime } from "./docker.js";

/* ------------------------------------------------------------------ */
/* Helpers                                                            */
/* ------------------------------------------------------------------ */

function makeSpec(overrides: Partial<ContainerSpec> = {}): ContainerSpec {
  return {
    image: "optio-agent:latest",
    command: ["/bin/bash", "-c", "sleep infinity"],
    env: { FOO: "bar", BAZ: "qux" },
    workDir: "/workspace",
    labels: { "optio.task": "123" },
    ...overrides,
  };
}

/* ------------------------------------------------------------------ */
/* Tests                                                              */
/* ------------------------------------------------------------------ */

beforeEach(() => {
  vi.clearAllMocks();
  // Reset default inspect return for create
  mockContainer.inspect.mockResolvedValue({
    Id: "abc123",
    Name: "/my-container",
    State: {},
  });
});

describe("DockerContainerRuntime", () => {
  /* -------------------------------------------------------------- */
  /* constructor                                                     */
  /* -------------------------------------------------------------- */
  describe("constructor", () => {
    it("uses default socket path /var/run/docker.sock", () => {
      new DockerContainerRuntime();
      expect(Docker).toHaveBeenCalledWith(
        expect.objectContaining({ socketPath: "/var/run/docker.sock" }),
      );
    });

    it("accepts custom host and port", () => {
      new DockerContainerRuntime({ host: "tcp://remote", port: 2375 });
      expect(Docker).toHaveBeenCalledWith(
        expect.objectContaining({ host: "tcp://remote", port: 2375 }),
      );
    });
  });

  /* -------------------------------------------------------------- */
  /* create                                                          */
  /* -------------------------------------------------------------- */
  describe("create", () => {
    it("creates and starts container with correct options", async () => {
      const runtime = new DockerContainerRuntime();
      const spec = makeSpec();

      await runtime.create(spec);

      expect(mockDocker.createContainer).toHaveBeenCalledWith(
        expect.objectContaining({
          Image: "optio-agent:latest",
          Entrypoint: ["/bin/bash", "-c", "sleep infinity"],
          WorkingDir: "/workspace",
          Labels: { "optio.task": "123" },
          Tty: true,
          OpenStdin: true,
        }),
      );
      expect(mockContainer.start).toHaveBeenCalled();
    });

    it("maps env from Record to KEY=value format", async () => {
      const runtime = new DockerContainerRuntime();
      await runtime.create(makeSpec({ env: { NODE_ENV: "production", PORT: "3000" } }));

      const call = mockDocker.createContainer.mock.calls[0][0];
      expect(call.Env).toEqual(["NODE_ENV=production", "PORT=3000"]);
    });

    it("maps volumes to HostConfig.Binds with :ro suffix for readOnly", async () => {
      const runtime = new DockerContainerRuntime();
      await runtime.create(
        makeSpec({
          volumes: [
            { hostPath: "/host/data", mountPath: "/container/data", readOnly: true },
            { hostPath: "/host/config", mountPath: "/container/config" },
          ],
        }),
      );

      const call = mockDocker.createContainer.mock.calls[0][0];
      expect(call.HostConfig.Binds).toEqual([
        "/host/data:/container/data:ro",
        "/host/config:/container/config",
      ]);
    });

    it("parses CPU limit from millicores (2000m -> 2_000_000_000 NanoCpus)", async () => {
      const runtime = new DockerContainerRuntime();
      await runtime.create(makeSpec({ cpuLimit: "2000m" }));

      const call = mockDocker.createContainer.mock.calls[0][0];
      expect(call.HostConfig.NanoCpus).toBe(2_000_000_000);
    });

    it("parses CPU limit from whole cores (2 -> 2_000_000_000)", async () => {
      const runtime = new DockerContainerRuntime();
      await runtime.create(makeSpec({ cpuLimit: "2" }));

      const call = mockDocker.createContainer.mock.calls[0][0];
      expect(call.HostConfig.NanoCpus).toBe(2_000_000_000);
    });

    it("parses memory limit in Mi (512Mi -> 536870912)", async () => {
      const runtime = new DockerContainerRuntime();
      await runtime.create(makeSpec({ memoryLimit: "512Mi" }));

      const call = mockDocker.createContainer.mock.calls[0][0];
      expect(call.HostConfig.Memory).toBe(536870912);
    });

    it("parses memory limit in Gi (2Gi -> 2147483648)", async () => {
      const runtime = new DockerContainerRuntime();
      await runtime.create(makeSpec({ memoryLimit: "2Gi" }));

      const call = mockDocker.createContainer.mock.calls[0][0];
      expect(call.HostConfig.Memory).toBe(2147483648);
    });

    it("strips leading / from container name in returned handle", async () => {
      mockContainer.inspect.mockResolvedValue({
        Id: "abc123",
        Name: "/my-container",
        State: {},
      });

      const runtime = new DockerContainerRuntime();
      const handle = await runtime.create(makeSpec());

      expect(handle.name).toBe("my-container");
      expect(handle.id).toBe("abc123");
    });

    it("passes networkMode in HostConfig", async () => {
      const runtime = new DockerContainerRuntime();
      await runtime.create(makeSpec({ networkMode: "host" }));

      const call = mockDocker.createContainer.mock.calls[0][0];
      expect(call.HostConfig.NetworkMode).toBe("host");
    });
  });

  /* -------------------------------------------------------------- */
  /* status                                                          */
  /* -------------------------------------------------------------- */
  describe("status", () => {
    const handle = { id: "abc123", name: "my-container" };

    it("maps Running=true to running", async () => {
      mockContainer.inspect.mockResolvedValue({
        State: { Running: true, Status: "running", ExitCode: 0, StartedAt: "2025-01-01T00:00:00Z" },
      });

      const runtime = new DockerContainerRuntime();
      const status = await runtime.status(handle);

      expect(status.state).toBe("running");
    });

    it("maps exited with exit code 0 to succeeded", async () => {
      mockContainer.inspect.mockResolvedValue({
        State: { Running: false, Status: "exited", ExitCode: 0 },
      });

      const runtime = new DockerContainerRuntime();
      const status = await runtime.status(handle);

      expect(status.state).toBe("succeeded");
    });

    it("maps exited with non-zero exit code to failed", async () => {
      mockContainer.inspect.mockResolvedValue({
        State: { Running: false, Status: "exited", ExitCode: 1 },
      });

      const runtime = new DockerContainerRuntime();
      const status = await runtime.status(handle);

      expect(status.state).toBe("failed");
    });

    it("maps created to pending", async () => {
      mockContainer.inspect.mockResolvedValue({
        State: { Running: false, Status: "created", ExitCode: 0 },
      });

      const runtime = new DockerContainerRuntime();
      const status = await runtime.status(handle);

      expect(status.state).toBe("pending");
    });

    it("maps unknown status to unknown", async () => {
      mockContainer.inspect.mockResolvedValue({
        State: { Running: false, Status: "paused", ExitCode: 0 },
      });

      const runtime = new DockerContainerRuntime();
      const status = await runtime.status(handle);

      expect(status.state).toBe("unknown");
    });

    it("returns exitCode, startedAt, finishedAt", async () => {
      mockContainer.inspect.mockResolvedValue({
        State: {
          Running: false,
          Status: "exited",
          ExitCode: 137,
          StartedAt: "2025-06-01T12:00:00Z",
          FinishedAt: "2025-06-01T12:05:00Z",
        },
      });

      const runtime = new DockerContainerRuntime();
      const status = await runtime.status(handle);

      expect(status.exitCode).toBe(137);
      expect(status.startedAt).toEqual(new Date("2025-06-01T12:00:00Z"));
      expect(status.finishedAt).toEqual(new Date("2025-06-01T12:05:00Z"));
    });

    it("ignores zero-value FinishedAt (0001-01-01T00:00:00Z)", async () => {
      mockContainer.inspect.mockResolvedValue({
        State: {
          Running: true,
          Status: "running",
          ExitCode: 0,
          StartedAt: "2025-06-01T12:00:00Z",
          FinishedAt: "0001-01-01T00:00:00Z",
        },
      });

      const runtime = new DockerContainerRuntime();
      const status = await runtime.status(handle);

      expect(status.finishedAt).toBeUndefined();
    });

    it("returns reason from Error field", async () => {
      mockContainer.inspect.mockResolvedValue({
        State: {
          Running: false,
          Status: "exited",
          ExitCode: 137,
          Error: "OOMKilled",
        },
      });

      const runtime = new DockerContainerRuntime();
      const status = await runtime.status(handle);

      expect(status.reason).toBe("OOMKilled");
    });
  });

  /* -------------------------------------------------------------- */
  /* logs                                                            */
  /* -------------------------------------------------------------- */
  describe("logs", () => {
    const handle = { id: "abc123", name: "my-container" };

    it("yields lines from non-follow log output", async () => {
      mockContainer.logs.mockResolvedValue({
        toString: () => "line1\nline2\nline3\n",
      });

      const runtime = new DockerContainerRuntime();
      const lines: string[] = [];
      for await (const line of runtime.logs(handle)) {
        lines.push(line);
      }

      expect(lines).toEqual(["line1", "line2", "line3"]);
      expect(mockContainer.logs).toHaveBeenCalledWith(
        expect.objectContaining({ follow: false, stdout: true, stderr: true, timestamps: true }),
      );
    });

    it("handles follow mode (async iteration)", async () => {
      async function* generate() {
        yield Buffer.from("streamed-line-1\n");
        yield Buffer.from("streamed-line-2\n");
      }

      mockContainer.logs.mockResolvedValue(generate());

      const runtime = new DockerContainerRuntime();
      const lines: string[] = [];
      for await (const line of runtime.logs(handle, { follow: true })) {
        lines.push(line);
      }

      expect(lines).toEqual(["streamed-line-1", "streamed-line-2"]);
      expect(mockContainer.logs).toHaveBeenCalledWith(expect.objectContaining({ follow: true }));
    });
  });

  /* -------------------------------------------------------------- */
  /* exec                                                            */
  /* -------------------------------------------------------------- */
  describe("exec", () => {
    const handle = { id: "abc123", name: "my-container" };

    it("creates exec with Cmd, AttachStdin, AttachStdout, AttachStderr, Tty", async () => {
      const mockDuplex = {
        on: vi.fn(),
        write: vi.fn(),
        destroy: vi.fn(),
      };
      const mockExec = {
        start: vi.fn().mockResolvedValue(mockDuplex),
        resize: vi.fn().mockResolvedValue(undefined),
      };
      mockContainer.exec.mockResolvedValue(mockExec);

      const runtime = new DockerContainerRuntime();
      await runtime.exec(handle, ["bash", "-c", "echo hello"]);

      expect(mockContainer.exec).toHaveBeenCalledWith({
        Cmd: ["bash", "-c", "echo hello"],
        AttachStdin: true,
        AttachStdout: true,
        AttachStderr: true,
        Tty: true,
      });
    });

    it("starts with hijack and stdin", async () => {
      const mockDuplex = {
        on: vi.fn(),
        write: vi.fn(),
        destroy: vi.fn(),
      };
      const mockExec = {
        start: vi.fn().mockResolvedValue(mockDuplex),
        resize: vi.fn().mockResolvedValue(undefined),
      };
      mockContainer.exec.mockResolvedValue(mockExec);

      const runtime = new DockerContainerRuntime();
      await runtime.exec(handle, ["bash"]);

      expect(mockExec.start).toHaveBeenCalledWith(
        expect.objectContaining({ hijack: true, stdin: true }),
      );
    });

    it("resize calls exec.resize with {h, w}", async () => {
      const mockDuplex = {
        on: vi.fn(),
        write: vi.fn(),
        destroy: vi.fn(),
      };
      const mockExec = {
        start: vi.fn().mockResolvedValue(mockDuplex),
        resize: vi.fn().mockResolvedValue(undefined),
      };
      mockContainer.exec.mockResolvedValue(mockExec);

      const runtime = new DockerContainerRuntime();
      const session = await runtime.exec(handle, ["bash"]);
      session.resize(120, 40);

      expect(mockExec.resize).toHaveBeenCalledWith({ h: 40, w: 120 });
    });

    it("close destroys the duplex stream", async () => {
      const mockDuplex = {
        on: vi.fn(),
        write: vi.fn(),
        destroy: vi.fn(),
      };
      const mockExec = {
        start: vi.fn().mockResolvedValue(mockDuplex),
        resize: vi.fn().mockResolvedValue(undefined),
      };
      mockContainer.exec.mockResolvedValue(mockExec);

      const runtime = new DockerContainerRuntime();
      const session = await runtime.exec(handle, ["bash"]);
      session.close();

      expect(mockDuplex.destroy).toHaveBeenCalled();
    });
  });

  /* -------------------------------------------------------------- */
  /* destroy                                                         */
  /* -------------------------------------------------------------- */
  describe("destroy", () => {
    const handle = { id: "abc123", name: "my-container" };

    it("stops then removes container with force", async () => {
      const runtime = new DockerContainerRuntime();
      await runtime.destroy(handle);

      expect(mockContainer.stop).toHaveBeenCalledWith({ t: 10 });
      expect(mockContainer.remove).toHaveBeenCalledWith({ force: true });
    });

    it("handles already-stopped container (stop throws, remove still called)", async () => {
      mockContainer.stop.mockRejectedValueOnce(new Error("container already stopped"));

      const runtime = new DockerContainerRuntime();
      await runtime.destroy(handle);

      expect(mockContainer.stop).toHaveBeenCalled();
      expect(mockContainer.remove).toHaveBeenCalledWith({ force: true });
    });
  });

  /* -------------------------------------------------------------- */
  /* ping                                                            */
  /* -------------------------------------------------------------- */
  describe("ping", () => {
    it("returns true on success", async () => {
      mockDocker.ping.mockResolvedValue("OK");

      const runtime = new DockerContainerRuntime();
      const result = await runtime.ping();

      expect(result).toBe(true);
    });

    it("returns false on failure", async () => {
      mockDocker.ping.mockRejectedValue(new Error("connection refused"));

      const runtime = new DockerContainerRuntime();
      const result = await runtime.ping();

      expect(result).toBe(false);
    });
  });
});
