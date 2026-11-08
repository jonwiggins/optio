export interface UserInfo {
  id: string;
  email: string;
  displayName: string;
  provider?: string;
  avatarUrl?: string | null;
}
