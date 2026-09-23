package dev.optio.feature.glance

import androidx.test.ext.junit.runners.AndroidJUnit4
import com.google.firebase.messaging.RemoteMessage
import dev.optio.core.data.InMemoryPreferences
import dev.optio.core.data.ServerClient
import dev.optio.core.glance.FcmAvailability
import dev.optio.core.glance.GlanceStore
import dev.optio.core.glance.NeedsYouSnapshot
import dev.optio.core.glance.NotificationPermissionState
import dev.optio.core.glance.PushRegistration
import dev.optio.core.glance.PushStatus
import dev.optio.core.glance.WatchSources
import dev.optio.core.model.AndroidPushAlert
import dev.optio.core.model.AndroidPushMessage
import dev.optio.core.model.AndroidPushWatch
import dev.optio.core.model.AndroidPushWatchEvent
import dev.optio.core.model.PushAlertCategory
import dev.optio.core.model.WatchItemKind
import dev.optio.core.testing.FakeOptioServer
import dev.optio.core.testing.FakeResponse
import dev.optio.feature.glance.GlanceTestEnv.actions
import dev.optio.feature.glance.GlanceTestEnv.item
import dev.optio.feature.glance.GlanceTestEnv.text
import dev.optio.feature.glance.GlanceTestEnv.title
import dev.optio.feature.glance.GlanceTestEnv.url
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
import java.time.Instant
import kotlin.test.AfterTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertIs
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.runner.RunWith

/** FCM payload decoding and dispatch, notification actions against the API, needs-you dedupe, registration. */
@RunWith(AndroidJUnit4::class)
class PushAndActionsTest {
    private val context = GlanceTestEnv.context()
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    private val server = FakeOptioServer().start()
    private val second = FakeOptioServer().start()
    private val alerts = AlertNotifier(context)
    private val store = GlanceStore.inMemory()
    private val sources = WatchSources(InMemoryPreferences(), scope)

    @AfterTest
    fun tearDown() {
        scope.cancel()
        server.close()
        second.close()
    }

    // region FCM data messages (the payloads docs/android-push.md documents)

    private val alertData =
        mapOf(
            "type" to "alert",
            "category" to "LOCAL_NEEDS_YOU",
            "title" to "Needs you · web",
            "subtitle" to "claude-code · mbp",
            "body" to "Waiting on a permission · Allow Bash(rm -rf)?",
            "url" to "optio://local/t1?compose=1",
            "kind" to "local",
            "id" to "t1",
            "threadId" to "t1",
            "sound" to "default",
            "timeSensitive" to "1",
            "collapseId" to "local-t1",
            "serverId" to "srv-1",
        )

    private val watchData =
        mapOf(
            "type" to "watch",
            "event" to "update",
            "state" to
                """{"phase":"waiting","head":{"kind":"local","id":"t1","title":"claude-code","mono":"web","reason":"Waiting on a permission",""" +
                """"preview":"Allow Bash(rm -rf)?","since":811339200,"state":"needs_you","link":"optio://local/t1?compose=1","source":"local-terminal",""" +
                """"when":"now","where":{"target":"machine","detail":"mbp · ~/repos/optio/apps/web"},"who":"claude-code","then":"waits-for-me",""" +
                """"statusLabel":"needs you"},"others":[],"needsYouCount":1,"runningCount":2,"waitingCount":1,"recurringCount":4,"agentCount":2,""" +
                """"offlineSince":null,"summary":null,"asOf":811339200}""",
            "serverId" to "srv-1",
        )

