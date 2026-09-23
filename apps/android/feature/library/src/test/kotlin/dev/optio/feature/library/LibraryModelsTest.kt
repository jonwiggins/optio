package dev.optio.feature.library

import dev.optio.core.model.OptioJson
import dev.optio.core.network.ApiError
import dev.optio.feature.library.connections.AccessControl
import dev.optio.feature.library.connections.ConnectionDetail
import dev.optio.feature.library.connections.ConnectionsCatalog
import dev.optio.feature.library.prompts.ALL_KINDS
import dev.optio.feature.library.prompts.visiblePrompts
import dev.optio.feature.library.repos.RepoSettingsForm
import dev.optio.feature.library.repos.SharedDirectoryDraft
import dev.optio.feature.library.repos.reviewerLabel
import dev.optio.feature.library.repos.volumesFooter
import java.io.IOException
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

/** The Library's pure logic: ports of the iOS helpers in MoreAPI / MoreSupport and the views. */
class LibraryModelsTest {
    // region Prompts

    @Test
    fun paramNamesComeFromTheBodyInOrderWithoutDuplicatesOrHelpers() {
        val body = "Add {{flag}}{{#if owner}} owned by {{owner}}{{/if}} for {{ flag }} and {{#each x}}{{/each}} {{}}"
        assertEquals(listOf("flag", "owner"), templateParamNames(body))
    }

    @Test
    fun paramNamesStopAtAnUnclosedToken() {
        assertEquals(listOf("a"), templateParamNames("{{a}} then {{b"))
        assertEquals(emptyList(), templateParamNames("no params here"))
    }

    @Test
    fun declaredParamsSchemaWinsOverTheBody() {
        val schema = OptioJson.parseToJsonElement("""{"properties":{"zeta":{},"alpha":{}}}""")
        val row = PromptTemplateRow(id = "1", name = "x", template = "{{other}}", paramsSchema = schema)
        assertEquals(listOf("alpha", "zeta"), row.paramNames)
        // An empty schema falls back to the body.
        val empty = row.copy(paramsSchema = OptioJson.parseToJsonElement("""{"properties":{}}"""))
        assertEquals(listOf("other"), empty.paramNames)
        assertEquals(listOf("other"), row.copy(paramsSchema = JsonNull).paramNames)
    }

    @Test
    fun promptKindLabelsMatchTheWeb() {
        assertEquals("Repo task blueprint", PromptKind.label("task"))
        assertEquals("Standalone", PromptKind.shortLabel("job"))
        assertEquals("custom", PromptKind.label("custom"))
        assertEquals("prompt", PromptKind.label(null))
        assertEquals(PromptKind.REVIEW, PromptKind.fromRaw("review"))
    }

    @Test
    fun kindFilterKeepsOnlyThatKind() {
        val all = LibrarySamples.prompts
        assertEquals(4, visiblePrompts(all, ALL_KINDS).size)
        assertEquals(listOf("p-review"), visiblePrompts(all, "review").map { it.id })
    }

    @Test
    fun promptEditSendsExplicitNullsToClearFields() {
        val input = PromptTemplateInput(name = "n", template = "t", kind = "job")
        val patch = input.patchBody()
        assertTrue(patch.containsKey("description"))
        assertNull(patch["description"])
        assertNull(patch["defaultAgentType"])
        // A create omits them instead.
        val created = OptioJson.encodeToString(PromptTemplateInput.serializer(), input)
        assertEquals("""{"name":"n","template":"t","kind":"job"}""", created)
    }

    // endregion

    // region Connections

    @Test
    fun configFieldsPutRequiredFirstAndReadTheSchema() {
        val fields = LibrarySamples.httpProvider.configFields
        assertEquals("baseUrl", fields.first().key)
        assertTrue(fields.first().required)
        assertEquals(listOf("baseUrl", "authType", "AUTH_TOKEN", "authHeader", "description"), fields.map { it.key })
        val auth = fields.first { it.key == "authType" }
        assertEquals(listOf("none", "api-key", "bearer"), auth.options)
        assertEquals("Authentication type", auth.title)
        val token = fields.first { it.key == "AUTH_TOKEN" }
        assertTrue(token.isSecret)
        assertFalse(token.required)
        // `default` becomes the hint.
        assertEquals("Authorization", fields.first { it.key == "authHeader" }.placeholder)
    }

    @Test
    fun configFieldsHandleMultilineAndMissingTitles() {
        val schema = OptioJson.parseToJsonElement(
            """{"type":"object","required":["command"],"properties":{"args":{"type":"string","title":"Arguments (one per line)"},"command":{"type":"string"},"n":{"default":3}}}""",
        )
        val fields = ConnectionProviderRow(id = "p", configSchema = schema).configFields
        assertEquals(listOf("command", "args", "n"), fields.map { it.key })
        assertEquals("command", fields[0].title)
        assertTrue(fields[1].multiline)
        assertEquals("3", fields[2].placeholder)
        assertEquals(emptyList(), ConnectionProviderRow(id = "p").configFields)
    }

