package dev.optio.feature.workform

import kotlin.random.Random
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import org.junit.Test

/**
 * Ports `apps/ios/OptioTests/WorkFormModelTests.swift` case for case, and the vectors of
 * `apps/web/src/components/work-form/model.test.ts` (the reference: where the web moved on since
 * the iOS port, e.g. event triggers now need "you", the web's rule wins and the case says so).
 */
class WorkFormModelTest {
    private val empty = WorkDraft.EMPTY

    private fun local(d: WorkDraft, dir: String = "/Users/dev/repos/app"): WorkDraft =
        d.copy(location = d.location.copy(runTarget = Where.LOCAL, localHostId = "h1", localDir = dir))

    private fun text(d: WorkDraft, ctx: SentenceContext = SentenceContext()): String = sentenceText(describe(d, ctx))

    private fun <T> enabled(choices: List<Choice<T>>): List<T> = choices.filter { it.isEnabled }.map { it.value }

    private val base = empty.copy(prompt = "p")

    /** A GitHub event about "you" with the login filled in, so the sentence has no identity gap. */
    private fun githubAs(d: WorkDraft, login: String = "octocat"): WorkDraft =
        d.copy(event = EventTrigger(EventTriggerType.GITHUB, defaultEventConfig(EventTriggerType.GITHUB).with("login", JsonPrimitive(login))))

    // region deriveKind: every kind is a point in the attribute space

    @Test
    fun exitsPodRepo() {
        assertEquals(WorkKind.REPO_TASK, deriveKind(base))
        assertEquals(WorkKind.REPO_BLUEPRINT, deriveKind(base.copy(whenType = WhenType.SCHEDULE)))
    }

    @Test
    fun exitsNoRepoOrCurrentDirectory() {
        assertEquals(WorkKind.STANDALONE, deriveKind(base.copy(withRepo = false)))
        assertEquals(WorkKind.STANDALONE, deriveKind(base.copy(withRepo = false, whenType = WhenType.WEBHOOK)))
        assertEquals(WorkKind.STANDALONE, deriveKind(local(base.copy(withRepo = false, whenType = WhenType.SCHEDULE))))
    }

    @Test
    fun exitsMachineNewBranchOpensPr() {
        assertEquals(WorkKind.REPO_TASK, deriveKind(local(base.copy(withRepo = true))))
    }

    @Test
    fun eventTriggerIsAWhenLikeAnyOther() {
        // Pod + repo + GitHub event → a scheduled Task; no repo → a Job.
        assertEquals(WorkKind.REPO_BLUEPRINT, deriveKind(base.copy(whenType = WhenType.GITHUB)))
        assertEquals(WorkKind.STANDALONE, deriveKind(base.copy(whenType = WhenType.SLACK, withRepo = false)))
        // Machine + branch + Linear event → a scheduled Task that runs in the checkout.
        assertEquals(WorkKind.REPO_BLUEPRINT, deriveKind(local(base.copy(whenType = WhenType.LINEAR))))
        // Only an interactive automation on a machine is a Local automation.
        assertEquals(WorkKind.LOCAL_BLUEPRINT, deriveKind(local(base.copy(whenType = WhenType.GITHUB, then = Then.WAITS_FOR_ME))))
    }

    @Test
    fun waitsForMe() {
        assertEquals(WorkKind.LOCAL_TERMINAL, deriveKind(local(base.copy(then = Then.WAITS_FOR_ME))))
        assertEquals(WorkKind.LOCAL_BLUEPRINT, deriveKind(local(base.copy(then = Then.WAITS_FOR_ME, whenType = WhenType.SLACK))))
        assertEquals(WorkKind.POD_SESSION, deriveKind(base.copy(then = Then.WAITS_FOR_ME)))
    }

    @Test
    fun persistentAgent() {
        assertEquals(WorkKind.PERSISTENT_AGENT, deriveKind(base.copy(then = Then.WAITS_FOR_MESSAGES, withRepo = false)))
    }

    // endregion

    // region Constraints flow downstream

    @Test
    fun everyTriggerWorksWithEveryWhere() {
        for (w in WhenType.entries) {
            assertEquals(listOf(Where.CLUSTER, Where.LOCAL), enabled(whereOptions(empty.copy(whenType = w))), "$w")
        }
        assertEquals(Where.CLUSTER, normalize(empty.copy(whenType = WhenType.LINEAR)).location.runTarget)
    }