    @Test
    fun remoteMessageDataDecodesAsTheGeneratedUnion() {
        // Exactly what FirebaseMessagingService hands onMessageReceived.
        val alert = RemoteMessage.Builder("x@fcm.googleapis.com").setData(alertData).build()
        val decodedAlert = assertIs<AndroidPushAlert>(PushMessageHandler.decode(alert.data))
        assertEquals(PushAlertCategory.LOCAL_NEEDS_YOU, decodedAlert.category)
        assertEquals("1", decodedAlert.timeSensitive)
        assertEquals("srv-1", decodedAlert.serverId)
        val watch = RemoteMessage.Builder("x@fcm.googleapis.com").setData(watchData).build()
        val decodedWatch = assertIs<AndroidPushWatch>(PushMessageHandler.decode(watch.data))
        assertEquals(AndroidPushWatchEvent.UPDATE, decodedWatch.event)
        assertIs<AndroidPushMessage.Unknown>(PushMessageHandler.decode(mapOf("type" to "sticker")))
        assertNull(PushMessageHandler.decode(emptyMap()))
        assertNull(PushMessageHandler.decode(mapOf("type" to "alert", "title" to "no body")), "malformed")
    }

    @Test
    fun anAlertPostsAndAWatchFrameShowsTheWatch(): Unit =
        runBlocking {
            val watch = watchManager()
            val handler = PushMessageHandler(alerts, watch, scope)
            val alert = assertIs<PushMessageHandler.Result.Alert>(handler.handle(RemoteMessage.Builder("x").setData(alertData).build().data))
            assertTrue(alert.posted)
            val n = assertNotNull(GlanceTestEnv.notification(context, "local-t1", AlertNotifier.ALERT_ID))
            assertEquals("Needs you · web", title(n))
            assertEquals(listOf("Reply", "Later"), actions(n))
            assertEquals("optio://local/t1?compose=1&server=srv-1", url(n.contentIntent))

            val frame = assertIs<PushMessageHandler.Result.Watch>(handler.handle(RemoteMessage.Builder("x").setData(watchData).build().data))
            assertEquals(WatchManager.FrameResult.APPLIED, frame.result, "an update for a Watch not showing starts it")
            val w = assertNotNull(GlanceTestEnv.notification(context, null, WatchNotifier.WATCH_ID))
            assertEquals("1 session needs you", title(w))
            assertEquals("claude-code · needs you · Waiting on a permission", text(w))
            assertEquals(Instant.ofEpochSecond(811_339_200L + 978_307_200L), watch.display.value?.head?.since, "Apple seconds → unix")
            assertEquals(PushMessageHandler.Result.Malformed, handler.handle(mapOf("type" to "watch", "event" to "update", "state" to "{not json")))
        }

    @Test
    fun anAlertWithoutAServerFindsItsServer(): Unit =
        runBlocking {
            second.json("/api/local/terminals/t1", """{"terminal":{"id":"t1"}}""")
            val clients = listOf(GlanceTestEnv.client(server, "srv-1"), GlanceTestEnv.client(second, "srv-2"))
            val actions = handler(clients)
            val handler = PushMessageHandler(alerts, watchManager(clients), scope, resolveServer = actions::resolveServerId)
            handler.handle(alertData - "serverId")
            // The re-post with the resolved server lands shortly after.
            val deadline = System.currentTimeMillis() + 5_000
            var link: String? = null
            while (System.currentTimeMillis() < deadline) {
                link = url(GlanceTestEnv.notification(context, "local-t1", AlertNotifier.ALERT_ID)?.contentIntent)
                if (link?.contains("server=srv-2") == true) break
                Thread.sleep(50)
            }
            assertEquals("optio://local/t1?compose=1&server=srv-2", link, "probed: only the second server has the terminal")
        }

    // endregion

    // region Actions

    private fun handler(clients: List<ServerClient>): NotificationHandler =
        NotificationHandler(
            clients = { clients },
            resolve = { id -> clients.firstOrNull { it.server.id == id } ?: clients.firstOrNull() },
            store = store,
            sources = sources,
            alerts = alerts,
        )

    private fun target(
        kind: String,
        id: String,
        serverId: String? = "srv-1",
        category: NotificationCategory = NotificationCategory.LOCAL_NEEDS_YOU,
    ) = ActionTarget(ActionTarget.Source.ALERT, kind, id, serverId, url = "optio://local/$id", tag = "$kind-$id", category = category.raw, title = "Vesper")

