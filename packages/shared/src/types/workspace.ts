export type WorkspaceRole = "admin" | "member" | "viewer";

export interface Workspace {
  id: string;
  name: string;
  slug: string;
  description?: string | null;
  createdBy?: string | null;
  allowDockerInDocker: boolean;
  /**
   * Email domains whose people join this workspace when they sign in
   * (verified email only), e.g. `["acme.com"]`.
   */
  autoJoinDomains?: string[];
  /** The role people joining by domain get. */
  autoJoinRole?: WorkspaceRole;
  /**
   * Pods get only the secrets a piece of work picks. Off keeps the legacy
   * behavior for work that picks none: every org secret goes to repo pods.
   */
  restrictPodSecrets?: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface WorkspaceMember {
  id: string;
  workspaceId: string;
  userId: string;
  role: WorkspaceRole;
  createdAt: Date;
}

export interface WorkspaceMemberWithUser extends WorkspaceMember {
  email: string;
  displayName: string;
  avatarUrl: string | null;
}

export interface CreateWorkspaceInput {
  name: string;
  slug: string;
  description?: string;
}

/**
 * A deployment admin who is an admin of a workspace through the grant (while
 * deployment admins are admins of every workspace): listed with the
 * workspace's members so its people see everyone who can act in it.
 */
export interface WorkspaceDeploymentAdmin {
  userId: string;
  email: string;
  displayName: string;
  avatarUrl: string | null;
  /** Their own membership role in the workspace; null when they aren't a member. */
  membershipRole: WorkspaceRole | null;
}

export interface WorkspaceSummary {
  id: string;
  name: string;
  slug: string;
  role: WorkspaceRole;
  /**
   * The role comes from being a deployment admin (while deployment admins are
   * admins of every workspace, `deployment-admins.all-workspaces`), not from a
   * membership: they aren't a member, or only with a lower role.
   */
  viaDeploymentAdmin?: boolean;
}

/** Where a person's work ran last: a pod, or a machine and a directory on it. */
export interface WorkFormLocationDefault {
  runTarget: "cluster" | "local";
  /** Local only: `local_hosts.id`. */
  localHostId?: string;
  /** Local only: the directory picked on that machine. */
  localDir?: string;
}

/**
 * The settings a person last used in the New work form, offered again next
 * time: where it ran, its end state, the runtime, and for each runtime its agent options
 * (model, effort, model provider, …).
 */
export interface WorkFormDefaults {
  /** Last end state chosen for agent work. */
  then?: "exits" | "until-merged" | "waits-for-me" | "waits-for-messages";
  runtime?: string;
  /** Per runtime: option key → value (a string or a boolean, like work's `agentOptions`). */
  agentOptions?: Record<string, Record<string, unknown>>;
  location?: WorkFormLocationDefault;
}
