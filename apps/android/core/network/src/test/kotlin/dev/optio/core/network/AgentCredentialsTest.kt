package dev.optio.core.network

import dev.optio.core.model.AgentCredentialInput
import dev.optio.core.model.AgentCredentialKind
import dev.optio.core.model.AgentCredentialMethod
import dev.optio.core.model.CreateAgentCredentialInput
import dev.optio.core.model.OptioJson
import dev.optio.core.model.ResourceOwner
import dev.optio.core.model.VerifyAgentCredentialInput
import java.util.concurrent.TimeUnit
import kotlin.test.AfterTest
import kotlin.test.BeforeTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import mockwebserver3.MockResponse
import mockwebserver3.MockWebServer

class AgentCredentialsTest {
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

    private val secretId = "11111111-1111-4111-8111-111111111111"

    private val credentialJson = """
        {"id":"secret:$secretId","kind":"secret","method":"api-key","label":"Anthropic API key",
         "secretName":"ANTHROPIC_API_KEY","owner":"workspace","default":true,"updatedAt":"2026-10-07T00:00:00Z"}
    """.trimIndent()

    @Test
    fun listsCredentialsAndWhatCanBeAdded() = runTest {
        enqueue(
            """
            {"credentials":[$credentialJson,
              {"id":"provider:p1","kind":"provider","method":"bedrock","label":"Amazon Bedrock · prod","providerId":"p1","owner":"me","default":false}],
             "addable":[{"secretName":"ANTHROPIC_API_KEY","method":"api-key","label":"Anthropic API key","input":"token","verifiable":true,"hint":"From the Anthropic console."},
                        {"secretName":"CLAUDE_CODE_OAUTH_TOKEN","method":"oauth-token","label":"Claude subscription (OAuth token)","input":"token","verifiable":false}]}
            """.trimIndent(),
        )
        val out = api.listAgentCredentials("claude-code", ResourceOwner.ME)
        val req = checkNotNull(server.takeRequest(5, TimeUnit.SECONDS))
        assertEquals("GET", req.method)
        assertEquals("/api/agents/credentials", req.url.encodedPath)
        assertEquals("claude-code", req.url.queryParameter("agentType"))
        assertEquals("me", req.url.queryParameter("owner"))
        assertEquals(2, out.credentials.size)
        val key = out.credentials[0]
        assertEquals(AgentCredentialKind.SECRET, key.kind)
        assertEquals(AgentCredentialMethod.API_KEY, key.method)
        assertEquals("ANTHROPIC_API_KEY", key.secretName)
        assertTrue(key.default)
        assertEquals(ResourceOwner.WORKSPACE, key.owner)
        val bedrock = out.credentials[1]
        assertEquals(AgentCredentialKind.PROVIDER, bedrock.kind)
        assertEquals("p1", bedrock.providerId)
        assertEquals(ResourceOwner.ME, bedrock.owner)
        assertFalse(bedrock.default)
        assertEquals(2, out.addable.size)
        assertEquals(AgentCredentialInput.TOKEN, out.addable[0].input)
        assertTrue(out.addable[0].verifiable)
        assertEquals("From the Anthropic console.", out.addable[0].hint)
        assertFalse(out.addable[1].verifiable)
        assertNull(out.addable[1].hint)
    }

    @Test
    fun unknownMethodsAndKindsDecodeAsUnknown() = runTest {
        enqueue("""{"credentials":[{"id":"x:1","kind":"future","method":"magic","label":"?","owner":"workspace","default":false}],"addable":[]}""")
        val c = api.listAgentCredentials("codex", ResourceOwner.WORKSPACE).credentials.single()
        assertEquals(AgentCredentialKind.UNKNOWN, c.kind)
        assertEquals(AgentCredentialMethod.UNKNOWN, c.method)
    }

    @Test
    fun createPostsTheInputAndReturnsTheCredential() = runTest {
        enqueue("""{"credential":$credentialJson}""", code = 201)
        val created = api.createAgentCredential(
            CreateAgentCredentialInput(agentType = "claude-code", secretName = "ANTHROPIC_API_KEY", value = "sk-ant-test", owner = ResourceOwner.WORKSPACE, verify = false),
        )
        val req = checkNotNull(server.takeRequest(5, TimeUnit.SECONDS))
        assertEquals("POST", req.method)
        assertEquals("/api/agents/credentials", req.url.encodedPath)
        val body = OptioJson.parseToJsonElement(req.body!!.utf8()).jsonObject
        assertEquals(JsonPrimitive("claude-code"), body["agentType"])
        assertEquals(JsonPrimitive("ANTHROPIC_API_KEY"), body["secretName"])
        assertEquals(JsonPrimitive("sk-ant-test"), body["value"])
        assertEquals(JsonPrimitive("workspace"), body["owner"])
        assertEquals(JsonPrimitive(false), body["verify"])
        assertEquals("secret:$secretId", created.id)
        assertEquals("Anthropic API key", created.label)
    }

    @Test
    fun verifyPostsTheValueAndReadsTheVerdict() = runTest {
        enqueue("""{"valid":false,"error":"invalid x-api-key"}""")
        val out = api.verifyAgentCredential(VerifyAgentCredentialInput(agentType = "codex", secretName = "OPENAI_API_KEY", value = "sk-bad"))
        val req = checkNotNull(server.takeRequest(5, TimeUnit.SECONDS))
        assertEquals("/api/agents/credentials/verify", req.url.encodedPath)
        val body = OptioJson.parseToJsonElement(req.body!!.utf8()).jsonObject
        assertEquals("OPENAI_API_KEY", body["secretName"]?.jsonPrimitive?.content)
        assertEquals("sk-bad", body["value"]?.jsonPrimitive?.content)
        assertFalse(out.valid)
        assertEquals("invalid x-api-key", out.error)
        assertNull(out.detail)
    }

    @Test
    fun credentialIdHelpers() {
        assertEquals("secret:$secretId", secretCredentialId(secretId))
        assertEquals(secretId, secretIdFromCredential(" secret:$secretId "))
        assertNull(secretIdFromCredential("provider:p1"))
        assertNull(secretIdFromCredential("secret:nope"))
        assertNull(secretIdFromCredential(null))
        assertEquals("secret:$secretId", credentialIdFrom(mapOf(AGENT_CREDENTIAL_OPTION_KEY to JsonPrimitive("secret:$secretId"))))
        assertNull(credentialIdFrom(mapOf(AGENT_CREDENTIAL_OPTION_KEY to JsonPrimitive(""))))
        assertNull(credentialIdFrom(mapOf(AGENT_CREDENTIAL_OPTION_KEY to JsonPrimitive(true))))
        assertNull(credentialIdFrom(null))
    }
}