    @Test
    fun replySendsTextAndEnterToATerminalAMessageToAnAgentOrATask(): Unit =
        runBlocking {
            server.post("/api/local/terminals/:id/input") { FakeResponse.json("""{"ok":true}""") }
            server.post("/api/persistent-agents/:id/messages") { FakeResponse.json("""{"message":{}}""", 201) }
            server.post("/api/tasks/:id/message") { FakeResponse.json("""{"accepted":true}""", 202) }
            val h = handler(listOf(GlanceTestEnv.client(server)))
            alerts.post(dev.optio.feature.glance.notifications.AlertSpec(NotificationCategory.LOCAL_NEEDS_YOU, "t", body = "b", url = "optio://local/t1", kind = "local", id = "t1", threadId = "t1", collapseId = "local-t1"))

            assertEquals(NotificationHandler.Outcome.DONE, h.perform(NotificationAction.REPLY, target("local", "t1"), "  yes  "))
            val input = server.lastRequest("POST", "/api/local/terminals/t1/input")!!
            assertEquals("yes\r", input.json.jsonObject["data"]!!.jsonPrimitive.content, "the text plus Enter (a carriage return)")
            assertNull(GlanceTestEnv.notification(context, "local-t1", AlertNotifier.ALERT_ID), "answered: the alert goes")

            assertEquals(NotificationHandler.Outcome.DONE, h.perform(NotificationAction.REPLY, target("agent", "a1", category = NotificationCategory.AGENT_REPLY), "ship it"))
            assertEquals("ship it", server.lastRequest("POST", "/api/persistent-agents/a1/messages")!!.json.jsonObject["body"]!!.jsonPrimitive.content)
            assertTrue("a1" in sources.recentAgentSends(), "the agent's next turn joins the Watch")
            val replied = assertNotNull(GlanceTestEnv.notification(context, "agent-a1", AlertNotifier.ALERT_ID), "the conversation shows the reply")
            val style = assertNotNull(androidx.core.app.NotificationCompat.MessagingStyle.extractMessagingStyleFromNotification(replied))
            assertEquals("ship it", style.messages.last().text.toString())
            assertNull(style.messages.last().person, "sent by the user")

            assertEquals(NotificationHandler.Outcome.DONE, h.perform(NotificationAction.REPLY, target("task", "k1"), "rebase please"))
            val msg = server.lastRequest("POST", "/api/tasks/k1/message")!!.json.jsonObject
            assertEquals("rebase please", msg["content"]!!.jsonPrimitive.content)
            assertEquals("soft", msg["mode"]!!.jsonPrimitive.content)

            assertEquals(NotificationHandler.Outcome.NOTHING_TO_DO, h.perform(NotificationAction.REPLY, target("local", "t1"), "   "))
        }

    @Test
    fun laterSnoozesOnTheServerAndHereResumeAndRetryCallTheirRoutes(): Unit =
        runBlocking {
            server.post("/api/local/terminals/:id/snooze") { FakeResponse.json("""{"terminal":{}}""") }
            server.post("/api/tasks/:id/resume") { FakeResponse.json("{}") }
            server.post("/api/tasks/:id/retry") { FakeResponse.json("{}") }
            server.post("/api/persistent-agents/:id/control") { FakeResponse.json("{}") }
            val h = handler(listOf(GlanceTestEnv.client(server)))

            assertEquals(NotificationHandler.Outcome.DONE, h.perform(NotificationAction.LATER, target("local", "t1")))
            assertEquals(15, server.lastRequest("POST", "/api/local/terminals/t1/snooze")!!.json.jsonObject["minutes"]!!.jsonPrimitive.content.toInt())
            assertNotNull(store.snoozedUntil("t1"), "mirrored locally so widgets agree at once")

            h.perform(NotificationAction.RESUME, target("task", "k1", category = NotificationCategory.TASK_ATTENTION))
            assertEquals("{}", server.lastRequest("POST", "/api/tasks/k1/resume")!!.body)
            h.perform(NotificationAction.RETRY, target("task", "k1", category = NotificationCategory.TASK_ATTENTION))
            assertNotNull(server.lastRequest("POST", "/api/tasks/k1/retry"))
            h.perform(NotificationAction.RESUME, target("agent", "a1", category = NotificationCategory.AGENT_FAILED))
            assertEquals("resume", server.lastRequest("POST", "/api/persistent-agents/a1/control")!!.json.jsonObject["intent"]!!.jsonPrimitive.content)
            assertEquals(NotificationHandler.Outcome.NOTHING_TO_DO, h.perform(NotificationAction.RETRY, target("agent", "a1")))
        }

