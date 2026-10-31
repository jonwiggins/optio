import { setGitLabInstanceUrls } from "@optio/shared";
import { request } from "@/lib/api-client";

export interface GitLabInstance {
  id: string;
  baseUrl: string;
  displayName: string;
  caPem: string | null;
  hasToken: boolean;
  source: "app" | "environment";
}
export interface GitLabInstanceInput {
  baseUrl: string;
  displayName: string;
  caPem?: string | null;
  token?: string | null;
}
export const gitlabInstancesApi = {
  async list() {
    const view = await request<{ instances: GitLabInstance[]; canEdit: boolean }>(
      "/api/gitlab-instances",
    );
    setGitLabInstanceUrls(view.instances.filter((i) => i.source === "app").map((i) => i.baseUrl));
    return view;
  },
  save: (body: GitLabInstanceInput, id?: string) =>
    request<GitLabInstance>(`/api/gitlab-instances${id ? `/${id}` : ""}`, {
      method: id ? "PUT" : "POST",
      body: JSON.stringify(body),
    }),
  remove: (id: string) =>
    request<{ ok: boolean }>(`/api/gitlab-instances/${id}`, { method: "DELETE" }),
  test: (body: GitLabInstanceInput & { id?: string }) =>
    request<{ ok: boolean; version?: string; username?: string; error?: string }>(
      "/api/gitlab-instances/test",
      { method: "POST", body: JSON.stringify(body) },
    ),
};