    @Test
    fun machineOffersTerminalAndOnlyDaemonClis() {
        val opts = runtimeOptions(local(empty.copy(withRepo = false)))
        assertTrue(TERMINAL in enabled(opts))
        assertFalse("copilot" in enabled(opts))
        assertEquals("claude-code", normalize(local(empty.copy(runtime = "copilot"))).runtime)
    }

    @Test
    fun podTerminalNeedsRepoAndIsOpenedByHand() {
        assertFalse(TERMINAL in enabled(runtimeOptions(empty.copy(withRepo = false))))
        assertFalse(TERMINAL in enabled(runtimeOptions(empty.copy(whenType = WhenType.SCHEDULE))))
        assertTrue(TERMINAL in enabled(runtimeOptions(empty)))
    }

    /** model.test.ts: "a trigger never starts a bare terminal, on a pod or a machine". */
    @Test
    fun triggerNeverStartsABareTerminal() {
        assertFalse(TERMINAL in enabled(runtimeOptions(local(empty.copy(whenType = WhenType.SCHEDULE)))))
        assertFalse(TERMINAL in enabled(runtimeOptions(local(empty.copy(whenType = WhenType.SLACK)))))
        assertEquals("claude-code", normalize(local(empty.copy(whenType = WhenType.SCHEDULE, runtime = TERMINAL))).runtime)
        assertEquals(
            "A trigger starts an agent — a terminal is opened by hand, pick Now above.",
            runtimeOptions(local(empty.copy(whenType = WhenType.SCHEDULE))).first { it.value == TERMINAL }.disabled,
        )
    }

    @Test
    fun terminalWithNoAgentWaitsForYou() {
        val d = normalize(local(empty.copy(withRepo = false, runtime = TERMINAL)))
        assertEquals(listOf(Then.WAITS_FOR_ME), enabled(thenOptions(d)))
        assertEquals(Then.WAITS_FOR_ME, d.then)
        assertEquals(LocalSessionMode.INTERACTIVE, d.location.localSessionMode)
    }

    @Test
    fun persistentAgentLivesInPodNoRepoNotOnEvents() {
        assertFalse(Then.WAITS_FOR_MESSAGES in enabled(thenOptions(local(empty))))
        assertFalse(Then.WAITS_FOR_MESSAGES in enabled(thenOptions(empty)))
        assertTrue(Then.WAITS_FOR_MESSAGES in enabled(thenOptions(empty.copy(withRepo = false))))
        val flipped = normalize(local(empty.copy(withRepo = false, then = Then.WAITS_FOR_MESSAGES)))
        assertEquals(Then.EXITS, flipped.then)
    }

    /** model.test.ts: "a pod session chats with Claude Code, so other runtimes can't wait for you there". */
    @Test
    fun podSessionChatsWithClaudeCode() {
        assertFalse(Then.WAITS_FOR_ME in enabled(thenOptions(empty.copy(runtime = "codex"))))
        assertTrue(Then.WAITS_FOR_ME in enabled(thenOptions(empty.copy(runtime = "claude-code"))))
        assertTrue(Then.WAITS_FOR_ME in enabled(thenOptions(empty.copy(runtime = TERMINAL))))
        // On a machine any launchable CLI can wait for you.
        assertTrue(Then.WAITS_FOR_ME in enabled(thenOptions(local(empty.copy(runtime = "codex")))))
    }

    @Test
    fun switchingRuntimesClearsPreviousOptions() {
        val d = normalize(local(empty.copy(runtime = "copilot", agentOptions = mapOf("copilotModel" to OptionValue.Str("x")))))
        assertEquals(emptyMap(), d.agentOptions)
    }

    // endregion

    // region The sentence

    @Test
    fun leadsWithTriggerForPrTask() {
        val d = empty.copy(repoUrl = "https://github.com/acme/app")
        assertEquals(
            "Started now, a Claude Code run in an Optio pod with acme/app that opens a PR and exits when done.",
            text(d, SentenceContext(repoName = "acme/app")),
        )
    }

    @Test
    fun namesMachineAndDirectoryForLocalTerminal() {
        val d = normalize(local(empty.copy(then = Then.WAITS_FOR_ME, withRepo = false), dir = "/Users/dev/notes"))
        assertEquals(
            "Opened now, a Claude Code session on M1 in ~/notes that waits for you between turns.",
            text(d, SentenceContext(machineName = "M1")),
        )
        val branch = normalize(local(empty.copy(withRepo = true)))
        assertTrue("on a new branch in ~/repos/app that opens a PR" in text(branch))
    }

