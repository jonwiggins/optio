/**
 * Workspaces as code (docs/workspaces-as-code.md): `kind: Workspace`
 * manifests, applied with deployment authority. Per manifest: create the
 * workspace when no workspace has its slug, else bring the display name,
 * description and settings the file names into line; add the members it
 * lists (by verified email) and set their roles; register and configure its
 * repos through the workspace-level apply (the `Repo` kind, a plain upsert).
 *
 * What a file doesn't say is left alone: settings it doesn't name, members it
 * doesn't list (unless `prune: true`), repos it doesn't list, and workspaces
 * it doesn't mention. Nothing here deletes a workspace or a repo. `dryRun`
 * plans and writes nothing. Each manifest is its own unit: one bad file is
 * one error item, the rest still apply.
 */
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import {
  MANIFEST_API_VERSION,
  WORKSPACE_MANIFEST_KIND,
  normalizeRepoUrl,
  stableStringify,
  type ConfigApplyResult,
  type ConfigPlanItem,
  type ExportedWorkspaceManifest,
  type ManifestInput,
  type RepoManifestSpec,
  type WorkspaceManifest,
  type WorkspaceManifestRole,
} from "@optio/shared";
import { db } from "../../db/client.js";
import { users, workspaceMembers, workspaces } from "../../db/schema.js";
import { logger } from "../../logger.js";
import { WorkspaceManifestSchema } from "../../schemas/config.js";
import {
  WorkspaceSettingsError,
  addMember,
  createWorkspace,
  normalizeAutoJoinDomains,
  removeMember,
  updateMemberRole,
  updateWorkspace,
} from "../workspace-service.js";
import { applyManifests, summarize } from "./apply.js";
import { exportManifests } from "./export.js";

type WorkspaceRow = typeof workspaces.$inferSelect;
type Settings = NonNullable<WorkspaceManifest["spec"]["settings"]>;

const SETTING_KEYS = [
  "allowDockerInDocker",
  "autoJoinDomains",
  "autoJoinRole",
  "restrictPodSecrets",
] as const satisfies ReadonlyArray<keyof Settings>;

export interface WorkspaceApplyOptions {
  manifests: ManifestInput[];
  dryRun: boolean;
}

/** A problem with one workspace manifest: reported for it, the apply goes on. */
class WorkspaceManifestError extends Error {}

function labelOf(document: unknown): string {
  const doc = (document ?? {}) as { metadata?: { name?: unknown } };
  return typeof doc.metadata?.name === "string" ? doc.metadata.name : "?";
}

function errorItem(path: string, name: string, message: string): ConfigPlanItem {
  return { kind: WORKSPACE_MANIFEST_KIND, name, path, action: "error", message, workspace: name };
}

function parse(inputs: ManifestInput[]): {
  parsed: Array<{ path: string; manifest: WorkspaceManifest }>;
  items: ConfigPlanItem[];
} {
  const parsed: Array<{ path: string; manifest: WorkspaceManifest }> = [];
  const items: ConfigPlanItem[] = [];
  const seen = new Set<string>();
  for (const input of inputs) {
    const name = labelOf(input.document);
    const result = WorkspaceManifestSchema.safeParse(input.document);
    if (!result.success) {
      const problems = result.error.issues
        .slice(0, 5)
        .map((i) => `${i.path.join(".") || "document"}: ${i.message}`)
        .join("; ");
      items.push(errorItem(input.path, name, problems));
      continue;
    }
    const manifest = result.data as WorkspaceManifest;
    if (seen.has(manifest.metadata.name)) {
      items.push(errorItem(input.path, name, `Workspace "${name}" is declared more than once`));
      continue;
    }
    seen.add(manifest.metadata.name);
    parsed.push({ path: input.path, manifest });
  }
  return { parsed, items };
}

