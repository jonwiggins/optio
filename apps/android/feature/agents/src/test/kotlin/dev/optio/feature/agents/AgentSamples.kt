package dev.optio.feature.agents

import dev.optio.core.model.AgentLogEntry
import dev.optio.core.model.PersistentAgentMessage
import dev.optio.core.model.PersistentAgentMessageSenderType
import dev.optio.core.model.PersistentAgentState
import dev.optio.core.model.PersistentAgentTurn
import dev.optio.core.model.PersistentAgentTurnHaltReason
import dev.optio.core.model.PersistentAgentWakeSource
import dev.optio.core.testing.Samples
import dev.optio.core.ui.state.LoadState
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonArray

/** Agent screen data dated around [Samples.NOW], shaped like the private test API's. */
object AgentSamples {
    const val ID = "agent-captain"

    fun agent(state: PersistentAgentState = PersistentAgentState.RUNNING) =
        Samples.persistentAgent(id = ID, state = state).copy(
            systemPrompt = "You are the release captain for acme/web. Be terse; link PRs by number.",
            agentsMd = AgentDefaults.AGENTS_MD,
            initialPrompt = "You coordinate releases for acme/web. Keep the changelog honest and flag anything blocking the next tag.",
        )

    private fun message(
        id: String,
        type: PersistentAgentMessageSenderType,
        body: String,
        minutesAgo: Long,
        name: String? = null,
        processed: Boolean = true,
        broadcast: Boolean = false,
    ) = PersistentAgentMessage(
        id = id,
        agentId = ID,
        senderType = type,
        senderName = name,
        body = body,
        broadcasted = broadcast,
        receivedAt = Samples.ago(minutesAgo),
        processedAt = if (processed) Samples.ago(minutesAgo - 1) else null,
        turnId = if (processed) "turn-6" else null,
    )

    val messages: List<PersistentAgentMessage> =
        listOf(
            message("m1", PersistentAgentMessageSenderType.SYSTEM, "You coordinate releases for acme/web. Keep the changelog honest.", 60 * 24 * 2, name = "Optio"),
            message("m2", PersistentAgentMessageSenderType.USER, "What's blocking the 2.4 release?", 42),
            message(
                "m3",
                PersistentAgentMessageSenderType.AGENT,
                "Two things:\n\n1. the flaky login e2e test — **#42** fixes it\n2. no changelog entry for the billing migration yet",
                40,
                name = "vesper",
            ),
            message("m4", PersistentAgentMessageSenderType.AGENT, "Heads up: main is green again.", 25, name = "sentinel", broadcast = true),
            message("m5", PersistentAgentMessageSenderType.USER, "Draft the changelog entry, please.", 2, processed = false),
        )

    val live =
        AgentLiveTail(
            turnId = "turn-7",
            entries =
                listOf(
                    Samples.logEntry(AgentLogEntry.TypeValue.SYSTEM, "Session started · claude-sonnet-4-5 · 12 tools", minutesAgo = 1, taskId = ID),
                    Samples.logEntry(
                        AgentLogEntry.TypeValue.TOOL_USE,
                        "{\"file_path\":\"CHANGELOG.md\"}",
                        mapOf("toolName" to JsonPrimitive("Read"), "summary" to JsonPrimitive("CHANGELOG.md")),
                        minutesAgo = 1,
                        taskId = ID,
                    ),
                    Samples.logEntry(AgentLogEntry.TypeValue.TEXT, "Drafting the entry under **2.4.0 › Changed** now.", minutesAgo = 0, taskId = ID),
                ),
        )

    private fun turn(
        n: Int,
        wake: PersistentAgentWakeSource,
        minutesAgo: Long,
        halt: PersistentAgentTurnHaltReason?,
        summary: String? = null,
        cost: String? = "0.0421",
        error: String? = null,
    ) = PersistentAgentTurn(
        id = "turn-$n",
        agentId = ID,
        turnNumber = n.toDouble(),
        wakeSource = wake,
        haltReason = halt,
        errorMessage = error,
        costUsd = cost,
        inputTokens = if (halt == null) null else 18_234.0,
        outputTokens = if (halt == null) null else 912.0,
        summary = summary,
        promptUsed = "# Inbox (1 new message)\n---BEGIN OPTIO MESSAGE---\n{\"version\":1,\"sender\":\"user:dev@example.com\",\"body\":\"What's blocking the 2.4 release?\"}\n---END OPTIO MESSAGE---",
        startedAt = Samples.ago(minutesAgo),
        finishedAt = halt?.let { Samples.ago(minutesAgo - 1) },
        createdAt = Samples.ago(minutesAgo),
    )

