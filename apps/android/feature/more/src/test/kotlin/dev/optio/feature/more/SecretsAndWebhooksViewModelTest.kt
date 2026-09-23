package dev.optio.feature.more

import dev.optio.core.testing.FakeOptioServerRule
import dev.optio.core.testing.FakeResponse
import dev.optio.core.testing.Fixtures
import dev.optio.core.testing.MainDispatcherRule
import dev.optio.core.ui.state.LoadState
import dev.optio.core.ui.state.isForbidden
import dev.optio.core.ui.theme.Tone
import dev.optio.feature.more.secrets.SecretsViewModel
import dev.optio.feature.more.ui.Notice
import dev.optio.feature.more.webhooks.NewWebhookViewModel
import dev.optio.feature.more.webhooks.WebhookDetailViewModel
import dev.optio.feature.more.webhooks.WebhookDraft
import dev.optio.feature.more.webhooks.WebhooksViewModel
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Rule

/** Secrets and webhooks ViewModels against the fake API (fixtures from the private test API). */
class SecretsAndWebhooksViewModelTest {
    @get:Rule(order = 0)
    val main = MainDispatcherRule()

    @get:Rule(order = 1)
    val fake = FakeOptioServerRule()

    @get:Rule(order = 2)
    val vms = ViewModelsRule()

    private val server get() = fake.server
    private val hookId = "8230ea20-4742-4047-b684-8988723d6c6b"

    /** Waits for a request off the test thread, so coroutines queued on it keep running. */
    private suspend fun awaitRequest(
        method: String,
        path: String,
    ) = withContext(Dispatchers.Default) { server.awaitRequest(method, path) }

    // region Secrets

    @Test
    fun secretsLoadDedupesTheServersDuplicateRows() = runTest(main.dispatcher) {
        server.fixture("/api/secrets", "secrets-duplicates.json")
        server.fixture("/api/repos", "repos.json")
        val vm = vms.of { SecretsViewModel(server.client()) }
        vm.load()
        val data = assertNotNull(vm.state.value.value)
        assertEquals(listOf("A8_PROBE_USER", "A8_PROBE_REPO"), data.secrets.map { it.name })
        assertEquals(listOf("e2e-org/e2e-repo", "e2e-org/mobile-app"), data.repos.map { it.displayName })
        assertNull(server.lastRequest("GET", "/api/secrets")!!.queryParam("scope"), "All scopes sends no filter")
    }

    @Test
    fun secretsFilterAsksTheServerAndKeepsOnlyThatScope() = runTest(main.dispatcher) {
        server.fixture("/api/secrets", "secrets-scope-global.json")
        server.fixture("/api/repos", "repos.json")
        val vm = vms.of { SecretsViewModel(server.client()) }
        vm.setFilter("global")
        val loaded = vm.state.first { it is LoadState.Loaded }
        assertTrue(loaded.value!!.secrets.isEmpty(), "the server's appended user row is dropped")
        assertEquals("global", server.lastRequest("GET", "/api/secrets")!!.queryParam("scope"))
        assertEquals("global", vm.scopeFilter.value)
    }

    @Test
    fun secretsReposFailingStillShowsTheSecrets() = runTest(main.dispatcher) {
        server.fixture("/api/secrets", "secrets-duplicates.json")
        server.error("GET", "/api/repos", 500, "boom")
        val vm = vms.of { SecretsViewModel(server.client()) }
        vm.load()
        assertEquals(2, vm.state.value.value!!.secrets.size)
        assertTrue(vm.state.value.value!!.repos.isEmpty())
    }

    @Test
    fun secretsViewerGets403() = runTest(main.dispatcher) {
        server.fixture("/api/secrets", "secrets-viewer-403.json", status = 403)
        server.fixture("/api/repos", "repos.json")
        val vm = vms.of { SecretsViewModel(server.client()) }
        vm.load()
        val error = assertNotNull(vm.state.value.errorOrNull)
        assertTrue(error.isForbidden)
    }