    @Test
    fun withoutAServerIdTheServerThatHasTheSubjectIsUsed(): Unit =
        runBlocking {
            second.json("/api/tasks/k9", """{"task":{"id":"k9","state":"failed"}}""")
            second.post("/api/tasks/:id/retry") { FakeResponse.json("{}") }
            val h = handler(listOf(GlanceTestEnv.client(server, "srv-1"), GlanceTestEnv.client(second, "srv-2")))
            assertEquals("srv-2", h.resolveServerId("task", "k9"))
            assertEquals(NotificationHandler.Outcome.DONE, h.perform(NotificationAction.RETRY, target("task", "k9", serverId = null)))
            assertNotNull(second.lastRequest("POST", "/api/tasks/k9/retry"))
            assertNull(server.lastRequest("POST", "/api/tasks/k9/retry"))
            assertNull(handler(listOf(GlanceTestEnv.client(server))).resolveServerId("task", "k9"), "one server: nothing to disambiguate")
        }

    @Test
    fun aFailedReplySaysSo(): Unit =
        runBlocking {
            server.error("POST", "/api/local/terminals/:id/input", 409, "Terminal exited")
            val h = handler(listOf(GlanceTestEnv.client(server)))
            assertEquals(NotificationHandler.Outcome.FAILED, h.perform(NotificationAction.REPLY, target("local", "t1"), "hello"))
            assertEquals("Couldn't send your reply — tap to open", text(GlanceTestEnv.notification(context, "local-t1", AlertNotifier.ALERT_ID)!!))
        }

    // endregion

    // region Needs-you alerts (on-device baseline)

    @Test
    fun needsYouAlertsOncePerEpisodeAndSkipsPushingServers(): Unit =
        runBlocking {
            val notified = NotifiedStore.inMemory()
            var pushes = false
            val notifier = NeedsYouNotifier(alerts, notified) { pushes }
            val now = GlanceTestEnv.now
            val a = item("a", minutesAgo = 5)
            val b = item("b", minutesAgo = 1)
            val first = notifier.notifyNew("srv-1", NeedsYouSnapshot(needsYou = listOf(a, b), asOf = now), now)
            assertEquals(listOf("a", "b"), first.map { it.id }, "items not seen before, oldest first")
            assertEquals(listOf(true, false), first.map { it.audible }, "one sound per batch, and only when the queue was empty")
            assertTrue(notifier.notifyNew("srv-1", NeedsYouSnapshot(needsYou = listOf(a, b), asOf = now), now).isEmpty(), "seen")
            val c = item("c")
            val third = notifier.notifyNew("srv-1", NeedsYouSnapshot(needsYou = listOf(a, c), asOf = now), now)
            assertEquals(listOf("c"), third.map { it.id })
            assertEquals(false, third.single().audible, "the queue was not empty")
            // b left and comes back: a new episode.
            assertEquals(listOf("b"), notifier.notifyNew("srv-1", NeedsYouSnapshot(needsYou = listOf(a, c, b), asOf = now), now).map { it.id })
            // Snoozed items never alert (and count as seen).
            val snoozed = item("s", snoozedUntil = now.plusSeconds(600))
            assertTrue(notifier.notifyNew("srv-1", NeedsYouSnapshot(needsYou = listOf(snoozed), asOf = now), now).isEmpty())
            assertTrue(notifier.notifyNew("srv-1", NeedsYouSnapshot(needsYou = listOf(snoozed.copy(snoozedUntil = null)), asOf = now), now).isEmpty())
            // A server that pushes its own alerts is skipped, but its set is still tracked.
            pushes = true
            assertTrue(notifier.notifyNew("srv-2", NeedsYouSnapshot(needsYou = listOf(item("p", server = "srv-2")), asOf = now), now).isEmpty())
            pushes = false
            assertTrue(notifier.notifyNew("srv-2", NeedsYouSnapshot(needsYou = listOf(item("p", server = "srv-2")), asOf = now), now).isEmpty())
        }