    val turns: List<PersistentAgentTurn> =
        listOf(
            turn(7, PersistentAgentWakeSource.USER, 1, null, cost = null),
            turn(6, PersistentAgentWakeSource.USER, 41, PersistentAgentTurnHaltReason.NATURAL, summary = "Listed the two blockers for 2.4"),
            turn(5, PersistentAgentWakeSource.SCHEDULE, 60 * 8, PersistentAgentTurnHaltReason.ERROR, cost = "0.0102", error = "Agent exited with code 1: rate limited"),
            turn(4, PersistentAgentWakeSource.AGENT, 60 * 20, PersistentAgentTurnHaltReason.MAX_DURATION, summary = "Audited open PRs against the milestone"),
            turn(3, PersistentAgentWakeSource.WEBHOOK, 60 * 30, PersistentAgentTurnHaltReason.NATURAL, cost = "0.0088"),
        )

    val triggers: List<PersistentAgentTrigger> =
        listOf(
            PersistentAgentTrigger("t1", "schedule", buildJsonObject { put("cronExpression", "0 9 * * 1-5") }, true, lastFiredAt = Samples.ago(60 * 7 + 40), nextFireAt = Samples.NOW.plusSeconds(60 * 60 * 16 + 20 * 60)),
            PersistentAgentTrigger("t2", "webhook", buildJsonObject { put("path", "release-captain") }, true, lastFiredAt = Samples.ago(60 * 26)),
            PersistentAgentTrigger("t3", "ticket", buildJsonObject { put("source", "linear"); putJsonArray("labels") { add(JsonPrimitive("release")) } }, true),
            PersistentAgentTrigger("t4", "github", buildJsonObject { putJsonArray("events") { add(JsonPrimitive("review_requested")); add(JsonPrimitive("mentioned")) }; put("login", "release-bot") }, true),
            PersistentAgentTrigger("t5", "slack", buildJsonObject { put("channelId", "C0RELEASES"); put("mentionOnly", true) }, false),
            PersistentAgentTrigger("t6", "linear", buildJsonObject { putJsonArray("events") { add(JsonPrimitive("created")) }; putJsonArray("teams") { add(JsonPrimitive("REL")) } }, true),
            PersistentAgentTrigger("t7", "manual", buildJsonObject { }, true),
        )

    fun ui(
        state: PersistentAgentState = PersistentAgentState.RUNNING,
        pending: Int = 1,
        live: AgentLiveTail = this.live,
        connected: Boolean = true,
    ) = AgentDetailUi(
        header = LoadState.Loaded(AgentHeader(agent(state), PersistentAgentInbox(pending = pending))),
        messages = LoadState.Loaded(messages),
        turns = LoadState.Loaded(turns),
        triggers = LoadState.Loaded(triggers),
        live = live,
        connected = connected,
    )

    val turnDetail =
        PersistentAgentTurnDetail(
            turn = turns[1],
            logs =
                listOf(
                    PersistentAgentTurnLog(content = "Session started · claude-sonnet-4-5 · 12 tools", logType = "system", timestamp = Samples.ago(41)),
                    PersistentAgentTurnLog(content = "Checking the milestone and the open PRs.", logType = "text", timestamp = Samples.ago(41)),
                    PersistentAgentTurnLog(
                        content = "{\"command\":\"gh pr list --milestone 2.4\"}",
                        logType = "tool_use",
                        metadata = mapOf("toolName" to JsonPrimitive("Bash"), "summary" to JsonPrimitive("gh pr list --milestone 2.4"), "result" to JsonPrimitive("#42 Fix flaky login test\n#57 Billing migration")),
                        timestamp = Samples.ago(41),
                    ),
                    PersistentAgentTurnLog(
                        content = "Two things block 2.4: **#42** (flaky login e2e) and the missing changelog entry for **#57**.",
                        logType = "text",
                        timestamp = Samples.ago(40),
                    ),
                    PersistentAgentTurnLog(content = "(3 turns · 41.2s · \$0.0421)", logType = "info", timestamp = Samples.ago(40)),
                ),
        )
}