    @Test
    fun secretSaveSendsNameValueScopeAndReportsValidation() = runTest(main.dispatcher) {
        server.fixture("/api/secrets", "secrets.json")
        server.fixture("/api/repos", "repos.json")
        server.post("/api/secrets") {
            FakeResponse.json("""{"name":"ANTHROPIC_API_KEY","scope":"global","validation":{"valid":false,"error":"API key is invalid"}}""", 201)
        }
        val vm = vms.of { SecretsViewModel(server.client()) }
        val closed = CompletableDeferred<Unit>()
        vm.save(" ANTHROPIC_API_KEY ", "sk-test-value", "global") { closed.complete(Unit) }
        assertEquals(Notice("Saved, but validation failed: API key is invalid", Tone.ACCENT), vm.notices.first())
        assertTrue(closed.isCompleted)
        val body = server.lastRequest("POST", "/api/secrets")!!.json.jsonObject
        assertEquals("ANTHROPIC_API_KEY", body["name"]!!.jsonPrimitive.content, "the name is trimmed")
        assertEquals("sk-test-value", body["value"]!!.jsonPrimitive.content)
        assertEquals("global", body["scope"]!!.jsonPrimitive.content)
        assertFalse(vm.saving.value)
    }

    @Test
    fun secretSaveForbiddenForAMemberKeepsTheForm() = runTest(main.dispatcher) {
        server.fixture("/api/secrets", "secrets.json")
        server.error("POST", "/api/secrets", 403, "Forbidden: requires admin role")
        val vm = vms.of { SecretsViewModel(server.client()) }
        var closed = false
        vm.save("MY_TOKEN", "x", "user") { closed = true }
        assertEquals(Notice("You don't have permission to do that. Forbidden: requires admin role", Tone.DANGER), vm.notices.first())
        assertFalse(closed, "the form stays open")
    }

    @Test
    fun secretDeleteByNameAndScope() = runTest(main.dispatcher) {
        server.fixture("/api/secrets", "secrets-duplicates.json")
        server.fixture("/api/repos", "repos.json")
        server.delete("/api/secrets/:name") { FakeResponse.empty() }
        val vm = vms.of { SecretsViewModel(server.client()) }
        vm.load()
        val repoSecret = vm.state.value.value!!.secrets[1]
        server.clearRequests()
        vm.delete(repoSecret)
        awaitRequest("GET", "/api/secrets")
        vm.state.first { it is LoadState.Loaded }
        val delete = server.lastRequest("DELETE", "/api/secrets/:name")!!
        assertEquals("A8_PROBE_REPO", delete.pathParams["name"])
        assertEquals("https://github.com/e2e-org/e2e-repo", delete.queryParam("scope"))
    }

    // endregion

    // region Webhooks

    @Test
    fun webhooksLoadTestAndDelete() = runTest(main.dispatcher) {
        server.fixture("/api/webhooks", "webhooks.json")
        server.fixture("/api/webhooks/:id/test", "webhook-test-delivery.json", method = "POST")
        server.delete("/api/webhooks/:id") { FakeResponse.empty() }
        val vm = vms.of { WebhooksViewModel(server.client()) }
        vm.load()
        val hook = vm.state.value.value!!.single()
        vm.test(hook)
        assertEquals(Notice("Failed: fetch failed", Tone.DANGER), vm.notices.first())
        assertEquals("{}", server.lastRequest("POST", "/api/webhooks/:id/test")!!.body, "no event = the webhook's first")
        server.clearRequests()
        vm.delete(hook)
        awaitRequest("GET", "/api/webhooks")
        vm.state.first { it is LoadState.Loaded }
        assertEquals(hookId, server.lastRequest("DELETE", "/api/webhooks/:id")!!.pathParams["id"])
    }

