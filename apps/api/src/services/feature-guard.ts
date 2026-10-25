/**
 * The deployment's feature lists' one refusal (packages/shared/src/config/features.ts).
 *
 * Routes, zod refinements and services that accept a runtime, a git
 * platform, a trigger, a ticket source or a connection provider call these
 * checks next to their own validation, so a value an admin left out of a
 * list is a 400 "<value> isn't available in this deployment" everywhere alike.
 *
 * Only values Optio knows are refused: with the lists unset (the default)
 * every check passes, and an unknown value is left to the caller's own
 * validation, so upstream behaviour (and its error messages) stays as it was.
 */
import {
  AGENT_TYPES,
  ALL_FEATURES,
  featureAllows,
  featureFilter,
  providerForAgentType,
  type AgentProviderId,
  type FeatureList,
} from "@optio/shared";
import type { RefinementCtx } from "zod";

/** A value the deployment doesn't offer (a 400 for the caller). */
export class FeatureUnavailableError extends Error {
  readonly statusCode = 400;
  constructor(
    readonly feature: FeatureList,
    readonly value: string,
  ) {
    super(unavailableMessage(value));
    this.name = "FeatureUnavailableError";
  }
}

export function unavailableMessage(value: string): string {
  return `${value} isn't available in this deployment`;
}

/**
 * Why `value` can't be used here, or null when it can: nothing chosen, the
 * deployment offers it, or it isn't one Optio knows (the caller's own
 * validation answers for those).
 */
export function featureRefusal(
  feature: FeatureList,
  value: string | null | undefined,
): string | null {
  if (value === null || value === undefined || value === "") return null;
  const known = ALL_FEATURES[feature].includes(value);
  if (!known || featureAllows(feature, value)) return null;
  return unavailableMessage(value);
}

function assertAllowed(feature: FeatureList, value: string | null | undefined): void {
  if (featureRefusal(feature, value)) throw new FeatureUnavailableError(feature, value!);
}

export const runtimeRefusal = (v: string | null | undefined) => featureRefusal("runtimes", v);
export const platformRefusal = (v: string | null | undefined) => featureRefusal("gitPlatforms", v);
export const triggerRefusal = (v: string | null | undefined) => featureRefusal("triggers", v);
export const ticketSourceRefusal = (v: string | null | undefined) =>
  featureRefusal("ticketSources", v);
/** Built-in connection provider slugs that the list names differently. */
const CONNECTION_PROVIDER_FEATURE: Record<string, string> = { "github-enhanced": "github" };
export const connectionProviderRefusal = (v: string | null | undefined) =>
  v && featureRefusal("connectionProviders", CONNECTION_PROVIDER_FEATURE[v] ?? v)
    ? unavailableMessage(v)
    : null;

export const assertRuntimeAllowed = (v: string | null | undefined) => assertAllowed("runtimes", v);
export const assertPlatformAllowed = (v: string | null | undefined) =>
  assertAllowed("gitPlatforms", v);
export const assertTriggerAllowed = (v: string | null | undefined) => assertAllowed("triggers", v);
export const assertTicketSourceAllowed = (v: string | null | undefined) =>
  assertAllowed("ticketSources", v);
export const assertConnectionProviderAllowed = (v: string | null | undefined) => {
  if (connectionProviderRefusal(v)) throw new FeatureUnavailableError("connectionProviders", v!);
};

/** A zod `superRefine` that refuses what the deployment leaves out of `feature`. */
export function refineFeature(feature: FeatureList) {
  return (value: string | null | undefined, ctx: RefinementCtx): void => {
    const refusal = featureRefusal(feature, value);
    if (refusal) ctx.addIssue({ code: "custom", message: refusal });
  };
}

/** The agent provider catalogs (`AgentProviderId`s) the offered runtimes use. */
export function offeredProviderIds(): AgentProviderId[] {
  return [...new Set(featureFilter("runtimes", AGENT_TYPES).map(providerForAgentType))];
}

/** Whether a provider catalog belongs to one of the offered runtimes. */
export function providerAllowed(provider: string): boolean {
  return offeredProviderIds().includes(provider as AgentProviderId);
}

/**
 * `app` when the deployment offers `trigger` (always, unless an admin
 * narrowed `OPTIO_TRIGGERS`), otherwise a stand-in whose `post` registers
 * nothing: the receiver of a trigger left out never exists, so a delivery
 * to it answers 404.
 */
export function receiverFor<A extends { post: (...args: never[]) => unknown }>(
  app: A,
  trigger: string,
): A {
  if (featureAllows("triggers", trigger)) return app;
  return { post: () => undefined } as unknown as A;
}
