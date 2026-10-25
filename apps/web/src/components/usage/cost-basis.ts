import type { UsageMetrics } from "@optio/shared";
import { formatUsd } from "@optio/shared";

const money = (cost: string | null) => (cost === null ? "Not reported" : formatUsd(Number(cost)));

/**
 * Where the cost tile's number comes from: what the runtimes reported, what
 * Optio estimated from the gateway catalog's prices (docs/model-gateway.md
 * "Usage"), or both.
 */
export function costBasisNote(
  s: Pick<UsageMetrics, "costUsd" | "reportedCostUsd" | "estimatedCostUsd">,
): string {
  const reported = s.reportedCostUsd !== null && Number(s.reportedCostUsd) > 0;
  const estimated = s.estimatedCostUsd !== null && Number(s.estimatedCostUsd) > 0;
  if (estimated && reported) {
    return `${money(s.estimatedCostUsd)} estimated (catalog prices) · ${money(s.reportedCostUsd)} reported`;
  }
  if (estimated) return "Estimated from the catalog's prices";
  if (reported) return "Reported by runtimes";
  return s.costUsd === null ? "No cost recorded" : "Reported by runtimes";
}
