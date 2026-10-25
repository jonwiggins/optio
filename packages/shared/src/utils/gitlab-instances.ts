/** Public instance locations; credentials and TLS dispatchers stay in the API. */
let baseUrls: string[] = [];

export function setGitLabInstanceUrls(urls: string[]): void {
  baseUrls = [...urls].sort((a, b) => b.length - a.length);
}

export function gitLabInstanceForHost(host: string): string | undefined {
  return baseUrls.find((base) => new URL(base).host === host.toLowerCase());
}

export function gitLabInstanceForUrl(url: string): string | undefined {
  return baseUrls.find((base) => url === base || url.startsWith(`${base}/`));
}

/** An injectable transport lets ticket providers share the API's instance CA trust. */
type GitLabTransport = (url: string, init?: RequestInit) => Promise<Response>;
let transport: GitLabTransport | undefined;
export function setGitLabTransport(value: GitLabTransport): void {
  transport = value;
}
export const gitLabFetch: GitLabTransport = (input, init) => (transport ?? fetch)(input, init);

export function gitLabInstanceUrls(): string[] {
  return [...baseUrls];
}
export function normalizeGitLabBaseUrl(value: string): string {
  const url = new URL(/^https?:\/\//i.test(value) ? value : `https://${value}`);
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash)
    throw new Error("Use an HTTPS base URL without credentials, query or fragment");
  return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
}
