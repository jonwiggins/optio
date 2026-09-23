package dev.optio.feature.more

import dev.optio.core.data.ServerColor
import dev.optio.core.data.ServerProfile
import dev.optio.core.glance.FcmAvailability
import dev.optio.core.glance.PushRegistration
import dev.optio.core.glance.PushState
import dev.optio.core.glance.ServerPushState
import dev.optio.core.model.OptioJson
import dev.optio.core.network.ApiError
import dev.optio.core.ui.theme.Tone
import dev.optio.feature.more.api.OptioSettingsRow
import dev.optio.feature.more.api.PushDeviceRow
import dev.optio.feature.more.api.RepoRef
import dev.optio.feature.more.api.SecretCreateResult
import dev.optio.feature.more.api.SecretRow
import dev.optio.feature.more.api.WebhookDeliveryRow
import dev.optio.feature.more.api.WorkspaceRow
import dev.optio.feature.more.secrets.SecretsData
import dev.optio.feature.more.secrets.normalizeSecrets
import dev.optio.feature.more.secrets.saveNotice
import dev.optio.feature.more.secrets.scopeFilters
import dev.optio.feature.more.secrets.secretScopes
import dev.optio.feature.more.servers.ServerDraft
import dev.optio.feature.more.settings.AgentSettingsForm
import dev.optio.feature.more.settings.AppIconOption
import dev.optio.feature.more.settings.NotificationEvents
import dev.optio.feature.more.settings.fcmLabel
import dev.optio.feature.more.settings.isThisPhone
import dev.optio.feature.more.settings.registrationShort
import dev.optio.feature.more.settings.serverPushLabel
import dev.optio.feature.more.ui.MoreAgentTypes
import dev.optio.feature.more.ui.MoreWebhookEvents
import dev.optio.feature.more.ui.moreErrorText
import dev.optio.feature.more.webhooks.WebhookDraft
import dev.optio.feature.more.webhooks.deliveryNotice
import dev.optio.feature.more.webhooks.eventsSummary
import dev.optio.feature.more.webhooks.prettyJson
import dev.optio.feature.more.webhooks.successRate
import dev.optio.feature.more.workspace.WorkspaceForm
import dev.optio.feature.more.workspace.slugify
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive

/** The More tab's pure logic: copy, form bodies, filters, and gating helpers. */
class MoreLogicTest {
    @Test
    fun slugifyMatchesIos() {
        // iOS CreateWorkspaceSheet.slugify (the same vectors as WorkFormModelTests).
        assertEquals("release-manager", slugify("Release Manager!"))
        assertEquals("session-12", slugify("Session 12"))
        assertEquals("n-code-name", slugify("  --Ünïcode__name  "))
        assertEquals("android-devlab", slugify("Android DevLab"))
        assertEquals("", slugify("—"))
        assertEquals(50, slugify("a".repeat(50)).length, "no length cap here (the API caps at 50)")
    }

    @Test
    fun agentSettingsBodyClearsReviewDefaultsAndOmitsEmptyTools() {
        val body = AgentSettingsForm(model = "opus", maxTurns = 30).body().jsonObject
        assertEquals("opus", body["model"]?.jsonPrimitive?.content)
        assertEquals(30, body["maxTurns"]?.jsonPrimitive?.content?.toInt())
        assertEquals(JsonNull, body["defaultReviewAgentType"], "No preference clears it")
        assertEquals(JsonNull, body["defaultReviewModel"])
        assertFalse("enabledTools" in body, "the route rejects an empty list")

        val set = AgentSettingsForm(enabledTools = listOf("list_tasks"), reviewAgentType = "codex", reviewModel = " gpt-5 ").body().jsonObject
        assertEquals("codex", set["defaultReviewAgentType"]?.jsonPrimitive?.content)
        assertEquals("gpt-5", set["defaultReviewModel"]?.jsonPrimitive?.content)
        assertEquals(1, (set["enabledTools"] as JsonArray).size)
    }

    @Test
    fun agentSettingsClampMaxTurns() {
        val row = OptioJson.decodeFromString<OptioSettingsRow>("""{"maxTurns":99,"model":"haiku"}""")
        assertEquals(50, AgentSettingsForm.of(row).maxTurns)
        assertEquals("haiku", AgentSettingsForm.of(row).model)
    }

