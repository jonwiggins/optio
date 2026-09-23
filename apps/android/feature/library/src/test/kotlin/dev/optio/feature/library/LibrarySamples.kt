package dev.optio.feature.library

import dev.optio.core.testing.Fixtures
import dev.optio.core.testing.Samples

/**
 * Library rows for screenshots and ViewModel tests, shaped like the DevLab seed (captured under
 * `src/test/resources/fixtures/`) but dated around [Samples.NOW] so relative times read naturally.
 */
object LibrarySamples {
    private fun ago(minutes: Long) = Samples.agoIso(minutes)

    val prompts: List<PromptTemplateRow> = listOf(
        PromptTemplateRow(
            id = "p-prompt",
            name = "Explain a failing test",
            template = "Explain why {{test}} fails and propose the smallest fix.",
            kind = "prompt",
            description = "Ask an agent to diagnose one failing test",
            updatedAt = ago(12),
        ),
        PromptTemplateRow(
            id = "p-task",
            name = "Add a feature flag",
            template = "Add a feature flag named {{flag}}{{#if owner}} owned by {{owner}}{{/if}}, default off, and open a PR.",
            kind = "task",
            description = "Repo task: wire a new flag end to end",
            defaultAgentType = "claude-code",
            updatedAt = ago(95),
        ),
        PromptTemplateRow(
            id = "p-job",
            name = "Weekly dependency report",
            template = "List outdated dependencies in {{repo}}\nand summarize the risk of each upgrade.",
            kind = "job",
            description = "Standalone job: summarize outdated dependencies",
            defaultAgentType = "codex",
            updatedAt = ago(60 * 26),
        ),
        PromptTemplateRow(
            id = "p-review",
            name = "Strict code review",
            template = "Review the PR for correctness, tests and naming. Be concise; flag blockers first.",
            kind = "review",
            description = "Reviewer instructions that flag blockers first",
            updatedAt = ago(60 * 24 * 3),
        ),
    )

    val flagPrompt: PromptTemplateRow = prompts[1]

    val repos: List<RepoRow> = listOf(
        RepoRow(
            id = "r-main",
            repoUrl = "https://github.com/e2e-org/e2e-repo",
            gitPlatform = "github",
            fullName = "e2e-org/e2e-repo",
            defaultBranch = "main",
            isPrivate = false,
            imagePreset = "node",
            autoMerge = true,
            defaultAgentType = "claude-code",
            claudeModel = "opus",
            claudeContextWindow = "1m",
            claudeThinking = true,
            claudeEffort = "high",
            maxTurnsCoding = 250,
            autoResume = true,
            maxConcurrentTasks = 6,
            maxPodInstances = 2,
            maxAgentsPerPod = 3,
            reviewEnabled = true,
            reviewTrigger = "on_ci_pass",
            reviewModel = "sonnet",
            effectiveReviewAgentType = "claude-code",
            effectiveReviewModel = "sonnet",
            externalReviewMode = "on_request",
            externalReviewWaitForCi = true,
            networkPolicy = "unrestricted",
            testCommand = "pnpm test",
        ),
        RepoRow(
            id = "r-mobile",
            repoUrl = "https://github.com/e2e-org/mobile-app",
            gitPlatform = "github",
            fullName = "e2e-org/mobile-app",
            defaultBranch = "develop",
            isPrivate = true,
            imagePreset = "base",
            defaultAgentType = "codex",
        ),
    )

    val mainRepo: RepoRow = repos[0]

    /** The built-in catalogue as the DevLab API serves it (captured). */
    val providers: List<ConnectionProviderRow> = Fixtures.decode<ProvidersFixture>("connection-providers.json").providers

    val httpProvider: ConnectionProviderRow = providers.first { it.slug == "custom-http" }
    val slackProvider: ConnectionProviderRow = providers.first { it.slug == "slack" }

    val filesystemConnection = ConnectionRow(
        id = "c-fs",
        name = "Docs filesystem",
        providerId = providers.first { it.slug == "filesystem" }.id,
        scope = "global",
        enabled = true,
        status = "healthy",
        statusMessage = "Connection OK",
        lastCheckedAt = ago(8),
        createdAt = ago(60 * 5),
        provider = providers.first { it.slug == "filesystem" },
        assignments = emptyList(),
    )

    val httpConnection = ConnectionRow(
        id = "c-http",
        name = "Status page API",
        providerId = httpProvider.id,
        scope = "global",
        enabled = true,
        status = "unknown",
        createdAt = ago(60 * 5),
        provider = httpProvider,
        assignments = listOf(
            ConnectionAssignmentRow(
                id = "a-1",
                connectionId = "c-http",
                repoId = "r-main",
                agentTypes = listOf("claude-code"),
                permission = "read",
                enabled = true,
            ),
            ConnectionAssignmentRow(
                id = "a-2",
                connectionId = "c-http",
                repoId = null,
                agentTypes = emptyList(),
                permission = "readwrite",
                enabled = false,
            ),
        ),
    )

    val failingConnection = ConnectionRow(
        id = "c-sentry",
        name = "Sentry (prod)",
        providerId = providers.first { it.slug == "sentry" }.id,
        scope = "global",
        enabled = false,
        status = "error",
        statusMessage = "401 Unauthorized",
        lastCheckedAt = ago(42),
        provider = providers.first { it.slug == "sentry" },
    )

    val connections: List<ConnectionRow> = listOf(filesystemConnection, httpConnection, failingConnection)

    val globalMcp = McpServerRow(
        id = "m-everything",
        name = "everything",
        command = "npx",
        args = listOf("-y", "@modelcontextprotocol/server-everything"),
        scope = "global",
        enabled = true,
    )

    val repoMcp = McpServerRow(
        id = "m-browser",
        name = "browser",
        command = "npx",
        args = listOf("-y", "@playwright/mcp", "--headless"),
        scope = "https://github.com/e2e-org/e2e-repo",
        repoUrl = "https://github.com/e2e-org/e2e-repo",
        enabled = false,
    )

    val directories: List<SharedDirectoryRow> = listOf(
        SharedDirectoryRow(
            id = "d-npm",
            repoId = "r-main",
            name = "npm-cache",
            description = "npm cache",
            mountLocation = "home",
            mountSubPath = ".npm",
            sizeGi = 10,
            lastClearedAt = ago(60 * 30),
            lastMountedAt = ago(20),
        ),
        SharedDirectoryRow(
            id = "d-gradle",
            repoId = "r-main",
            name = "gradle-cache",
            mountLocation = "home",
            mountSubPath = ".gradle",
            sizeGi = 25,
        ),
    )

    @kotlinx.serialization.Serializable
    data class ProvidersFixture(val providers: List<ConnectionProviderRow>)
}
