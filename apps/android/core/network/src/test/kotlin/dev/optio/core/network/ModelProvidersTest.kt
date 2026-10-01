package dev.optio.core.network

import dev.optio.core.model.ModelProviderAgent
import dev.optio.core.model.ModelProviderCredentials
import dev.optio.core.model.ModelProviderModel
import dev.optio.core.model.ModelProviderPodCredential
import dev.optio.core.model.OptioJson
import dev.optio.core.model.PickableSecret
import dev.optio.core.model.ResourceOwner
import java.util.concurrent.TimeUnit
import kotlin.test.AfterTest
import kotlin.test.BeforeTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonObject
import mockwebserver3.MockResponse
import mockwebserver3.MockWebServer

class ModelProvidersTest {
    private lateinit var server: MockWebServer
    private lateinit var api: ApiClient

    @BeforeTest
    fun setUp() {
        server = MockWebServer()
        server.start()
        api = ApiClient(baseUrl = server.url("/").toString(), token = "optio_pat_test")
    }

    @AfterTest
    fun tearDown() {
        server.close()
    }

    private fun enqueue(body: String, code: Int = 200) = server.enqueue(MockResponse.Builder().code(code).body(body).build())

    private val providerJson = """
        {"id":"p1","workspaceId":"w1","ownerUserId":null,"ownerName":null,"kind":"bedrock","name":"Bedrock prod",
         "agents":["claude-code","codex"],"region":"us-west-2",
         "models":{"claude-code":[{"id":"us.anthropic.claude-opus-5-5","label":"Opus 5.5"},{"id":"us.anthropic.claude-sonnet-5"}],
                   "codex":[{"id":"openai.gpt-5.5"}]},
         "localAwsProfile":"work","podCredential":"access-key","hasPodCredentials":true,"mine":false,"canEdit":true,
         "createdAt":"2026-09-30T00:00:00Z","updatedAt":"2026-09-30T00:00:00Z","futureField":1}
    """.trimIndent()

    @Test
    fun listDecodesProvidersAndTheirModels() = runTest {
        enqueue("""{"providers":[$providerJson]}""")
        val list = api.listModelProviders()
        val req = checkNotNull(server.takeRequest(5, TimeUnit.SECONDS))
        assertEquals("/api/model-providers", req.url.encodedPath)
        val p = list.single()
        assertEquals("Bedrock prod", p.name)
        assertEquals(listOf(ModelProviderAgent.CLAUDE_CODE, ModelProviderAgent.CODEX), p.agents)
        assertEquals(ModelProviderPodCredential.ACCESS_KEY, p.podCredential)
        assertEquals(listOf("us.anthropic.claude-opus-5-5", "us.anthropic.claude-sonnet-5"), p.modelsFor("claude-code").map { it.id })
        assertEquals("Opus 5.5", p.modelsFor("claude-code")[0].label)
        assertEquals(1, p.modelsFor("codex").size)
        assertTrue(p.modelsFor("gemini").isEmpty())
        assertTrue(p.serves("codex"))
        assertFalse(p.serves("gemini"))
        assertTrue(p.isOrganization)
        assertEquals("Organization", p.ownerLabel)
    }

    @Test
    fun unknownCredentialKindDecodesToUnknown() = runTest {
        enqueue("""{"providers":[${providerJson.replace("\"access-key\"", "\"sso\"")}]}""")
        assertEquals(ModelProviderPodCredential.UNKNOWN, api.listModelProviders().single().podCredential)
    }

    @Test
    fun pickableSecretsDecode() = runTest {
        enqueue("""{"secrets":[{"name":"GH","owner":"workspace"},{"name":"GH","owner":"me"}]}""")
        val list = api.listPickableSecrets()
        assertEquals(listOf(PickableSecret.Owner.WORKSPACE, PickableSecret.Owner.ME), list.map { it.owner })
        assertEquals("/api/secrets/pickable", checkNotNull(server.takeRequest(5, TimeUnit.SECONDS)).url.encodedPath)
    }

    @Test
    fun personalSecretCreateSendsUserScope() = runTest {
        enqueue("{}", 201)
        api.createPickableSecret("TOKEN", "v", personal = true)
        val body = OptioJson.parseToJsonElement(checkNotNull(server.takeRequest(5, TimeUnit.SECONDS)).body!!.utf8()).jsonObject
        assertEquals(JsonPrimitive("user"), body["scope"])
        enqueue("{}", 201)
        api.createPickableSecret("TOKEN", "v", personal = false)
        val org = OptioJson.parseToJsonElement(checkNotNull(server.takeRequest(5, TimeUnit.SECONDS)).body!!.utf8()).jsonObject
        assertNull(org["scope"])
    }

    @Test
    fun bodyKeepsClearsOrReplacesCredentials() {
        fun body(change: CredentialChange, create: Boolean = false) = modelProviderBody(
            name = " Bedrock ",
            owner = ResourceOwner.ME,
            agents = listOf(ModelProviderAgent.CLAUDE_CODE),
            region = "us-west-2",
            models = mapOf(
                ModelProviderAgent.CLAUDE_CODE to listOf(ModelProviderModel("a", "A"), ModelProviderModel(" ", null)),
                ModelProviderAgent.CODEX to listOf(ModelProviderModel("ignored")),
            ),
            localAwsProfile = "",
            podCredential = ModelProviderPodCredential.ACCESS_KEY,
            credentials = change,
            create = create,
        )
        val keep = body(CredentialChange.Keep)
        assertFalse("credentials" in keep)
        assertFalse("kind" in keep)
        assertEquals(JsonPrimitive("Bedrock"), keep["name"])
        assertEquals(JsonPrimitive("me"), keep["owner"])
        assertEquals(JsonNull, keep["localAwsProfile"])
        val models = keep["models"] as JsonObject
        assertEquals(setOf("claude-code"), models.keys)
        assertEquals(1, (models["claude-code"] as JsonArray).size)
        assertEquals(JsonNull, body(CredentialChange.Clear)["credentials"])
        val replaced = body(CredentialChange.Replace(ModelProviderCredentials.BearerToken("tok")), create = true)
        assertEquals(JsonPrimitive("bedrock"), replaced["kind"])
        val creds = replaced["credentials"] as JsonObject
        assertEquals(JsonPrimitive("bearer-token"), creds["type"])
        assertEquals(JsonPrimitive("tok"), creds["bearerToken"])
    }

    @Test
    fun sharedHelpers() {
        assertTrue(isValidAwsRegion("us-west-2"))
        assertTrue(isValidAwsRegion("us-gov-west-1"))
        assertFalse(isValidAwsRegion("uswest2"))
        assertEquals("eu", bedrockInferencePrefix("eu-central-1"))
        assertEquals("apac", bedrockInferencePrefix("ap-south-1"))
        assertEquals("eu.anthropic.claude-opus-5-5", bedrockDefaultModels(ModelProviderAgent.CLAUDE_CODE, "eu-west-1")[0].id)
        assertEquals("openai.gpt-5.5", bedrockDefaultModels(ModelProviderAgent.CODEX, "us-west-2")[0].id)
        assertEquals("machines only", podCredentialLabel(ModelProviderPodCredential.NONE))
        assertEquals("p1", modelProviderIdFrom(mapOf(MODEL_PROVIDER_OPTION_KEY to JsonPrimitive(" p1 "))))
        assertNull(modelProviderIdFrom(mapOf(MODEL_PROVIDER_OPTION_KEY to JsonPrimitive(""))))
    }
}
