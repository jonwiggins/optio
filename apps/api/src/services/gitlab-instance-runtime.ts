import { setGitLabTransport } from "@optio/shared/gitlab-transport";
import { rootCertificates } from "node:tls";
import { gitLabInstanceForHost, gitLabInstanceForUrl, setGitLabInstanceUrls } from "@optio/shared";
import { guardedFetch } from "../utils/outbound-url.js";

export interface RuntimeGitLabInstance {
  baseUrl: string;
  caPem: string | null;
  token: string | null;
}
let instances: RuntimeGitLabInstance[] = [];

export function configureGitLabInstances(next: RuntimeGitLabInstance[]): void {
  instances = next;
  setGitLabTransport(gitLabFetch);
  setGitLabInstanceUrls(next.map((v) => v.baseUrl));
}

export function runtimeGitLabInstance(value: string): RuntimeGitLabInstance | null {
  const base = value.includes("://")
    ? gitLabInstanceForUrl(value)
    : value.includes("/")
      ? gitLabInstanceForUrl(`https://${value}`)
      : gitLabInstanceForHost(value);
  return instances.find((v) => v.baseUrl === base) ?? null;
}

/** Instance CA trust shares the upstream DNS-pinned transport and rejects redirects. */
export async function gitLabFetch(url: string, init?: RequestInit): Promise<Response> {
  const instance = runtimeGitLabInstance(url);
  return guardedFetch(url, {
    ...init,
    redirect: "error",
    ...(instance?.caPem ? { tls: { ca: [...rootCertificates, instance.caPem].join("\n") } } : {}),
  });
}
