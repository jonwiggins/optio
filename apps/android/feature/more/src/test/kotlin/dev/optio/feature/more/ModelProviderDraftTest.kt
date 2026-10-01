package dev.optio.feature.more

import dev.optio.core.model.ModelProvider
import dev.optio.core.model.ModelProviderAgent
import dev.optio.core.model.ModelProviderKind
import dev.optio.core.model.ModelProviderModel
import dev.optio.core.model.ModelProviderPodCredential
import dev.optio.core.model.ResourceOwner
import dev.optio.core.network.CredentialChange
import dev.optio.feature.more.providers.CredentialMode
import dev.optio.feature.more.providers.ModelProviderDraft
import dev.optio.feature.more.providers.modelsText
import dev.optio.feature.more.providers.parseModels
import dev.optio.feature.more.providers.providerSummary
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import dev.optio.core.model.ModelProviderModels
import org.junit.Test

class ModelProviderDraftTest {
    private val stored = ModelProvider(
        id = "p1",
        ownerUserId = null,
        kind = ModelProviderKind.BEDROCK,
        name = "Bedrock",
        agents = listOf(ModelProviderAgent.CLAUDE_CODE),
        region = "eu-west-1",
        models = ModelProviderModels(claudeCode = listOf(ModelProviderModel("eu.x", "X"))),
        localAwsProfile = "work",
        podCredential = ModelProviderPodCredential.ACCESS_KEY,
        hasPodCredentials = true,
        mine = false,
        canEdit = true,
        createdAt = "",
        updatedAt = "",
    )

    @Test
    fun modelsTextRoundTrips() {
        val models = listOf(ModelProviderModel("a", "A"), ModelProviderModel("b"))
        assertEquals("a | A\nb", modelsText(models))
        assertEquals(models, parseModels("a | A\n\n  b  \n"))
    }

    @Test
    fun aNewDraftNeedsANameAndCredentials() {
        val d = ModelProviderDraft.new(admin = true)
        assertEquals(ResourceOwner.WORKSPACE, d.owner)
        assertEquals(ResourceOwner.ME, ModelProviderDraft.new(admin = false).owner)
        assertEquals("Name it.", d.problem())
        assertEquals("Enter the access key id and secret.", d.copy(name = "B").problem())
        assertEquals("Region looks like us-west-2.", d.copy(name = "B", region = "west").problem())
        assertEquals("Pick at least one agent.", d.copy(name = "B", agents = emptySet()).problem())
        val ready = d.copy(name = "B", accessKeyId = "AKIA", secretAccessKey = "s")
        assertNull(ready.problem())
        val body = ready.body()
        assertEquals(JsonPrimitive("bedrock"), body["kind"])
        assertEquals(JsonPrimitive("access-key"), (body["credentials"] as JsonObject)["type"])
        assertEquals(4, ((body["models"] as JsonObject)["claude-code"] as JsonArray).size)
        assertNull(d.copy(name = "B", podCredential = ModelProviderPodCredential.AMBIENT).problem())
    }

    @Test
    fun regionChangeMovesUntouchedSuggestions() {
        val d = ModelProviderDraft.new(admin = false).withRegion("eu-central-1")
        assertTrue(d.models[ModelProviderAgent.CLAUDE_CODE]!!.startsWith("eu.anthropic."))
        val edited = d.copy(models = d.models + (ModelProviderAgent.CLAUDE_CODE to "custom")).withRegion("us-east-1")
        assertEquals("custom", edited.models[ModelProviderAgent.CLAUDE_CODE])
    }

    @Test
    fun editingKeepsClearsOrReplacesStoredCredentials() {
        val d = ModelProviderDraft.from(stored)
        assertEquals(CredentialMode.KEEP, d.credentialMode)
        assertEquals("eu.x | X", d.models[ModelProviderAgent.CLAUDE_CODE])
        assertEquals("work", d.localAwsProfile)
        assertNull(d.problem())
        val keep = d.body()
        assertFalse("credentials" in keep)
        assertFalse("kind" in keep)
        assertEquals(JsonPrimitive("workspace"), keep["owner"])
        assertEquals(JsonNull, d.copy(credentialMode = CredentialMode.CLEAR).body()["credentials"])
        assertEquals("Enter the access key id and secret.", d.copy(credentialMode = CredentialMode.REPLACE).problem())
        // Switching to the pod's role drops what's stored.
        assertEquals(CredentialChange.Clear, d.copy(podCredential = ModelProviderPodCredential.AMBIENT).credentialChange())
    }

    @Test
    fun summary() {
        assertEquals("Bedrock · Organization · Claude Code · eu-west-1 · Pods: access key (stored)", providerSummary(stored))
    }
}