    @Test
    fun describesSchedulesAndMarksMissing() {
        val d = normalize(
            empty.copy(
                withRepo = false,
                whenType = WhenType.SCHEDULE,
                trigger = TriggerConfig(type = TriggerType.SCHEDULE, cronExpression = "0 9 * * 1-5"),
            ),
        )
        assertEquals("Running weekdays at 09:00 UTC, a Claude Code run in an Optio pod that exits when done.", text(d))
        assertEquals(listOf(SentenceField.PROMPT), missingFields(d))
        val bad = d.copy(trigger = TriggerConfig(type = TriggerType.SCHEDULE, cronExpression = "nope"))
        assertTrue("[on a schedule]" in text(bad))
        assertEquals(listOf(SentenceField.CRON, SentenceField.PROMPT), missingFields(bad))
    }

    @Test
    fun unknownCronReadsAsCode() {
        val d = empty.copy(withRepo = false, whenType = WhenType.SCHEDULE, trigger = TriggerConfig(TriggerType.SCHEDULE, cronExpression = "*/5 * * * *"))
        assertTrue(text(d).startsWith("Running on `*/5 * * * *`,"))
    }

    /** model.test.ts: "an event trigger about you needs your login, a Slack one a channel id". */
    @Test
    fun eventTriggerAboutYouNeedsLoginSlackNeedsChannel() {
        fun gh(extra: Map<String, kotlinx.serialization.json.JsonElement>) =
            eventGaps(EventTrigger(EventTriggerType.GITHUB, JsonObject(mapOf("events" to jsonArrayOf("review_requested")) + extra)))
        assertEquals(listOf(SentenceField.IDENTITY), gh(mapOf("login" to JsonPrimitive(""))))
        assertEquals(emptyList(), gh(mapOf("login" to JsonPrimitive("octocat"))))
        assertEquals(
            emptyList(),
            eventGaps(EventTrigger(EventTriggerType.GITHUB, jsonObjectOf("events" to jsonArrayOf("pr_opened"), "login" to JsonPrimitive("")))),
        )
        assertEquals(
            listOf(SentenceField.IDENTITY),
            eventGaps(EventTrigger(EventTriggerType.LINEAR, jsonObjectOf("events" to jsonArrayOf("assigned"), "user" to JsonPrimitive("")))),
        )
        assertEquals(
            listOf(SentenceField.EVENTS),
            eventGaps(EventTrigger(EventTriggerType.GITHUB, jsonObjectOf("events" to jsonArrayOf(), "login" to JsonPrimitive("octocat")))),
        )
        assertEquals(listOf(SentenceField.CHANNEL), eventGaps(EventTrigger(EventTriggerType.SLACK, jsonObjectOf("channelId" to JsonPrimitive("general")))))
        assertEquals(emptyList(), eventGaps(EventTrigger(EventTriggerType.SLACK, jsonObjectOf("channelId" to JsonPrimitive("C0123ABCD")))))
        // The sentence carries the gap, so the form can't submit.
        val d = normalize(
            empty.copy(
                whenType = WhenType.GITHUB,
                prompt = "p",
                event = EventTrigger(EventTriggerType.GITHUB, jsonObjectOf("events" to jsonArrayOf("mentioned"), "login" to JsonPrimitive(""))),
            ),
        )
        assertTrue("[about you]" in text(local(d)))
        assertTrue(SentenceField.IDENTITY in missingFields(local(d)))
        // Slack and "no kinds" gaps read as their own words.
        val slack = normalize(empty.copy(whenType = WhenType.SLACK, withRepo = false, event = EventTrigger.default(EventTriggerType.SLACK)))
        assertTrue(text(slack).startsWith("Started by Slack messages [in a channel],"))
        val none = normalize(
            empty.copy(
                whenType = WhenType.LINEAR,
                withRepo = false,
                event = EventTrigger(EventTriggerType.LINEAR, jsonObjectOf("events" to jsonArrayOf(), "user" to JsonPrimitive("ada"))),
            ),
        )
        assertTrue(text(none).startsWith("Started by Linear events [of some kind],"))
    }

