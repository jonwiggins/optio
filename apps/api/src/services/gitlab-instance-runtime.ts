import { rootCertificates } from "node:tls";
import { Agent, fetch as undiciFetch } from "undici";
import {
  gitLabInstanceForHost,
  gitLabInstanceForUrl,
  setGitLabInstanceUrls,
  setGitLabTransport,
} from "@optio/shared";

export interface RuntimeGitLabInstance {
  baseUrl: string;
  caPem: string | null;
  token: string | null;
}
let instances: RuntimeGitLabInstance[] = [];
const agents = new Map<string, { pem: string; agent: Agent }>();

export function configureGitLabInstances(next: RuntimeGitLabInstance[]): void {
  instances = next;
  setGitLabTransport(gitLabFetch);
  setGitLabInstanceUrls(next.map((v) => v.baseUrl));
  for (const [url, cached] of agents) {
    if (next.find((v) => v.baseUrl === url)?.caPem !== cached.pem) {
      agents.delete(url);
      void cached.agent.close();
    }
  }
}

export function runtimeGitLabInstance(value: string): RuntimeGitLabInstance | null {
  const base = value.includes("://")
    ? gitLabInstanceForUrl(value)
    : value.includes("/")
      ? gitLabInstanceForUrl(`https://${value}`)
      : gitLabInstanceForHost(value);
  return instances.find((v) => v.baseUrl === base) ?? null;
}

/** A dispatcher is scoped to one instance; redirects cannot carry tokens or CA trust elsewhere. */
export async function gitLabFetch(url: string, init?: RequestInit): Promise<Response> {
  const instance = runtimeGitLabInstance(url);
  if (!instance) return fetch(url, init);
  let agent: Agent | undefined;
  if (instance.caPem) {
    let cached = agents.get(instance.baseUrl);
    if (!cached) {
      cached = {
        pem: instance.caPem,
        agent: new Agent({ connect: { ca: [...rootCertificates, instance.caPem] } }),
      };
      agents.set(instance.baseUrl, cached);
    }
    agent = cached.agent;
  }
  const options = { ...init, redirect: "error" as const, ...(agent ? { dispatcher: agent } : {}) };
  // Use the matching undici fetch with its Agent: Node's bundled dispatcher protocol may differ.
  return agent
    ? ((await undiciFetch(
        url,
        options as Parameters<typeof undiciFetch>[1],
      )) as unknown as Response)
    : fetch(url, options);
}
