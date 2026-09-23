package dev.optio.feature.agents

import androidx.compose.runtime.Immutable
import dev.optio.core.model.PersistentAgent
import dev.optio.core.model.PersistentAgentPodLifecycle
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

/**
 * The agent form's answers (iOS `AgentFormSheet` state, which mirrors the web's agent form): pure,
 * so validation and the request bodies are unit-tested. Limits are in milliseconds like the API.
 */
@Immutable
data class AgentFormDraft(
    val slug: String = "",
    val name: String = "",
    val description: String = "",
    val agentRuntime: String = "claude-code",
    val model: String = "",
    val podLifecycle: String = "sticky",
    val idlePodTimeoutMs: Int = 300_000,
    val maxTurnDurationMs: Int = 600_000,
    val maxTurns: Int = 50,
    val consecutiveFailureLimit: Int = 3,
    val systemPrompt: String = "",
    val agentsMd: String = AgentDefaults.AGENTS_MD,
    val initialPrompt: String = "",
    val enabled: Boolean = true,
) {
    /** iOS `valid`: a name and an initial prompt, and (creating) a slug of a-z, 0-9 and hyphens. */
    fun isValid(editing: Boolean): Boolean =
        name.isNotBlank() && initialPrompt.isNotBlank() && (editing || SLUG.matches(slug))

    /** Why Create/Save is disabled, for the form's footer; null when it isn't. */
    fun problem(editing: Boolean): String? =
        when {
            !editing && slug.isEmpty() -> "Pick a slug: other agents address this one by it."
            !editing && !SLUG.matches(slug) -> "The slug takes lowercase letters, digits and hyphens, and starts with a letter or digit."
            name.isBlank() -> "Give the agent a name."
            initialPrompt.isBlank() -> "Write the agent's first mission (the initial prompt)."
            else -> null
        }

    /** `POST /api/persistent-agents`: blank optional fields are left to the server's defaults. */
    fun createInput(): PersistentAgentInput =
        PersistentAgentInput(
            slug = slug,
            name = name.trim(),
            description = description.takeIf { it.isNotBlank() },
            agentRuntime = agentRuntime,
            model = model.trim().takeIf { it.isNotEmpty() },
            systemPrompt = systemPrompt.takeIf { it.isNotBlank() },
            agentsMd = agentsMd.takeIf { it.isNotBlank() },
            initialPrompt = initialPrompt,
            podLifecycle = podLifecycle,
            idlePodTimeoutMs = idlePodTimeoutMs,
            maxTurnDurationMs = maxTurnDurationMs,
            maxTurns = maxTurns,
            consecutiveFailureLimit = consecutiveFailureLimit,
        )

    /**
     * `PATCH /api/persistent-agents/:id`: every field the form edits (the slug is immutable). A
     * blank description, model or prompt is sent as JSON `null`, which clears it (iOS omits it, so
     * a cleared field used to come back).
     */
    fun patch(): JsonObject {
        fun text(value: String): JsonElement = if (value.isBlank()) JsonNull else JsonPrimitive(value)
        return JsonObject(
            linkedMapOf(
                "name" to JsonPrimitive(name.trim()),
                "description" to text(description),
                "agentRuntime" to JsonPrimitive(agentRuntime),
                "model" to text(model.trim()),
                "systemPrompt" to text(systemPrompt),
                "agentsMd" to text(agentsMd),
                "initialPrompt" to JsonPrimitive(initialPrompt),
                "podLifecycle" to JsonPrimitive(podLifecycle),
                "idlePodTimeoutMs" to JsonPrimitive(idlePodTimeoutMs),
                "maxTurnDurationMs" to JsonPrimitive(maxTurnDurationMs),
                "maxTurns" to JsonPrimitive(maxTurns),
                "consecutiveFailureLimit" to JsonPrimitive(consecutiveFailureLimit),
                "enabled" to JsonPrimitive(enabled),
            ),
        )
    }

    companion object {
        /** `routes/persistent-agents.ts` `createSchema.slug`. */
        val SLUG = Regex("^[a-z0-9][a-z0-9-]*$")

        /** The steppers' ranges and steps (iOS `Stepper`s). */
        val IDLE_TTL_RANGE = 30_000..3_600_000
        const val IDLE_TTL_STEP = 30_000
        val TURN_DURATION_RANGE = 60_000..7_200_000
        const val TURN_DURATION_STEP = 60_000
        val MAX_TURNS_RANGE = 1..10_000
        val FAILURE_LIMIT_RANGE = 1..50

        /** The form seeded from a saved agent (iOS `seed()`). */
        fun from(agent: PersistentAgent): AgentFormDraft =
            AgentFormDraft(
                slug = agent.slug,
                name = agent.name,
                description = agent.description.orEmpty(),
                agentRuntime = agent.agentRuntime,
                model = agent.model.orEmpty(),
                podLifecycle =
                    agent.podLifecycle.takeUnless { it == PersistentAgentPodLifecycle.UNKNOWN }?.raw ?: "sticky",
                idlePodTimeoutMs = agent.idlePodTimeoutMs.toInt(),
                maxTurnDurationMs = agent.maxTurnDurationMs.toInt(),
                maxTurns = agent.maxTurns.toInt(),
                consecutiveFailureLimit = agent.consecutiveFailureLimit.toInt(),
                systemPrompt = agent.systemPrompt.orEmpty(),
                agentsMd = agent.agentsMd.orEmpty(),
                initialPrompt = agent.initialPrompt,
                enabled = agent.enabled,
            )
    }
}

