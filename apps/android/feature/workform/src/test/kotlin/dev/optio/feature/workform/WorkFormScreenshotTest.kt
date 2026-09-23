package dev.optio.feature.workform

import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import dev.optio.core.model.LocalHost
import dev.optio.core.model.OptioJson
import dev.optio.core.network.ApiClient
import dev.optio.core.testing.Fixtures
import dev.optio.core.testing.Samples
import dev.optio.core.testing.ScreenSize
import dev.optio.core.testing.ScreenshotTest
import dev.optio.core.testing.captureScreens
import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonObject
import org.junit.Test

/**
 * The form in its main states, light and dark, from fixtures captured on the private test API
 * (`./gradlew :feature:workform:recordRoborazziDebug` writes
 * `feature/workform/build/outputs/roborazzi/WorkForm_*.png`).
 */
class WorkFormScreenshotTest : ScreenshotTest() {
    private val sampleRepos: List<FormRepo> =
        (Fixtures.json("workform-repos.json").jsonObject["repos"] as JsonArray).mapNotNull { FormRepo.from(it.jsonObject) }

    private val hosts: List<LocalHost> =
        OptioJson.decodeFromJsonElement(ListSerializer(LocalHost.serializer()), Fixtures.json("workform-local-hosts.json").jsonObject["hosts"]!!)

    private val sampleTemplates: List<PromptTemplateRow> =
        OptioJson.decodeFromJsonElement(ListSerializer(PromptTemplateRow.serializer()), Fixtures.json("workform-prompt-templates.json").jsonObject["templates"]!!)

    private val tasks: List<DependencyTaskRow> =
        OptioJson.decodeFromJsonElement(ListSerializer(DependencyTaskRow.serializer()), Fixtures.json("workform-tasks.json").jsonObject["tasks"]!!)

    private val sampleCatalogs: Map<String, CatalogState> = listOf("anthropic", "openai", "opencode", "gemini").associateWith {
        CatalogState.Loaded(Fixtures.decode<ProviderOptionsResponse>("workform-options-$it.json").catalog)
    }

    /** An online machine next to the seeded offline one. */
    private val online = Samples.localHost(name = "Jon's MacBook Pro")

    @Composable
    private fun Form(
        preset: String? = null,
        edit: EditTarget? = null,
        hosts: List<LocalHost> = this.hosts,
        setup: WorkFormState.() -> Unit = {},
    ) {
        val scope = rememberCoroutineScope()
        val state = remember {
            WorkFormState(ApiClient(), scope, presetId = preset, edit = edit, clock = Samples.clock).apply {
                preload(repos = sampleRepos, hosts = hosts, templates = sampleTemplates, existingTasks = tasks, workCount = 13, catalogs = sampleCatalogs)
                setup()
            }
        }
        WorkFormScreen(state = state, onClose = {}, onCreated = {})
    }

    @Test
    fun openAPr() = captureScreens("WorkForm_pr", size = ScreenSize.TALL) { Form() }

    @Test
    fun openAPrReady() = captureScreens("WorkForm_pr_ready") {
        Form { setPrompt("Fix the flaky login test. The race is in the session refresh."); setName("Fix flaky login") }
    }

    @Test
    fun interactiveChatOnAMachine() = captureScreens("WorkForm_chat_machine", size = ScreenSize.TALL) { Form(preset = "chat") }

    @Test
    fun terminalOnAnOnlineMachine() = captureScreens("WorkForm_terminal", size = ScreenSize.TALL) {
        Form(preset = "terminal", hosts = listOf(online) + hosts)
    }

    @Test
    fun scheduledRun() = captureScreens("WorkForm_schedule", size = ScreenSize.TALL) {
        Form(preset = "schedule") { setPrompt("Summarize yesterday's Sentry alerts and post the digest to #ops.") }
    }

    @Test
    fun persistentAgent() = captureScreens("WorkForm_agent", size = ScreenSize.TALL) {
        Form(preset = "agent") { setName("Release Captain 2"); setPrompt("You run releases: cut the branch, write notes, ping #releases.") }
    }

    @Test
    fun githubEventNeedsYou() = captureScreens("WorkForm_github_gap", size = ScreenSize.TALL) {
        Form(preset = "chat") {
            setWhen(WhenType.GITHUB)
            setPrompt("Review {{url}} with me")
        }
    }

    @Test
    fun slackJobNeedsAChannel() = captureScreens("WorkForm_slack_gap", size = ScreenSize.TALL) {
        Form(preset = "schedule") {
            setWhen(WhenType.SLACK)
            setEventField("channelId", JsonPrimitive("general"))
        }
    }

    @Test
    fun linearOnANewBranch() = captureScreens("WorkForm_linear_branch", size = ScreenSize.TALL) {
        Form {
            setWhen(WhenType.LINEAR)
            setWhere(Where.LOCAL)
            setWithRepo(true)
            setEventField("user", JsonPrimitive("Ada Lovelace"))
            setEventField("teams", JsonArray(listOf(JsonPrimitive("ENG"))))
            setPrompt("We were assigned {{ticketUrl}}. Triage it.")
            setRunName("Triage: {{ticketTitle}}")
        }
    }

    @Test
    fun ticketJobWithLabelsAndParams() = captureScreens("WorkForm_ticket", size = ScreenSize.TALL) {
        Form(preset = "schedule") {
            setWhen(WhenType.TICKET)
            addTicketLabel("bug")
            addTicketLabel("triage")
            setPrompt("Triage {{ticketUrl}}")
        }
    }

    @Test
    fun moreOptionsOpen() = captureScreens(
        "WorkForm_more",
        size = ScreenSize.TALL,
        interact = { onNodeWithTag("work-form-more-toggle").performScrollTo() },
    ) {
        Form {
            setPrompt("Bump the minor versions and fix what breaks.")
            setDescription("Keeps the lockfile fresh between releases.")
            toggleDependency(tasks.first { it.state == "queued" }.id)
            more = true
        }
    }

    @Test
    fun noPairedMachine() = captureScreens("WorkForm_no_machine", interact = { onNodeWithTag("work-form-where").performScrollTo() }) {
        Form(hosts = emptyList())
    }

    @Test
    fun runtimeMenuOnAMachine() = captureScreens(
        "WorkForm_runtime_menu",
        size = ScreenSize.TALL,
        wholeScreen = true,
        interact = { onNodeWithTag("work-form-runtime").performClick() },
    ) {
        Form(preset = "chat")
    }

    @Test
    fun dependenciesSheet() = captureScreens("WorkForm_deps", wholeScreen = true) {
        Form {
            setPrompt("Document the config loader cleanup.")
            toggleDependency(tasks.first { it.state == "queued" }.id)
            showDeps = true
        }
    }

    @Test
    fun editAScheduledJob() = captureScreens("WorkForm_edit_job", size = ScreenSize.TALL) {
        val row = Fixtures.json("workform-get-job.json").jsonObject["task"]!!.jsonObject
        val trigger = (Fixtures.json("workform-job-triggers.json").jsonObject["triggers"] as JsonArray)[0].jsonObject
        val target = EditTarget(row.text("id"), EditableKind.STANDALONE, row, trigger, listOf(trigger), draftFromRow(EditableKind.STANDALONE, row, trigger))
        Form(edit = target)
    }
}
