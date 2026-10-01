package dev.optio.feature.workform

import dev.optio.core.model.ModelProvider
import dev.optio.core.model.ModelProviderAgent
import dev.optio.core.model.ModelProviderKind
import dev.optio.core.model.ModelProviderModel
import dev.optio.core.model.ModelProviderModels
import dev.optio.core.model.ModelProviderPodCredential
import dev.optio.core.model.WorkFormDefaults
import dev.optio.core.network.MODEL_PROVIDER_OPTION_KEY
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonPrimitive
import org.junit.Test
import dev.optio.core.ui.agent.TERMINAL
import dev.optio.core.ui.agent.OptionValue

class WorkFormRememberedTest {
    private fun provider(
        id: String,
        org: Boolean = true,
        mine: Boolean = !org,
        agents: List<ModelProviderAgent> = listOf(ModelProviderAgent.CLAUDE_CODE),
        pod: ModelProviderPodCredential = ModelProviderPodCredential.ACCESS_KEY,
    ) = ModelProvider(
        id = id,
        ownerUserId = if (org) null else "u-$id",
        kind = ModelProviderKind.BEDROCK,
        name = "P $id",
        agents = agents,
        region = "us-west-2",
        models = ModelProviderModels(claudeCode = listOf(ModelProviderModel("us.anthropic.claude-opus-5-5"))),
        podCredential = pod,
        hasPodCredentials = true,
        mine = mine,
        canEdit = true,
        createdAt = "",
        updatedAt = "",
    )

    private val pod = normalize(PRESETS[0].apply(WorkDraft.EMPTY))
    private val machine = normalize(pod.copy(location = pod.location.copy(runTarget = Where.LOCAL), withRepo = false))

    private fun defaults(runtime: String? = null, vararg options: Pair<String, Map<String, JsonElement>>) =
        WorkFormDefaults(runtime = runtime, agentOptions = mapOf(*options))

    private fun claude(vararg kv: Pair<String, JsonElement>) = "claude-code" to mapOf(*kv)

    @Test
    fun theSavedRuntimeWhenItCanRunHere() {
        assertEquals("codex", rememberedRuntime(defaults("codex"), pod))
        assertEquals("openclaw", rememberedRuntime(defaults("openclaw"), pod))
        assertNull(rememberedRuntime(defaults("openclaw"), machine), "pod-only CLI on a machine")
        assertNull(rememberedRuntime(defaults(TERMINAL), pod), "never the bare terminal")
        assertNull(rememberedRuntime(defaults("vim"), pod), "an unknown runtime")
        assertNull(rememberedRuntime(defaults(), pod))
    }

    @Test
    fun optionsForTheRuntimeKeepStringsBooleansAndFreeTextModels() {
        val d = defaults(
            "claude-code",
            claude(
                "claudeModel" to JsonPrimitive("my-custom-model"),
                "claudeEffort" to JsonPrimitive("high"),
                "claudeThinking" to JsonPrimitive(true),
                "weird" to JsonArray(emptyList()),
            ),
            "codex" to mapOf("copilotModel" to JsonPrimitive("gpt-5.5")),
        )
        assertEquals(
            mapOf(
                "claudeModel" to OptionValue.Str("my-custom-model"),
                "claudeEffort" to OptionValue.Str("high"),
                "claudeThinking" to OptionValue.Bool(true),
            ),
            rememberedOptions(d, "claude-code", pod, emptyList()),
        )
        assertEquals(mapOf("copilotModel" to OptionValue.Str("gpt-5.5")), rememberedOptions(d, "codex", pod, emptyList()))
        assertEquals(emptyMap(), rememberedOptions(d, "gemini", pod, emptyList()))
        assertEquals(emptyMap(), rememberedOptions(d, TERMINAL, pod, emptyList()))
    }

    @Test
    fun anUnusableProviderIsDroppedWithItsModel() {
        val saved = { id: String ->
            defaults(
                null,
                claude(
                    MODEL_PROVIDER_OPTION_KEY to JsonPrimitive(id),
                    "claudeModel" to JsonPrimitive("us.anthropic.claude-opus-5-5"),
                    "claudeEffort" to JsonPrimitive("high"),
                ),
            )
        }
        val providers = listOf(
            provider("org"),
            provider("mine", org = false),
            provider("theirs", org = false, mine = false),
            provider("codex-only", agents = listOf(ModelProviderAgent.CODEX)),
            provider("machines", pod = ModelProviderPodCredential.NONE),
        )
        val kept = mapOf(
            "claudeModel" to OptionValue.Str("us.anthropic.claude-opus-5-5"),
            "claudeEffort" to OptionValue.Str("high"),
        )
        assertEquals(kept + (MODEL_PROVIDER_OPTION_KEY to OptionValue.Str("org")), rememberedOptions(saved("org"), "claude-code", pod, providers))
        assertEquals(kept + (MODEL_PROVIDER_OPTION_KEY to OptionValue.Str("mine")), rememberedOptions(saved("mine"), "claude-code", pod, providers))
        val dropped = mapOf("claudeEffort" to OptionValue.Str("high"))
        assertEquals(dropped, rememberedOptions(saved("gone"), "claude-code", pod, providers))
        assertEquals(dropped, rememberedOptions(saved("theirs"), "claude-code", pod, providers), "someone else's")
        assertEquals(dropped, rememberedOptions(saved("codex-only"), "claude-code", pod, providers), "doesn't serve the runtime")
        assertEquals(dropped, rememberedOptions(saved("machines"), "claude-code", pod, providers), "machines-only on a pod")
        assertEquals(
            kept + (MODEL_PROVIDER_OPTION_KEY to OptionValue.Str("machines")),
            rememberedOptions(saved("machines"), "claude-code", machine, providers),
        )
    }

    @Test
    fun aCreateRemembersItsRuntimeAndSetOptionsButNotATerminal() {
        val d = pod.copy(
            runtime = "codex",
            agentOptions = mapOf("copilotModel" to OptionValue.Str("gpt-5.5"), "codexEffort" to OptionValue.Str(""), "fast" to OptionValue.Bool(false)),
        )
        assertEquals(
            WorkFormDefaults("codex", mapOf("codex" to mapOf("copilotModel" to JsonPrimitive("gpt-5.5"), "fast" to JsonPrimitive(false)))),
            rememberedAfterCreate(d),
        )
        assertEquals(WorkFormDefaults("claude-code", mapOf("claude-code" to emptyMap())), rememberedAfterCreate(pod))
        assertNull(rememberedAfterCreate(pod.copy(runtime = TERMINAL)))
    }
}
