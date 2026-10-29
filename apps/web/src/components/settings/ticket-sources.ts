import { featureAllows, type DeploymentFeatures } from "@optio/shared";
export interface TicketSourceOption {
  value: string;
  label: string;
}
/** Narrow the existing settings choices without adding sources to the default UI. */
export function ticketSourceOptions<T extends TicketSourceOption>(
  builtIn: readonly T[],
  features: DeploymentFeatures,
): T[] {
  return builtIn.filter((source) => featureAllows("ticketSources", source.value, features));
}
