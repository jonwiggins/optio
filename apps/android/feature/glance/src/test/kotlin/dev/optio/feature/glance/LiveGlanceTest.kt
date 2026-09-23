package dev.optio.feature.glance

import androidx.test.ext.junit.runners.AndroidJUnit4
import com.google.firebase.messaging.RemoteMessage
import dev.optio.core.data.InMemoryPreferences
import dev.optio.core.data.ServerClient
import dev.optio.core.data.ServerProfile
import dev.optio.core.glance.FcmAvailability
import dev.optio.core.glance.GlanceStore
import dev.optio.core.glance.GlanceWatchState
import dev.optio.core.glance.NeedsYouSnapshot
import dev.optio.core.glance.NotificationPermissionState
import dev.optio.core.glance.PushRegistration
import dev.optio.core.glance.PushStatus
import dev.optio.core.glance.WatchSources
import dev.optio.core.model.OptioJson
import dev.optio.core.model.PushPlatform
import dev.optio.core.network.ApiClient
import dev.optio.feature.glance.notifications.ActionTarget
import dev.optio.feature.glance.notifications.AlertNotifier
import dev.optio.feature.glance.notifications.NeedsYouNotifier
import dev.optio.feature.glance.notifications.NotificationAction
import dev.optio.feature.glance.notifications.NotificationCategory
import dev.optio.feature.glance.notifications.NotificationHandler
import dev.optio.feature.glance.notifications.NotifiedStore
import dev.optio.feature.glance.push.FcmTokenSource
import dev.optio.feature.glance.push.PushMessageHandler
import dev.optio.feature.glance.push.PushRegistrar
import dev.optio.feature.glance.watch.WatchManager
import dev.optio.feature.glance.watch.WatchNotifier
import dev.optio.feature.glance.watch.WatchStore
import java.io.File
import java.util.UUID
import kotlin.test.AfterTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertIs
import kotlin.test.assertNotNull
import kotlin.test.assertTrue
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assume.assumeTrue
import org.junit.runner.RunWith

/**
 * The glance paths against a private **auth-enabled** test API started with `--fcm-fake`
 * (`test-api.sh start --auth --port 4990 --fcm-fake`). Skipped unless `OPTIO_TEST_API_URL` is set.
 *
 * Registration, `POST /api/notifications/devices/test`, the message the server would have sent
 * (read back from the fake transport's outbox) fed through [PushMessageHandler] exactly as
 * `onMessageReceived` would, the snapshot and Watch frame loads, and the notification actions.
 *
 * ```
 * OPTIO_TEST_API_URL=http://127.0.0.1:4990 ./gradlew :feature:glance:testDebugUnitTest --tests '*LiveGlanceTest*'
 * ```
 */
