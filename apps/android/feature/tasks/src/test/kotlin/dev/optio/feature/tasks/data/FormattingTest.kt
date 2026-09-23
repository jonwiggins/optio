package dev.optio.feature.tasks.data

import dev.optio.core.model.OptioJson
import java.time.Instant
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlinx.serialization.Serializable

/** Dates, repo names, durations and cron words (iOS `RunFormatting`, `ScheduleFormat`). */
class FormattingTest {
    @Serializable
    private data class Dated(@Serializable(with = LenientInstantSerializer::class) val at: Instant? = null)

    private fun decode(json: String): Instant? = OptioJson.decodeFromString<Dated>(json).at

    @Test
    fun lenientDatesAcceptEveryFormTheApiSends() {
        val t = Instant.parse("2026-09-23T00:46:26.671Z")
        assertEquals(t, decode("""{"at":"2026-09-23T00:46:26.671Z"}"""))
        assertEquals(Instant.parse("2026-09-23T00:46:26Z"), decode("""{"at":"2026-09-23T00:46:26Z"}"""))
        assertEquals(Instant.parse("2026-09-23T00:46:26.671658Z"), decode("""{"at":"2026-09-23 00:46:26.671658+00"}"""))
        assertEquals(Instant.parse("2026-09-22T19:16:26Z"), decode("""{"at":"2026-09-23 00:46:26+05:30"}"""))
        assertEquals(Instant.parse("2026-09-22T19:16:26Z"), decode("""{"at":"2026-09-23 00:46:26+0530"}"""))
        assertEquals(Instant.parse("2026-09-23T00:46:26Z"), decode("""{"at":"2026-09-23T00:46:26"}"""))
        assertEquals(t, decode("""{"at":${t.toEpochMilli()}}"""))
        assertEquals(Instant.ofEpochSecond(1_790_000_000), decode("""{"at":1790000000}"""))
    }

    @Test
    fun lenientDatesNeverFailTheRow() {
        assertNull(decode("""{"at":null}"""))
        assertNull(decode("""{}"""))
        assertNull(decode("""{"at":"yesterday"}"""))
        assertNull(decode("""{"at":"2026-09-23"}"""))
        assertNull(decode("""{"at":{"nested":true}}"""))
    }

    @Test
    fun repoShortNameDropsSchemeHostAndGit() {
        assertEquals("acme/web", RunFormatting.repoShortName("https://github.com/acme/web.git"))
        assertEquals("acme/web", RunFormatting.repoShortName("https://github.com/acme/web"))
        assertEquals("group/sub/repo", RunFormatting.repoShortName("https://gitlab.example.com/group/sub/repo"))
        assertEquals("", RunFormatting.repoShortName(""))
    }

    @Test
    fun agentLabels() {
        assertEquals("Claude Code", RunFormatting.agentLabel("claude-code"))
        assertEquals("OpenAI Codex", RunFormatting.agentLabel("codex"))
        assertEquals("default agent", RunFormatting.agentLabel(null))
        assertEquals("aider", RunFormatting.agentLabel("aider"))
        assertEquals("My Runtime", JobFormat.runtimeLabel("my-runtime"))
    }

    @Test
    fun durations() {
        assertEquals("0s", RunFormatting.duration(400.0))
        assertEquals("45s", RunFormatting.duration(45_000.0))
        assertEquals("3m 12s", RunFormatting.duration(192_000.0))
        assertEquals("1h 4m", RunFormatting.duration(3_840_000.0))
        assertEquals("59s", JobRun.formatDuration(59))
        assertEquals("1m 0s", JobRun.formatDuration(60))
        assertEquals("2h 0m", JobRun.formatDuration(7200))
        assertEquals("0s", JobRun.formatDuration(-5))
    }

    @Test
    fun stagesMirrorTheWebPipeline() {
        fun stage(state: String, checks: String? = null, review: String? = null) =
            RunFormatting.stage(TaskRow(id = "t", state = state, prChecksStatus = checks, prReviewStatus = review))
        assertEquals("queue", stage("waiting_on_deps"))
        assertEquals("setup", stage("provisioning"))
        assertEquals("ci", stage("pr_opened", checks = "pending"))
        assertEquals("review", stage("pr_opened", checks = "passing"))
        assertEquals("review", stage("pr_opened", review = "changes_requested"))
        assertEquals("ci", stage("pr_opened", review = "pending"))
        assertEquals("done", stage("cancelled"))
        assertEquals("attention", stage("needs_attention"))
    }

    @Test
    fun cronInWords() {
        assertEquals("Every Monday 09:00", ScheduleFormat.cron("0 9 * * 1"))
        assertEquals("Every Sunday 18:30", ScheduleFormat.cron("30 18 * * 0"))
        assertEquals("Weekdays 09:00", ScheduleFormat.cron("0 9 * * 1-5"))
        assertEquals("Every day 00:00", ScheduleFormat.cron("0 0 * * *"))
        assertEquals("Every hour", ScheduleFormat.cron("0 * * * *"))
        assertEquals("Every hour at :15", ScheduleFormat.cron("15 * * * *"))
        assertEquals("Every 6 hours", ScheduleFormat.cron("0 */6 * * *"))
        // Anything else stays as written.
        assertEquals("0 9 1 * *", ScheduleFormat.cron("0 9 1 * *"))
        assertEquals("0 * * * 1", ScheduleFormat.cron("0 * * * 1"))
        assertEquals("*/5 * * * *", ScheduleFormat.cron("*/5 * * * *"))
        assertEquals("0 9 * * 7", ScheduleFormat.cron("0 9 * * 7"))
        assertEquals("not cron", ScheduleFormat.cron("not cron"))
    }
}
