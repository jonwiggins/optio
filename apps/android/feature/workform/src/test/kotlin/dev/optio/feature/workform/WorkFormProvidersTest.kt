package dev.optio.feature.workform

import dev.optio.core.model.LocalHost
import dev.optio.core.model.LocalHostState
import dev.optio.core.model.ModelProvider
import dev.optio.core.model.ModelProviderAgent
import dev.optio.core.model.ModelProviderKind
import dev.optio.core.model.ModelProviderPodCredential
import dev.optio.core.model.PickableSecret
import dev.optio.core.network.MODEL_PROVIDER_OPTION_KEY
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import dev.optio.core.model.ModelProviderModels
import dev.optio.core.model.ModelProviderModel
import org.junit.Test
import dev.optio.core.ui.agent.TERMINAL
import dev.optio.core.ui.agent.OptionValue

class WorkFormProvidersTest {
    private fun provider(
        id: String,
        org: Boolean = true,
        mine: Boolean = !org,
        agents: List<ModelProviderAgent> = listOf(ModelProviderAgent.CLAUDE_CODE),
        pod: ModelProviderPodCredential = ModelProviderPodCredential.ACCESS_KEY,
        profile: String? = null,
        models: List<String> = listOf("us.anthropic.claude-opus-5-5", "us.anthropic.claude-sonnet-5"),
    ) = ModelProvider(
        id = id,
        ownerUserId = if (org) null else "u-$id",
        kind = ModelProviderKind.BEDROCK,
        name = "P $id",
        agents = agents,
        region = "us-west-2",
        models = ModelProviderModels(claudeCode = models.map { ModelProviderModel(it) }),
        localAwsProfile = profile,
        podCredential = pod,
        hasPodCredentials = true,
        mine = mine,
        canEdit = true,
        createdAt = "",
        updatedAt = "",
    )

    private fun host(modelProviders: Boolean?, profiles: List<String>? = null) = LocalHost(
        id = "h1",
        name = "laptop",
        hostname = "laptop",
        platform = "darwin",
        dirs = emptyList(),
        modelProviders = modelProviders,
        awsProfiles = profiles,
        state = LocalHostState.ONLINE,
        createdAt = "",
        updatedAt = "",
    )

    private val pod = normalize(PRESETS[0].apply(WorkDraft.EMPTY))
    private val machine = normalize(pod.copy(location = pod.location.copy(runTarget = Where.LOCAL), withRepo = false))

    @Test
    fun usableProvidersServeTheRuntimeAndBelongToTheOrgOrMe() {
        val list = listOf(
            provider("org"),
            provider("mine", org = false),
            provider("theirs", org = false, mine = false),
            provider("codex", agents = listOf(ModelProviderAgent.CODEX)),
        )
        assertEquals(listOf("org", "mine"), usableProviders(pod, list).map { it.id })
        assertEquals(listOf("codex"), usableProviders(pod.copy(runtime = "codex"), list).map { it.id })
        assertTrue(usableProviders(pod.copy(runtime = "gemini"), list).isEmpty())
        assertTrue(usableProviders(pod.copy(runtime = TERMINAL), list).isEmpty())
    }

    @Test
    fun pickingAProviderSetsItsFirstModelAndDefaultRestores() {
        val p = provider("org")
        val picked = withProvider(pod, p)
        assertEquals(OptionValue.Str("org"), picked.agentOptions[MODEL_PROVIDER_OPTION_KEY])
        assertEquals(OptionValue.Str("us.anthropic.claude-opus-5-5"), picked.agentOptions["claudeModel"])
        assertEquals(WorkOwner.WORKSPACE, picked.owner)
        assertEquals(listOf("us.anthropic.claude-opus-5-5", "us.anthropic.claude-sonnet-5"), providerModels(picked, listOf(p))?.map { it.id })
        val back = withProvider(picked, null)
        assertNull(back.agentOptions[MODEL_PROVIDER_OPTION_KEY])
        assertNull(back.agentOptions["claudeModel"])
        assertNull(providerModels(back, listOf(p)))
        // A provider with no models leaves the model blank (free text).
        assertEquals(OptionValue.Str(""), withProvider(pod, provider("x", models = emptyList())).agentOptions["claudeModel"])
    }

    @Test
    fun aPersonalProviderMakesPodWorkMine() {
        val mine = provider("mine", org = false)
        val d = withProvider(pod, mine)
        assertEquals(WorkOwner.ME, d.owner)
        assertTrue(organizationDisabled(d, listOf(mine), emptyList())!!.contains("your own provider"))
        assertNull(organizationDisabled(pod, listOf(mine), emptyList()))
    }

