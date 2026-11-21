/**
 * Where the browser starts a sign-in with a provider: a page of the web
 * server's own, never under `/api`. An ingress usually sends `/api` straight
 * to the API, and the API refuses a sign-in that didn't pass the web server,
 * which creates the browser's verifier cookie (`app/auth/login/[provider]`).
 */
export function signInPath(provider: string): string {
  return `/auth/login/${encodeURIComponent(provider)}`;
}
