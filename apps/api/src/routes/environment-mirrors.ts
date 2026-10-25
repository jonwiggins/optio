import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { logger } from "../logger.js";

/**
 * Which package mirrors the agent pods have (docs/air-gapped.md): the
 * answer behind the "needs the npm mirror" note on the MCP server forms. With
 * no internet access, an `npx`, `pip` or `uvx` command in an agent pod only
 * works when `agent.env` in the chart points the tool at an Artifactory /
 * Nexus repository, and nothing in the UI would otherwise say so before the
 * run's warning in the log.
 *
 * The variables live in the `<release>-agent-env` ConfigMap, which the API
 * names in `OPTIO_AGENT_ENV_CONFIGMAP` and may read (its role has `get` on
 * configmaps). Outside Kubernetes, or when the read fails, the API's own
 * environment answers (the chart loads the same ConfigMap into the API pod
 * for the turns that run there); failing that, there is no mirror.
 */

export const MirrorsResponseSchema = z
  .object({
    /** `NPM_CONFIG_REGISTRY` (npm, npx, pnpm, yarn). */
    npm: z.boolean(),
    /** `PIP_INDEX_URL` (pip, pipx). */
    pip: z.boolean(),
    /** `UV_DEFAULT_INDEX` or `UV_INDEX_URL` (uv, uvx). */
    uv: z.boolean(),
  })
  .describe("Which package mirrors the agent pods are configured with");

export type Mirrors = z.infer<typeof MirrorsResponseSchema>;

const MIRROR_VARS: Record<keyof Mirrors, readonly string[]> = {
  npm: ["NPM_CONFIG_REGISTRY", "npm_config_registry"],
  pip: ["PIP_INDEX_URL"],
  uv: ["UV_DEFAULT_INDEX", "UV_INDEX_URL"],
};

/**
 * The public registries the tools use when nothing is set: naming one is not
 * a mirror (and pnpm puts npm's into every script's environment, so an API
 * started with `pnpm dev` has it).
 */
const PUBLIC_DEFAULTS = [
  /^https?:\/\/registry\.npmjs\.org\/?$/i,
  /^https?:\/\/pypi\.org\/simple\/?$/i,
];

/** The mirrors a variable bag (a ConfigMap's data, a process environment) declares. */
export function mirrorsFrom(vars: Record<string, string | undefined>): Mirrors {
  const mirror = (value: string | undefined) =>
    !!value?.trim() && !PUBLIC_DEFAULTS.some((re) => re.test(value.trim()));
  const has = (names: readonly string[]) => names.some((n) => mirror(vars[n]));
  return { npm: has(MIRROR_VARS.npm), pip: has(MIRROR_VARS.pip), uv: has(MIRROR_VARS.uv) };
}

/** The agent-env ConfigMap's data, or null when there is none to read. */
async function readAgentEnvConfigMap(
  env: NodeJS.ProcessEnv = process.env,
): Promise<Record<string, string> | null> {
  const name = env.OPTIO_AGENT_ENV_CONFIGMAP?.trim();
  if (!name) return null;
  const namespace = env.OPTIO_NAMESPACE ?? "optio";
  const { KubeConfig, CoreV1Api } = await import("@kubernetes/client-node");
  const kc = new KubeConfig();
  kc.loadFromDefault();
  const cm = await kc.makeApiClient(CoreV1Api).readNamespacedConfigMap({ name, namespace });
  return cm.data ?? {};
}

const CACHE_TTL_MS = 60_000;
let cached: { at: number; mirrors: Mirrors } | null = null;

/** Forget the cached answer (tests). */
export function _resetMirrorsCache(): void {
  cached = null;
}

/** The mirrors the agent pods have, cached a minute (the forms ask on every open). */
export async function detectMirrors(env: NodeJS.ProcessEnv = process.env): Promise<Mirrors> {
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.mirrors;
  let vars: Record<string, string | undefined> | null = null;
  try {
    vars = await readAgentEnvConfigMap(env);
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      "Could not read the agent-env ConfigMap; answering from the API's own environment",
    );
  }
  const mirrors = mirrorsFrom(vars ?? env);
  cached = { at: Date.now(), mirrors };
  return mirrors;
}

export async function environmentMirrorsRoutes(rawApp: FastifyInstance) {
  const app = rawApp.withTypeProvider<ZodTypeProvider>();

  app.get(
    "/api/environment/mirrors",
    {
      schema: {
        operationId: "getEnvironmentMirrors",
        summary: "Which package mirrors agent pods have",
        description:
          "Whether the agent pods are configured with an npm, PyPI (pip) and uv " +
          "package mirror (agent.env in the chart). The MCP server forms warn " +
          "when an install or npx/uvx command would need one that is missing.",
        tags: ["System"],
        response: { 200: MirrorsResponseSchema },
      },
    },
    async () => detectMirrors(),
  );
}
