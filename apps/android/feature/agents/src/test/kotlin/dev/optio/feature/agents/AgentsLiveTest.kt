package dev.optio.feature.agents

import dev.optio.core.model.PersistentAgentControlIntent
import dev.optio.core.model.PersistentAgentState
import dev.optio.core.model.get
import dev.optio.core.model.stringValue
import dev.optio.core.network.ApiClient
import java.io.File
import java.util.UUID
import java.util.concurrent.CopyOnWriteArrayList
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.put
import org.junit.Assume.assumeTrue
import org.junit.Rule
import org.junit.Test

/**
 * The agent screens' calls against a real API (the private test API: fake agent runtime, DevLab
 * seed). Skipped unless `OPTIO_TEST_API_URL` is set; the seed manifest comes from `OPTIO_TEST_SEED`,
 * else `~/.android/optio-devlab/test-api/<port>/seed.json`. Writes only to that instance.
 *
 * ```
 * OPTIO_TEST_API_URL=http://127.0.0.1:4967 ./gradlew :feature:agents:testDebugUnitTest --tests '*AgentsLiveTest*'
 * ```
 */
class AgentsLiveTest {
    @get:Rule
    val main = RealMainRule()

    private val baseUrl: String? = System.getenv("OPTIO_TEST_API_URL")?.trimEnd('/')

    private fun seed(): JsonObject {
        val url = checkNotNull(baseUrl)
        val port = url.substringAfterLast(':').takeWhile { it.isDigit() }
        val file =
            listOfNotNull(System.getenv("OPTIO_TEST_SEED"), File(System.getProperty("user.home"), ".android/optio-devlab/test-api/$port/seed.json").path)
                .map(::File)
                .firstOrNull { it.isFile } ?: error("no seed.json for $url (set OPTIO_TEST_SEED)")
        return Json.parseToJsonElement(file.readText()).jsonObject
    }

    private fun api(seed: JsonObject) = ApiClient(baseUrl, seed["api"]?.get("token")?.stringValue ?: "dev")

    private fun JsonObject.agentId(which: String): String = checkNotNull(this["agents"]?.get(which)?.get("id")?.stringValue)

    @Test
    fun aMessageWakesATurnThatStreamsIntoTheChat() {
        assumeTrue("OPTIO_TEST_API_URL not set", baseUrl != null)
        val seed = seed()
        val api = api(seed)
        val id = seed.agentId("main")
        // The default socket factory: a single-use ws-token, like the app.
        val vm = main.onMain { AgentDetailViewModel(id, api) }
        try {
            main.onMain {
                vm.appeared()
                vm.connect()
            }
            eventually(15_000, { "load + socket" }) { vm.turns.value.value != null && vm.messages.value.value != null && vm.connected.value }
            val lastTurn = vm.turns.value.value!!.maxOfOrNull { it.turnNumber } ?: 0.0

            val text = "Android live check ${UUID.randomUUID()} [[mock:cost:0.001]]"
            assertTrue(main.onMain { vm.send(text) })
            // Stored and drained by a new turn, which halts; its output streamed into the live tail.
            eventually(30_000, { "message processed" }) { vm.messages.value.value!!.any { it.body == text && it.processedAt != null } }
            eventually(30_000, { "new turn halted" }) {
                val newest = vm.turns.value.value!!.firstOrNull()
                newest != null && newest.turnNumber > lastTurn && newest.haltReason != null
            }
            val turn = vm.turns.value.value!!.first()
            eventually(10_000, { "live tail of turn ${turn.turnNumber}" }) {
                vm.live.value.turnId == turn.id && vm.live.value.entries.any { it.content.startsWith("Mock agent handled") }
            }
            eventually(10_000, { "agent idle" }) { vm.header.value.value?.agent?.state == PersistentAgentState.IDLE }

            // The turn opens with its prompt and logs (the Turns chip's detail).
            val detail = runBlocking { api.getPersistentAgentTurn(id, turn.id) }
            assertTrue(detail.turn.promptUsed!!.contains(text))
            assertTrue(detail.logs.map { it.asLogEntry(id) }.any { it.content.startsWith("Mock agent handled") })
        } finally {
            main.onMain { vm.disconnect() }
        }
    }

