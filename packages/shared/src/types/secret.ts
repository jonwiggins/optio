export interface SecretRef {
  id: string;
  name: string;
  scope: string;
  userId?: string | null;
  /**
   * Who it belongs to: null = the organization's; set = one person's private
   * secret (`scope: "user"`, or a legacy `user:<id>` token). Lists carry it
   * with `ownerName` so an admin can tell whose a private secret is.
   */
  ownerUserId?: string | null;
  ownerName?: string | null;
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