    @Test
    fun localAlertsUseTheServersCopy() {
        val local = NeedsYouNotifier.spec(item("t1"), "srv-1")
        assertEquals(NotificationCategory.LOCAL_NEEDS_YOU, local.category)
        assertEquals("Needs you · web", local.title)
        assertEquals("claude-code · web", local.subtitle)
        assertEquals("Waiting on a permission · Allow Bash(pnpm test)? (y/n)", local.body)
        assertEquals("local-t1", local.collapseId)
        val task = NeedsYouNotifier.spec(item("k", kind = WatchItemKind.TASK, state = "failed", title = "Fix login", reason = "Tests failed"), "srv-1")
        assertEquals("Task failed", task.title)
        assertEquals("Fix login — Tests failed", task.body)
        assertEquals(NotificationCategory.TASK_ATTENTION, task.category)
        assertEquals("task-k", task.threadId)
        val agent = NeedsYouNotifier.spec(item("a", kind = WatchItemKind.AGENT, state = "failed", title = "Vesper", reason = "Turn failed — resume?"), null)
        assertEquals("Vesper stopped", agent.title)
        assertEquals("Too many failed turns — resume when ready", agent.body)
    }

    // endregion

    // region Registration

    private class FakeTokens(
        var availability: FcmAvailability = FcmAvailability.Available,
        var token: String = "fcm-token-" + "x".repeat(40),
    ) : FcmTokenSource {
        override fun availability() = availability

        override suspend fun token() = token
    }

    @Test
    fun registersWithEveryServerAndUnregistersFromAForgottenOne(): Unit =
        runBlocking {
            fun devices(fcm: Boolean) = """{"devices":[],"push":{"apns":false,"fcm":$fcm}}"""
            server.post("/api/notifications/devices") { FakeResponse.json(deviceJson("dev-1"), 201) }
            server.json("/api/notifications/devices", devices(fcm = true))
            second.post("/api/notifications/devices") { FakeResponse.json(deviceJson("dev-2"), 201) }
            second.json("/api/notifications/devices", devices(fcm = false))
            second.delete("/api/notifications/devices/:ref") { FakeResponse(status = 204) }
            val one = GlanceTestEnv.client(server, "srv-1")
            val two = GlanceTestEnv.client(second, "srv-2")
            var paired = listOf(one, two)
            val status = PushStatus.detached()
            status.update { it.copy(permission = NotificationPermissionState.GRANTED) }
            val registrar = PushRegistrar(context, scope, status, FakeTokens(), { paired }, MutableStateFlow(paired.map { it.server }))

            registrar.sync()
            val body = server.lastRequest("POST", "/api/notifications/devices")!!.json.jsonObject
            assertEquals("android", body["platform"]!!.jsonPrimitive.content)
            assertEquals(context.packageName, body["appId"]!!.jsonPrimitive.content)
            assertEquals("srv-1", body["serverId"]!!.jsonPrimitive.content, "pushes carry the profile id back")
            assertTrue(body["token"]!!.jsonPrimitive.content.startsWith("fcm-token-"))
            assertNotNull(body["deviceName"])
            assertNotNull(body["appVersion"])
            val state = status.state.value
            assertEquals(PushRegistration.REGISTERED, state.server("srv-1")!!.registration)
            assertEquals(true, state.server("srv-1")!!.serverCanPush)
            assertEquals("dev-1", state.server("srv-1")!!.deviceId)
            assertEquals(false, state.server("srv-2")!!.serverCanPush, "that server has no FCM credentials")
            assertEquals("fcm-to…xxxx", state.maskedToken)

            // Forget the second server: it gets a DELETE with the address and PAT it was registered under.
            paired = listOf(one)
            registrar.sync()
            val delete = assertNotNull(second.lastRequest("DELETE", "/api/notifications/devices/:ref"))
            assertTrue(delete.path.endsWith("/fcm-token-" + "x".repeat(40)))
            assertEquals("Bearer ${dev.optio.core.testing.FakeOptioServer.TEST_TOKEN}", delete.header("Authorization"))
            assertNull(status.state.value.server("srv-2"))
        }

