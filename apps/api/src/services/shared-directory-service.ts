import { eq, and } from "drizzle-orm";
import { db } from "../db/client.js";
import { repoSharedDirectories, repos } from "../db/schema.js";
import { listPods } from "./agent-pod-pool.js";
import { logger } from "../logger.js";
import { MAX_CACHE_SIZE_PER_DIR_GI, MAX_CACHE_SIZE_TOTAL_GI } from "@optio/shared";

export type SharedDirectory = typeof repoSharedDirectories.$inferSelect;

export interface CreateSharedDirectoryInput {
  repoId: string;
  workspaceId?: string | null;
  name: string;
  description?: string;
  mountLocation: "workspace" | "home";
  mountSubPath: string;
  sizeGi: number;
  scope?: string;
  createdBy?: string;
}

export interface UpdateSharedDirectoryInput {
  description?: string | null;
  sizeGi?: number;
}

const NAME_REGEX = /^[a-z0-9](-?[a-z0-9])*$/;
const SUBPATH_REGEX = /^[a-zA-Z0-9._/-]+$/;

/**
 * Validate shared directory input. Returns error message or null.
 */
export function validateSharedDirectoryInput(input: {
  name: string;
  mountLocation: string;
  mountSubPath: string;
  sizeGi: number;
  scope?: string;
}): string | null {
  const maxSizePerDir = parseInt(
    process.env.OPTIO_CACHE_MAX_SIZE_PER_DIR_GI ?? String(MAX_CACHE_SIZE_PER_DIR_GI),
    10,
  );

  if (!NAME_REGEX.test(input.name) || input.name.length > 40) {
    return "Invalid name: must be 1-40 lowercase alphanumeric characters with optional hyphens";
  }

  if (input.mountLocation !== "workspace" && input.mountLocation !== "home") {
    return "Invalid mount location: must be 'workspace' or 'home'";
  }

  if (input.mountSubPath.startsWith("/")) {
    return "mountSubPath must not start with /";
  }

  if (input.mountSubPath.includes("..")) {
    return "mountSubPath must not contain path traversal (..)";
  }

  if (!SUBPATH_REGEX.test(input.mountSubPath) || input.mountSubPath.length > 200) {
    return "mountSubPath must be 1-200 characters, alphanumeric with . _ / - only";
  }

  if (input.sizeGi < 1) {
    return "sizeGi must be at least 1";
  }

  if (input.sizeGi > maxSizePerDir) {
    return `sizeGi must be at most ${maxSizePerDir}`;
  }

  if (input.scope && input.scope !== "per-pod") {
    return "Only 'per-pod' scope is supported in v1";
  }

  return null;
}

/**
 * Generate the full mount path from location and subpath.
 */
export function getMountPath(mountLocation: string, mountSubPath: string): string {
  if (mountLocation === "home") {
    return `/home/agent/${mountSubPath}`;
  }
  return `/workspace/${mountSubPath}`;
}

/**
 * Generate a PVC name for cache storage.
 */
export function generateCachePvcName(repoUrl: string, instanceIndex: number): string {
  const slug = repoUrl.replace(/[^a-zA-Z0-9]/g, "-").slice(0, 40);
  const suffix = instanceIndex > 0 ? `-${instanceIndex}` : "";
  return `optio-cache-${slug}${suffix}`;
}

/**
 * List all shared directories for a repo.
 */
export async function listSharedDirectories(repoId: string): Promise<SharedDirectory[]> {
  return db.select().from(repoSharedDirectories).where(eq(repoSharedDirectories.repoId, repoId));
}

/**
 * Get a single shared directory by ID.
 */
export async function getSharedDirectory(id: string): Promise<SharedDirectory | null> {
  const [row] = await db
    .select()
    .from(repoSharedDirectories)
    .where(eq(repoSharedDirectories.id, id));
  return row ?? null;
}

/**
 * Create a shared directory entry.
 */
export async function createSharedDirectory(
  input: CreateSharedDirectoryInput,
): Promise<SharedDirectory> {
  const maxSizeTotal = parseInt(
    process.env.OPTIO_CACHE_MAX_SIZE_TOTAL_GI ?? String(MAX_CACHE_SIZE_TOTAL_GI),
    10,
  );

  // Check total size cap across all dirs for this repo
  const existing = await db
    .select()
    .from(repoSharedDirectories)
    .where(eq(repoSharedDirectories.repoId, input.repoId));

  const currentTotalSize = existing.reduce((sum, d) => sum + d.sizeGi, 0);
  if (currentTotalSize + input.sizeGi > maxSizeTotal) {
    throw new Error(
      `Adding ${input.sizeGi}Gi would exceed total cache size limit of ${maxSizeTotal}Gi ` +
        `(current: ${currentTotalSize}Gi)`,
    );
  }

  const [row] = await db
    .insert(repoSharedDirectories)
    .values({
      repoId: input.repoId,
      workspaceId: input.workspaceId ?? undefined,
      name: input.name,
      description: input.description ?? undefined,
      mountLocation: input.mountLocation,
      mountSubPath: input.mountSubPath,
      sizeGi: input.sizeGi,
      scope: input.scope ?? "per-pod",
      createdBy: input.createdBy ?? undefined,
    })
    .returning();
  return row;
}