    @Test
    fun secretsNormalizeAndScopes() {
        val rows = listOf(
            SecretRow(id = "1", name = "A", scope = "user"),
            SecretRow(id = "2", name = "B", scope = "https://github.com/o/r"),
            SecretRow(id = "1", name = "A", scope = "user"),
            SecretRow(name = "C"),
        )
        assertEquals(listOf("A", "B", "C"), normalizeSecrets(rows, "all").map { it.name })
        assertEquals(listOf("C"), normalizeSecrets(rows, "global").map { it.name }, "a scope-less row is global")
        assertEquals(listOf("A"), normalizeSecrets(rows, "user").map { it.name })
        assertEquals("C@global", rows[3].listId)

        val repos = listOf(RepoRef("r1", "https://github.com/o/r", "o/r"), RepoRef("r2", null, "no-url"))
        val data = SecretsData(rows, repos)
        assertEquals("Global", data.scopeLabel(null))
        assertEquals("User-only", data.scopeLabel("user"))
        assertEquals("o/r", data.scopeLabel("https://github.com/o/r"))
        assertEquals("https://x/y", data.scopeLabel("https://x/y"))

        assertEquals(listOf("all", "global", "user", "https://github.com/o/r"), scopeFilters(repos).map { it.first })
        assertEquals(listOf("global", "user", "https://github.com/o/r"), secretScopes(repos, allowGlobal = true).map { it.first })
        assertEquals(listOf("user"), secretScopes(repos, allowGlobal = false).map { it.first }, "members store only their own secrets")
    }

    @Test
    fun secretSaveNotices() {
        assertEquals("GITHUB_TOKEN has been encrypted and stored." to Tone.SUCCESS, saveNotice(SecretCreateResult("GITHUB_TOKEN", "global")))
        val failed = saveNotice(SecretCreateResult("ANTHROPIC_API_KEY", "global", SecretCreateResult.Validation(false, "API key is invalid")))
        assertEquals("Saved, but validation failed: API key is invalid" to Tone.ACCENT, failed)
        assertEquals(
            "Saved, but validation failed: token rejected",
            saveNotice(SecretCreateResult("X", validation = SecretCreateResult.Validation(false))).first,
        )
    }

    @Test
    fun webhookHelpers() {
        assertNull(eventsSummary(emptyList()))
        assertEquals("a · b · c", eventsSummary(listOf("a", "b", "c")))
        assertEquals("a · b · c +2", eventsSummary(listOf("a", "b", "c", "d", "e")))

        val ok = WebhookDeliveryRow(id = "1", success = true, statusCode = 200)
        val bad = WebhookDeliveryRow(id = "2", success = false, error = "fetch failed")
        val http = WebhookDeliveryRow(id = "3", success = false, statusCode = 500)
        assertNull(successRate(emptyList()))
        assertEquals(33, successRate(listOf(ok, bad, http)))
        assertEquals("Delivered (HTTP 200)" to Tone.SUCCESS, deliveryNotice(ok))
        assertEquals("Failed: fetch failed" to Tone.DANGER, deliveryNotice(bad))
        assertEquals("Failed: HTTP 500", deliveryNotice(http).first)
        assertEquals("Failed: HTTP ?", deliveryNotice(WebhookDeliveryRow(id = "4")).first)

        val payload = OptioJson.parseToJsonElement("""{"b":1,"a":{"d":2,"c":3}}""")
        assertEquals("{\n  \"a\": {\n    \"c\": 3,\n    \"d\": 2\n  },\n  \"b\": 1\n}", prettyJson(payload))
    }

    @Test
    fun webhookDraftBuildsTheBodyInCatalogueOrder() {
        val draft = WebhookDraft(url = " https://hooks.example.com/x ", description = "  ", events = setOf("workflow_run.failed", "task.completed"))
        assertTrue(draft.canSave())
        val input = draft.input(secret = "")
        assertEquals("https://hooks.example.com/x", input.url)
        assertEquals(listOf("task.completed", "workflow_run.failed"), input.events)
        assertNull(input.secret)
        assertNull(input.description)
        assertEquals("s3cret", draft.input("s3cret").secret)
        assertFalse(WebhookDraft(url = "https://x", events = emptySet()).canSave())
        assertFalse(WebhookDraft(url = " ").canSave())
        assertEquals(setOf("workflow_run.completed"), WebhookDraft().events, "iOS default selection")
        assertEquals(9, MoreWebhookEvents.all.size)
    }

    @Test
    fun workspaceFormDirtiness() {
        val ws = WorkspaceRow(id = "w", name = "A", slug = "a", description = null)
        val form = WorkspaceForm.of(ws)
        assertFalse(form.isDirty(ws))
        assertTrue(form.copy(description = "x").isDirty(ws))
        assertTrue(form.copy(slug = "b").isDirty(ws))
    }

