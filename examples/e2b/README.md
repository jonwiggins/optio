# An E2B template work runs in

A template for the sandbox Optio starts work in on E2B
([docs/remote-workspaces.md](../../docs/remote-workspaces.md), "E2B").

```
e2b/
  template.ts   # Node.js 20, git, curl and the agent CLIs, built with E2B's SDK
  README.md
```

Build it (`npx tsx template.ts`, with `E2B_API_KEY` set) — or add the same
packages to a template you have. In Optio, **Settings → Integrations →
Remote workspaces → Add connection → E2B** with an API key; after **Test**,
pick the template as the default, and set "Stop after" to the longest run
(E2B pauses the sandbox at the end of its time; your plan caps it).

When work starts, Optio creates a sandbox from the template and runs its
start script through the sandbox's envd with the pairing bundle in the
process's environment: the agent policy (as root or with `sudo -n`: give
the template's user passwordless sudo if it isn't root), the repository
cloned into `/home/user/repo`, the Optio CLI from the Optio server, and
`optio local up` there. The sandbox must reach Optio at its public URL.
