/** A change-request URL names a merge request on any GitLab host. */
export function isMergeRequest(prUrl: unknown): boolean {
  return typeof prUrl === "string" && /\/merge_requests\/\d+/.test(prUrl);
}

/** "MR" or "PR", for a short label. */
export function changeRequestAbbrev(prUrl: unknown): "MR" | "PR" {
  return isMergeRequest(prUrl) ? "MR" : "PR";
}
