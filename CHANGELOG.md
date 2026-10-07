# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.11.2] - 2026-10-06

### Changed

- README and product site now lead with a visual tour of Work, session panes, workflow triggers, native iOS and Android apps, and Apple glance surfaces. Production installation docs use existing Secrets and the supported single API/web replica.
- iOS Work widgets use a clearer count-and-session layout, real runtime logos, adaptive rows and quieter saved-work counts. The Start widget makes its confirmation and started states explicit. Lock Screen accessories distinguish waiting, running, offline and all-clear states.
- Live Activities use status symbols, readable action contrast and runtime marks, while retaining Reply, Later, Resume, Retry and PR links. Stale activities show their last update time.
- The web session’s “Terminal here” action is icon-only, with a descriptive tooltip.
- Session sidebar cards have equal left and right spacing, with a thin overlay scrollbar near the edge and a separate resize target on the divider.
- Web status colors use purple for working, green for needs-you, grey for finished or dead sessions, and yellow for problems. Session harness logos are larger and sit directly in the sidebar without a surrounding tile.

### Fixed

- iOS session usage pills match the agent runtime. Codex sessions use their machine’s Codex limits, and shells and other agents no longer show Claude usage.
- The session sidebar's resize target stays inside the sidebar, so it no longer intercepts mouse input or text selection at the terminal's first character.

### Added

- An idempotent local example catalog with paused workflows for all nine trigger types, sample history, recorded sessions, and reproducible web/native screenshot tooling. Public captures use a separate fake-runtime demo instance.
- A dedicated Apple Watch Smart Stack layout for mirrored Live Activities (iOS 18 / watchOS 11 and later), with the priority session and one contextual action. iOS 17 retains its existing Live Activity support.

## [0.11.1] - 2026-10-06

### Changed

- **Local Sessions now follows the web redesign.** A clearer session list separates names, directories and machines; a slim session header brings controls beside the title while retaining usage and account limits. Headers and sidebar rows identify the agent harness or trigger with its own icon. Chat gains distinct message styling, an aligned composer and a jump-to-latest control that reaches the actual bottom. Resizing, thin native scrollbars, terminal shortcuts and view-local pane groups remain available.
- Session logos retain their brand colors, sidebar rows show the trigger separately, and Local sessions use one reconnect notice for host and browser connection issues.

### Added

- Codex Local sessions report tokens and estimated API-equivalent cost, including cached input, cache writes, model changes and known long-context/Fast rates. Repeated usage snapshots are counted once; unknown model prices stay unavailable. The updated Local daemon supplies live totals and usage when backfilling recorded conversations.

### Fixed

- Local and pod terminals fill their panes without an extra black inset around the screen; shared-screen scaling uses the full available width.
- Equal-sized terminal viewers recognize the same grid when header and status-strip heights fall on fractional pixels, avoiding a false “Sized for another device” banner.

## [0.11.0] - 2026-10-06

### Added

- Open a terminal beside a session in the same local directory or pod workspace. Multiplexed sessions appear as nested sidebar rows; grouping belongs to the current view and leaves other devices independent.
- Expiring, revocable session collaboration links for signed-in organization members, including shared terminal/chat control.
- Session recovery status and durable chat request receipts; terminal reconnection through tmux.
- Existing Kubernetes Secret references for managed database, Redis, encryption and OAuth configuration, with an EKS deployment guide.

### Changed

- **A consistent web experience.** Refined headers, cards, forms and empty states extend the Overview and Work design language to detail screens, Reviews, Inbox, Library and Settings. Prompts and repositories gain search; long lists and filters fit narrow screens.
- **A more usable pod Sessions workspace.** Chat and terminal share a compact header and calmer controls. Narrow windows switch between the two without restarting connections; desktop splits support dragging, keyboard resizing and a saved width. Chat drafts survive a reconnect and the model selector now updates the actual chat model.
- **Settings with a place for everything.** Section navigation for deployment and workspace settings keeps unsaved forms mounted. Prompt, run and dependency dialogs use native modal focus handling, Escape dismissal and consistent surfaces.

### Fixed

- Release service images report their release version instead of `dev`, so version checks work after deployment.

### Upgrade notes

- Deploy matching API, web and agent images; pod terminals now require `tmux`. Back up PostgreSQL, the existing encryption key and needed workspace volumes before upgrading.
- Legacy shared pods are not reused as isolated pools. Recreate old interactive sessions before sharing, and save any uncommitted work first. Legacy deployment-wide Git helper credentials are rejected by default.
- Production uses one combined API/web replica with Recreate upgrades. See [the EKS guide](docs/production-eks.md) and [security review](docs/security-review-2026-10.md) for recovery behavior, credential boundaries and retained storage.

### Security

- Partition agent pods, persistent homes and caches by workspace, owner and execution purpose/access profile; give interactive sessions dedicated pods.
- Replace deployment-wide Git credential helper keys with scoped keys and separate agent service accounts from API permissions.
- Preserve interrupted work and require inspection before replaying uncertain executions; enforce one combined API/web replica with Recreate upgrades.

## [0.10.2] - 2026-10-06

### Added

- **Resize the session sidebar.** Drag its edge between 200 and 440 pixels, with a smaller maximum on narrow windows. The width is remembered, double-click resets it, and arrow keys resize it when the handle is focused. The mobile drawer keeps its original width.

### Changed

- **Clearer iOS widgets and Live Activities.** Prominent needs-you and running counts, more breathing room, clearer status rows, and a refreshed Start widget retain the existing session links, reply, snooze, retry, resume, and PR actions.
- **A slimmer session scrollbar.** A thin native thumb keeps a generous grab area, separated from the sidebar resize handle. The session list scrolls independently with its search and header fixed.

### Fixed

- **The terminal no longer adds an unnecessary scrollbar.** Session pages stay within the available screen, and the terminal shows its scrollbar only when there is history to scroll. Chat and terminal history keep their own scrolling.
- **iOS chat reaches the actual bottom.** The down arrow scrolls through the trailing space and dismisses when the view reaches the end, including after expanding a turn's work steps.
- **iOS Overview counts have room to breathe.** Summary cards use consistent padding and continuous corners, with fewer columns for larger accessibility text.

## [0.10.1] - 2026-10-06

### Fixed

- **New work starts with the trigger again.** The web, iOS, and Android forms return to When → Where → Who → What → Then → Name, so the prompt follows the trigger, location, and runtime. The web review summary follows the same order. The refreshed styling and optional examples are retained.

## [0.10.0] - 2026-10-06

### Changed

- **A refreshed iOS and Android experience.** Warmer light surfaces, clearer dark surfaces, refined status colors, and more readable work rows carry through dashboards, lists, detail screens, and account settings. Section tabs scroll instead of squeezing their labels, summary tiles adapt to the available space, and iOS work metadata accommodates larger accessibility text.
- **Work summaries become filters.** Select Needs you, Running, or Ready on mobile to narrow the Work list, and clear the selection to return to everything. The web has the same actionable summaries, with filters reflected in the URL, clearer empty and error states, and separate links for work, pull requests, and edits.
- **New work starts with the prompt.** Creation on web, iOS, and Android puts What first, followed by When, Where, Who, and Then. Examples stay behind an optional disclosure. The web adds a review summary that links back to each section, with a compact review on phones.
- **A calmer web sidebar.** Clearer workspace and account controls, softer selection states, an expanded Library by default, and keyboard focus handling in the mobile drawer make navigation easier. Saved navigation preferences and Overview usage-limit indicators are retained.

### Fixed

