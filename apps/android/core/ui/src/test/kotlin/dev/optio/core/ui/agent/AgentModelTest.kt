package dev.optio.core.ui.agent

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

/** The shared agent picker's pure rules: per-model effort and the repo-column mapping. */
class AgentModelTest {
    private val effort = ProviderCatalog.Option(
        key = "claudeEffort",
        label = "Effort Level",
        kind = "select",
        modelEfforts = true,
        choices = listOf(
            ProviderCatalog.Choice("low", "Low"),
            ProviderCatalog.Choice("medium", "Medium"),
            ProviderCatalog.Choice("high", "High"),
            ProviderCatalog.Choice("xhigh", "Extra high"),
            ProviderCatalog.Choice("max", "Max"),
        ),
    )
    private val catalog = ProviderCatalog(
        provider = "anthropic",
        label = "Claude Code",
        modelField = "claudeModel",
        models = listOf(
            ProviderCatalog.Model("claude-opus-5-5", "Opus 5.5", efforts = listOf("low", "medium", "high", "xhigh", "max")),
            ProviderCatalog.Model("claude-opus-4-5", "Opus 4.5", efforts = listOf("low", "medium", "high")),
            ProviderCatalog.Model("claude-haiku-4-5", "Haiku 4.5", efforts = emptyList()),
            ProviderCatalog.Model("claude-legacy", "Legacy"),
        ),
        aliases = mapOf("opus" to "claude-opus-5-5"),
        options = listOf(effort, ProviderCatalog.Option("claudePermissionMode", "Permissions", "select", runsOn = listOf("local"))),
    )

    @Test
    fun effortChoicesNarrowToTheSelectedModel() {
        assertEquals(listOf("low", "medium", "high", "xhigh", "max"), optionChoicesFor(effort, catalog.model("opus")).map { it.value })
        assertEquals(listOf("Low", "Medium", "High"), optionChoicesFor(effort, catalog.model("claude-opus-4-5")).map { it.label })
        // A model that takes no effort: none (the field hides).
        assertEquals(emptyList(), optionChoicesFor(effort, catalog.model("claude-haiku-4-5")))
        // No per-model list (or no model): every choice.
        assertEquals(5, optionChoicesFor(effort, catalog.model("claude-legacy")).size)
        assertEquals(5, optionChoicesFor(effort, null).size)
        // An effort the field doesn't list is still offered, capitalized.
        val odd = ProviderCatalog.Model("m", "M", efforts = listOf("ultra"))
        assertEquals(listOf(ProviderCatalog.Choice("ultra", "Ultra")), optionChoicesFor(effort, odd))
    }

    @Test
    fun changingTheModelBlanksAnEffortItDoesNotTake() {
        val values = mapOf("claudeModel" to OptionValue.Str("opus"), "claudeEffort" to OptionValue.Str("max"))
        assertEquals(listOf("claudeEffort"), catalog.effortResets(values, "claude-opus-4-5"))
        assertEquals(listOf("claudeEffort"), catalog.effortResets(values, "claude-haiku-4-5"))
        assertEquals(emptyList(), catalog.effortResets(values, "claude-opus-5-5"))
        // A model without a per-model list, or a blank effort, keeps what's there.
        assertEquals(emptyList(), catalog.effortResets(values, "claude-legacy"))
        assertEquals(emptyList(), catalog.effortResets(values + ("claudeEffort" to OptionValue.Str("")), "claude-haiku-4-5"))
    }

    @Test
    fun podOptionKeysDropMachineOnlyFields() {
        assertEquals(listOf("claudeModel", "claudeEffort"), catalog.podOptionKeys)
    }

    private fun repo(vararg pairs: Pair<String, Any>) = JsonObject(
        pairs.associate { (k, v) -> k to if (v is Boolean) JsonPrimitive(v) else JsonPrimitive(v.toString()) },
    )

    private val keys: (String) -> List<String> = { repoKeysForProvider(providerFor(it)) }

    @Test
    fun aRepoOnTheFactoryDefaultsHasNothingOfItsOwn() {
        val factory = repo("defaultAgentType" to "claude-code", "claudeModel" to "opus", "claudeContextWindow" to "1m", "claudeEffort" to "high")
        assertFalse(repoHasOwnOptions("claude-code", factory, keys("claude-code")))
        assertNull(repoOwnRuntime(factory, keys))
        assertEquals("claude-code", repoRuntime(factory))

        val tuned = repo("defaultAgentType" to "claude-code", "claudeModel" to "sonnet", "claudeEffort" to "high")
        assertTrue(repoHasOwnOptions("claude-code", tuned, keys("claude-code")))
        assertEquals("claude-code", repoOwnRuntime(tuned, keys))

        val gemini = repo("defaultAgentType" to "gemini", "geminiModel" to "gemini-2.5-pro")
        assertEquals("gemini", repoOwnRuntime(gemini, keys))
        assertEquals("claude-code", repoRuntime(repo("defaultAgentType" to "bogus")))
    }

    @Test
    fun codexKeepsNoRepoSettings() {
        val r = repo("defaultAgentType" to "codex", "copilotModel" to "gpt-5")
        assertEquals(emptyMap(), optionsFromRepo("codex", r, keys("codex")))
        assertEquals(mapOf("copilotModel" to OptionValue.Str("gpt-5")), optionsFromRepo("copilot", r, keys("copilot")))
        assertEquals("codex", repoOwnRuntime(r, keys))
    }

    @Test
    fun sameOptionsIgnoresBlanks() {
        assertTrue(sameOptions(mapOf("a" to OptionValue.Str("x"), "b" to OptionValue.Str("")), mapOf("a" to OptionValue.Str("x"))))
        assertFalse(sameOptions(mapOf("a" to OptionValue.Str("x")), mapOf("a" to OptionValue.Str("y"))))
    }

    @Test
    fun summaryLine() {
        assertEquals("Claude Code · opus · high", agentSummary("claude-code", REPO_FACTORY_OPTIONS))
        assertEquals("OpenAI Codex", agentSummary("codex", mapOf("copilotModel" to OptionValue.Str("gpt-5"))))
    }
}