/**
 * Update a shared directory.
 */
export async function updateSharedDirectory(
  id: string,
  input: UpdateSharedDirectoryInput,
): Promise<SharedDirectory | null> {
  const updates: Record<string, unknown> = { updatedAt: new Date() };
  if (input.description !== undefined) updates.description = input.description;
  if (input.sizeGi !== undefined) updates.sizeGi = input.sizeGi;

  const [row] = await db
    .update(repoSharedDirectories)
    .set(updates)
    .where(eq(repoSharedDirectories.id, id))
    .returning();
  return row ?? null;
}

/**
 * Delete a shared directory entry.
 */
export async function deleteSharedDirectory(id: string): Promise<void> {
  await db.delete(repoSharedDirectories).where(eq(repoSharedDirectories.id, id));
}

/**
 * Get shared directories for a repo by repo URL (used during pod creation).
 */
export async function getSharedDirectoriesForRepo(
  repoUrl: string,
  workspaceId?: string | null,
): Promise<SharedDirectory[]> {
  // Look up the repo to get the repoId
  const conditions = [eq(repos.repoUrl, repoUrl)];
  if (workspaceId) {
    conditions.push(eq(repos.workspaceId, workspaceId));
  }
  const [repo] = await db
    .select({ id: repos.id })
    .from(repos)
    .where(and(...conditions));

  if (!repo) return [];

  return db.select().from(repoSharedDirectories).where(eq(repoSharedDirectories.repoId, repo.id));
}

/**
 * Ensure a cache PVC exists for a given repo pod instance.
 * Creates the PVC if it doesn't exist. Returns the PVC name and volume mounts.
 */
export async function ensureCachePvcForPod(
  repoUrl: string,
  instanceIndex: number,
  sharedDirs: SharedDirectory[],
): Promise<{
  pvcName: string;
  volumeMounts: Array<{ mountPath: string; subPath: string }>;
} | null> {
  if (sharedDirs.length === 0) return null;

  const pvcName = generateCachePvcName(repoUrl, instanceIndex);
  const totalSizeGi = sharedDirs.reduce((sum, d) => sum + d.sizeGi, 0);
  const storageClass = process.env.OPTIO_CACHE_STORAGE_CLASS || undefined;

  try {
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const execFileAsync = promisify(execFile);
    const namespace = process.env.OPTIO_NAMESPACE ?? "optio";

    // Check if PVC already exists
    try {
      await execFileAsync("kubectl", ["get", "pvc", pvcName, "-n", namespace]);
    } catch {
      // PVC doesn't exist, create it
      const storageClassLine = storageClass ? `\n  storageClassName: ${storageClass}` : "";
      const pvcManifest = `apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: ${pvcName}
  namespace: ${namespace}
  labels:
    managed-by: optio
    optio.type: cache-pvc
spec:
  accessModes: [ReadWriteOnce]${storageClassLine}
  resources:
    requests:
      storage: ${totalSizeGi}Gi`;

      await execFileAsync("bash", [
        "-c",
        `echo '${pvcManifest}' | kubectl apply -f - -n ${namespace}`,
      ]);
      logger.info({ pvcName, totalSizeGi }, "Created cache PVC for repo pod");
    }
  } catch (err) {
    logger.warn({ err, pvcName }, "Failed to create cache PVC");
    return null;
  }

  // Build volume mounts — one per shared directory using subPath
  const volumeMounts = sharedDirs.map((dir) => ({
    mountPath: getMountPath(dir.mountLocation, dir.mountSubPath),
    subPath: dir.name,
  }));

  return { pvcName, volumeMounts };
}

/**
 * Clear the contents of a shared directory across all ready pods for a repo.
 */
