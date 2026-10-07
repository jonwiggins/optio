package dev.optio.feature.workform

import dev.optio.core.model.AgentCredential
import dev.optio.core.model.AgentCredentialKind
import dev.optio.core.model.AgentCredentialMethod
import dev.optio.core.model.ModelProvider
import dev.optio.core.model.ModelProviderAgent
import dev.optio.core.model.ModelProviderKind
import dev.optio.core.model.ModelProviderModel
import dev.optio.core.model.ModelProviderModels
import dev.optio.core.model.ModelProviderPodCredential
import dev.optio.core.model.ResourceOwner
import dev.optio.core.model.WorkFormDefaults
import dev.optio.core.network.AGENT_CREDENTIAL_OPTION_KEY
import dev.optio.core.network.MODEL_PROVIDER_OPTION_KEY
import dev.optio.core.ui.agent.OptionValue
import dev.optio.core.ui.agent.TERMINAL
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.junit.Test

class WorkFormCredentialsTest {
    private fun provider(id: String, org: Boolean = true, pod: ModelProviderPodCredential = ModelProviderPodCredential.ACCESS_KEY) = ModelProvider(
        id = id,
        ownerUserId = if (org) null else "u-$id",
        kind = ModelProviderKind.BEDROCK,
        name = "P $id",
        agents = listOf(ModelProviderAgent.CLAUDE_CODE),
        region = "us-west-2",
        models = ModelProviderModels(claudeCode = listOf(ModelProviderModel("us.anthropic.claude-opus-5-5"))),
        localAwsProfile = null,
        podCredential = pod,
        hasPodCredentials = true,
        mine = !org,
        canEdit = true,
        createdAt = "",
        updatedAt = "",
    )

    private fun secret(id: String, owner: ResourceOwner = ResourceOwner.WORKSPACE, default: Boolean = false) = AgentCredential(
        id = "secret:$id",
        kind = AgentCredentialKind.SECRET,
        method = AgentCredentialMethod.API_KEY,
        label = "Anthropic API key",
        secretName = "ANTHROPIC_API_KEY",
        owner = owner,
        default = default,
    )

    private fun providerCredential(p: ModelProvider) = AgentCredential(
        id = "provider:${p.id}",
        kind = AgentCredentialKind.PROVIDER,
        method = AgentCredentialMethod.BEDROCK,
        label = "Amazon Bedrock · ${p.name}",
        providerId = p.id,
        owner = if (p.ownerUserId == null) ResourceOwner.WORKSPACE else ResourceOwner.ME,
        default = false,
    )

    private val pod = normalize(PRESETS[0].apply(WorkDraft.EMPTY))
    private val machine = normalize(pod.copy(location = pod.location.copy(runTarget = Where.LOCAL), withRepo = false))
    private val orgKey = secret("11111111-1111-4111-8111-111111111111", default = true)
    private val myKey = secret("22222222-2222-4222-8222-222222222222", owner = ResourceOwner.ME)

    @Test
    fun theControlShowsForPodAgentWorkOnly() {
        assertTrue(showsCredentials(pod))
        assertFalse(showsCredentials(machine))
        assertFalse(showsCredentials(pod.copy(runtime = TERMINAL)))
        assertFalse(showsCredentials(normalize(pod.copy(then = Then.WAITS_FOR_ME))))
        assertTrue(usableCredentials(machine, listOf(orgKey)).isEmpty())
        assertEquals(listOf(orgKey, myKey), usableCredentials(pod, listOf(orgKey, myKey)))
    }

    @Test
    fun pickingASecretSetsCredentialAndDropsTheProvider() {
        val p = provider("org")
        val withP = withProvider(pod, p)
        val d = withCredential(withP, orgKey, listOf(p))
        assertEquals(OptionValue.Str(orgKey.id), d.agentOptions[AGENT_CREDENTIAL_OPTION_KEY])
        assertNull(d.agentOptions[MODEL_PROVIDER_OPTION_KEY])
        assertNull(d.agentOptions["claudeModel"])
        assertEquals(WorkOwner.WORKSPACE, d.owner)
        assertEquals(orgKey, pickedCredential(d, listOf(orgKey, providerCredential(p))))
    }