/** Constants of the agent form (iOS `AgentFormSheet` statics). */
object AgentDefaults {
    val RUNTIMES: List<String> = listOf("claude-code", "codex", "copilot", "gemini", "opencode", "cursor")

    val LIFECYCLES: List<String> = listOf("sticky", "always-on", "on-demand")

    /** What each lifecycle means (iOS `WorkForm.PodLifecycle.hint`). */
    fun lifecycleHint(lifecycle: String): String =
        when (lifecycle) {
            "always-on" -> "The pod never goes away — fastest wake, highest cost."
            "on-demand" -> "A fresh pod for every turn — slowest wake, nothing idle."
            else -> "The pod stays warm for a while after each turn, then goes away until the next wake."
        }

    /** The operator manual a new agent starts with (iOS `AgentFormSheet.defaultAgentsMd`). */
    val AGENTS_MD: String =
        """
        You are running as a Persistent Agent inside Optio. You can talk to other
        agents in this workspace through Optio's HTTP API. Use the bash + curl
        verbs below — there is no human waiting at a terminal, so design every
        call to be non-interactive.

        Environment variables (already set):
        - OPTIO_API_URL          — base URL for Optio's API
        - OPTIO_AGENT_TOKEN      — your bearer token (your own UUID)
        - OPTIO_PERSISTENT_AGENT_SLUG — your own slug
        - OPTIO_PERSISTENT_AGENT_TURN_ID — current turn id

        ## List addressable agents in your workspace

            curl -s -H "X-Optio-Agent-Token: ${'$'}OPTIO_AGENT_TOKEN" \
              "${'$'}OPTIO_API_URL/api/internal/persistent-agents"

        ## Send a direct message to another agent (by slug)

            curl -s -X POST -H "X-Optio-Agent-Token: ${'$'}OPTIO_AGENT_TOKEN" \
              -H "Content-Type: application/json" \
              -d '{"to":"forge","body":"Please implement spec X..."}' \
              "${'$'}OPTIO_API_URL/api/internal/persistent-agents/send"

        ## Broadcast to everyone in your workspace

            curl -s -X POST -H "X-Optio-Agent-Token: ${'$'}OPTIO_AGENT_TOKEN" \
              -H "Content-Type: application/json" \
              -d '{"body":"Heads up, the build is broken."}' \
              "${'$'}OPTIO_API_URL/api/internal/persistent-agents/broadcast"

        ## Read your own recent inbox

            curl -s -H "X-Optio-Agent-Token: ${'$'}OPTIO_AGENT_TOKEN" \
              "${'$'}OPTIO_API_URL/api/internal/persistent-agents/inbox?limit=20"

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
        """.trimIndent()
}