    @Test
    fun noFirebaseOrNoPermissionMeansNoRegistration(): Unit =
        runBlocking {
            val one = GlanceTestEnv.client(server, "srv-1")
            val status = PushStatus.detached()
            status.update { it.copy(permission = NotificationPermissionState.GRANTED) }
            val tokens = FakeTokens(availability = FcmAvailability.NotConfigured)
            val registrar = PushRegistrar(context, scope, status, tokens, { listOf(one) }, MutableStateFlow(listOf(one.server)))
            registrar.sync()
            assertEquals(FcmAvailability.NotConfigured, status.state.value.fcm)
            assertEquals("Push needs a Firebase build", status.state.value.server("srv-1")!!.label(status.state.value))
            assertEquals(0, server.count("POST", "/api/notifications/devices"))

            tokens.availability = FcmAvailability.Available
            status.update { it.copy(permission = NotificationPermissionState.DENIED) }
            registrar.sync()
            assertEquals(0, server.count("POST", "/api/notifications/devices"), "a push the phone may not show is not registered")

            server.error("POST", "/api/notifications/devices", 404, "Not found")
            status.update { it.copy(permission = NotificationPermissionState.GRANTED) }
            registrar.sync()
            assertEquals(PushRegistration.UNSUPPORTED, status.state.value.server("srv-1")!!.registration, "an older server")
        }

    @Test
    fun turningNotificationsOffWithdrawsTheToken(): Unit =
        runBlocking {
            server.post("/api/notifications/devices") { FakeResponse.json(deviceJson("dev-1"), 201) }
            server.json("/api/notifications/devices", """{"devices":[],"push":{"apns":false,"fcm":true}}""")
            server.delete("/api/notifications/devices/:ref") { FakeResponse(status = 204) }
            val one = GlanceTestEnv.client(server, "srv-1")
            val status = PushStatus.detached()
            status.update { it.copy(permission = NotificationPermissionState.GRANTED) }
            val registrar = PushRegistrar(context, scope, status, FakeTokens(), { listOf(one) }, MutableStateFlow(listOf(one.server)))
            registrar.sync()
            assertTrue(status.state.value.server("srv-1")!!.receivesPush)
            registrar.withdraw()
            assertTrue(server.lastRequest("DELETE", "/api/notifications/devices/:ref")!!.path.endsWith("x".repeat(40)))
            assertEquals(PushRegistration.IDLE, status.state.value.server("srv-1")!!.registration)
        }

    private fun deviceJson(id: String) =
        """{"device":{"id":"$id","token":"fcm-to…xxxx","platform":"android","appId":"dev.optio.android","failureCount":0,"lastSeenAt":"2026-09-22T16:40:00Z","createdAt":"2026-09-22T16:40:00Z"}}"""

    // endregion

    private fun watchManager(clients: List<ServerClient> = listOf(GlanceTestEnv.client(server))) =
        WatchManager(
            scope = scope,
            host = WatchManager.fixedHost(clients),
            sources = sources,
            glanceStore = store,
            store = WatchStore.inMemory(),
            notifier = WatchNotifier(context),
            needsYou = NeedsYouNotifier(alerts, NotifiedStore.inMemory()),
        )
}
