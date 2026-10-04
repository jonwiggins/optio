/**
 * Config as code: what a resource that a configuration directory manages
 * carries in every list and detail response (`docs/config-as-code.md`).
 * The file is the truth: edits made in the UI are put back at the next sync.
 */
export interface ManagedBy {
  /** The `config_objects` row — `POST /api/config/objects/:id/detach` takes it. */
  objectId: string;
  sourceId: string;
  /** The source's name as Settings shows it ("config directory"). */
  sourceName: string;
  /** The manifest's file, relative to the source's directory. */
  path: string;
  /** The manifest kind: Work, Prompt, Repo, McpServer, Skill, Connection. */
  kind: string;
}
