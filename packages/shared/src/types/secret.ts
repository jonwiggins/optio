export interface SecretRef {
  id: string;
  name: string;
  scope: string;
  userId?: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateSecretInput {
  name: string;
  value: string;
  scope?: string;
}

/** A secret a piece of work can pick for its pod: the org's and the viewer's own. */
export interface PickableSecret {
  name: string;
  owner: "workspace" | "me";
}
