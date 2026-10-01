# Model providers, owners and pod secrets

## Model providers

A **model provider** is a saved way for an agent CLI to reach its models other than its usual
sign-in. Today the one kind is **Amazon Bedrock**, for Claude Code (Anthropic models) and Codex
(OpenAI models on Bedrock, through Codex's built-in `amazon-bedrock` provider).

Managed in **Settings → Model providers** (`GET/POST/PATCH/DELETE /api/model-providers`,
`services/model-provider-service.ts`, table `model_providers`). A provider has:

- a **name** and an **owner**: the organization (`owner_user_id` null; admins only) or one person;
- the **agents** it serves (`claude-code`, `codex`) and the **models** it offers each, in picker
  order (the first is the default; `bedrockDefaultModels` suggests `us.anthropic.claude-…` /
  `openai.gpt-…` ids for the region);
- a **region**;
- **on your machines**: an optional AWS profile name (blank = the machine's default AWS
  credentials);
- **in pods**: `access-key` (AWS key id + secret + optional session token), `bearer-token` (a
  Bedrock API key), `ambient` (the pod's own IAM role, e.g. IRSA on EKS) or `none` (machines
  only). Stored credentials are AES-256-GCM encrypted on the row (AAD `model_provider|<id>`) and
  never returned; the API only says `hasPodCredentials`.

Work picks a provider with `agentOptions.modelProvider = <id>`, and its model field
(`claudeModel` / `copilotModel`) then holds one of the provider's model ids. The web, iOS and
Android forms only show the **Provider** switch once a provider serves the chosen runtime.

`bedrockRuntime()` in `@optio/shared` is the one mapping to the CLIs, used by both run
locations:

|             | Claude Code                                                                                                                                       | Codex                                |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------ |
| env         | `CLAUDE_CODE_USE_BEDROCK=1`, `AWS_REGION`, `AWS_DEFAULT_REGION`                                                                                   | `AWS_REGION`, `AWS_DEFAULT_REGION`   |
| flags       | —                                                                                                                                                 | `-c model_provider="amazon-bedrock"` |
| credentials | pods: `AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY`/`AWS_SESSION_TOKEN` or `AWS_BEARER_TOKEN_BEDROCK`; machines: `AWS_PROFILE` or the default chain | same                                 |

Pods: the task, workflow and persistent-agent workers call `resolveProviderForWork` (which
re-checks the owner, agent, workspace and pod credentials at run time and fails the run with a
clear message otherwise) and `podProviderRuntime`; the agent's sign-in mode becomes `bedrock`, so
no Anthropic / OpenAI key is required. Machines: see "Model providers" in
[optio-local.md](optio-local.md#launching-agents).

## Owners

Model providers, secrets (`scope: "user"`), connections and work (`tasks`, `task_configs`,
`workflows`, `persistent_agents`) have an owner: the organization (null) or one person
(`owner_user_id`). The rules (`services/work-ownership.ts`):

- Personal work runs with its owner's secrets, providers and connections. Everyone in the
  workspace sees it; only its owner may change it, run it by hand, message it, resume it or change
  its triggers (`403`). Admins may delete it.
- Organization work can only use organization providers, secrets and connections (`400`
  otherwise). Its runs never look up anyone's personal secrets, agent sign-in included.
- New work is personal when the body says `owner: "me"`, when it runs on a machine (always), or
  when it picks something personal; otherwise the organization's. Making organization work
  personal takes an admin or its creator.
- Tasks spawned by a scheduled Task inherit its owner and picked secrets.
- A personal connection reaches only work its owner owns (`getConnectionsForTask`).

## Pod secrets

`podSecrets` (on `tasks`, `task_configs`, `workflows`, `persistent_agents`) is the list of secret
names a piece of work gives its agent. `GET /api/secrets/pickable` lists what a viewer can pick:
the organization's global secrets and their own; identity tokens (`ANTHROPIC_API_KEY`, …) and
Optio's own settings (`*_AUTH_MODE`, Vertex settings) are never offered. At run time
`resolvePodSecrets` takes the owner's secret first, then the repo's, then the organization's.
`null` keeps the legacy behavior. The workspace setting **Pods get only the secrets work picks**
(`workspaces.restrict_pod_secrets`) also stops repo pods from receiving every organization secret
during setup.

## Joining a workspace by email domain

`workspaces.auto_join_domains` + `auto_join_role` (member or viewer; workspace settings, admins
only; public mail domains are refused). After an OAuth sign-in, `joinWorkspacesByEmailDomain`
adds the user to every workspace listing their email's domain, but only when the provider vouches
for the email (`OAuthUser.emailVerified`: Google `verified_email`, OIDC `email_verified`,
GitHub's verified primary, GitLab's confirmed email). A first-time user's default workspace
becomes the first one joined, so no empty personal workspace is created.
