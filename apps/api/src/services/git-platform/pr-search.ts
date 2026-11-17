import type { Branch } from "@optio/shared";

/** `branches` with the default branch first, the rest in their given order. */
export function defaultBranchFirst(branches: Branch[]): Branch[] {
  return [...branches.filter((b) => b.default), ...branches.filter((b) => !b.default)];
}

/** `branches` whose name contains `search` (case-insensitive), all when blank. */
export function filterBranches(branches: Branch[], search?: string): Branch[] {
  const q = search?.trim().toLowerCase();
  return q ? branches.filter((b) => b.name.toLowerCase().includes(q)) : branches;
}