/** The settings the file names, normalized the way the workspace stores them. */
function desiredSettings(settings: Settings | undefined): Partial<Settings> {
  const out: Partial<Settings> = {};
  if (!settings) return out;
  for (const key of SETTING_KEYS) {
    if (settings[key] === undefined) continue;
    if (key === "autoJoinDomains") {
      const normalized = normalizeAutoJoinDomains(settings.autoJoinDomains!);
      if ("error" in normalized) throw new WorkspaceManifestError(normalized.error);
      out.autoJoinDomains = normalized.domains;
    } else {
      (out as Record<string, unknown>)[key] = settings[key];
    }
  }
  return out;
}

/** The fields of `row` that differ from what the manifest names. */
function workspaceChanges(
  row: WorkspaceRow,
  m: WorkspaceManifest,
  settings: Partial<Settings>,
): string[] {
  const changes: string[] = [];
  if (m.spec.displayName !== undefined && m.spec.displayName !== row.name) {
    changes.push("displayName");
  }
  if (
    m.metadata.description !== undefined &&
    (m.metadata.description ?? null) !== (row.description ?? null)
  ) {
    changes.push("description");
  }
  for (const key of SETTING_KEYS) {
    if (settings[key] === undefined) continue;
    const current = (row as Record<string, unknown>)[key];
    if (stableStringify(current) !== stableStringify(settings[key])) changes.push(key);
  }
  return changes;
}

interface CurrentMember {
  userId: string;
  role: WorkspaceManifestRole;
  email: string;
}

async function membersOf(workspaceId: string): Promise<CurrentMember[]> {
  return db
    .select({ userId: workspaceMembers.userId, role: workspaceMembers.role, email: users.email })
    .from(workspaceMembers)
    .innerJoin(users, eq(users.id, workspaceMembers.userId))
    .where(eq(workspaceMembers.workspaceId, workspaceId));
}

/**
 * The accounts each email names: only accounts whose sign-in proved the
 * email (verified), so nobody gets into a workspace by claiming an address.
 * A person may hold more than one (two sign-in methods); each is a member.
 */
async function accountsByEmail(emails: string[]): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  if (emails.length === 0) return out;
  const rows = await db
    .select({ id: users.id, email: sql<string>`lower(${users.email})` })
    .from(users)
    .where(
      and(
        eq(users.emailVerified, true),
        inArray(
          sql`lower(${users.email})`,
          emails.map((e) => e.toLowerCase()),
        ),
      ),
    )
    .orderBy(asc(users.createdAt));
  for (const row of rows) out.set(row.email, [...(out.get(row.email) ?? []), row.id]);
  return out;
}

async function applyMembers(
  m: WorkspaceManifest,
  ws: WorkspaceRow | null,
  base: { path: string; workspace: string },
  dryRun: boolean,
): Promise<{ items: ConfigPlanItem[]; kept: string[] }> {
  const items: ConfigPlanItem[] = [];
  const listed = m.spec.members ?? [];
  const accounts = await accountsByEmail(listed.map((x) => x.email));
  const current = ws ? await membersOf(ws.id) : [];
  const currentById = new Map(current.map((c) => [c.userId, c]));
  const matched = new Set<string>();
  const item = (email: string, rest: Partial<ConfigPlanItem> = {}): ConfigPlanItem => ({
    kind: "WorkspaceMember",
    name: email,
    ...base,
    action: "unchanged",
    ...rest,
  });

  const desiredAdmins = new Set<string>();
  for (const member of listed) {
    const role = member.role ?? "member";
    const ids = accounts.get(member.email.toLowerCase()) ?? [];
    if (ids.length === 0) {
      items.push(
        item(member.email, {
          message:
            "no account with this verified email has signed in yet; an apply after they do adds them",
        }),
      );
      continue;
    }
    const toAdd: string[] = [];
    const toChange: Array<{ id: string; from: string }> = [];
    for (const id of ids) {
      matched.add(id);
      if (role === "admin") desiredAdmins.add(id);
      const existing = currentById.get(id);
      if (!existing) toAdd.push(id);
      else if (existing.role !== role) toChange.push({ id, from: existing.role });
    }
    if (!dryRun && ws) {
      for (const id of toAdd) await addMember(ws.id, id, role);
      for (const { id } of toChange) await updateMemberRole(ws.id, id, role);
    }
    if (toAdd.length) {
      items.push(item(member.email, { action: "create", message: `as ${role}` }));
    } else if (toChange.length) {
      items.push(
        item(member.email, { action: "update", changes: [`role: ${toChange[0].from} → ${role}`] }),
      );
    } else {
      items.push(item(member.email));
    }
  }

  const unlisted = current.filter((c) => !matched.has(c.userId));
  if (!m.spec.prune || unlisted.length === 0) {
    return { items, kept: unlisted.map((c) => c.email).sort() };
  }
  // Pruning must not leave the workspace without anyone who can run it.
  if (desiredAdmins.size === 0) {
    items.push(
      item("(members not listed)", {
        action: "error",
        message:
          "prune is on but no listed admin has signed in yet: nobody was removed, so the " +
          "workspace keeps an admin",
      }),
    );
    return { items, kept: unlisted.map((c) => c.email).sort() };
  }
  for (const c of unlisted.sort((a, b) => a.email.localeCompare(b.email))) {
    if (!dryRun && ws) await removeMember(ws.id, c.userId);
    items.push(item(c.email, { action: "prune", message: `was ${c.role}` }));
  }
  return { items, kept: [] };
}