    @Test
    fun pickingAProviderCredentialIsTheProviderPick() {
        val p = provider("org")
        val d = withCredential(withCredential(pod, orgKey, listOf(p)), providerCredential(p), listOf(p))
        assertEquals(OptionValue.Str("org"), d.agentOptions[MODEL_PROVIDER_OPTION_KEY])
        assertEquals(OptionValue.Str("us.anthropic.claude-opus-5-5"), d.agentOptions["claudeModel"])
        assertNull(d.agentOptions[AGENT_CREDENTIAL_OPTION_KEY])
        assertEquals("provider:org", pickedCredentialId(d))
        assertEquals(providerCredential(p), pickedCredential(d, listOf(orgKey, providerCredential(p))))
    }

    @Test
    fun aProviderNotLoadedYetIsPickedById() {
        val mine = provider("mine", org = false)
        val d = withCredential(pod, providerCredential(mine), emptyList())
        assertEquals(OptionValue.Str("mine"), d.agentOptions[MODEL_PROVIDER_OPTION_KEY])
        assertEquals(WorkOwner.ME, d.owner)
    }

    @Test
    fun defaultDropsBoth() {
        val p = provider("org")
        val d = withCredential(withProvider(pod, p), null, listOf(p))
        assertNull(d.agentOptions[MODEL_PROVIDER_OPTION_KEY])
        assertNull(d.agentOptions[AGENT_CREDENTIAL_OPTION_KEY])
        assertNull(pickedCredentialId(d))
        assertNull(pickedCredentialId(withCredential(withCredential(pod, orgKey, emptyList()), null, emptyList())))
    }

    @Test
    fun aPrivateSecretMakesPodWorkMineAndBlocksOrganization() {
        val d = withCredential(pod, myKey, emptyList())
        assertEquals(WorkOwner.ME, d.owner)
        val reason = organizationDisabled(d, emptyList(), emptyList(), listOf(orgKey, myKey))
        assertTrue(reason!!.contains("your own credential"), reason)
        assertNull(organizationDisabled(withCredential(d, orgKey, emptyList()), emptyList(), emptyList(), listOf(orgKey, myKey)))
        assertNull(organizationDisabled(withCredential(d, null, emptyList()), emptyList(), emptyList(), listOf(orgKey, myKey)))
    }

    @Test
    fun aMachinesOnlyProviderIsDisabledThroughItsCredential() {
        val machinesOnly = provider("m", pod = ModelProviderPodCredential.NONE)
        assertEquals("Machines only", credentialDisabled(providerCredential(machinesOnly), pod, listOf(machinesOnly), null))
        assertNull(credentialDisabled(providerCredential(provider("a")), pod, listOf(provider("a")), null))
        assertNull(credentialDisabled(orgKey, pod, emptyList(), null))
    }

    @Test
    fun aCredentialNeverShipsToAMachine() {
        val picked = withCredential(pod, orgKey, emptyList())
        val moved = normalize(picked.copy(location = picked.location.copy(runTarget = Where.LOCAL), withRepo = false))
        assertNull(moved.agentOptions[AGENT_CREDENTIAL_OPTION_KEY])
        val defaults = WorkFormDefaults(
            runtime = "claude-code",
            agentOptions = mapOf("claude-code" to buildJsonObject { put(AGENT_CREDENTIAL_OPTION_KEY, orgKey.id) }),
        )
        assertEquals(OptionValue.Str(orgKey.id), rememberedOptions(defaults, "claude-code", pod, emptyList())[AGENT_CREDENTIAL_OPTION_KEY])
        assertNull(rememberedOptions(defaults, "claude-code", machine, emptyList())[AGENT_CREDENTIAL_OPTION_KEY])
    }

    @Test
    fun labels() {
        assertEquals("Default", credentialValueLabel(null))
        assertEquals("Anthropic API key", credentialValueLabel(orgKey))
        assertEquals("Anthropic API key (private)", credentialValueLabel(myKey))
        assertEquals("Organization · API key · default", credentialSubtitle(orgKey))
        assertEquals("Private · API key", credentialSubtitle(myKey))
        assertEquals("Private · Amazon Bedrock", credentialSubtitle(providerCredential(provider("mine", org = false))))
    }
}