- **Apple Watch: a session appears once across paired servers.** When two servers report the same session on a machine, the Watch list now combines it into one entry (#642).

## [0.9.1] - 2026-10-05

### Changed

- **The New work form opens where you worked last.** It remembered the runtime and its model, but not Where: every new piece of work started in a pod, so machine work meant picking My machine, the machine and the directory again each time. The form now remembers all of it, and opens on your machine and directory when that is where the last work ran (and the machine is still paired). On an install with auth disabled the settings are kept too — before, they were silently dropped there, so nothing was ever remembered.
- The When pills divide into even rows: eight make two rows of four, not six and two, and the rows stay even as trigger types are added.
- The New work and Edit work forms fill the same centred column as every other page instead of a narrower, left-aligned measure.

### Fixed

- **iOS: a reply from Chat reaches Codex.** A message sent from the Chat view of a Codex session on your machine landed in Codex's composer with a newline instead of being sent, so you had to switch to Terminal and press Enter. The app now sends the text and its Enter a beat apart, as the server already does for the web.
- **iOS: the keyboard's Send key sends.** Return in the Chat reply box inserted a newline; the key now reads Send and sends the message.
- **iOS: the conversation opens at the end.** The Chat view opened at the top of the conversation and had to be scrolled down each time. It now opens at the latest message, and when you scroll up a floating arrow takes you back to the end. Task logs, job runs and agent turns get the same.

## [0.9.0] - 2026-10-05

### Added

- **Connections: one logo-picked list of everything work can be connected to.** A Connection is a named account at a service — "Jon's AWS", "Acme Linear" — made of parts: **credentials** (encrypted on the row, never returned; a boot-time heal seals any stored in plain text), **tools** (an MCP server in the pod), **shell env** (vars exported into the agent's own shell, so `aws s3 ls` and SDKs are signed in), and a **note** (a skill telling the agent how to use it). Bare secrets ("credentials only") and hand-written MCP servers ("tools only") are listed with them. New providers **AWS** (keys or the pod's IAM role; optional `awslabs` tools), **Pylon**, **PagerDuty**, and **HTTP API** (any REST API, through a small REST bridge baked into the agent images at `/opt/optio/mcp-bridge.js`); custom MCP servers and HTTP connections now reach pods, and **Test** runs a real health check. Library → **Connections** is the new page (search, kind and owner filters, Test, edit sheet, "Connect" gallery); `/secrets` redirects there, and deployment secrets moved to Settings → **Deployment secrets**. The work form's Environment section becomes one **Connected to** picker with logos and "whose · parts · provider" subtext; the repo page gets **Connected by default**; the agent page shows what it is connected to. `GET /api/connections/catalog` and `catalog` in `GET /api/work/environment` list all three kinds. See `docs/connections.md`.
- **Pylon and PagerDuty as triggers.** Any Job, scheduled Task, Local automation, or persistent agent can start on a Pylon event (per-trigger URL `/api/hooks/pylon/:triggerId` with a shared secret minted on creation and shown once; events matched by name) or a PagerDuty incident event (`/api/webhooks/pagerduty`, signed with `PAGERDUTY_WEBHOOK_SECRET`, filtered by event kind, service, and urgency; the run is ticket-linked to the incident). Trigger payload fields reach the prompt as `{{params}}` like the GitHub, Slack, and Linear events.

### Changed

- **An expired Claude login on a paired machine renews itself.** When the cluster's Claude OAuth token expires, Optio takes a fresh one from a machine running `optio local up`; but a machine where nobody had run `claude` for a while held the same expired token, and the banner asked you to open a terminal. The daemon now runs `claude` once itself, in a scratch directory, when its login is expired or about to be, and hands over the renewed token. Restart `optio local up`. Codex needs no such step: pods sign in with an OpenAI API key or the managed app-server, never a copy of a machine's login.
- **Kill asks right under the button.** Killing a session's process confirms in a small card under the Kill button, like the usage pills, instead of a browser dialog in the middle of the screen. Escape or a click elsewhere cancels; Enter confirms.
- Workspaces can no longer auto-join people by `private.icloud.com`, Apple's new Sign in with Apple relay domain, alongside `privaterelay.appleid.com` (#638).

### Fixed

- A trigger's secret (webhook, Pylon) is never returned after creation: every trigger list and detail redacts `config.secret` and reports `hasSecret` instead. The Jobs page no longer prints raw trigger config.
- A connection's repo assignments picked in the form are saved (they were silently dropped).

### Changed

- **An expired Claude login on a paired machine renews itself.** When the cluster's Claude OAuth token expires, Optio takes a fresh one from a machine running `optio local up`; but a machine where nobody had run `claude` for a while held the same expired token, and the banner asked you to open a terminal. The daemon now runs `claude` once itself, in a scratch directory, when its login is expired or about to be, and hands over the renewed token. Restart `optio local up`. Codex needs no such step: pods sign in with an OpenAI API key or the managed app-server, never a copy of a machine's login.
- **Kill asks right under the button.** Killing a session's process confirms in a small card under the Kill button, like the usage pills, instead of a browser dialog in the middle of the screen. Escape or a click elsewhere cancels; Enter confirms.
- Workspaces can no longer auto-join people by `private.icloud.com`, Apple's new Sign in with Apple relay domain, alongside `privaterelay.appleid.com` (#638).

## [0.8.0] - 2026-10-04

### Added

- **Config as code.** Every Job, scheduled Task, persistent agent, prompt, repo, MCP server, skill and connection can be a YAML manifest (`apiVersion: optio/v1`, six kinds, names as references, secrets by name and never by value, `*File` fields for long prompts and skill directories). Mount a directory of them (`OPTIO_CONFIG_DIR`; Helm `configAsCode.*`) and the API keeps the workspace matching the files: create, adopt, update, replace, prune. A managed row edited in the UI is put back at the next sync and reported as reverted. **Settings → Config as code** shows the directory, the last sync with every error, **Sync now**, **Preview** and **Export YAML**; managed rows carry a **Managed** chip and a **Download YAML**; `GET /api/config/schema.json` is the JSON Schema for editors and CI. The CLI gains `optio export`, `optio apply -f`, `optio diff -f` and `optio schema` (a CLI apply is a plain upsert that manages nothing). See `docs/config-as-code.md`.
- **New look.** Optio has a mark, Peek, and app icons to match, across the web app, the site, iOS and Android.

### Fixed

- **Codex sessions on your machine have their conversation again.** Codex 0.160 moved its TUI behind a machine-wide app-server daemon that holds every session file open, and changed what it writes in them, so the daemon never found a Codex session: no thread id, an empty Chat view, nothing to resume or backfill. The daemon now matches a Codex to its session by where and when it started, and reads the new session format. Restart `optio local up`.
- **A finished Codex session no longer says "The agent is working".** Codex's TUI keeps repainting after it answers, so the quiet-terminal heuristic never fired and a done session stayed "working", with the Chat reply box warning that your message would queue. The session file marks every turn, and the daemon now takes those as the signal, the way it takes Claude Code's hooks: "needs you" within seconds of a reply, "working" when you send the next message.
- **Replies from Chat reach Codex.** A message sent from the Chat view was typed into Codex with a newline added instead of being sent: the text and its Enter arrived together and Codex read them as a paste. The server now sends the Enter a beat after the text. Web, iOS and Android.
- **Chat keeps a reply's line breaks.** A reply's lines were run together as one paragraph (a haiku on one line). They now break where the agent broke them.
- Helm renders an empty `OPTIO_CONFIG_DIR` when config as code is off.

## [0.7.0] - 2026-10-01

### Added

- **Work until merged.** The New work form's **Then** has a fourth answer for work that opens a PR: **Work until merged**. The agent opens the PR, then Optio brings it back to fix failing CI, merge conflicts, and review feedback, and squash-merges once it's green, whatever the repo's own auto-resume and auto-merge settings say. Untick **Merge it for me** to have the agent keep the PR green and leave the merge to you. Under Then, **What happens to the PR** lists each step (review, CI fixes, requested changes, merge) for any work that opens a PR, so **Exit when done** now shows what the repo's settings will do too. A repo in cautious mode (draft PRs) still never merges. Scheduled Tasks pass the setting to every run, the Work list shows "until merged", and a new **Assign to Optio** preset turns issues labeled `optio` into PRs worked until they merge.
- **Reply from Chat in the web app.** A running session's conversation now has a reply box at the bottom: type and press Enter (Shift+Enter for a new line) and your message goes to the agent as if you had typed it in the terminal. While the agent is mid-turn it says so, and your message waits for it. Until now the web's conversation view was read-only, and replying meant switching back to the terminal.
- **Model providers: run Claude Code and Codex on Amazon Bedrock.** **Settings → Model providers** saves a way for an agent to reach its models other than its usual sign-in. Today that's Amazon Bedrock, for Claude Code (Anthropic models) and Codex (OpenAI models on Bedrock). A provider has a region, the models it offers each agent (suggested Bedrock ids to start from), and how it signs in:
  - **On your machines:** the machine's own AWS credentials, optionally a named AWS profile. No credential ever leaves the server; the daemon reports which AWS profiles the machine has, by name.
  - **In pods:** an AWS access key, a Bedrock API key (both stored encrypted, never shown again), or the pod's own IAM role.

  Once a provider exists, the New work form's Who section gets a **Provider** switch (Default, or the provider) and the model list becomes the provider's. Picking nothing keeps everything as before. It's in the web, iOS and Android apps, for Tasks, scheduled Tasks, Jobs, persistent agents, automations and sessions on your machine. Restart `optio local up` to run providers on a machine; an older daemon refuses such a run rather than quietly using its usual sign-in.

- **Organization or Just me.** Model providers, secrets, connections and work now have an owner: the organization, or one person. Personal work runs with its owner's secrets, providers and connections; everyone still sees it ("Runs as Alice"), but only its owner can change it, run it by hand, message it or change its triggers (an admin can still delete it). Organization work can only use the organization's. Admins add the organization's providers and connections; anyone can add their own. Work on your machine is always yours.
- **Pick the secrets work gets.** Pod work has a **Secrets** row: the agent gets only the secrets you pick (the organization's, or your own for personal work), and you can add one on the spot. A new workspace setting, **Pods get only the secrets work picks**, also stops repo pods from receiving every organization secret for work that picks none.
- **Join a workspace by signing in.** Workspace settings take email domains (`acme.com`): anyone who signs in with a verified email at one of them joins with the role you choose. Public mail domains are refused. Works with Google, GitHub, GitLab and generic OIDC sign-in.
- **Logos.** Work rows, PR and issue links, Reviews and Inbox, trigger lists and the New work form's When section show the GitHub, Slack, Linear, Jira, GitLab and other marks, and pull requests show GitHub's glyph in their state's colour. Web, iOS and Android.

- **The New work form remembers your agent settings.** The runtime you picked last, and for each runtime its model, effort and other parameters (model provider included), are filled in next time you start new work, on any device. Saved when you create work; **Reset** goes back to the defaults.
- **Agent logos** for Claude Code, Codex, Copilot, Gemini, Cursor and OpenCode in the New work form's Who picker and on Work rows.
- **A task can open several PRs.** Every PR a task opens is tracked: the ones its agent's `gh pr create` / `glab mr create` / MCP `create_pull_request` calls created, and any open PR on a branch under the task's (`optio/task-<id>-<slug>`; the prompt now asks for that naming when the work needs more than one PR). The task page lists them once there's more than one, with **Stop tracking** and **Add PR** for one Optio missed. The first stays the PR Optio follows for CI, reviews and merge. `GET /api/tasks/:id` returns them as `prs`.

- **Text size and column width in Chat.** A session's Chat view has A− / A+ and Narrower / Wider controls (and ⌘/Ctrl + = / − / 0), remembered per browser for every chat.
- **Refresh Codex's usage.** The Codex usage pill has a refresh button like Claude's: the machine's daemon asks Codex for its current limits instead of waiting for the next Codex turn. Restart `optio local up` to get it.
- **Environment per piece of work.** The New work form's **Where** has an **Environment** section: pod work can switch the repo's connections, MCP servers and skills on or off, pick its secrets, run its own setup commands before the agent, and make its PR follow-through more careful than the repo's (ask for a review, open draft PRs, resume fewer times), never less. Jobs and persistent agents now get connections, MCP servers and skills like Tasks do.
- **Commands as work.** A Job can run a shell command instead of an agent, in a pod or on a machine, on any trigger: its `{{params}}` arrive as shell variables (never spliced into the command) and its exit status settles the run. A trigger on a machine can open a plain shell.
- **Persistent agents with a repo.** A persistent agent can work in one checkout of one of the workspace's repos, fetched each turn.

### Changed

- **Repo settings on iOS and Android use the live agent picker** (same models and per-model effort levels as New work); New work on mobile starts from the picked repo's defaults.
- **Repo settings pick the agent the way New work does.** The repo page's default agent and its model, effort and other parameters use the same picker as the New work form, with the same live model and effort options; the new-repo wizard offers every agent. Picking a repo in New work starts from the repo's defaults ("Repo defaults · Reset"); a repo's own defaults win over your remembered settings for pod work on it. The repo settings and new-repo pages are refreshed to the newer layout.
- **Every effort level Claude supports.** The Claude Code effort picker now offers Low, Medium, High, Extra high and Max, narrowed to what the chosen model takes, and it's hidden for models without an effort setting (Haiku 4.5, Sonnet 4.5). Optio reads each model's levels from Anthropic's Models API (`capabilities.effort`) along with the model list; on a machine, an effort the installed `claude` doesn't list is left out instead of stopping it from starting.
- **Logos are one colour.** Slack, Claude and Gemini follow the text colour like every other mark; only pull request and issue glyphs keep their state colours.
- **Transcript ⇄ Screen is now Chat ⇄ Terminal**, on the web, iOS and Android, matching the Chat · Terminal tabs of pod sessions. The toggle now shows up as soon as a Claude Code or Codex session starts, before the agent has said anything, with "Nothing yet" until the first message lands. On a phone-width browser, a session with a conversation opens on Chat, as it does in the iOS and Android apps.
- **One pod for the API and the web UI.** The Helm chart runs the web UI as a second container in the API's pod instead of its own Deployment, so there is one rollout and one pod to schedule, and the web server reaches the API over localhost. The web UI follows the API's replicas, autoscaling, disruption budget, anti-affinity and node selector; `web.replicas`, `web.autoscaling`, `web.pdb`, `web.antiAffinity` and `web.nodeSelector` are gone. The `optio-web` Service still exists. To restart both, restart `deployment/optio-api`.
- **The operations assistant pod is off by default** (`optio.enabled: false`). Nothing in Optio needs it; set it to `true` to keep running it. The local setup and update scripts no longer build its image.
- **Sessions stay put in the Machines list.** Sessions used to be grouped by Needs you / Working / Idle, so with many of them flipping between states the list kept moving under your cursor. It is now ordered by when you last typed into a session, then by when it started, with finished sessions below; a session that needs you is marked on its row, and the count in the header jumps to the next one. Same on iOS and Android.
- **Personal secrets follow the work's owner, not its creator.** A run used to look up the creator's own secrets first. It now does that only for work that belongs to someone ("Just me"), and organization work never sees anyone's personal secrets, agent sign-in included. Set work you rely on personal secrets for to **Just me**.
- Members can now add their own (personal) secrets and connections; the organization's still need an admin.
- **One backend for Work.** Scheduled Tasks, Jobs and Local automations are now one `work_definitions` table, and Job runs are rows in `tasks` (`kind = 'standalone'`), with one log table and one pod table under them. `/api/work` lists, creates, saves and deletes every kind (create and save write the trigger in the same transaction). Every legacy endpoint keeps its response shape. Five migrations move the data on first boot; back up the database before upgrading.

### Fixed

- **Max effort now reaches pod runs.** Optio passed effort to pods through Claude Code's `effortLevel` setting, which only persists up to Extra high, so Max was silently dropped. Pods now also get `CLAUDE_CODE_EFFORT_LEVEL`, which takes every level.
- **No more "Extended thinking" toggle.** Claude Code always thinks (its default; adaptive thinking on current models, steered by effort), and turning it off made any run with an effort level fail. The toggle is gone from the New work form, repo settings, and the iOS and Android apps; a saved value is ignored.
- **PRs an agent only mentions are no longer adopted.** A task used to take the last PR link in its agent's output for its own repo, so `gh pr view 812` or "like #812" could make an unrelated PR the task's, and on your machine the first PR link the session printed won. Optio now adopts a PR only from the result of the agent's own PR-creating call (or a PR on the task's branch), checks it with GitHub / GitLab / CodeCommit (right repo, open or merged, new or on the task's branch), and still shows other links as links.

## [0.6.5] - 2026-09-28

### Added

- **Codex sessions have a Transcript too.** Opening a Codex session now offers the same **Transcript ⇄ Screen** toggle as Claude Code: your prompts, Codex's replies, its reasoning summaries, and every command or patch with its output, readable at any width. It works for Codex started by Optio and for `codex` typed into a shell on your machine. The daemon reads Codex's own session file (the one the running `codex` process holds open), so nothing needs configuring. Codex runs now report their session id too, so **Resume chat** works for them, a headless Codex task that gets review feedback resumes one-shot (`codex exec resume`), and a finished Codex session's conversation can be read back off the machine like a Claude Code one's. Restart `optio local up` to pick this up.
- **Linear triggers can skip your own tickets.** A Linear trigger's new **Only tickets from someone else** option ignores issues you created and changes you made yourself, like filing a ticket assigned to you or assigning one to yourself. A ticket someone else creates for you, or assigns to you, still starts the work. It's in the New work form, the Machines automations editor, and the iOS and Android forms, and needs your Linear name, handle or user id.

### Fixed

- **Scrolling back in a session.** Opening a long-running Claude Code session (after a reload, switching sessions, another device, or a reconnect) could leave the wheel, a trackpad or a finger drag scrolling nothing. A viewer got only the last 512 KB of the session's output, and Claude Code turns on its fullscreen mode and mouse reporting once, at startup. A viewer now gets the terminal as it stands, rebuilt from the daemon's model of the screen, with the program's modes. Restart `optio local up` to pick this up. Also:
  - On a phone or tablet in the web app, a finger drag now scrolls Claude Code.
  - The iOS Transcript no longer jumps back to the bottom every few seconds while you read back through a running session.
  - The iOS Screen view no longer comes back blank and unscrollable after you switch to the Transcript and back.
  - Android's Transcript no longer pulls you down while you read up through a long last message.
- **Codex's lines around the prompt.** The tinted band Codex draws around where you type, and the `────` rules between turns, could look broken in the web terminal: part of the band was left untinted after you opened a session in the middle of a turn, rows landed at the wrong width when the session had been sized for another screen, and xterm's HTML renderer left seams between the band's rows and ticks along the rules at some zoom levels. Sessions now open exactly as they were drawn, and the web terminal draws with WebGL where the browser supports it, falling back to the HTML renderer otherwise.
- **Messages you didn't send no longer show as yours** in a session's Transcript. Claude Code files some messages as your turns: a background task or agent reporting back, a message from another agent session, the summary that replaces a compacted conversation, an interruption. These now show as notes saying what they are, and a session's launch prompt (from the New work form or an automation) shows as **Prompt**. Conversations recorded before this read correctly too.

## [0.6.4] - 2026-09-26

### Added

- **Slack bots can start work.** A Slack trigger's new **Posted by** setting takes bots (apps, integrations, incoming webhooks: an alerting tool, say) or anyone, not just people, and **Bot** narrows it to one bot by the name on its posts or its id. So "when the alert bot posts in #alerts, start a Codex session to debug it" is a Slack trigger with the channel, **Posted by: Bots** and the bot's name. A bot's `{{text}}` includes what its attachments and blocks say, where alerting tools put the details, and `{{botName}}` names the bot. Posts by Optio's own Slack app never start anything. Triggers keep firing only for people unless you change the setting.
- **Codex can skip every check on your machine.** For a Codex run on a machine, the New work form's **Permissions** has **Skip all checks**, which starts Codex with `--yolo` (`--dangerously-bypass-approvals-and-sandbox`: no approval prompts, no sandbox), for new, one-shot and resumed sessions alike. Left at **Default**, Codex keeps the machine's own settings. Claude Code's **Skip all checks** (`--dangerously-skip-permissions`) was already there. The iOS and Android forms now show **Permissions** and **Reasoning effort** for runs on a machine too, where they showed only the model. Restart `optio local up` to pick this up.

### Changed

- **A session fits the screen you open it on.** Opening a session, bringing its tab to the front, or coming back to it after a minute away resizes the terminal to that screen, with no need to click **Use this screen**. A screen that is showing the session and was used in the last minute keeps its size, so glancing from your phone at a laptop you're working at doesn't squeeze the laptop down to phone width. The newcomer then shows the laptop's layout scaled down, with **Use this screen**, and typing or clicking there still takes it. The server decides which screen that is (it knows every screen viewing a session), and a laptop that went to sleep with the session open stops counting within seconds. Same in the iOS and Android apps, on the Screen face.
- **The iOS Live Activity looks like the Work widget.** Its top row is the widget's counts: Need you and Running, plus Waiting, Recurring, and Agents. When more than one session needs you, it lists them instead of showing only the oldest: each row has its status (**Allow?**, **Reply**, **Conflict**…), how long it has waited, and a **Later** button, and tapping a row opens that session. Up to three are listed, else the oldest two and "+N more". A single waiting session is still shown in full with **Reply…** and **Later**. When nothing needs you, it lists what's running the same way, newest first. The Dynamic Island shows how many need you and how many are running, and lists the same sessions when expanded.
- **iOS Live Activity and widgets** read cleanly at any width and text size. Status words, timers, counts, and chip values always show in full; only titles and reasons shorten. A widget lists as many sessions as fit.

### Fixed

- **Copying from a session in the web UI.** With Claude Code in fullscreen mode, a drag selects in Claude Code rather than in the terminal, and Claude Code copies the selection with an escape sequence (OSC 52) that the web terminal ignored. Now a drag followed by ⌘C copies it (in Chrome it's on the clipboard as soon as you let go), and ⌥-drag selects in the terminal itself. The same goes for `/copy` and for tmux and vim copying. Pod sessions get the same fix.
- The iOS app no longer puts text back on the clipboard when you open a session that copied something earlier, and a program in a session can no longer read your phone's clipboard.
- On Android, editing a Local automation shows its model and permission settings, and saving applies changes to them; the edit form used to leave them out.
- A screen whose size already matched the session's no longer showed **Sized for another device**, and **Use this screen** no longer resized the session twice.
- A web terminal no longer answered queries replayed from a session's history (a cursor-position or terminal-identity request from when the program started). The stray answers reached the program as input, and opening a second window could take the session's size.
- **Later** on the iOS Live Activity takes effect at once: the activity moves on to the next session waiting, or shows the session as running when it was the only one. It used to look like nothing happened until the app refreshed, and a lone waiting session stayed put even then. **Resume** and **Retry** update it right away too, and **Later** from a notification does the same. On Android, **Later** on the only waiting session now moves the Watch on as well.

## [0.6.3] - 2026-09-24

### Changed

- Links in a session open on **⌘-click** (Ctrl-click off a Mac), straight into a new tab. Clicking a link no longer asks "Do you want to navigate to…?" every time, and a plain click stays a click in the terminal. On a touch screen a tap still opens it.

## [0.6.2] - 2026-09-24

### Added

- **Codex's own models and effort levels** — each machine's daemon asks its Codex which models it offers (`codex debug models`) and reports them with their reasoning efforts, so the New work form lists the latest Codex models (GPT-5.6-Sol, -Terra, -Luna, …) as Codex does, and a **Reasoning effort** picker shows only the levels the chosen model takes. A run on a machine uses that machine's list. Codex runs in pods now get the model and effort too; they used to run Codex's default model. Restart `optio local up` to pick this up.
- **Codex limits in sessions** — a Codex session's header shows Codex's 5-hour and weekly limits (from its session log, updated after each turn). A plain terminal on a machine where Codex ran recently shows them next to Claude's.
- Runs on a machine can set the **effort** (Claude Code and Codex) and, for Claude Code, the **permission mode**.
- A **Sessions** button on the Work list opens the session screen at the session that has waited on you longest, else the most recently active one.

### Changed

- Claude Code agents on your machine start in **auto** permission mode (`--permission-mode auto`): Claude's classifier approves routine edits and commands and blocks risky ones, so an agent no longer stalls on permission prompts. A headless run could previously do nothing that needed approval. Choose **Skip all checks** (`--dangerously-skip-permissions`) or **Ask first** per run in the New work form. A Claude Code too old for auto mode starts in its own default. Restart `optio local up` to pick this up.
- A session started by a trigger names its source on its badge (GitHub, Slack, Linear, schedule, webhook) instead of "trigger".
- PR and ticket badges are a size larger.

### Fixed

- **Killing a session** leaves it in Finished. Its last hook or shutdown output used to put it back under Working, and an automation's session landed in Needs you on exit. The run behind a killed session now ends cleanly: an interactive run completes (closing it is how it ends), and a headless run stops without a retry. Before, the kill's non-zero exit failed the run, which could retry.
- The same PR no longer shows as two badges (a bare `#607` and its URL, or the PR a review-request automation started for), and a PR URL ending a line no longer picks up digits from the next one (`#612` showing up again as `#61219`).
- Codex runs no longer pick up the repo's Copilot model and effort, which share its settings columns.
- **⌥↑ / ⌥↓ in the web terminal on a Mac** reached the program as Ctrl+↑ / Ctrl+↓, so Codex's "answer the question" key (⌥↑) did nothing. xterm.js mistook the web bundle for Node and dropped all its Mac key handling, which also sent Option-typed characters as Esc+letter.

## [0.6.1] - 2026-09-24

### Added

- **Add machine** on the Machines page walks through pairing a computer with Optio Local: the commands come with this server's URL filled in (sign-in is skipped when auth is off), and the page says when the machine connects. `@optio/cli` isn't on npm yet, so the steps — and the READMEs — build it from a checkout.
- **Directories from the UI** — add and remove a machine's directories from its card on the Machines page, or with **+ Add a directory…** in the New work form. The machine's daemon makes the change, as `optio local add` would there (it expands `~`, checks the directory exists, and detects its git remote); `optio local up --no-remote-dirs` keeps a machine's list local-only. Restart `optio local up` on each machine to pick this up.
- **"Always the latest" models** — the Optio agent's model picker reads the live model list and offers each family's alias ("Opus · now Opus 5.5") above the specific versions.

### Changed

- The Optio agent defaults to **Opus** — the newest one — instead of Sonnet. Settings you've already saved keep their model.
- Model aliases follow the live model list: "opus", "sonnet", and "fable" mean the newest model of that family the configured key can see, and each family lists newest first, so "(latest)" is right in every model picker.

### Fixed

- "My machine" in the New work form dead-ended in an empty Machine list and a "Pick a directory…" placeholder when no machine was paired (the Interactive chat and Terminal examples picked it anyway); it now shows how to pair one and picks the machine up when it connects.
- The Optio agent's model could only be saved as opus, sonnet, or haiku — picking Fable failed to save; any Claude model id is accepted now.
- A provider's list-models probe times out instead of holding a request open when the provider doesn't answer.

## [0.6.0] - 2026-09-23

### Added

- **Optio for iOS** — a native SwiftUI app (`apps/ios`): the Overview board, the Work feed and a native New work form with every option the web form has, Optio Local terminals with Transcript and Screen faces, Insights, persistent agents, and pod sessions. Sign-in pairs the device with a personal access token. Widgets, Controls, App Intents, a Live Activity and Dynamic Island, notifications over APNs, alternate app icons, and two windows on iPad. Its models are generated from the shared TypeScript types (`pnpm gen:swift`, checked in CI) (#597, #598, #600, #603, #606, #613).
- **Optio for Android** — a native Kotlin + Jetpack Compose app at parity with iOS (`apps/android`), with notifications you can reply to, widgets, Quick Settings tiles, multiple servers, and `optio://` links. The API sends push over **FCM** alongside APNs (optional; see `docs/android-push.md`), and `pnpm gen:kotlin` generates the app's models (#618).
- **Run Tasks and Jobs on your own machine** — every Task, Job, and scheduled Task has a run location (`cluster`, or `local` with a host, directory, and session mode). Local runs go to the Optio Local daemon as agent terminals, and the terminal drives the run's state (#590).
- **Local automations on events** — GitHub, Slack, and Linear event triggers with signed ingress, interactive or headless session modes, saved prompts as the command, and resume of an exited agent session.
- **Personal access tokens** are created and revoked in Settings.
- **Full agent parameters for every pod run** — Jobs and persistent agents keep `agent_options` (effort, thinking, context window, approval mode, …) the way Tasks do (#599).
- **Run names from trigger params** — recurring work can name each run from its trigger's `{{params}}`, e.g. `Triage: {{ticketTitle}}` (#617).
- **Optio Local** (restart `optio local up` on each machine to pick these up):
  - A finished agent session reads back as its full conversation. Sessions recorded before transcripts existed are backfilled from Claude Code's own log by the machine's daemon (#591, #619).
  - An exited terminal replays its final screen at its recorded size (#587).
  - The terminal follows whoever is typing; other viewers see it scaled to fit.
  - A machine keeps its identity when its hostname changes, and Machines can merge an offline duplicate into the machine it became (#619).
  - The Claude OAuth token can be refreshed from a paired machine's daemon (#593).
- **Per-model 7-day usage limits** (Claude Fable) in the usage widgets (#592).
- The pod session chat is one Claude conversation across turns and reconnects (#602).

### Changed

- **One noun: Work.** Tasks, Jobs, scheduled Tasks, Local automations, terminals, and persistent agents are all presented as **work** with five attributes: **When** (now, a schedule, a webhook, a ticket, a GitHub / Slack / Linear event, or messages), **Where** (an Optio pod, with or without a repo, or a directory on your own machine), **Who** (a terminal or an agent runtime and its parameters), **What** (the prompt), and **Then** (exits when done, waits for me, or a persistent agent). `/work` is the one feed (Active · Recurring · Agents · History) and `/work/new` the one form; recurring work is edited in the same form at `/work/:id/edit`. The sidebar is **Overview · Work · Reviews · Inbox**, then **Library** (Prompts · Repos · Machines · Connections). The per-kind list and creation pages, and the interim `/sessions` pages, redirect; detail pages stay (#594, #599, #601, #615).
- **One trigger layer.** Every trigger type attaches to every kind of work — a GitHub event can start a Job or a scheduled Task in a pod as well as an automation on your machine — through one CRUD and one dispatcher, and a definition can carry several triggers of one type (#615, #616).
- **Overview** opens with a board built from the Work feed (needs you, live, recurring, agents), then usage limits, recent runs, and activity (#594).
- **Machines** is a Library page for paired computers and their automations (#594).
- A denser sidebar with collapsible groups; admin pages moved to the user menu.
- The README, docs, examples, and marketing site are rewritten around the work model (#604, #610, #614).

### Fixed

- Opening a Local session from Work (or any other list page) stuck on "connecting…" until a reload: those pages carried the build-time API URL (#612).
- **Issues** names the repos and ticket providers it couldn't read, such as a stale `GITHUB_TOKEN`, instead of showing an empty list (#611).
- GitHub, Slack, and Linear webhooks were rejected with 401 when auth was enabled (#618).
- WebSocket messages sent before authentication finished were dropped, which kept `optio local up` from connecting to an auth-enabled API (#618).
- Pod session chat dropped a message sent right after connecting, replayed events out of order, and reset its cost on reconnect (#618).
- `GET /api/activity`, cost filtering by repo, and deleting a trigger that had started runs returned 500; raw database timestamps reached JSON, which kept iOS from loading an agent with a pending message (#618).
- **Resume chat** on a finished Local session opens the resume already in progress instead of starting another, and says when the machine is offline (#619).
- The New work form's answers reach the API intact: pod kinds were rejected, a pod session lost its name, a new branch on a machine was dropped, ticket triggers on Jobs and agents never fired, and unnamed work was always "Session 2" (#599, #601).
- A revoked Claude token is detected, so the automatic refresh from a paired machine fires (#617).
- Local terminals: a stale echo of our own resize no longer hides the bottom rows (#588); previews and PR links are read off a screen model, so full-screen agents no longer produce bogus PR badges (#608); the session title no longer runs into the status dot (#589); the usage pill stays visible when the usage read fails (#605).
- Local session and Job run spend count in Insights costs (#595).
- The per-IP API rate limit is configurable (`OPTIO_RATE_LIMIT_MAX`, default 600/min), so the mobile apps' polling no longer trips 429s (#596).

### Security

- `/api/webhooks/slack/actions` now verifies Slack's signature. **Deployments that use the Slack action buttons must set `SLACK_SIGNING_SECRET`** (#618).

## [0.5.0] - 2026-09-18

### Added

- **Optio Local** — terminals on your own machine, managed from the web UI at `/local`. The CLI daemon (`optio local up`) makes one outbound WebSocket to the server, advertises a directory allowlist, and runs PTYs; the browser attaches over a relay. Attention detection is layered (Claude Code hooks → bell → silence) and drives a "needs you" queue. Local Blueprints spawn terminals from webhook/schedule/ticket triggers with shell-quoted params. See [docs/optio-local.md](docs/optio-local.md).
- **Local cockpit UX** — split view (up to three terminals side by side or stacked), a session rail with PR/ticket badges and link-aware search, Shift+Enter for newlines in agent REPLs, a collapsible rail (`⌃⇧B`), inline session rename, a single status dot per header that folds lifecycle and attention into one color, and headers that collapse by pane width so the title always keeps its text.
- **Attention from another tab** — the favicon shows the focused session's status (yellow needs you / green working / grey quiet), the tab title carries a `(N)` needs-you count, and a per-session bell arms a browser notification for when that session needs input.
- **Usage in the terminal header** — Claude's 5-hour / 7-day account limits as a gauge pill with a hover card and a manual refresh (`GET /api/auth/usage?fresh=1` bypasses the 5-minute cache), and a per-session tokens/cost chip summed by the daemon from the Claude Code transcript. A `claude` shim on every spawned terminal's PATH gives a hand-launched Claude Code the same hooks as an agent spawn.
- **Overview redesign** — the dashboard now opens with a cross-concept **Needs you** strip, then a **Usage limits** panel showing Claude next to **Codex** (the daemon reads Codex's newest rate-limit snapshot from its session logs, no token leaves the laptop), a **Live** panel of every open terminal, session, and awake agent, per-concept stats strips with **Local** as a peer, quiet concepts folded into one line, and a **Recent** feed mixing repo tasks, job runs, and persistent-agent turns via `GET /api/runs/recent`.
- **Cursor (`cursor-agent`)** as a supported agent type.
- **Workspace RBAC** enforced across the API and WebSockets: viewers are read-only on all mutating routes, member/admin gates on the rest, and workspace scoping on activity, log streams, persistent agents, jobs, connections, and webhooks (#574, #575, #576).
- **Deterministic test tiers** — integration tests against real Postgres + Redis, a full-pipeline e2e tier with a fake agent runtime, Playwright web e2e, and a live smoke harness.
- **Opt-in rootless mode** for agent StatefulSet pods; a storage class setting for the built-in Postgres PVC (#577); `--check` mode for `update-claude-auth.sh`.

### Fixed

- Agent prompt arguments are shell-quoted everywhere they reach a shell; PR-open task state is cleaned safely (#555, #558).
- Scraped PR URLs are verified against the git platform before a task enters `pr_opened` (#561); in-pod agents are terminated on cancel and post-cancel PR adoption is guarded (#564).
- Runs fail on terminal Claude API errors instead of being marked Done (#563); cost accumulates across resumes and survives bare retries (#573).
- Tasks created by webhooks, tickets, and subtasks get a `workspace_id` (#560); missing secrets fail provisioning permanently instead of retrying forever (#569).
- Schedule triggers compute `nextFireAt` again (#568); cancelled standalone runs are no longer auto-retried (#567).
- Setup re-runs no longer rotate the encryption key, and decrypt failures are actionable (#562); built-in connection providers stop duplicating on restart.
- GitHub rate limiting is respected (#546); the enterprise security posture is hardened (#545); Gemini/Vertex credentials count as setup-complete signals.
- Agent images pin CLIs to work around a Bun exec crash (#566) and install the Codex CLI (#559); the web production build excludes e2e files (#578); log catch-up replay frames are ignored in the web log view (#535).

## [0.4.1] - 2026-06-11

### Added

- **AWS CodeCommit** as a third supported git platform alongside GitHub and GitLab. Auths via AWS access keys or IRSA/instance profile on EKS; PR ops go through `@aws-sdk/client-codecommit`. CI checks return `[]` (auto-merge fires on `checksStatus="none"`); `reviewTrigger="on_pr"` is recommended over the default `on_ci_pass` (#529).
- **Ruby and Dart agent image presets** — new language-specific base images available in the agent image picker (#470).
- **Live model discovery** — agent model lists are now fetched directly from provider APIs at runtime rather than being hard-coded, so newly released models appear automatically (#543).
- **Claude Fable 5 and GitHub Copilot** added as supported agent vendors (#542).

### Fixed

- Git token resolution in repo pods is now more resilient against transient credential lookup failures (#525).
- `scope='global'` secrets now correctly enforce `workspace_id IS NULL` in the database, preventing a constraint mismatch that could cause secret lookups to fail (#509).
- Missing `auth.oidc` block validation added to the Helm chart, preventing silent misconfiguration when using generic OIDC login (#528).

## [0.4.0] - 2026-04-27

### Added

- **Persistent Agents** — a third Task tier alongside Repo Tasks and Standalone Tasks. Long-lived, named, message-driven agents that wake on user messages, agent messages, webhooks, cron ticks, or ticket events. Each agent has a stable slug, addressable by other agents in the same workspace via an inter-agent HTTP API. Three configurable pod lifecycle modes: `always-on`, `sticky` (default, with idle warm window), and `on-demand`. Cyclic state machine reconciled by the existing K8s-style control plane (now a fourth `RunKind`: `persistent-agent`). New `/agents` UI with chat, turn history, live activity stream, and pause/resume/restart/archive controls (#510). See [docs/persistent-agents.md](docs/persistent-agents.md) and the four-agent demo in [demos/the-forge](demos/the-forge/README.md).
- **Issues** as a top-level nav item — the GitHub Issues queue is now its own page at `/issues`, fanning out across multiple configured ticket providers.
- **Reviews** as a top-level nav item — code-review subtasks plus external PR reviews now live at `/reviews` (and `/reviews/:id`), with their own reconciler `RunKind` (`pr-review`).
- **Workspace member management UI** — invite, list, and remove workspace members by email with a server-side duplicate-member 409 guard (#496, #499).
- **Agent-aware review configuration** — pick the review agent type per repo so reviews can run on a different vendor than the authoring agent (#504).
- **Skills marketplace** — install skills from any git URL, with agent-typed scoping and a multi-file skill-directory layout so a single skill can target one or many agent types.
- **Persistent Agents and Sessions stats bars** on the overview page (#521).
- **Persisted session chat history** — re-opening a session now shows the prior conversation (#517).
- **Rich rendering in the agent log viewer** — markdown tables and rich blocks render in agent text output (#520).
- **Examples directory** — runnable, self-contained agent configurations under [`examples/`](examples/README.md), starting with two Persistent Agent setups (Forge and Mars Mission Control). Each example is idempotent — re-running `setup.sh` is safe.

### Changed

- **Sidebar nav reorganized.** The hub-and-tabs `/tasks` page is gone. Each tier has its own dedicated route, grouped into **Run** (Tasks · Jobs · Reviews · Issues · Scheduled) and **Live** (Agents · Sessions). The Library group renamed "Templates" to **Prompts** to free that label. Legacy `/tasks?tab=…` URLs redirect to the dedicated pages.
- **User-facing names finalised.** Repo Tasks → **Tasks**; Standalone Tasks → **Jobs** (matching the existing `/api/jobs` URL); PR Reviews → **Reviews**; Persistent Agents → **Agents**; Templates (in the Library) → **Prompts**. Backend table names (`tasks`, `task_configs`, `workflows`, `prompt_templates`) are unchanged.
- **Setup wizard defaults agent secrets to global scope** with an explicit scope toggle, reducing per-user secret sprawl for the common case (#503).
- **README leads with differentiation** — self-hosted, BYO-K8s, multi-vendor — to better orient first-time readers (#519).

### Fixed

- Sessions: stop echoing the agent's final line in the chat view (#516).
- Auth: `/me` now returns the enriched user object with the caller's workspace role attached (#508).

### Migration notes

> Upgrading from 0.3.x — there are no required user actions. URL/nav changes:
>
> - `/tasks?tab=standalone` → `/jobs` (auto-redirected)
> - `/tasks?tab=issues` → `/issues` (auto-redirected)
> - `/tasks?tab=prs` → `/reviews` (auto-redirected)
> - The "Templates" sidebar item is now labeled **Prompts** but still points to `/templates`.
> - The new `/agents` route requires the v0.4 schema migration (`1777200001_persistent_agents.sql`) — applied automatically on API startup.
>
> No data migration is needed. Existing tasks, workflows, triggers, and templates continue to work unchanged.

## [0.3.2] - 2026-04-24

### Added

- **External PR auto-review** — review agent for PRs on external repos with chat + one-click merge, lifted into its own primitive alongside task-generated reviews.
- **Google Vertex AI authentication mode for Claude Code** — route Claude through GCP Vertex AI using `CLAUDE_VERTEX_PROJECT_ID` / `CLAUDE_VERTEX_REGION` and an optional (encrypted, global-scope) service account key, with workload-identity fallback (#478).
- **Workload identity support** for agent pods, plus fixes to repo pod lifecycle (#486).
- **User-scoped secrets** — keep identity tokens out of the pod env and scope them per user (#474).
- **Secrets injected into pod env for setup commands** (#471), and an OAuth refresh widget on `/secrets` that hides the banner when visible.
- **Resume stopped agents on chat message** — sending a chat message to a stopped task resumes the agent (#488).
- **Multi-repo + multi-tracker ticket integration** — redesigned setup flow (#489).
- **Dynamic per-provider model & options picker** with a refresh button for agent settings (#493).
- **Gemini model options** updated with new preview models (#490).
- **GKE & Gateway deployment enhancements** in the Helm chart (#461).
- **Diagnostic logging for raw error detection** in agent adapters (#467).

### Changed

- **PR reviews folded into the Tasks page** — removed the sidebar duplicate; task and PR-review detail views now share primitives (#494, #485, f1a6da4).
- **Repo settings page** — split external PR review out and tabified agent settings (#487).
- **Standalone Tasks pipeline stats bar** restored on the overview page.
- **Opus model option bumped from 4.6 to 4.7** (#491).

### Fixed

- Reconciler: guard PR-reactive actions (auto-merge, complete-on-merge, review launch) to coding tasks only so external PR reviews don't trip them (#480).
- Reviews: stop writing external PR URLs to `pr_review` task rows (#481).
- Secrets: downgrade `scope='user'` to `'global'` when auth is disabled.
- API: derive Claude/Codex/Gemini mode from secret names on public `/setup/status` (#477).
- Auth: add OIDC routes to public auth routes so login works before a session exists (#479).
- Helm: restore `chown` capabilities in postgres init containers (#482); fix postgres volume permissions and decouple `isSetUp` from runtime health (#472).
- Images: change agent user UID from 1000 to 1001 to avoid conflicts on managed node images (#466).
- Gemini agent: settings validation, parser crash, and exit-code inference (#463).
- Correct sub-hour timezone drift in `getETDate` (#462).

## [0.3.1] - 2026-04-20

### Fixed

- Ticket sync: fall back to the configured GitHub App (or `GITHUB_TOKEN` PAT) when a GitHub ticket provider has no inline token or provider-specific secret. Previously sync hard-failed with `"GitHub provider requires token, owner, and repo in config"` even when a GitHub App was fully configured (#458).

## [0.3.0] - 2026-04-20

### Added

- **Pooled standalone-task pods** — runs within a workflow now share pods, scaling out to `workflows.maxPodInstances` replicas each hosting up to `workflows.maxAgentsPerPod` concurrent runs (mirrors repo pod scaling). Runs track assigned pods via `workflow_runs.pod_id` with `last_pod_id` for retry affinity, and pool selection follows preferred → least-loaded → scale-up → overflow. Fixes a leak where a burst of triggers would spawn one pod per run even though only a few ran at once.

### Changed

- **Reconciliation control plane is now authoritative** — the K8s-style reconciler (shadow mode in 0.2.0) now owns PR-driven transitions, auto-merge, complete-on-merge, fail-on-close, auto-resume, review launch, stall detection, pod-death detection, and control intent (cancel/retry/resume/restart) for both Repo Tasks and Standalone Tasks.
- **Shared auth banner, state badge, and metadata card** across task pages for a consistent UX.

### Fixed

- Reconciler: clear stale `finishedAt` when retrying a standalone run.
- Reconciler: use unique jobIds for executor enqueues to prevent BullMQ dedup collisions.
- Agent adapters: include `cache_read` and `cache_creation` tokens in input totals (#457).
- API: trigger auth banner when the usage endpoint detects an expired OAuth token (#455).
- API: detect Claude auth failures mid-run in standalone task runs and override nominally-successful exit codes.

### Docs

- Document the unified reconciler and the Repo vs Standalone Task model.

## [0.2.0] - 2026-04-17

### Added

- **Unified Task model** — single polymorphic `/api/tasks` HTTP resource covering Repo Tasks, Repo Task blueprints, and Standalone Tasks; unified resolver across `tasks`, `task_configs`, and `workflows`
- **Standalone Tasks (Agent Workflows)** — agent runs with no repo checkout, `{{PARAM}}` prompt templates, four trigger types (manual / schedule / webhook / ticket), isolated pod execution, WebSocket log streaming, auto-retry with exponential backoff, clone, visual editors, search and filters
- **Connections** — external service integrations via MCP with built-in providers (Notion, GitHub, Slack, Linear, PostgreSQL, Sentry, Filesystem) plus custom MCP servers and HTTP APIs; three-layer model of providers → connections → per-repo/agent-type assignments
- **Reconciliation control plane (shadow mode)** — K8s-style reconciler for task and pod state, running in observe-only mode
- **StatefulSets for repo pods, Jobs for workflow pods** — native K8s controllers replace ad-hoc pod management
- **Generic OIDC OAuth provider** — self-hosted SSO via `OIDC_ISSUER_URL` + `OIDC_CLIENT_ID` + `OIDC_CLIENT_SECRET`
- **OpenTelemetry instrumentation** — Fastify HTTP metrics plugin and wired-up callsites
- **OpenAPI + Swagger UI at `/docs`** — Zod type-provider migration across all routes (10-phase rollout covering tasks, workflows, repos, sessions, PR reviews, issues, workspaces, notifications, analytics, setup, secrets, optio, cluster, auth, GitHub)
- **Workspace-level audit log and activity feed**
- **Outbound webhooks** — fire on workflow run events with UI management
- **Expanded dashboard analytics** — performance, agents, and failure insights
- **Planning mode** and message bar improvements for agent interaction
- **OpenClaw agent runtime** adapter
- **OpenCode custom OpenAI-compatible endpoints**
- **Multi-arch image publishing** — amd64 + arm64 for all service and agent images
- **Ticket trigger UI** in TriggerSelector and task forms
- **Ticket-provider auth failure handling** — surfaced in UI with auto-disable
- **Stale Claude OAuth token detection** — surface before 401s
- **nodeSelector and tolerations** for api, web, optio, postgres, redis, and agent pods
- **`OPTIO_ALLOW_PRIVATE_URLS`** — SSRF-check bypass for private network integrations

### Changed

- **Overview panel redesign** — reordered sections, side-by-side recent tasks and pods, responsive multi-column / masonry grid with auto-fit minmax
- **Replaced connections modal with inline form**
- **Renamed "Workflows" to "Agent Workflows"** in UI; docs consolidate Schedules + Workflows into a unified Tasks section
- **Removed redundant templates and schedules** — superseded by agent workflows
- **Workflow tables replaced** with new Workflows data model

### Removed

- Top Failures and Performance dashboard panels
- "N tasks failed today" dashboard banner

### Fixed

- Classify agent auth failures as run failures rather than global failures
- Escalate repo tasks to `needs_attention` when the agent completes without opening a PR
- Prevent false task failures when agent creates a PR but exits non-zero
- Detect and clean up zombie `workflow_runs` with terminated pods
- Six K8s infra bugs blocking standalone/scheduled runs and repo pods
- Pod `securityContext` and explicit UID for PVC permissions on GKE
- Re-read task state before orphan reconciliation transitions
- Use `KubernetesObjectApi` for merge-patch annotations; fix scale API
- Persist workflow run logs and publish to per-run channel
- Allow access to workflows with null `workspaceId`
- Treat empty-string env vars as missing in `parseInt` parsing
- JSON.parse error handling for agent scheduling env vars
- Health check passes when ClusterRole is not deployed
- Record GitHub 401s to `auth_events` for banner detection
- Dismiss GitHub/Claude token banners immediately after save
- Clear stale auth-failure banner when token is updated
- Scope auth failure detection to distinguish provider vs global token failures
- Replace Drizzle `migrate()` with hash-based runner; add missing 0046 migration entry to Drizzle journal
- Merge new chart defaults on `update-local` upgrade
- Rename `/docs/guides/workflows` route to `/docs/guides/standalone-tasks`

## [0.1.0] - 2026-03-24

### Added

- **Pod-per-repo architecture** — long-lived Kubernetes pods with git worktrees for concurrent task execution per repository
- **Task orchestration** — full task lifecycle with state machine (pending, queued, provisioning, running, pr_opened, completed, failed, cancelled, needs_attention)
- **Priority queue with concurrency limits** — global and per-repo concurrency controls, priority-based scheduling, and task reordering
- **Subtask system** — child, step, and review subtask types with parent blocking and completion tracking
- **Code review agent** — automatic PR review as a blocking subtask, configurable triggers (on CI pass or PR open), and dedicated review prompts
- **PR watcher** — polls GitHub PRs for CI status, review status, merge/close events; auto-completes on merge, auto-fails on close
- **Auto-resume on review** — re-queues tasks with reviewer comments when changes are requested
- **Auto-resume on CI failure and merge conflicts** — detects failures and re-queues the agent to fix them
- **Auto-merge** — merges PRs automatically when CI passes and reviews are approved
- **Auto-close linked GitHub issues** — closes the originating GitHub issue when a task completes
- **GitHub Issues integration** — browse issues across repos, one-click assign to create tasks, bulk assign all
- **Linear ticket provider** — sync tasks from Linear projects
- **Structured log streaming** — real-time NDJSON parsing of Claude Code output with typed log entries (text, tool_use, tool_result, thinking, system, error, info)
- **WebSocket event streaming** — live task state and log updates pushed to the web UI via Redis pub/sub
- **Web UI** — Next.js 15 app with task list, task detail with log viewer, repo management, cluster health, secrets management, and setup wizard
- **Cluster health dashboard** — expandable resource usage graphs, pod health monitoring, and stale task detection
- **Pod health monitoring** — automatic detection of crashed/OOM-killed pods, auto-restart, orphan worktree cleanup, and idle pod cleanup
- **Secrets management** — AES-256-GCM encrypted secrets with global and repo-scoped support
- **Prompt templates** — configurable system prompts with template variables and conditional blocks; per-repo overrides
- **Per-repo agent settings** — configurable Claude model, context window, thinking mode, effort level, and max turns
- **Auto-detect image preset** — detects project language (Node, Python, Go, Rust) from repo files and selects the appropriate container image
- **Agent adapters** — pluggable adapter interface with Claude Code and OpenAI Codex implementations
- **Container runtimes** — Docker and Kubernetes runtime backends
- **Authentication** — API key and Max Subscription (OAuth) modes for Claude Code
- **Error classification** — pattern-matching error classifier with human-readable titles, descriptions, and remediation suggestions
- **Helm chart** — full Kubernetes deployment with configurable Postgres, Redis, ingress, RBAC, and secrets
- **Pre-commit hooks** — Husky with lint-staged, Prettier formatting, ESLint, typecheck, and conventional commit enforcement
- **CI pipeline** — GitHub Actions for format checking, typechecking, testing, web build, and Docker image build