@RunWith(AndroidJUnit4::class)
class LiveGlanceTest {
    private val baseUrl: String? = System.getenv("OPTIO_TEST_API_URL")?.trimEnd('/')
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)

    @AfterTest
    fun tearDown() = scope.cancel()

    private fun runDir(): File {
        val port = checkNotNull(baseUrl).substringAfterLast(':').takeWhile { it.isDigit() }
        return File(System.getenv("OPTIO_TEST_RUN_DIR") ?: File(System.getProperty("user.home"), ".android/optio-devlab/test-api/$port").path)
    }

    private fun seed(): JsonObject = OptioJson.parseToJsonElement(File(runDir(), "seed.json").readText()).jsonObject

    private fun JsonObject.path(vararg keys: String): String = keys.fold(this as kotlinx.serialization.json.JsonElement) { acc, k -> acc.jsonObject.getValue(k) }.jsonPrimitive.content

    private fun client(): ServerClient {
        val token = seed().path("auth", "adminToken")
        return ServerClient(ServerProfile(id = "live-srv", name = "DevLab", url = baseUrl!!), ApiClient(baseUrl, token))
    }

    @Test
    fun snapshotAndWatchFrameLoad(): Unit =
        runBlocking {
            assumeTrue("OPTIO_TEST_API_URL not set", baseUrl != null)
            val c = client()
            val snapshot = NeedsYouSnapshot.load(c)
            assertTrue(snapshot.hostsTotal >= 1, "the seeded E2E laptop")
            assertNotNull(snapshot.counts, "auth-enabled servers serve the tiles")
            val frame = GlanceWatchState.fromWire(c.api.glanceWatch(), c.server.id)
            assertTrue(frame.recurringCount!! >= 1)
        }

    @Test
    fun registerSendATestPushAndHandleWhatTheServerSent(): Unit =
        runBlocking {
            assumeTrue("OPTIO_TEST_API_URL not set", baseUrl != null)
            val outbox = File(runDir(), "fcm-outbox.jsonl")
            assumeTrue("start the API with --fcm-fake", runDir().resolve("server.json").isFile)
            val context = GlanceTestEnv.context()
            val c = client()
            val token = "live-" + UUID.randomUUID().toString().replace("-", "") + "x".repeat(8)
            val status = PushStatus.detached()
            status.update { it.copy(permission = NotificationPermissionState.GRANTED) }
            var paired = listOf(c)
            val tokens =
                object : FcmTokenSource {
                    override fun availability() = FcmAvailability.Available

                    override suspend fun token() = token
                }
            val registrar = PushRegistrar(context, scope, status, tokens, { paired }, MutableStateFlow(listOf(c.server)))
            registrar.sync()
            val mine = status.state.value.server("live-srv")!!
            assertEquals(PushRegistration.REGISTERED, mine.registration, mine.error)
            assertEquals(true, mine.serverCanPush, "the fake FCM transport counts as configured")
            val listed = c.api.listNotificationDevices().devices.single { it.id == mine.deviceId }
            assertEquals(PushPlatform.ANDROID, listed.platform)
            assertEquals("live-srv", listed.serverId)
            assertEquals(context.packageName, listed.appId)
            assertTrue(status.state.value.isThisDevice(listed))

            val before = if (outbox.isFile) outbox.readLines().size else 0
            assertTrue(c.api.sendTestNotification() >= 1)
            val sent =
                outbox.readLines().drop(before).map { OptioJson.parseToJsonElement(it).jsonObject.getValue("message").jsonObject }
                    .single { it["token"]?.jsonPrimitive?.content == token }
            val data = sent.getValue("data").jsonObject.mapValues { (it.value as JsonPrimitive).content }
            assertEquals("live-srv", data["serverId"], "every push carries the serverId the app registered with")

            // Exactly what onMessageReceived hands the handler.
            val message = RemoteMessage.Builder("$token@fcm.googleapis.com").setData(data).build()
            val alerts = AlertNotifier(context)
            val watch =
                WatchManager(
                    scope,
                    WatchManager.fixedHost(listOf(c)),
                    WatchSources(InMemoryPreferences(), scope),
                    GlanceStore.inMemory(),
                    WatchStore.inMemory(),
                    WatchNotifier(context),
                    NeedsYouNotifier(alerts, NotifiedStore.inMemory()),
                )
            val result = assertIs<PushMessageHandler.Result.Alert>(PushMessageHandler(alerts, watch, scope).handle(message.data))
            assertTrue(result.posted)
            assertEquals(NotificationCategory.TEST, result.spec.category)
            assertNotNull(GlanceTestEnv.notification(context, result.spec.tag, AlertNotifier.ALERT_ID))

            // Forgetting the server unregisters the device there.
            paired = emptyList()
            registrar.sync()
            assertTrue(c.api.listNotificationDevices().devices.none { it.id == mine.deviceId })
        }

    @Test
    fun actionsAgainstTheSeededData(): Unit =
        runBlocking {
            assumeTrue("OPTIO_TEST_API_URL not set", baseUrl != null)
            val context = GlanceTestEnv.context()
            val c = client()
            val seed = seed()
            val store = GlanceStore.inMemory()
            val sources = WatchSources(InMemoryPreferences(), scope)
            val handler = NotificationHandler({ listOf(c) }, { c }, store, sources, AlertNotifier(context))
            fun target(
                kind: String,
                id: String,
            ) = ActionTarget(ActionTarget.Source.ALERT, kind, id, "live-srv", tag = "$kind-$id")

            // Later on the recorded agent session: server-side snooze.
            val terminal = seed.path("local", "recordedAgentSession", "terminalId")
            assertEquals(NotificationHandler.Outcome.DONE, handler.perform(NotificationAction.LATER, target("local", terminal)))
            val snoozed = c.api.get<JsonObject>("/api/local/terminals/$terminal").getValue("terminal").jsonObject["snoozedUntil"]
            assertTrue(snoozed != null && snoozed.toString() != "null", "snoozed on the server")
            c.api.delete("/api/local/terminals/$terminal/snooze")

            // Reply to a task needing attention: a message resumes it.
            val attention = seed.path("tasks", "needsAttention", "id")
            assertEquals(NotificationHandler.Outcome.DONE, handler.perform(NotificationAction.REPLY, target("task", attention), "Try again, please [[mock:hang]]"))

            // Message the seeded persistent agent.
            val agent = seed.path("agents", "main", "id")
            assertEquals(NotificationHandler.Outcome.DONE, handler.perform(NotificationAction.REPLY, target("agent", agent), "Status? [[mock:hang]]"))
            assertTrue(agent in sources.recentAgentSends())
        }
}
