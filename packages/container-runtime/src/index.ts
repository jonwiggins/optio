export type {
  ContainerRuntime,
  LogOptions,
  ExecOptions,
  RunSignal,
  RunStartInput,
  RunStartResult,
  RunAttachInput,
  RunAttachment,
  RunExit,
  RunStdinInput,
  RunKillInput,
} from "./types.js";
export {
  RUN_STARTED_MARKER,
  RUN_EXIT_MARKER,
  RUN_LOST_MARKER,
  STDIN_EOF_SENTINEL,
  RUN_FILES,
  RUN_STDIN_ENV,
  RUN_DIR_ENV,
  RUN_MARK_ENV_READY_ENV,
  RUN_SIGNALS,
  SUPERVISOR_SCRIPT,
  superviseAgent,
  attachRunScript,
  deliverStdinScript,
  killRunScript,
  parseRunExitLine,
  parseRunStartedPid,
  RunStartError,
  RunDeliverError,
} from "./run-protocol.js";
export { DockerContainerRuntime } from "./docker.js";
export type { DockerRuntimeOptions } from "./docker.js";
export {
  KubernetesContainerRuntime,
  ALLOWED_CAPABILITIES,
  ALLOWED_HOST_PATH_PREFIXES,
} from "./kubernetes.js";
export { FakeContainerRuntime } from "./fake.js";

import type { ContainerRuntime } from "./types.js";
import { DockerContainerRuntime, type DockerRuntimeOptions } from "./docker.js";
import { KubernetesContainerRuntime } from "./kubernetes.js";
import { FakeContainerRuntime } from "./fake.js";

export interface RuntimeConfig {
  type: "docker" | "kubernetes" | "fake";
  docker?: DockerRuntimeOptions;
  kubernetes?: { namespace?: string };
}

export function createRuntime(config: RuntimeConfig): ContainerRuntime {
  switch (config.type) {
    case "docker":
      return new DockerContainerRuntime(config.docker);
    case "kubernetes":
      return new KubernetesContainerRuntime(config.kubernetes?.namespace);
    case "fake":
      // Test-tier double (e2e harness). A deployment misconfigured with
      // OPTIO_RUNTIME=fake would silently "succeed" every agent run, so
      // require an explicit acknowledgement on top of the runtime selection.
      if (process.env.OPTIO_ALLOW_FAKE_RUNTIME !== "1") {
        throw new Error(
          'Runtime type "fake" is a test double; set OPTIO_ALLOW_FAKE_RUNTIME=1 to confirm this is a test environment',
        );
      }
      return new FakeContainerRuntime();
    default:
      throw new Error(`Unknown runtime type: ${config.type}`);
  }
}
