# Conversational work creation

Open **Optio Agent** in the sidebar. Describe the work, or click **Dictate**,
stop recording, review the draft, and send. For example:

> Start a Codex session on my Mac in the Optio repo to investigate the login issue.

Optio discovers repositories and paired machines, asks about ambiguous destinations,
and proposes work through the Optio controller MCP and the same work service as the
form. The review card shows When, Where, Who, Then and the prompt. Approval executes
the tool once and the response links to the work. Settings → Agents → Optio agent
controls the harness, its options, enabled controller tools and write approvals.

Each Optio Agent conversation is an ordinary **waits for me** pod work session with an Optio prompt and
controller MCP access. The floating panel and its **Open in session** icon show
the same saved conversation at `/work/:id`. Older `/sessions/:id` links redirect there,
including terminal pane selections. Use **All work** to return to the unified list. It supports Claude Code, Codex, Copilot, Gemini,
OpenCode and Cursor through the existing harness command and credential machinery.
Changing the harness applies on the next request. Each request launches a harness
turn with the saved conversation; it does not migrate a provider's native session
or automatically replay an interrupted request.

## Where a turn runs

Every turn runs in an **isolated agent pod per conversation**, using the same
harness credentials and scoped controller MCP grants as other pod work. Native
shell and filesystem tools remain available to a harness, so a prompt or MCP
allowlist cannot safely confine it inside the API container. The API image no
longer includes agent harnesses or an agent home.

The former `api-pod` placement is removed. Existing
`OPTIO_ASSISTANT_PLACEMENT=api-pod`, `OPTIO_ASSISTANT_IN_POD_MAX`, and Helm
`optio.assistant.*` settings are ignored; they cannot restore execution in the API
process. The standalone process runtime remains available to trusted callers,
but interactive sessions never select it.

The optional legacy dedicated Optio pod (`optio.enabled`) is not used by these
turns. Pod startup, harness credentials and provider errors appear in the
conversation. The controller grants expire with their turn and remain restricted
to its owner and workspace; no user API token is forwarded into the pod.

Conversation history and pending approvals survive refresh and reconnect. Several
clients can view the same session. Send another message while it is working to queue
it: pending messages persist on the server, appear on every client, and execute in
order with one active turn. Remove a queued message before it starts; up to 20 can
wait. Reconnecting never replays a started turn. Approval
decisions are single-use and synchronized between clients. Clear conversation is
available after the current request, queued messages and approvals finish. Closing the panel
keeps its connection; dismissing the native assistant disconnects its viewer.
Neither operation automatically retries a message or an action.

## Multiple sessions and panel layout

The web panel has a tab for each active conversation. **+** starts an independent
session: its own history, pod, queue, approvals, and connection. Several sessions
can work at once. Tabs show working, approval, disconnected, and unread-reply
indicators, including while another tab is selected. Switching tabs or minimizing
the panel keeps their connections running. The sidebar shows when an agent is working.

Open **Session options** (the three dots) to rename or end a session; an unnamed session takes its first request as its
title. Ending an idle session removes its tab; its saved history
remains in Work. Running sessions and sessions with queued messages or pending
approvals must finish before the panel offers this action. Sessions are private to
the exact user and workspace, including when selected by id. The server lists them
again after refresh; the browser remembers the selected tab and keeps a separate
draft for each conversation in session storage.

The session tabs and panel controls share one header row. On desktop, drag the panel's right edge, top edge, or top-right corner to resize it.
The same handles accept arrow keys (Shift for larger steps). The floating panel
opens at the bottom left beside the sidebar launcher, leaves a 12px margin, and follows the sidebar's width. Size is remembered and constrained again when the viewport changes.
**Dock assistant** in Session options places it between the sidebar and the page, where the right edge resizes its width.
Below 1024px it floats; on phones it fills the screen.

Each conversation reconnects its viewer with bounded exponential backoff after a
connection loss and restores server history and approvals. Reconnecting never
resends messages, decisions, or clear-history requests. After repeated failures,
use Reconnect. An interrupted turn remains subject to the existing session recovery
rules; reconnecting does not restart it.

`GET/POST /api/optio/sessions` lists/creates conversations; `PATCH/DELETE
/api/optio/sessions/:id` renames/ends one. `/ws/optio/chat?sessionId=<id>` attaches
that exact conversation. The no-id WebSocket still opens one stable default for
legacy/native clients. The `assistant_default` flag narrows the old uniqueness
constraint to that default; migration preserves every existing conversation.

The iOS and Android apps have a dedicated **Optio Agent** tab, alongside Overview,
Work, Library and More. Insights remains available in More. They
show the same conversation and approval cards. Use the system keyboard's microphone
for dictation. Drafts stay local to the client; saved history comes from the session.

## Dictation prototype

This version uses browser `SpeechRecognition` / `webkitSpeechRecognition` with
interim results. Final words append to an editable draft; neither speech nor stopping
the microphone sends the message. Closing the panel stops listening. Microphone
errors leave typed text intact. Dictation can edit a draft even while chat is disconnected or busy. Unsupported browsers, silent endings and startup/finish timeouts show an explanation; speech-service failures are distinguished from denied microphone access.

It needs a secure context (HTTPS or localhost), microphone permission and a browser
with speech recognition. Browser support and service availability vary. The browser
may send audio to its speech provider; Optio receives only the text you send. Use OS
keyboard dictation or typing when browser recognition is unavailable. Dictate is
disabled in that case, with the explanation in its tooltip.

For broader browser support, the next step is a MediaRecorder capture and authenticated
server transcription endpoint, with explicit provider configuration, upload limits,
and short-lived audio handling. That would replace the recognition hook while keeping
the same draft → review → send interaction. A continuous voice conversation would be
a separate interaction, including interruption and spoken responses.

Reference: [MDN SpeechRecognition](https://developer.mozilla.org/en-US/docs/Web/API/SpeechRecognition).

## Implementation and verification

- `session-harness-service.ts`: ordinary session creation and shared harness execution.
- `harness-session-chat.ts`: WebSocket presentations for the panel and session page.
- `controller-mcp.ts` and `controller-auth.ts`: controller tools and scoped turn credentials.
- `session-tool-approval.ts`: durable, single-use approvals.
- `use-dictation.ts`: browser microphone lifecycle and editable transcription draft.

Integration tests cover private session creation, turn credential revocation and a
real MCP work creation gated by approval. Pipeline tests run the real server with
the fake runtime, restoring history, deduplicating requests and switching between
Claude Code and Cursor. Browser tests cover dictation, approval cards, real saved
history, concurrent sessions, draft and approval isolation, resizing, docking and narrow layouts in Chromium and Firefox. Other harnesses use
the command, environment and parser tests shared with other pod work. These tests
do not establish live provider availability or microphone quality.
