import { guardedFetch } from "./outbound-http.js";

/** An injectable transport lets ticket providers share the API's instance CA trust. */
type GitLabTransport = (url: string, init?: RequestInit) => Promise<Response>;
let transport: GitLabTransport | undefined;
export function setGitLabTransport(value: GitLabTransport): void {
  transport = value;
}
export const gitLabFetch: GitLabTransport = (input, init) =>
  (transport ?? guardedFetch)(input, init);
