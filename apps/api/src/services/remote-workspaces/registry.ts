/**
 * The remote-workspace providers (docs/remote-workspaces.md), by id. Adding
 * one is a client implementing `RemoteWorkspaceClient` (types.ts), an entry
 * here and in @optio/shared's catalog, and its id in the `provider` and
 * `origin` checks (a migration).
 */
import type { RemoteWorkspaceProviderId } from "@optio/shared";
import { codespacesProvider } from "./codespaces.js";
import { coderProvider } from "./coder.js";
import { daytonaProvider } from "./daytona.js";
import { e2bProvider } from "./e2b.js";
import { RemoteWorkspaceError, type RemoteWorkspaceProvider } from "./types.js";

const PROVIDERS: Record<RemoteWorkspaceProviderId, RemoteWorkspaceProvider> = {
  coder: coderProvider,
  codespaces: codespacesProvider,
  daytona: daytonaProvider,
  e2b: e2bProvider,
};

export function providerFor(id: string): RemoteWorkspaceProvider {
  const provider = PROVIDERS[id as RemoteWorkspaceProviderId];
  if (!provider) throw new RemoteWorkspaceError(`No remote-workspace provider "${id}"`);
  return provider;
}