export async function clearSharedDirectory(dir: SharedDirectory, repoUrl: string): Promise<void> {
  const pods = (await listPods("repo", repoUrl)).filter((p) => p.state === "ready");

  const mountPath = getMountPath(dir.mountLocation, dir.mountSubPath);

  for (const pod of pods) {
    if (!pod.podName) continue;
    try {
      const { execFile } = await import("node:child_process");
      const { promisify } = await import("node:util");
      const execFileAsync = promisify(execFile);
      const namespace = process.env.OPTIO_NAMESPACE ?? "optio";

      await execFileAsync("kubectl", [
        "exec",
        pod.podName,
        "-n",
        namespace,
        "--",
        "sh",
        "-c",
        `rm -rf ${mountPath}/* ${mountPath}/.[!.]* ${mountPath}/..?* 2>/dev/null || true`,
      ]);
      logger.info(
        { podName: pod.podName, mountPath, dirName: dir.name },
        "Cleared shared directory",
      );
    } catch (err) {
      logger.warn(
        { err, podName: pod.podName, dirName: dir.name },
        "Failed to clear shared directory in pod",
      );
    }
  }

  // Update lastClearedAt
  await db
    .update(repoSharedDirectories)
    .set({ lastClearedAt: new Date(), updatedAt: new Date() })
    .where(eq(repoSharedDirectories.id, dir.id));
}

/**
 * Get disk usage for a shared directory in a ready pod.
 */
export async function getSharedDirectoryUsage(
  dir: SharedDirectory,
  repoUrl: string,
): Promise<string | null> {
  const pod = (await listPods("repo", repoUrl)).find((p) => p.state === "ready");

  if (!pod?.podName) return null;

  const mountPath = getMountPath(dir.mountLocation, dir.mountSubPath);

  try {
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const execFileAsync = promisify(execFile);
    const namespace = process.env.OPTIO_NAMESPACE ?? "optio";

    const { stdout } = await execFileAsync("kubectl", [
      "exec",
      pod.podName,
      "-n",
      namespace,
      "--",
      "du",
      "-sh",
      mountPath,
    ]);

    return stdout.split("\t")[0]?.trim() ?? null;
  } catch {
    return null;
  }
}

/**
 * Clean up all cache PVCs for a repo URL.
 */
export async function cleanupCachePvcsForRepo(repoUrl: string): Promise<void> {
  const slug = repoUrl.replace(/[^a-zA-Z0-9]/g, "-").slice(0, 40);
  const pvcPrefix = `optio-cache-${slug}`;
  const namespace = process.env.OPTIO_NAMESPACE ?? "optio";

  try {
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const execFileAsync = promisify(execFile);

    // List PVCs matching the prefix
    const { stdout } = await execFileAsync("kubectl", [
      "get",
      "pvc",
      "-n",
      namespace,
      "-o",
      "jsonpath={.items[*].metadata.name}",
      "-l",
      "optio.type=cache-pvc",
    ]);

    const pvcNames = stdout
      .trim()
      .split(/\s+/)
      .filter((n: string) => n.startsWith(pvcPrefix));

    for (const name of pvcNames) {
      try {
        await execFileAsync("kubectl", [
          "delete",
          "pvc",
          name,
          "-n",
          namespace,
          "--ignore-not-found",
        ]);
        logger.info({ pvcName: name }, "Deleted cache PVC");
      } catch (err) {
        logger.warn({ err, pvcName: name }, "Failed to delete cache PVC");
      }
    }
  } catch (err) {
    logger.warn({ err, repoUrl }, "Failed to cleanup cache PVCs");
  }
}

/**
 * Clean up home PVCs for a repo URL (fixes pre-existing leak).
 */
export async function cleanupHomePvcsForRepo(repoUrl: string): Promise<void> {
  const slug = repoUrl.replace(/[^a-zA-Z0-9]/g, "-").slice(0, 40);
  const pvcPrefix = `optio-home-${slug}`;
  const namespace = process.env.OPTIO_NAMESPACE ?? "optio";

  try {
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const execFileAsync = promisify(execFile);

    // List PVCs matching the prefix
    const { stdout } = await execFileAsync("kubectl", [
      "get",
      "pvc",
      "-n",
      namespace,
      "-o",
      "jsonpath={.items[*].metadata.name}",
      "-l",
      "optio.type=home-pvc",
    ]);

    const pvcNames = stdout
      .trim()
      .split(/\s+/)
      .filter((n: string) => n.startsWith(pvcPrefix));

    for (const name of pvcNames) {
      try {
        await execFileAsync("kubectl", [
          "delete",
          "pvc",
          name,
          "-n",
          namespace,
          "--ignore-not-found",
        ]);
        logger.info({ pvcName: name }, "Deleted home PVC");
      } catch (err) {
        logger.warn({ err, pvcName: name }, "Failed to delete home PVC");
      }
    }
  } catch (err) {
    logger.warn({ err, repoUrl }, "Failed to cleanup home PVCs");
  }
}
