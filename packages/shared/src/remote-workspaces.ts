/**
 * Remote workspaces (docs/remote-workspaces.md): work that runs in a
 * development workspace a provider hosts — a Coder workspace, a GitHub
 * codespace, a Daytona sandbox or an E2B sandbox. The workspace pairs itself
 * with Optio as a machine and the agent runs there the way it runs on a
 * paired laptop. Off until someone adds a connection (Settings → Integrations
 * → Remote workspaces).
 *
 * The providers and what each calls its parts, shared by the API and the web
 * app so the settings form, the New work form and the server agree.
 */

import type { LocalHostOrigin } from "./types/local.js";

/** Every provider, in the order the forms list them (alphabetical). */
export const REMOTE_WORKSPACE_PROVIDERS = ["coder", "codespaces", "daytona", "e2b"] as const;
export type RemoteWorkspaceProviderId = (typeof REMOTE_WORKSPACE_PROVIDERS)[number];

// A machine's origin (types/local.ts) is "machine" or one of these: the two
// lists stay the same (this fails to compile otherwise).
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const ORIGINS_ARE_PROVIDERS: Same<
  Exclude<LocalHostOrigin, "machine">,
  RemoteWorkspaceProviderId
> = true;
void ORIGINS_ARE_PROVIDERS;

export const isRemoteWorkspaceProvider = (v: unknown): v is RemoteWorkspaceProviderId =>
  typeof v === "string" && (REMOTE_WORKSPACE_PROVIDERS as readonly string[]).includes(v);

/** The parameter that names the checkout the agent works in (every provider). */
export const REMOTE_WORKSPACE_CHECKOUT_PARAMETER = "optio_checkout_dir";
/** The parameter a Task's repository is handed to, by convention (every provider). */
export const REMOTE_WORKSPACE_REPO_PARAMETER = "repo_url";

export interface RemoteWorkspaceProviderInfo {
  id: RemoteWorkspaceProviderId;
  /** The product's name. */
  label: string;
  /** The API's address when the connection leaves it blank; null = it must be given. */
  defaultUrl: string | null;
  urlPlaceholder: string;
  urlHelp: string;
  /** What the credential is called, and where it comes from. */
  tokenLabel: string;
  tokenHelp: string;
  /** The optional scope field (an organization, a team); null = the provider has none. */
  organizationLabel: string | null;
  organizationHelp: string | null;
  /** What a workspace is made from, and what one is called. */
  templateNoun: string;
  workspaceNoun: string;
  /** One workspace in a sentence: "Coder workspace", "codespace", "Daytona sandbox". */
  workspaceTitle: string;
  /** Where the agent works when nothing says otherwise. */
  defaultCheckoutDir: string;
  /** What the connection's "stop after" does at this provider. */
  ttlHelp: string;
  /** What Optio does to the workspace when the work ends, unless it deletes it. */
  stopVerb: "stop" | "pause";
  /**
   * Only a person's own connection: the provider hands the pairing secret to
   * every workspace of the token's account, so one connection can't serve
   * several people.
   */
  personalOnly: boolean;
  /** A name Optio may give a new workspace; null = the provider names it. */
  name: { maxLength: number; pattern: string; help: string } | null;
}

const SLUG = "^[a-zA-Z0-9]+(?:-[a-zA-Z0-9]+)*$";

export const REMOTE_WORKSPACE_PROVIDER_INFO: Record<
  RemoteWorkspaceProviderId,
  RemoteWorkspaceProviderInfo
