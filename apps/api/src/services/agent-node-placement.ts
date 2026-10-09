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

/** Placement configured by Helm, shared by every agent workload creation path. */
export function agentNodePlacement(): Pick<ContainerSpec, "nodeSelector" | "tolerations"> {
  return {
    ...(process.env.OPTIO_AGENT_NODE_SELECTOR
      ? {
          nodeSelector: parseJsonEnv(
            "OPTIO_AGENT_NODE_SELECTOR",
            process.env.OPTIO_AGENT_NODE_SELECTOR,
          ) as ContainerSpec["nodeSelector"],
        }
      : {}),
    ...(process.env.OPTIO_AGENT_TOLERATIONS
      ? {
          tolerations: parseJsonEnv(
            "OPTIO_AGENT_TOLERATIONS",
            process.env.OPTIO_AGENT_TOLERATIONS,
          ) as ContainerSpec["tolerations"],
        }
      : {}),
  };
}