    @Test
    fun slackNeedsBothRequiredFields() {
        val required = LibrarySamples.slackProvider.configFields.filter { it.required }.map { it.key }.toSet()
        assertEquals(setOf("SLACK_BOT_TOKEN", "SLACK_TEAM_ID"), required)
    }

    @Test
    fun providersGroupByCategoryWithOtherLast() {
        val odd = ConnectionProviderRow(id = "odd", name = "Odd", category = "weird")
        val catalog = ConnectionsCatalog(providers = LibrarySamples.providers + odd)
        val groups = catalog.groupedProviders.map { it.first.label to it.second.size }
        assertEquals(listOf("Productivity" to 4, "Databases" to 1, "Cloud" to 1, "Knowledge" to 1, "Custom" to 2, "Other" to 1), groups)
    }

    @Test
    fun connectionProviderFallsBackToTheCatalogue() {
        val bare = LibrarySamples.httpConnection.copy(provider = null)
        val catalog = ConnectionsCatalog(providers = LibrarySamples.providers)
        assertEquals("HTTP API", catalog.provider(bare)?.name)
    }

    @Test
    fun accessControlOrdersAgentsLikeTheCatalogue() {
        val access = AccessControl(repoId = "", permission = "full").toggling("cursor", true).toggling("claude-code", true)
        val input = access.assignment()
        assertNull(input.repoId)
        assertEquals(listOf("claude-code", "cursor"), input.agentTypes)
        assertEquals("full", input.permission)
        assertEquals(listOf("cursor"), access.toggling("claude-code", false).assignment().agentTypes)
        assertEquals("""{"agentTypes":[],"permission":"read"}""", OptioJson.encodeToString(ConnectionAssignmentInput.serializer(), AccessControl().assignment()))
    }

    @Test
    fun assignmentRepoLabels() {
        val detail = ConnectionDetail(LibrarySamples.httpConnection, repos = LibrarySamples.repos)
        assertEquals("All repos", detail.repoLabel(null))
        assertEquals("e2e-org/e2e-repo", detail.repoLabel("r-main"))
        assertEquals("Repo 12345678", detail.repoLabel("1234567890abcdef"))
    }

    // endregion

    // region Repos

    @Test
    fun settingsPatchInheritsReviewAgentWithExplicitNull() {
        val patch = RepoSettingsForm.from(LibrarySamples.mainRepo).patch()
        assertTrue(patch.containsKey("reviewAgentType"))
        assertNull(patch["reviewAgentType"])
        assertEquals("sonnet", patch["reviewModel"])
        assertEquals("", patch["extraPackages"])
        assertEquals("pnpm test", patch["testCommand"])
        assertEquals(6, patch["maxConcurrentTasks"])
        assertEquals(true, patch["autoMerge"])
    }

    @Test
    fun settingsPatchOmitsAnEmptyReviewModelAndCautionDisablesAutoMerge() {
        val form = RepoSettingsForm(reviewModel = "", autoMerge = true).withCautiousMode(true)
        assertFalse(form.autoMerge)
        val patch = form.copy(autoMerge = true).patch()
        assertFalse(patch.containsKey("reviewModel"))
        assertEquals(false, patch["autoMerge"])
        assertEquals(2, RepoSettingsForm(maxPodInstances = 2, maxAgentsPerPod = 1).capacity)
    }

    @Test
    fun settingsFormDefaultsMatchIos() {
        val form = RepoSettingsForm.from(RepoRow(id = "x"))
        assertEquals(RepoSettingsForm(), form)
        assertEquals("opus", form.claudeModel)
        assertEquals(250, form.maxTurnsCoding)
        assertEquals("on_ci_pass", form.reviewTrigger)
    }

    @Test
    fun reviewerLabelFollowsTheInheritanceChain() {
        assertEquals("Claude Code · sonnet", reviewerLabel(LibrarySamples.mainRepo))
        assertEquals("OpenAI Codex", reviewerLabel(RepoRow(id = "x", defaultAgentType = "codex")))
        assertEquals("Google Gemini · gemini-2.5-pro", reviewerLabel(RepoRow(id = "x", reviewAgentType = "gemini", effectiveReviewModel = "gemini-2.5-pro")))
    }

    @Test
    fun reviewTriggerLabels() {
        assertEquals("Immediately on PR open", ReviewTriggers.label("on_pr"))
        assertEquals("After CI passes", ReviewTriggers.label(null))
        assertEquals("After CI passes", ReviewTriggers.label("bogus"))
    }

    @Test
    fun inferFullNameFromUrls() {
        assertEquals("owner/repo", inferFullName("https://github.com/owner/repo.git"))
        assertEquals("owner/repo", inferFullName(" https://gitlab.example.com/owner/repo/-/tree/main "))
        assertNull(inferFullName("https://github.com/owner"))
        assertNull(inferFullName("not a url"))
    }