async function applyRepos(
  repos: RepoManifestSpec[],
  ws: WorkspaceRow | null,
  base: { path: string; workspace: string },
  dryRun: boolean,
): Promise<ConfigPlanItem[]> {
  if (repos.length === 0) return [];
  const documents: ManifestInput[] = repos.map((spec) => ({
    path: base.path,
    document: {
      apiVersion: MANIFEST_API_VERSION,
      kind: "Repo",
      metadata: { name: normalizeRepoUrl(spec.url) },
      spec,
    },
  }));
  if (!ws) {
    // A workspace that doesn't exist yet (a dry run) has no repos: each is new.
    return documents.map((d) => ({
      kind: "Repo",
      name: labelOf(d.document),
      ...base,
      action: "create",
    }));
  }
  // The workspace-level apply, without a source: an upsert that manages nothing and never prunes.
  const result = await applyManifests({ workspaceId: ws.id, manifests: documents, dryRun });
  return result.items.map((i) => ({ ...i, ...base }));
}

async function applyOne(
  path: string,
  m: WorkspaceManifest,
  dryRun: boolean,
): Promise<ConfigPlanItem[]> {
  const slug = m.metadata.name;
  const base = { path, workspace: slug };
  const head: ConfigPlanItem = {
    kind: WORKSPACE_MANIFEST_KIND,
    name: slug,
    ...base,
    action: "unchanged",
  };
  const settings = desiredSettings(m.spec.settings);
  let [ws] = await db.select().from(workspaces).where(eq(workspaces.slug, slug));

  if (!ws) {
    head.action = "create";
    if (!dryRun) {
      // Nobody is added as its creator: its members are the ones the file lists.
      const created = await createWorkspace({
        name: m.spec.displayName ?? slug,
        slug,
        description: m.metadata.description ?? undefined,
      });
      [ws] = await db.select().from(workspaces).where(eq(workspaces.id, created.id));
      if (Object.keys(settings).length) {
        await updateWorkspace(ws.id, settings);
        [ws] = await db.select().from(workspaces).where(eq(workspaces.id, ws.id));
      }
      head.resourceId = ws.id;
    }
  } else {
    head.resourceId = ws.id;
    const changes = workspaceChanges(ws, m, settings);
    if (changes.length) {
      head.action = "update";
      head.changes = changes;
      if (!dryRun) {
        await updateWorkspace(ws.id, {
          ...(m.spec.displayName !== undefined ? { name: m.spec.displayName } : {}),
          ...(m.metadata.description !== undefined
            ? { description: m.metadata.description ?? null }
            : {}),
          ...settings,
        });
      }
    }
  }

  const members = await applyMembers(m, ws ?? null, base, dryRun);
  if (members.kept.length) {
    head.message =
      `${members.kept.length} member${members.kept.length === 1 ? "" : "s"} not in the file ` +
      `kept (prune is off): ${members.kept.slice(0, 10).join(", ")}` +
      (members.kept.length > 10 ? ", …" : "");
  }
  const repos = await applyRepos(m.spec.repos ?? [], ws ?? null, base, dryRun);
  return [head, ...members.items, ...repos];
}

