import type { ContainerSpec } from "@optio/shared";

/**
 * Parse a JSON-encoded environment variable, returning `undefined` when unset/empty.
 * Throws a descriptive error (including the variable name and raw value) on malformed JSON
 * so operators can quickly identify typos in values.yaml or Helm overrides.
 */
export function parseJsonEnv(name: string, value: string | undefined): unknown {
  if (!value) return undefined;
  try {
    return JSON.parse(value);
  } catch (err) {
    throw new Error(
      `Invalid JSON in ${name}: ${err instanceof Error ? err.message : err} (raw value: ${value})`,
    );
  }
}

/** Apply deployment scheduling to every pool, including bare pods and Jobs. */
export function agentPodScheduling(): Pick<ContainerSpec, "nodeSelector" | "tolerations"> {
  return {
    nodeSelector: parseJsonEnv(
      "OPTIO_AGENT_NODE_SELECTOR",
      process.env.OPTIO_AGENT_NODE_SELECTOR,
    ) as ContainerSpec["nodeSelector"],
    tolerations: parseJsonEnv(
      "OPTIO_AGENT_TOLERATIONS",
      process.env.OPTIO_AGENT_TOLERATIONS,
    ) as ContainerSpec["tolerations"],
  };
}