    @Test
    fun webhookDetailLoadsDeliveriesAndActs() = runTest(main.dispatcher) {
        // A stateful webhook: PATCH flips `active`, later GETs see it.
        var active = true
        fun hook() = FakeResponse.json(Fixtures.text("webhook.json").replace("\"active\": true", "\"active\": $active"))
        server.get("/api/webhooks/:id") { hook() }
        server.fixture("/api/webhooks/:id/deliveries", "webhook-deliveries.json")
        server.fixture("/api/webhooks/:id/test", "webhook-test-delivery.json", method = "POST")
        server.patch("/api/webhooks/:id") { req ->
            active = req.json.jsonObject["active"]!!.jsonPrimitive.content.toBoolean()
            hook()
        }
        val vm = vms.of { WebhookDetailViewModel(server.client(), hookId) }
        vm.load()
        val detail = vm.state.value.value!!
        assertEquals(2, detail.deliveries.size)
        assertEquals(0, detail.successRate)
        assertEquals("50", server.lastRequest("GET", "/api/webhooks/:id/deliveries")!!.queryParam("limit"))

        vm.test("task.failed")
        assertEquals("Failed: fetch failed", vm.notices.first().text)
        assertEquals("task.failed", server.lastRequest("POST", "/api/webhooks/:id/test")!!.json.jsonObject["event"]!!.jsonPrimitive.content)
        vm.busy.first { !it } // the test reloads the history before it is done

        vm.toggleActive()
        assertTrue(vm.busy.value)
        vm.busy.first { !it }
        assertEquals("false", server.lastRequest("PATCH", "/api/webhooks/:id")!!.json.jsonObject["active"]!!.jsonPrimitive.content)
        assertTrue(vm.state.value.value!!.webhook.isPaused)
    }

    @Test
    fun webhookDetailDeleteCallsBack() = runTest(main.dispatcher) {
        server.fixture("/api/webhooks/:id", "webhook.json")
        server.fixture("/api/webhooks/:id/deliveries", "webhook-deliveries.json")
        server.delete("/api/webhooks/:id") { FakeResponse.empty() }
        val vm = vms.of { WebhookDetailViewModel(server.client(), hookId) }
        vm.load()
        val deleted = CompletableDeferred<Unit>()
        vm.delete { deleted.complete(Unit) }
        deleted.await()
        assertNotNull(server.lastRequest("DELETE", "/api/webhooks/:id"))
    }

    @Test
    fun webhookDetailWithoutDeliveriesStillLoads() = runTest(main.dispatcher) {
        server.fixture("/api/webhooks/:id", "webhook.json")
        server.error("GET", "/api/webhooks/:id/deliveries", 500, "boom")
        val vm = vms.of { WebhookDetailViewModel(server.client(), hookId) }
        vm.load()
        assertTrue(vm.state.value.value!!.deliveries.isEmpty())
        assertNull(vm.state.value.value!!.successRate)
    }

    @Test
    fun newWebhookPostsTheDraftAndReportsSsrfRejections() = runTest(main.dispatcher) {
        server.post("/api/webhooks") { FakeResponse.fixture("webhook.json", 201) }
        val vm = vms.of { NewWebhookViewModel(server.client()) }
        val created = CompletableDeferred<String>()
        val draft = WebhookDraft(url = "https://hooks.example.invalid/optio", description = "Chat bridge", events = setOf("task.failed", "task.completed"))
        vm.create(draft.input(secret = "shh")) { created.complete(it.id) }
        assertEquals(hookId, created.await())
        val body = server.lastRequest("POST", "/api/webhooks")!!.json.jsonObject
        assertEquals(listOf("task.completed", "task.failed"), body["events"]!!.jsonArray.map { it.jsonPrimitive.content })
        assertEquals("shh", body["secret"]!!.jsonPrimitive.content)
        assertEquals("Chat bridge", body["description"]!!.jsonPrimitive.content)

        server.error("POST", "/api/webhooks", 400, "body/url URL must not target private or internal addresses")
        vm.create(WebhookDraft(url = "http://10.0.0.1/x").input("")) { error("must not be created") }
        assertEquals(Notice("body/url URL must not target private or internal addresses", Tone.DANGER), vm.notices.first())
        assertFalse("secret" in server.lastRequest("POST", "/api/webhooks")!!.json.jsonObject, "an empty secret is omitted")
    }

    // endregion
}