> = {
  coder: {
    id: "coder",
    label: "Coder",
    defaultUrl: null,
    urlPlaceholder: "https://coder.example.com",
    urlHelp: "The Coder deployment.",
    tokenLabel: "Session token",
    tokenHelp: "A Coder session token (coder tokens create).",
    organizationLabel: "Organization",
    organizationHelp: "Its ID in Coder; blank = the token user's default.",
    templateNoun: "template",
    workspaceNoun: "workspace",
    workspaceTitle: "Coder workspace",
    defaultCheckoutDir: "/home/coder/repo",
    ttlHelp: "The workspace stops itself after this; blank = never.",
    stopVerb: "stop",
    personalOnly: false,
    name: { maxLength: 32, pattern: SLUG, help: "Letters, digits and single hyphens only" },
  },
  codespaces: {
    id: "codespaces",
    label: "GitHub Codespaces",
    defaultUrl: "https://api.github.com",
    urlPlaceholder: "https://api.github.com",
    urlHelp: "GitHub's REST API; blank = api.github.com.",
    tokenLabel: "Personal access token",
    tokenHelp:
      "A token with the codespace scope (classic); fine-grained: Codespaces, Codespaces lifecycle admin and Codespaces metadata on the repositories, and Codespaces user secrets.",
    organizationLabel: "Organization",
    organizationHelp: "Lists this organization's repositories; blank = yours.",
    templateNoun: "repository",
    workspaceNoun: "codespace",
    workspaceTitle: "codespace",
    defaultCheckoutDir: "/workspaces/<repository>",
    ttlHelp:
      "GitHub stops a codespace after this long without terminal or editor activity (5 minutes to 4 hours); blank = 4 hours.",
    stopVerb: "stop",
    personalOnly: true,
    name: { maxLength: 48, pattern: "^[^\\n]+$", help: "At most 48 characters" },
  },
  daytona: {
    id: "daytona",
    label: "Daytona",
    defaultUrl: "https://app.daytona.io/api",
    urlPlaceholder: "https://app.daytona.io/api",
    urlHelp: "The Daytona API; blank = Daytona's cloud.",
    tokenLabel: "API key",
    tokenHelp: "A Daytona API key with sandbox write and delete permissions.",
    organizationLabel: "Organization",
    organizationHelp: "Its ID in Daytona; blank = the API key's organization.",
    templateNoun: "snapshot",
    workspaceNoun: "sandbox",
    workspaceTitle: "Daytona sandbox",
    defaultCheckoutDir: "/home/daytona/repo",
    ttlHelp: "Daytona stops the sandbox after this long without activity; blank = never.",
    stopVerb: "stop",
    personalOnly: false,
    name: { maxLength: 32, pattern: SLUG, help: "Letters, digits and single hyphens only" },
  },
  e2b: {
    id: "e2b",
    label: "E2B",
    defaultUrl: "https://api.e2b.app",
    urlPlaceholder: "https://api.e2b.app",
    urlHelp: "The E2B API; blank = E2B's cloud.",
    tokenLabel: "API key",
    tokenHelp: "An E2B API key (e2b_…).",
    organizationLabel: null,
    organizationHelp: null,
    templateNoun: "template",
    workspaceNoun: "sandbox",
    workspaceTitle: "E2B sandbox",
    defaultCheckoutDir: "/home/user/repo",
    ttlHelp:
      "E2B pauses the sandbox after this long (its plan's limit applies); blank = 1 hour. Set it to your longest run.",
    stopVerb: "pause",
    personalOnly: false,
    name: { maxLength: 32, pattern: SLUG, help: "Letters, digits and single hyphens only" },
  },
};

export function remoteWorkspaceProviderInfo(id: string): RemoteWorkspaceProviderInfo | null {
  return isRemoteWorkspaceProvider(id) ? REMOTE_WORKSPACE_PROVIDER_INFO[id] : null;
}

/** A name the provider takes for a new workspace, or why not (null: fine, or nothing typed). */
export function remoteWorkspaceNameError(
  provider: RemoteWorkspaceProviderId,
  name: string,
): string | null {
  const n = name.trim();
  const rule = REMOTE_WORKSPACE_PROVIDER_INFO[provider].name;
  if (!n || !rule) return null;
  if (n.length > rule.maxLength) return `At most ${rule.maxLength} characters`;
  if (!new RegExp(rule.pattern).test(n)) return rule.help;
  return null;
}