    @Test
    fun sharedDirectoryRulesMirrorTheApi() {
        assertNull(SharedDirectoryRules.nameProblem(""))
        assertNull(SharedDirectoryRules.nameProblem("npm-cache"))
        assertEquals("Lowercase letters, digits and single hyphens.", SharedDirectoryRules.nameProblem("Bad Name"))
        assertEquals("Lowercase letters, digits and single hyphens.", SharedDirectoryRules.nameProblem("a--b"))
        assertEquals("At most 40 characters.", SharedDirectoryRules.nameProblem("a".repeat(41)))
        assertNull(SharedDirectoryRules.subPathProblem(".local/share/pnpm/store"))
        assertEquals("Relative to the mount location: no leading /.", SharedDirectoryRules.subPathProblem("/etc"))
        assertEquals("No .. segments.", SharedDirectoryRules.subPathProblem("a/../b"))
        assertEquals("Letters, digits and . _ / - only.", SharedDirectoryRules.subPathProblem("a b"))
    }

    @Test
    fun sharedDirectoryPresetFillsTheForm() {
        val draft = SharedDirectoryDraft(mountLocation = "workspace").withPreset("pnpm")
        assertEquals("pnpm-store", draft.name)
        assertEquals(".local/share/pnpm/store", draft.mountSubPath)
        assertEquals("home", draft.mountLocation)
        assertEquals("pnpm cache", draft.description)
        assertTrue(draft.canSave)
        assertEquals(SharedDirectoryInput("pnpm-store", "pnpm cache", "home", ".local/share/pnpm/store", 10), draft.input())
        assertFalse(draft.copy(name = "Bad").canSave)
        assertFalse(SharedDirectoryDraft().canSave)
        assertEquals("custom", SharedDirectoryDraft().withPreset("custom").preset)
    }

    @Test
    fun volumesFooterPluralises() {
        assertTrue(volumesFooter(1).contains("with 1 pod instance that is 1 volume per directory"))
        assertTrue(volumesFooter(3).contains("with 3 pod instances that is 3 volumes per directory"))
    }

    @Test
    fun recycleMessages() {
        assertEquals("No idle pods to recycle.", recycleMessage(0))
        assertEquals("Recycled 1 pod.", recycleMessage(1))
        assertEquals("Recycled 3 pods.", recycleMessage(3))
    }

    @Test
    fun usageTextReadsStringsAndObjects() {
        assertNull(usageText(null))
        assertNull(usageText(JsonNull))
        assertEquals("1.2G\t/cache", usageText(JsonPrimitive("1.2G\t/cache")))
        assertEquals("""{"bytes":12}""", usageText(buildJsonObject { put("bytes", 12) }))
    }

    // endregion

    // region Shared helpers

    @Test
    fun keyValueLinesAndLines() {
        assertEquals(mapOf("a" to "1", "b" to "x=y"), parseKeyValueLines("a = 1\n\nnot a pair\n=skip\nb=x=y"))
        assertEquals(listOf("-y", "@pkg/server"), parseLines(" -y \n\n@pkg/server\n"))
    }

    @Test
    fun mcpDraftBuildsTheRequest() {
        val input = McpServerDraft(name = " fs ", command = " npx ", args = "-y\n@x/fs\n", env = "TOKEN=\${{SECRET}}", installCommand = "").input()
        assertEquals(McpServerInput("fs", "npx", listOf("-y", "@x/fs"), mapOf("TOKEN" to "\${{SECRET}}"), null, null), input)
        assertEquals(null, McpServerDraft(name = "a", command = "b").input().args)
        assertFalse(McpServerDraft(name = "a").canSave)
    }

    @Test
    fun actionMessagesMatchIos() {
        assertEquals("You don't have permission to do that. Admins only", ApiError(403, "Admins only").actionMessage())
        assertEquals("You don't have permission to do that.", ApiError(403, "Forbidden").actionMessage())
        assertEquals("This repository has already been added", ApiError(409, "This repository has already been added").actionMessage())
        assertEquals("Can't reach the server. Check your connection.", ApiError(0, "x", cause = IOException("boom")).actionMessage())
    }

    @Test
    fun agentAndPresetLabels() {
        assertEquals("GitHub Copilot", AgentTypes.label("copilot"))
        assertEquals("mystery", AgentTypes.label("mystery"))
        assertEquals("Docker-in-Docker", ImagePresets.find("dind")?.label)
        assertNull(ImagePresets.find("nope"))
    }

    @Test
    fun cardPositions() {
        assertEquals(CardPosition.SINGLE, cardPosition(0, 1))
        assertEquals(CardPosition.FIRST, cardPosition(0, 3))
        assertEquals(CardPosition.MIDDLE, cardPosition(1, 3))
        assertEquals(CardPosition.LAST, cardPosition(2, 3))
    }

    // endregion
}
