# A Daytona snapshot work runs in

An image for the snapshot a Daytona sandbox is made from when Optio starts
work in one ([docs/remote-workspaces.md](../../docs/remote-workspaces.md),
"Daytona").

```
daytona/
  Dockerfile   # Node.js 20, git, curl, the agent CLIs, a sudo-capable user
  README.md
```

Build the image, push it where Daytona pulls from, and make a snapshot of
it in Daytona (named, say, `optio-node`). In Optio, **Settings →
Integrations → Remote workspaces → Add connection → Daytona** with an API
key that may create and delete sandboxes; after **Test**, pick the snapshot
as the default.

When work starts, Optio creates a sandbox from the snapshot, waits until it
has started, and runs its start script through the sandbox's toolbox with
the pairing bundle in the command's environment: the agent policy (with
`sudo`), the repository cloned into `/home/daytona/repo` (the image's git
credentials apply: a public repository, or credentials you add to it), the
Optio CLI from the Optio server, and `optio local up` there. The sandbox
must reach Optio at its public URL.
