package dev.optio.feature.sessions

import dev.optio.core.model.InteractiveSessionState
import dev.optio.core.model.get
import dev.optio.core.model.stringValue
import dev.optio.core.network.ApiClient
import java.io.File
import java.util.UUID
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
import org.junit.Assume.assumeTrue
import org.junit.Rule
import org.junit.Test

/**
 * The session screen's calls against a real API (the private test API: fake agent runtime, DevLab
 * seed). Skipped unless `OPTIO_TEST_API_URL` is set; the seed comes from `OPTIO_TEST_SEED`, else
 * `~/.android/optio-devlab/test-api/<port>/seed.json`.
 *
 * ```
 * OPTIO_TEST_API_URL=http://127.0.0.1:4967 ./gradlew :feature:sessions:testDebugUnitTest --tests '*LiveTest*'
 * ```
 */
class SessionsLiveTest {
    @get:Rule
    val main = RealMainRule()

    private val baseUrl: String? = System.getenv("OPTIO_TEST_API_URL")?.trimEnd('/')

    private fun seed(): JsonObject = liveSeed(checkNotNull(baseUrl))

    private fun api(seed: JsonObject) = ApiClient(baseUrl, seed["api"]?.get("token")?.stringValue ?: "dev")

    @Test
    fun theActiveSessionLoadsAndChatsOverItsSocket() {
        assumeTrue("OPTIO_TEST_API_URL not set", baseUrl != null)
        val seed = seed()
        val api = api(seed)
        val id = checkNotNull(seed["sessions"]?.get("active")?.get("id")?.stringValue)
        val vm = main.onMain { SessionDetailViewModel(id, api) }
        try {
            main.onMain {
                vm.appeared()
                vm.connect()
            }
            eventually(15_000, { "session + PRs" }) { vm.session.value.value != null && vm.prs.value.isNotEmpty() }
            val envelope = vm.session.value.value!!
            assertEquals(InteractiveSessionState.ACTIVE, envelope.session.state)
            assertEquals(listOf("haiku", "sonnet", "opus"), envelope.modelConfig?.availableModels)
            assertTrue(vm.prs.value.first().prUrl.contains("/pull/"))

            // Ready, and the history replay over, before anything is sent.
            eventually(15_000, { "chat ready (${vm.chat.status.value}, settled=${vm.chat.settled.value})" }) { vm.chat.canSend.value }
            assertTrue(vm.chat.historyLoaded.value)
            val before = vm.chat.rows.value.size
            assertTrue(before > 0, "the seeded exchange")

            val text = "Android live check ${UUID.randomUUID().toString().take(8)}"
            assertTrue(main.onMain { vm.chat.send(text) })
            eventually(20_000, { "reply (rows ${vm.chat.rows.value.size}, ${vm.chat.status.value})" }) {
                vm.chat.rows.value.any { row -> row is SessionChatRow.Entry && row.entry.content == "Mock agent handled: $text" } &&
                    vm.chat.status.value == SessionChatConnection.IDLE
            }
            assertEquals(SessionChatRow.User(vm.chat.rows.value[before].id, text), vm.chat.rows.value[before])
            assertTrue(vm.chat.costUsd.value > 0)
            assertTrue(vm.chat.canSend.value)

            // The server kept both sides of the exchange for the next visit.
            val history = runBlocking { api.sessionChatHistory(id) }
            assertTrue(history.any { it.isUserMessage && it.content == text })

            // Picking a model is acknowledged with a status frame naming it.
            main.onMain { vm.chat.setModel("haiku") }
            eventually(10_000) { vm.chat.model.value == "haiku" && vm.chat.status.value == SessionChatConnection.IDLE }
        } finally {
            main.onMain { vm.disconnect() }
        }
    }

    @Test
    fun theEndedSessionOpensNoChat() {
        assumeTrue("OPTIO_TEST_API_URL not set", baseUrl != null)
        val seed = seed()
        val id = checkNotNull(seed["sessions"]?.get("ended")?.get("id")?.stringValue)
        val vm = main.onMain { SessionDetailViewModel(id, api(seed)) }
        main.onMain {
            vm.appeared()
            vm.connect()
        }
        eventually(15_000) { vm.session.value.value != null }
        assertEquals(InteractiveSessionState.ENDED, vm.session.value.value!!.session.state)
        Thread.sleep(500)
        assertFalse(vm.chat.historyLoaded.value, "no chat for an ended session")
        main.onMain { vm.disconnect() }
    }
}

/** The DevLab seed manifest of the instance at [baseUrl]. */
internal fun liveSeed(baseUrl: String): JsonObject {
    val port = baseUrl.substringAfterLast(':').takeWhile { it.isDigit() }
    val file =
        listOfNotNull(System.getenv("OPTIO_TEST_SEED"), File(System.getProperty("user.home"), ".android/optio-devlab/test-api/$port/seed.json").path)
            .map(::File)
            .firstOrNull { it.isFile } ?: error("no seed.json for $baseUrl (set OPTIO_TEST_SEED)")
    return Json.parseToJsonElement(file.readText()).jsonObject
}