    /** model.test.ts: "a shell terminal on a machine never claims a new branch". */
    @Test
    fun shellTerminalOnMachineNeverClaimsNewBranch() {
        val d = normalize(local(empty.copy(withRepo = true, runtime = TERMINAL)))
        assertTrue("a terminal on my machine in ~/repos/app" in text(d))
        assertFalse("new branch" in text(d))
    }

    @Test
    fun noPromptDemandedForHandOpenedTerminal() {
        assertEquals(emptyList(), missingFields(normalize(local(empty.copy(then = Then.WAITS_FOR_ME, withRepo = false)))))
        assertEquals(emptyList(), missingFields(normalize(empty.copy(then = Then.WAITS_FOR_ME, repoUrl = "x"))))
    }

    @Test
    fun moreSentences() {
        val agent = normalize(empty.copy(withRepo = false, then = Then.WAITS_FOR_MESSAGES, runtime = "codex"))
        assertEquals("Woken by messages, a OpenAI Codex agent in an Optio pod that keeps its memory between turns.", text(agent))

        val hook = normalize(
            empty.copy(withRepo = false, whenType = WhenType.WEBHOOK, trigger = TriggerConfig(type = TriggerType.WEBHOOK, webhookPath = "hook-abc")),
        )
        assertEquals("Started by a webhook at /api/hooks/hook-abc, a Claude Code run in an Optio pod that exits when done.", text(hook))
        val noPath = hook.copy(trigger = hook.trigger.copy(webhookPath = null))
        assertEquals("Started by [a webhook path], a Claude Code run in an Optio pod that exits when done.", text(noPath))
        assertEquals(listOf(SentenceField.WEBHOOK, SentenceField.PROMPT), missingFields(noPath))

        // iOS predates the web's "about you" rule: its GitHub drafts carry a login here so the
        // sentence is the one iOS asserts (the gap itself is covered above).
        val gh = normalize(githubAs(empty.copy(whenType = WhenType.GITHUB, withRepo = false)))
        assertEquals("Started by GitHub events, a Claude Code run in an Optio pod that exits when done.", text(gh))
        assertEquals(listOf(SentenceField.PROMPT), missingFields(gh))
        val ghLocal = normalize(
            githubAs(empty.copy(whenType = WhenType.GITHUB, withRepo = false, location = empty.location.copy(runTarget = Where.LOCAL))),
        )
        assertEquals("Started by GitHub events, a Claude Code run [a machine] [a directory] that exits when done.", text(ghLocal))
        // …and without the login, the web's gap leads.
        val ghNoLogin = normalize(empty.copy(whenType = WhenType.GITHUB, withRepo = false))
        assertEquals("Started by GitHub events [about you], a Claude Code run in an Optio pod that exits when done.", text(ghNoLogin))
        assertEquals(listOf(SentenceField.IDENTITY, SentenceField.PROMPT), missingFields(ghNoLogin))

        val shell = normalize(local(empty.copy(withRepo = false, runtime = TERMINAL), dir = "/home/dev/x"))
        assertEquals("Opened now, a terminal on my machine in ~/x that waits for you between turns.", text(shell))

        val missingRepo = empty.copy(repoUrl = "")
        assertEquals("Started now, a Claude Code run in an Optio pod [a repo] that opens a PR and exits when done.", text(missingRepo))
        assertEquals(listOf(SentenceField.REPO, SentenceField.PROMPT), missingFields(missingRepo))
    }

    @Test
    fun ticketSentenceNamesTheSource() {
        val d = empty.copy(withRepo = false, whenType = WhenType.TICKET, trigger = TriggerConfig(TriggerType.TICKET, ticketSource = TicketSource.LINEAR))
        assertTrue(text(d).startsWith("Started by linear tickets,"))
    }

    // endregion

    // region Presets and params

    @Test
    fun presetsLandOnPromisedKinds() {
        val by = PRESETS.associate { it.id to normalize(it.apply(empty)) }
        assertEquals(listOf("pr", "chat", "terminal", "schedule", "agent"), PRESETS.map { it.id })
        assertEquals(WorkKind.REPO_TASK, deriveKind(by.getValue("pr")))
        assertEquals(WorkKind.LOCAL_TERMINAL, deriveKind(local(by.getValue("chat"))))
        assertEquals(WorkKind.LOCAL_TERMINAL, deriveKind(local(by.getValue("terminal"))))
        assertEquals(TERMINAL, by.getValue("terminal").runtime)
        assertEquals(WorkKind.STANDALONE, deriveKind(by.getValue("schedule")))
        assertEquals(WorkKind.PERSISTENT_AGENT, deriveKind(by.getValue("agent")))
    }

