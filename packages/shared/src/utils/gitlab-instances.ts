/** Public instance locations; credentials and TLS dispatchers stay in the API. */
let baseUrls: string[] = [];

export function setGitLabInstanceUrls(urls: string[]): void {
  baseUrls = [...urls].sort((a, b) => b.length - a.length);
}

export function gitLabInstanceForHost(host: string): string | undefined {
  return baseUrls.find((base) => new URL(base).host === host.toLowerCase());
}

/**
 * The instance a URL is under. Case-insensitive: repository URLs are stored
 * lower-cased (normalizeRepoUrl, whatever is registered), while the base URL
 * keeps the case it was registered with for API calls and clones.
 */
export function gitLabInstanceForUrl(url: string): string | undefined {
  const u = url.toLowerCase();
  return baseUrls.find((base) => {
    const b = base.toLowerCase();
    return u === b || u.startsWith(`${b}/`);
  });
}

export function gitLabInstanceUrls(): string[] {
  return [...baseUrls];
}
export function normalizeGitLabBaseUrl(value: string): string {
  const url = new URL(/^https?:\/\//i.test(value) ? value : `https://${value}`);
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash)
    throw new Error("Use an HTTPS base URL without credentials, query or fragment");
  return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
}