    @Test
    fun everyTriggerTypeIsCreatedAndDeleted() {
        assumeTrue("OPTIO_TEST_API_URL not set", baseUrl != null)
        val seed = seed()
        val api = api(seed)
        val id = seed.agentId("paused")
        val vm = main.onMain { AgentDetailViewModel(id, api) }
        val failures = CopyOnWriteArrayList<AgentDetailViewModel.Event>()
        val collector = CoroutineScope(SupervisorJob() + Dispatchers.Default)
        collector.launch { vm.events.collect { failures += it } }
        main.onMain { vm.appeared() }
        eventually(15_000) { vm.triggers.value.value != null }

        val drafts =
            listOf(
                AgentTriggerDraft(type = AgentTriggerType.SCHEDULE, cron = "30 7 * * 1-5"),
                AgentTriggerDraft(type = AgentTriggerType.WEBHOOK, webhookPath = "android-live-${UUID.randomUUID().toString().take(8)}"),
                AgentTriggerDraft(type = AgentTriggerType.TICKET, ticketSource = "linear", ticketLabels = listOf("docs")),
                AgentTriggerDraft(type = AgentTriggerType.GITHUB, githubLogin = "octocat"),
                AgentTriggerDraft(type = AgentTriggerType.SLACK, slackChannel = "C0123ABCD", slackMentionOnly = true, slackKeyword = "docs"),
                AgentTriggerDraft(type = AgentTriggerType.LINEAR, linearEvents = listOf("created", "labeled")),
                AgentTriggerDraft(type = AgentTriggerType.MANUAL),
            )
        for (draft in drafts) {
            assertTrue(draft.isValid, "${draft.type}: ${draft.validation}")
            assertTrue(main.onMain { vm.createTrigger(draft) }, "create ${draft.type}: $failures")
            val created = vm.triggers.value.value!!.first()
            assertEquals(draft.type.raw, created.type)
            assertEquals(draft.config(), JsonObject(created.config.orEmpty()), "the server stores the config as sent")
            val stored = runBlocking { api.listPersistentAgentTriggers(id) }.single { it.id == created.id }
            assertEquals(created.summary, stored.summary)
            if (draft.type == AgentTriggerType.SCHEDULE) assertNotNull(stored.nextFireAt)

            main.onMain { vm.deleteTrigger(created.id) }
            eventually(10_000, { "${draft.type} deleted" }) { runBlocking { api.listPersistentAgentTriggers(id) }.none { it.id == created.id } }
        }

        // What the sheet's validation guards against, the server refuses in its own words.
        failures.clear()
        val refused =
            runCatching {
                runBlocking {
                    api.createPersistentAgentTrigger(id, PersistentAgentTriggerInput("slack", buildJsonObject { put("channelId", "general") }))
                }
            }.exceptionOrNull()
        assertEquals("Slack triggers require config.channelId (e.g. C0123ABCD)", refused?.message)
        collector.cancel()
    }

    @Test
    fun theFormCreatesAndEditsAnAgentThatCanBeControlled() {
        assumeTrue("OPTIO_TEST_API_URL not set", baseUrl != null)
        val seed = seed()
        val api = api(seed)
        val slug = "android-live-${UUID.randomUUID().toString().take(8)}"
        val create = main.onMain { AgentFormViewModel(null, api) }
        main.onMain {
            create.edit {
                it.copy(slug = slug, name = "Android live check", description = "Temporary", initialPrompt = "Say hello. [[mock:cost:0.001]]", maxTurns = 5)
            }
        }
        val created = assertNotNull(main.onMain { create.save() }, "create failed: ${create.error.value}")
        try {
            assertEquals(slug, created.slug)
            assertEquals(AgentDefaults.AGENTS_MD, created.agentsMd)

            // Edit: blank fields are cleared (JSON null), steppers saved, the slug untouched.
            val edit = main.onMain { AgentFormViewModel(created.id, api) }
            eventually(10_000, { "edit form loaded: ${edit.agent.value} / ${edit.draft.value.name}" }) {
                edit.agent.value.value != null && edit.draft.value.name == "Android live check"
            }
            main.onMain { edit.edit { it.copy(description = "", model = "haiku", maxTurns = 7, podLifecycle = "on-demand") } }
            val saved = assertNotNull(main.onMain { edit.save() }, "save failed: ${edit.error.value}")
            assertNull(saved.description)
            assertEquals("haiku", saved.model)
            assertEquals(7.0, saved.maxTurns)
            assertEquals(slug, saved.slug)
            main.onMain { edit.edit { it.copy(model = "") } }
            assertNull(assertNotNull(main.onMain { edit.save() }).model, "a cleared model goes back to the runtime default")

            // Pause, then resume, through the control intents the menu sends.
            val detail = main.onMain { AgentDetailViewModel(created.id, api) }
            main.onMain { detail.appeared() }
            eventually(10_000) { detail.header.value.value != null }
            main.onMain { detail.control(PersistentAgentControlIntent.PAUSE) }
            eventually(30_000, { "paused" }) { runBlocking { api.getPersistentAgent(created.id) }.agent.state == PersistentAgentState.PAUSED }
            main.onMain { detail.control(PersistentAgentControlIntent.RESUME) }
            eventually(30_000, { "resumed" }) { runBlocking { api.getPersistentAgent(created.id) }.agent.state != PersistentAgentState.PAUSED }
        } finally {
            runBlocking { api.deletePersistentAgent(created.id) }
        }
        val gone = runCatching { runBlocking { api.getPersistentAgent(created.id) } }.exceptionOrNull()
        assertFalse(gone == null, "deleted agent still loads")
    }
}