function messageOf(err: unknown): string {
  if (err instanceof WorkspaceManifestError || err instanceof WorkspaceSettingsError) {
    return err.message;
  }
  logger.warn({ err }, "workspace apply: unexpected error applying a manifest");
  return err instanceof Error ? err.message : String(err);
}

/** Make the deployment's workspaces match the manifests (or, `dryRun`, say what that would take). */
export async function applyWorkspaceManifests(
  opts: WorkspaceApplyOptions,
): Promise<ConfigApplyResult> {
  const { parsed, items } = parse(opts.manifests);
  for (const p of parsed.sort((a, b) =>
    a.manifest.metadata.name.localeCompare(b.manifest.metadata.name),
  )) {
    try {
      items.push(...(await applyOne(p.path, p.manifest, opts.dryRun)));
    } catch (err) {
      items.push(errorItem(p.path, p.manifest.metadata.name, messageOf(err)));
    }
  }
  return {
    dryRun: opts.dryRun,
    source: null,
    items,
    summary: summarize(items),
    at: new Date().toISOString(),
  };
}

/** Where an export files a workspace: `workspaces/<slug>.yaml`. */
export const workspaceManifestPath = (slug: string) => `workspaces/${slug}.yaml`;

/**
 * The deployment's workspaces as manifests, the way to start a versioned file
 * from what exists. Members are written by verified email only (what an apply
 * matches on); `prune` is never written, so applying an export removes no one.
 */
export async function exportWorkspaceManifests(
  slugs?: string[],
): Promise<ExportedWorkspaceManifest[]> {
  const rows = await db
    .select()
    .from(workspaces)
    .where(slugs?.length ? inArray(workspaces.slug, slugs) : undefined)
    .orderBy(asc(workspaces.slug));
  const out: ExportedWorkspaceManifest[] = [];
  for (const ws of rows) {
    const memberRows = await db
      .select({ email: users.email, role: workspaceMembers.role })
      .from(workspaceMembers)
      .innerJoin(users, eq(users.id, workspaceMembers.userId))
      .where(and(eq(workspaceMembers.workspaceId, ws.id), eq(users.emailVerified, true)));
    // One entry per email; a person with two accounts keeps the higher role.
    const rank: Record<string, number> = { viewer: 0, member: 1, admin: 2 };
    const byEmail = new Map<string, WorkspaceManifestRole>();
    for (const r of memberRows) {
      const email = r.email.toLowerCase();
      const prev = byEmail.get(email);
      if (!prev || rank[r.role] > rank[prev]) byEmail.set(email, r.role);
    }
    const repos = (await exportManifests(ws.id, { kinds: ["Repo"] })).map(
      (r) => r.document.spec as RepoManifestSpec,
    );
    const document: WorkspaceManifest = {
      apiVersion: MANIFEST_API_VERSION,
      kind: WORKSPACE_MANIFEST_KIND,
      metadata: { name: ws.slug, ...(ws.description ? { description: ws.description } : {}) },
      spec: {
        displayName: ws.name,
        settings: {
          allowDockerInDocker: ws.allowDockerInDocker,
          autoJoinDomains: ws.autoJoinDomains,
          ...(ws.autoJoinRole === "admin" ? {} : { autoJoinRole: ws.autoJoinRole }),
          restrictPodSecrets: ws.restrictPodSecrets,
        },
        members: [...byEmail.entries()]
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([email, role]) => ({ email, role })),
        ...(repos.length ? { repos } : {}),
      },
    };
    out.push({
      kind: WORKSPACE_MANIFEST_KIND,
      name: ws.slug,
      path: workspaceManifestPath(ws.slug),
      document,
    });
  }
  return out;
}