    @Test
    fun disabledReasons() {
        val machinesOnly = provider("m", pod = ModelProviderPodCredential.NONE)
        assertEquals("Machines only", providerDisabled(machinesOnly, pod, null))
        assertNull(providerDisabled(provider("a"), pod, null))
        assertNull(providerDisabled(machinesOnly, machine, host(true)))
        assertEquals("Update Optio Local on laptop to use model providers", providerDisabled(provider("a"), machine, host(false)))
        assertEquals("Update Optio Local on laptop to use model providers", providerDisabled(provider("a"), machine, host(null)))
        assertEquals("AWS profile work isn't on laptop", providerDisabled(provider("a", profile = "work"), machine, host(true, listOf("default"))))
        assertNull(providerDisabled(provider("a", profile = "work"), machine, host(true, listOf("work"))))
    }

    @Test
    fun ownerAndSecretsRowsOnlyForPodWork() {
        assertTrue(showsOwner(pod))
        assertTrue(showsPodSecrets(pod))
        assertFalse(showsOwner(machine))
        assertFalse(showsPodSecrets(machine))
        assertEquals(WorkOwner.ME, effectiveOwner(machine.copy(owner = WorkOwner.WORKSPACE)))
        val session = normalize(pod.copy(then = Then.WAITS_FOR_ME))
        assertEquals(WorkKind.POD_SESSION, deriveKind(session))
        assertFalse(showsOwner(session))
    }

    @Test
    fun secretsFollowTheOwnerRules() {
        val pickable = listOf(
            PickableSecret("GH", PickableSecret.Owner.WORKSPACE),
            PickableSecret("GH", PickableSecret.Owner.ME),
            PickableSecret("MINE", PickableSecret.Owner.ME),
            PickableSecret("ORG", PickableSecret.Owner.WORKSPACE),
        )
        assertEquals(listOf("GH", "ORG"), addableSecrets(pod, pickable).map { it.name })
        val mine = pod.copy(owner = WorkOwner.ME)
        assertEquals(listOf("GH" to PickableSecret.Owner.ME, "MINE" to PickableSecret.Owner.ME, "ORG" to PickableSecret.Owner.WORKSPACE), addableSecrets(mine, pickable).map { it.name to it.owner })
        assertEquals(listOf("MINE", "ORG"), addableSecrets(mine.copy(podSecrets = listOf("GH")), pickable).map { it.name })
        assertEquals("Organization", secretOwnerTag("GH", pod, pickable))
        assertEquals("Private", secretOwnerTag("GH", mine, pickable))
        assertEquals("Private", secretOwnerTag("MINE", pod, pickable))
        assertTrue(organizationDisabled(mine.copy(podSecrets = listOf("MINE")), emptyList(), pickable)!!.startsWith("MINE is your own"))
        assertNull(organizationDisabled(mine.copy(podSecrets = listOf("GH")), emptyList(), pickable))
    }

    @Test
    fun ownerPayloadOnPodsAndMachines() {
        assertEquals(buildJsonObject { put("owner", "workspace"); put("podSecrets", JsonArray(emptyList())) }, ownerPayload(pod))
        assertEquals(
            buildJsonObject { put("owner", "me"); put("podSecrets", JsonArray(listOf(JsonPrimitive("A")))) },
            ownerPayload(pod.copy(owner = WorkOwner.ME, podSecrets = listOf("A"))),
        )
        assertEquals(buildJsonObject { put("owner", "workspace") }, ownerPayload(pod.copy(podSecrets = null)))
        assertEquals(buildJsonObject { put("owner", "me") }, ownerPayload(machine.copy(podSecrets = listOf("A"))))
    }

    @Test
    fun editRestoresOwnerSecretsAndProvider() {
        val row = buildJsonObject {
            put("type", "standalone")
            put("name", "Digest")
            put("agentRuntime", "claude-code")
            put("promptTemplate", "Hi")
            put("ownerUserId", "u1")
            put("podSecrets", JsonArray(listOf(JsonPrimitive("GH"))))
            put("agentOptions", buildJsonObject { put("modelProvider", "p1"); put("claudeModel", "us.anthropic.claude-sonnet-5") })
        }
        val d = draftFromRow(EditableKind.STANDALONE, row, null)
        assertEquals(WorkOwner.ME, d.owner)
        assertEquals(listOf("GH"), d.podSecrets)
        assertEquals("p1", pickedProviderId(d))
        val legacy = draftFromRow(EditableKind.STANDALONE, buildJsonObject { put("name", "x") }, null)
        assertEquals(WorkOwner.WORKSPACE, legacy.owner)
        assertNull(legacy.podSecrets)
        assertEquals("Only Ann can change this — it runs with their credentials.", foreignOwnerReason("u1", "u2", "Ann"))
        assertNull(foreignOwnerReason("u1", "u1", "Ann"))
        assertNull(foreignOwnerReason(null, "u2", null))
    }
}