    @Test
    fun errorCopy() {
        assertEquals(
            "You don't have permission to do that. Forbidden: requires admin role",
            moreErrorText(ApiError(403, "Forbidden: requires admin role")),
        )
        assertEquals("URL must not target private or internal addresses", moreErrorText(ApiError(400, "URL must not target private or internal addresses")))
        assertEquals("Something went wrong — the server hit an error.", moreErrorText(ApiError(500, "boom")))
        assertEquals("User not found", moreErrorText(ApiError(404, "User not found")))
        assertEquals("User is already a member of this workspace", moreErrorText(ApiError(409, "User is already a member of this workspace")))
        assertEquals("Your access token was rejected. Sign in again.", moreErrorText(ApiError(401, "Not authenticated")))
    }

    @Test
    fun agentTypesAndEvents() {
        assertEquals("OpenAI Codex", MoreAgentTypes.label("codex"))
        assertEquals("openclaw", MoreAgentTypes.label("openclaw"))
        assertEquals(7, NotificationEvents.task.size)
        assertEquals(listOf("local.needs_you", "local.host_offline", "agent.turn_completed", "agent.failed"), NotificationEvents.native.map { it.key })
    }

    @Test
    fun serverDraftNormalisesLikeSignIn() {
        val profile = ServerProfile(id = "s", name = "Laptop", url = "http://laptop.tail.ts.net:30400", color = ServerColor.SLATE)
        val edited = ServerDraft.of(profile).copy(name = "  ", urlText = "studio.tail.ts.net", color = ServerColor.TEAL, workspaceId = "ws-2").applyTo(profile)
        assertEquals("https://studio.tail.ts.net", edited.url)
        assertEquals("studio", edited.name, "an empty name falls back to the host's first label")
        assertEquals(ServerColor.TEAL, edited.color)
        assertEquals("ws-2", edited.workspaceId)
        assertNull(ServerDraft.of(profile).copy(urlText = "  ").editedUrl)
        assertEquals("s", edited.id)
    }

    @Test
    fun appIconAliasesMatchTheManifest() {
        assertEquals(
            listOf(
                "dev.optio.app.LauncherDefault",
                "dev.optio.app.LauncherMidnight",
                "dev.optio.app.LauncherTerminal",
                "dev.optio.app.LauncherBlueprint",
                "dev.optio.app.LauncherSticker",
                "dev.optio.app.LauncherRetro",
                "dev.optio.app.LauncherSunrise",
                "dev.optio.app.LauncherChip",
            ),
            AppIconOption.entries.map { it.alias },
        )
        assertEquals(listOf(AppIconOption.DEFAULT), AppIconOption.entries.filter { it.enabledByDefault })
        assertEquals(AppIconOption.RETRO, AppIconOption.fromSlug("retro"))
    }

    @Test
    fun pushLabels() {
        assertEquals("Available", fcmLabel(FcmAvailability.Available))
        assertEquals("Not in this build", fcmLabel(FcmAvailability.NotConfigured))
        assertEquals("Unavailable: no Play services", fcmLabel(FcmAvailability.Unavailable("no Play services")))
        assertEquals("Registered", registrationShort(PushRegistration.REGISTERED, true))
        assertEquals("Registered · no FCM", registrationShort(PushRegistration.REGISTERED, false))
        assertEquals("Not registered", registrationShort(null, null))
        assertEquals("Android and iPhone", serverPushLabel(apns = true, fcm = true))
        assertEquals("Not configured", serverPushLabel(apns = false, fcm = false))
    }

    @Test
    fun thisPhoneMatchesByRegisteredIdOrMaskedToken() {
        val token = "fake-a8-instance:APA91bFakeTokenForFixturesOnly_0123456789abcdef"
        val state = PushState(token = token, servers = mapOf("dev-server" to ServerPushState("dev-server", PushRegistration.REGISTERED, deviceId = "row-1")))
        assertTrue(state.isThisPhone(PushDeviceRow(id = "row-1", platform = "android")))
        assertTrue(state.isThisPhone(PushDeviceRow(id = "other", token = "fake-a…cdef", platform = "android")))
        assertFalse(state.isThisPhone(PushDeviceRow(id = "row-1", platform = "ios")), "an iPhone is never this phone")
        assertFalse(PushState().isThisPhone(PushDeviceRow(id = "x", token = "abcdef…1234", platform = "android")))
    }
}
