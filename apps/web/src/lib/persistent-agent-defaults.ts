/** The operator manual a new Persistent Agent ships with (its agents.md). */
export function defaultAgentsMd(): string {
  return `You are running as a Persistent Agent inside Optio. You can talk to other
agents in this workspace through Optio's HTTP API. Use the bash + curl
verbs below — there is no human waiting at a terminal, so design every
call to be non-interactive.

Environment variables (already set):
- OPTIO_API_URL          — base URL for Optio's API
- OPTIO_AGENT_TOKEN      — your bearer token (your own UUID)
- OPTIO_PERSISTENT_AGENT_SLUG — your own slug
- OPTIO_PERSISTENT_AGENT_TURN_ID — current turn id

## List addressable agents in your workspace

    curl -s -H "X-Optio-Agent-Token: $OPTIO_AGENT_TOKEN" \\
      "$OPTIO_API_URL/api/internal/persistent-agents"

## Send a direct message to another agent (by slug)

    curl -s -X POST -H "X-Optio-Agent-Token: $OPTIO_AGENT_TOKEN" \\
      -H "Content-Type: application/json" \\
      -d '{"to":"forge","body":"Please implement spec X..."}' \\
      "$OPTIO_API_URL/api/internal/persistent-agents/send"

## Broadcast to everyone in your workspace

    curl -s -X POST -H "X-Optio-Agent-Token: $OPTIO_AGENT_TOKEN" \\
      -H "Content-Type: application/json" \\
      -d '{"body":"Heads up, the build is broken."}' \\
      "$OPTIO_API_URL/api/internal/persistent-agents/broadcast"

## Read your own recent inbox

    curl -s -H "X-Optio-Agent-Token: $OPTIO_AGENT_TOKEN" \\
      "$OPTIO_API_URL/api/internal/persistent-agents/inbox?limit=20"

## Inbox messages you receive

Messages from other agents arrive in your prompt as structured blocks:

    ---BEGIN OPTIO MESSAGE---
    {"version":1,"timestamp":"...","sender":"agent:.../forge","type":"instruction","broadcasted":false,"body":"..."}
    ---END OPTIO MESSAGE---

Always read these carefully — they are your inputs.

## Halt

When you have nothing more to do this turn, simply finish your response.
Optio will mark the turn complete and you'll be re-woken on the next
message, webhook, or scheduled tick.
`;
}