    @Test
    fun ticketStyleParamsForTicketAndLinear() {
        assertTrue("ticketUrl" in triggerParams(WhenType.TICKET))
        assertTrue("ticketUrl" in triggerParams(WhenType.LINEAR))
        assertEquals(emptyList(), triggerParams(WhenType.SCHEDULE))
        assertTrue("action" in triggerParams(WhenType.GITHUB))
    }

    @Test
    fun slugify() {
        assertEquals("release-manager", slugify("Release Manager!"))
        assertEquals("session-12", slugify("Session 12"))
        assertEquals("n-code-name", slugify("  --Ünïcode__name  "))
        assertEquals(40, slugify("a".repeat(50)).length)
    }

    // endregion

    // region Helpers the picker and the submitter lean on

    @Test
    fun repoUrlFromRemote() {
        assertEquals("https://github.com/jonwiggins/optio", repoUrlFromRemote("git@github.com:jonwiggins/optio.git"))
        assertEquals("https://github.com/foo/bar", repoUrlFromRemote("ssh://git@github.com:22/Foo/Bar.git"))
        assertEquals("https://github.com/foo/bar", repoUrlFromRemote("HTTPS://GitHub.com/Foo/Bar/"))
        assertEquals("https://github.com/foo/bar", repoUrlFromRemote("github.com/foo/bar"))
        assertNull(repoUrlFromRemote(null))
        assertNull(repoUrlFromRemote("  "))
        assertEquals("github.com/acme/app", shortRepo("git@github.com:acme/app.git"))
    }

    @Test
    fun fullOptionsApplyForEveryPodRun() {
        assertTrue(fullOptionsApply(empty))
        assertTrue(fullOptionsApply(empty.copy(withRepo = false)))
        assertTrue(fullOptionsApply(normalize(empty.copy(withRepo = false, then = Then.WAITS_FOR_MESSAGES))))
        assertFalse(fullOptionsApply(local(empty)))
        assertFalse(fullOptionsApply(empty.copy(runtime = TERMINAL)))
    }

    @Test
    fun presetsResetAgentOptionsAndAliasesResolve() {
        val d = empty.copy(agentOptions = mapOf("claudeModel" to OptionValue.Str("opus")))
        for (p in PRESETS) assertEquals(emptyMap(), p.apply(d).agentOptions, p.id)
        assertEquals("claude-opus-4-8", resolveModel("opus", mapOf("opus" to "claude-opus-4-8")))
        assertEquals("claude-opus-4-8", resolveModel("claude-opus-4-8", mapOf("opus" to "claude-opus-4-8")))
        assertEquals("x", resolveModel("x", null))
    }

    @Test
    fun optionsFromRepoReadsOnlyCatalogKeys() {
        val repo = jsonObjectOf(
            "claudeModel" to JsonPrimitive("opus"),
            "claudeThinking" to JsonPrimitive(true),
            "fullName" to JsonPrimitive("x"),
            "maxTurnsCoding" to JsonPrimitive(5),
            "claudeEffort" to JsonNull,
        )
        val out = optionsFromRepo("claude-code", repo, listOf("claudeModel", "claudeThinking", "claudeEffort"))
        assertEquals(mapOf("claudeModel" to OptionValue.Str("opus"), "claudeThinking" to OptionValue.Bool(true)), out)
        assertEquals(emptyMap(), optionsFromRepo(TERMINAL, repo, listOf("claudeModel")))
        assertEquals(emptyMap(), optionsFromRepo("claude-code", null, listOf("claudeModel")))
    }

    @Test
    fun pickedModelAndSetOptions() {
        val d = empty.copy(
            runtime = "codex",
            agentOptions = mapOf(
                "copilotModel" to OptionValue.Str("gpt-5"),
                "codexReasoning" to OptionValue.Str(""),
                "flag" to OptionValue.Bool(false),
            ),
        )
        assertEquals("gpt-5", pickedModel(d))
        assertEquals(jsonObjectOf("copilotModel" to JsonPrimitive("gpt-5"), "flag" to JsonPrimitive(false)), setOptions(d))
        assertNull(pickedModel(empty.copy(runtime = TERMINAL)))
        assertNull(setOptions(empty.copy(agentOptions = mapOf("claudeModel" to OptionValue.Str("")))))
    }

