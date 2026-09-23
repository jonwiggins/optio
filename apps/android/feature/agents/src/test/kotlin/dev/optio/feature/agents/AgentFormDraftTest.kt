package dev.optio.feature.agents

import dev.optio.core.model.OptioJson
import dev.optio.core.model.PersistentAgentPodLifecycle
import dev.optio.core.testing.Samples
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonObject
import org.junit.Test

/** The agent form's rules (iOS `AgentFormSheet`): validity, and the create / patch bodies. */
class AgentFormDraftTest {
    private val filled = AgentFormDraft(slug = "release-captain", name = "Release Captain", initialPrompt = "Cut the 2.4 release.")

    @Test
    fun createNeedsSlugNameAndInitialPrompt() {
        assertTrue(filled.isValid(editing = false))
        assertFalse(filled.copy(slug = "").isValid(editing = false))
        assertFalse(filled.copy(slug = "Release").isValid(editing = false))
        assertFalse(filled.copy(slug = "-release").isValid(editing = false))
        assertTrue(filled.copy(slug = "r2-d2").isValid(editing = false))
        assertFalse(filled.copy(name = "  ").isValid(editing = false))
        assertFalse(filled.copy(initialPrompt = " ").isValid(editing = false))
        // Editing never looks at the slug (immutable).
        assertTrue(filled.copy(slug = "").isValid(editing = true))
    }

    @Test
    fun problemsExplainTheDisabledButton() {
        assertEquals("Pick a slug: other agents address this one by it.", filled.copy(slug = "").problem(editing = false))
        assertEquals(
            "The slug takes lowercase letters, digits and hyphens, and starts with a letter or digit.",
            filled.copy(slug = "-x").problem(editing = false),
        )
        assertEquals("Give the agent a name.", filled.copy(name = "").problem(editing = false))
        assertEquals("Write the agent's first mission (the initial prompt).", filled.copy(initialPrompt = "").problem(editing = true))
        assertNull(filled.problem(editing = false))
    }

    @Test
    fun createBodyLeavesBlankOptionalsToTheServer() {
        val body = OptioJson.encodeToJsonElement(PersistentAgentInput.serializer(), filled.copy(agentsMd = "", model = " ").createInput()).jsonObject
        assertEquals(
            setOf(
                "slug", "name", "agentRuntime", "initialPrompt", "podLifecycle", "idlePodTimeoutMs",
                "maxTurnDurationMs", "maxTurns", "consecutiveFailureLimit",
            ),
            body.keys,
        )
        assertEquals(JsonPrimitive("release-captain"), body["slug"])
        assertEquals(JsonPrimitive(300_000), body["idlePodTimeoutMs"])
        // A fresh form ships the default operator manual.
        val withManual = OptioJson.encodeToJsonElement(PersistentAgentInput.serializer(), filled.createInput()).jsonObject
        assertTrue(withManual["agentsMd"].toString().contains("OPTIO_AGENT_TOKEN"))
        assertTrue(AgentDefaults.AGENTS_MD.contains("\$OPTIO_API_URL/api/internal/persistent-agents/send"))
    }

    @Test
    fun patchClearsBlankFieldsWithNull() {
        val patch = filled.copy(description = "", model = "", systemPrompt = "", agentsMd = "", enabled = false).patch()
        assertEquals(JsonNull, patch["description"])
        assertEquals(JsonNull, patch["model"])
        assertEquals(JsonNull, patch["systemPrompt"])
        assertEquals(JsonNull, patch["agentsMd"])
        assertEquals(JsonPrimitive(false), patch["enabled"])
        assertEquals(JsonPrimitive("Release Captain"), patch["name"])
        assertFalse("slug" in patch)
        val kept = filled.copy(model = " opus ", description = "Cuts releases").patch()
        assertEquals(JsonPrimitive("opus"), kept["model"])
        assertEquals(JsonPrimitive("Cuts releases"), kept["description"])
    }

    @Test
    fun seedsFromASavedAgent() {
        val agent = Samples.persistentAgent(podLifecycle = PersistentAgentPodLifecycle.ON_DEMAND)
        val draft = AgentFormDraft.from(agent)
        assertEquals("release-captain", draft.slug)
        assertEquals("on-demand", draft.podLifecycle)
        assertEquals(600_000, draft.idlePodTimeoutMs)
        assertEquals(1_800_000, draft.maxTurnDurationMs)
        assertEquals("sonnet", draft.model)
        assertEquals("", draft.agentsMd)
        assertTrue(draft.isValid(editing = true))
        assertEquals("sticky", AgentFormDraft.from(agent.copy(podLifecycle = PersistentAgentPodLifecycle.UNKNOWN)).podLifecycle)
    }
}
