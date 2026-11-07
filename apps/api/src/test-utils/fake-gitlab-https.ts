import https from "node:https";
import { readFileSync } from "node:fs";

/** Local HTTPS GitLab stand-in. This certificate and key are test fixtures only. */
export async function fakeGitLabHttps() {
  const caPem = readFileSync(new URL("./fixtures/gitlab-tls/ca.pem", import.meta.url), "utf8");
  const key = readFileSync(
    new URL("./fixtures/gitlab-tls/server-key.pem", import.meta.url),
    "utf8",
  );
  const requests: Array<{ url: string; authorization?: string }> = [];
  const server = https.createServer({ cert: caPem, key }, (req, res) => {
    requests.push({ url: req.url!, authorization: req.headers.authorization });
    res.setHeader("Content-Type", "application/json");
    if (req.headers.authorization !== "Bearer instance-token") {
      res.writeHead(401);
      res.end("{}");
      return;
    }
    const path = new URL(req.url!, "https://example.test").pathname;
    if (path === "/gitlab/api/v4/version") res.end(JSON.stringify({ version: "18.0.0" }));
    else if (path === "/gitlab/api/v4/user")
      res.end(JSON.stringify({ id: 1, username: "test-bot" }));
    else if (path === "/gitlab/api/v4/projects")
      res.end(
        JSON.stringify([
          {
            id: 1,
            path_with_namespace: "group/project",
            http_url_to_repo: "https://example.test/gitlab/group/project.git",
            web_url: "https://example.test/gitlab/group/project",
            default_branch: "main",
            visibility: "private",
          },
        ]),
      );
    else if (path === "/gitlab/api/v4/projects/group%2Fproject")
      res.end(
        JSON.stringify({
          id: 1,
          path_with_namespace: "group/project",
          name: "project",
          default_branch: "main",
          visibility: "private",
          web_url: "https://example.test/gitlab/group/project",
        }),
      );
    else if (path === "/gitlab/api/v4/projects/group%2Fproject/hooks") {
      res.end(req.method === "POST" ? '{"id":7}' : "[]");
    } else if (path === "/gitlab/api/v4/projects/group%2Fproject/issues") res.end("[]");
    else if (path === "/gitlab/api/v4/redirect") {
      res.writeHead(302, { Location: "/elsewhere" });
      res.end();
    } else {
      res.writeHead(404);
      res.end("{}");
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  return {
    baseUrl: `https://127.0.0.1:${port}/gitlab`,
    caPem,
    requests,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}