    @Test
    fun genericTriggerAndLocationPayload() {
        assertNull(triggerFor(empty))
        val sched = triggerFor(empty.copy(trigger = TriggerConfig(type = TriggerType.SCHEDULE, cronExpression = " 0 9 * * * ")))
        assertEquals("schedule", sched?.type)
        assertEquals(jsonObjectOf("cronExpression" to JsonPrimitive("0 9 * * *")), sched?.config)
        val ticket = triggerFor(empty.copy(trigger = TriggerConfig(type = TriggerType.TICKET, ticketSource = TicketSource.LINEAR, ticketLabels = listOf("bug"))))
        assertEquals(jsonObjectOf("source" to JsonPrimitive("linear"), "labels" to jsonArrayOf("bug")), ticket?.config)
        val plain = triggerFor(empty.copy(trigger = TriggerConfig(type = TriggerType.TICKET)))
        assertEquals(jsonObjectOf("source" to JsonPrimitive("github")), plain?.config)
        val hook = triggerFor(empty.copy(trigger = TriggerConfig(type = TriggerType.WEBHOOK, webhookPath = "hook-1")))
        assertEquals(TriggerSpec("webhook", jsonObjectOf("path" to JsonPrimitive("hook-1"))), hook)
        // An event When sends its config whatever the trigger config says.
        val gh = triggerFor(githubAs(empty.copy(whenType = WhenType.GITHUB)))
        assertEquals("github", gh?.type)
        assertEquals(JsonPrimitive("octocat"), gh?.config?.get("login"))

        assertEquals(
            jsonObjectOf("runTarget" to JsonPrimitive("cluster"), "localHostId" to JsonNull, "localDir" to JsonNull, "localSessionMode" to JsonNull),
            locationPayload(empty),
        )
        val l = locationPayload(normalize(local(empty.copy(withRepo = false, then = Then.WAITS_FOR_ME))))
        assertEquals(JsonPrimitive("local"), l["runTarget"])
        assertEquals(JsonPrimitive("h1"), l["localHostId"])
        assertEquals(JsonPrimitive("interactive"), l["localSessionMode"])
    }

    @Test
    fun submitLabel() {
        assertEquals("Start work (opens a PR)", submitLabel(empty))
        assertEquals("Start work", submitLabel(empty.copy(withRepo = false)))
        assertEquals("Open session", submitLabel(empty.copy(then = Then.WAITS_FOR_ME)))
        assertEquals("Create agent", submitLabel(normalize(empty.copy(withRepo = false, then = Then.WAITS_FOR_MESSAGES))))
        assertEquals("Save", submitLabel(empty.copy(whenType = WhenType.SCHEDULE)))
        assertEquals("Save changes", submitLabel(empty, editing = true))
    }

    @Test
    fun cronValidity() {
        assertTrue(cronIsValid("0 9 * * 1-5"))
        assertTrue(cronIsValid("  0  9 * * *  "))
        assertFalse(cronIsValid("nope"))
        assertFalse(cronIsValid(null))
        assertFalse(cronIsValid("   "))
        assertTrue(randomWebhookPath().startsWith("hook-"))
        assertEquals(13, randomWebhookPath().length)
        assertEquals(randomWebhookPath(Random(7)), randomWebhookPath(Random(7)))
    }

    @Test
    fun namesRunsOnlyForRecurringWork() {
        assertTrue(namesRuns(base.copy(whenType = WhenType.SCHEDULE)))
        assertTrue(namesRuns(base.copy(withRepo = false, whenType = WhenType.LINEAR)))
        assertFalse(namesRuns(base.copy(withRepo = false)))
        assertTrue(namesRuns(local(base.copy(whenType = WhenType.GITHUB, then = Then.WAITS_FOR_ME))))
        assertFalse(namesRuns(base))
    }

    @Test
    fun shortDirReplacesTheHome() {
        assertEquals("~/repos/app", shortDir("/Users/dev/repos/app"))
        assertEquals("~/x", shortDir("/home/dev/x"))
        assertEquals("/srv/app", shortDir("/srv/app"))
    }

    // endregion
}
