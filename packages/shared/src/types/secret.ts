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
