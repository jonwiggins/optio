package dev.optio.core.ui.format

import java.time.Duration
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneOffset
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull

/** Test vectors for the iOS `Cost` / `InsightsFormat` / date helpers and the shared usage formats. */
class FormatTest {
    private val now = Instant.parse("2026-09-22T16:40:00Z")

    private fun ago(seconds: Long) = now.minus(Duration.ofSeconds(seconds))

    @Test
    fun cost() {
        assertEquals("$0.78", Cost.format(0.78))
        assertEquals("$9.99", Cost.format(9.99))
        assertEquals("$12", Cost.format(12.4))
        assertEquals("$13", Cost.format(12.5))
        assertEquals("$0", Cost.format(0.0))
        assertEquals("$0", Cost.format(-2.0))
        assertEquals("$0", Cost.format(Double.NaN))
        assertEquals("$0", Cost.format(null as Double?))
        assertEquals("$0.42", Cost.format("0.4210"))
        assertEquals("$0", Cost.format("not a number"))
        assertNull(Cost.formatIfNonZero(0.0))
        assertNull(Cost.formatIfNonZero("0"))
        assertNull(Cost.formatIfNonZero(null as String?))
        assertEquals("$1.50", Cost.formatIfNonZero("1.5"))
    }

    @Test
    fun repoShortName() {
        assertEquals("acme/web", InsightsFormat.repoShortName("https://github.com/acme/web.git"))
        assertEquals("acme/web", InsightsFormat.repoShortName("https://github.com/acme/web"))
        assertEquals("web", InsightsFormat.repoShortName("web"))
    }

    @Test
    fun duration() {
        assertEquals("—", InsightsFormat.duration(null))
        assertEquals("—", InsightsFormat.duration(0.0))
        assertEquals("45s", InsightsFormat.duration(45.9))
        assertEquals("2m", InsightsFormat.duration(90.0))
        assertEquals("12m", InsightsFormat.duration(12 * 60 + 20.0))
        assertEquals("2h 5m", InsightsFormat.duration(2 * 3600 + 300.0))
        assertEquals("3h", InsightsFormat.duration(3 * 3600 + 10.0))
    }

    @Test
    fun tokensPercentModels() {
        assertEquals("0", InsightsFormat.tokens(null))
        assertEquals("950", InsightsFormat.tokens(950.0))
        assertEquals("12.3K", InsightsFormat.tokens(12_345.0))
        assertEquals("1.2M", InsightsFormat.tokens(1_234_567.0))
        assertEquals("42%", InsightsFormat.percent(41.6))
        assertEquals("—", InsightsFormat.percent(null))
        assertEquals("Opus", InsightsFormat.modelShortName("claude-opus-4-1"))
        assertEquals("Sonnet", InsightsFormat.modelShortName("claude-sonnet-4-5"))
        assertEquals("Haiku", InsightsFormat.modelShortName("HAIKU"))
        assertEquals("Unknown", InsightsFormat.modelShortName("unknown"))
        assertEquals("Unknown", InsightsFormat.modelShortName(null))
        assertEquals("gpt-5", InsightsFormat.modelShortName("gpt-5"))
    }

    @Test
    fun k8sResource() {
        assertEquals("31.3 Gi", InsightsFormat.k8sResource("32813152Ki"))
        assertEquals("512 Mi", InsightsFormat.k8sResource("524288Ki"))
        assertEquals("1000 Ki", InsightsFormat.k8sResource("1000Ki"))
        assertEquals("2.0 Gi", InsightsFormat.k8sResource("2048Mi"))
        assertEquals("512 Mi", InsightsFormat.k8sResource("512Mi"))
        assertEquals("4 Gi", InsightsFormat.k8sResource("4Gi"))
        assertEquals("2.0 Gi", InsightsFormat.k8sResource("2147483648"))
        assertEquals("10 Mi", InsightsFormat.k8sResource("10485760"))
        assertEquals("250m", InsightsFormat.k8sResource("250m"))
        assertEquals("—", InsightsFormat.k8sResource(null))
    }

    @Test
    fun dayAndAction() {
        assertEquals(LocalDate.of(2026, 9, 17), InsightsFormat.day("2026-09-17"))
        assertEquals(LocalDate.of(2026, 9, 17), InsightsFormat.day("2026-09-17T23:30:00Z", ZoneOffset.UTC))
        assertNull(InsightsFormat.day("nope"))
        assertNull(InsightsFormat.day(null))
        assertEquals("Task State Changed", InsightsFormat.action("task.state_changed"))
        assertEquals("Pr Review Started", InsightsFormat.action("pr_review.started"))
    }

    @Test
    fun elapsedDurations() {
        assertEquals("0s", Durations.elapsedMs(500.0))
        assertEquals("45s", Durations.elapsedMs(45_000.0))
        assertEquals("3m 12s", Durations.elapsedMs(192_000.0))
        assertEquals("1h 4m", Durations.elapsedMs(3_840_000.0))
        assertEquals("0s", Durations.elapsedMs(-5_000.0))
        assertEquals("3m 12s", Durations.between(ago(192), now = now))
        assertEquals("2m 0s", Durations.between(ago(300), end = ago(180)))
    }

    @Test
    fun usageFormats() {
        assertEquals("950", UsageFormat.tokens(950))
        assertEquals("9.5k", UsageFormat.tokens(9_500))
        assertEquals("12k", UsageFormat.tokens(12_345))
        assertEquals("1.2M", UsageFormat.tokens(1_234_567))
        assertEquals("<$0.01", UsageFormat.usd(0.004))
        assertEquals("$0.42", UsageFormat.usd(0.42))
        assertEquals("$12.30", UsageFormat.usd(12.3))
        assertEquals("$0.00", UsageFormat.usd(0.0))
    }

    @Test
    fun relativeTimeMatchesIosShortStyle() {
        assertEquals("now", ago(0).relativeDescription(now))
        assertEquals("30 sec. ago", ago(30).relativeDescription(now))
        assertEquals("5 min. ago", ago(5 * 60 + 20).relativeDescription(now))
        assertEquals("2 hr. ago", ago(2 * 3600 + 59 * 60).relativeDescription(now))
        assertEquals("1 day ago", ago(36 * 3600).relativeDescription(now))
        assertEquals("3 days ago", ago(3 * 86_400).relativeDescription(now))
        assertEquals("1 wk. ago", ago(10 * 86_400).relativeDescription(now))
        assertEquals("1 mo. ago", ago(45 * 86_400).relativeDescription(now))
        assertEquals("1 yr. ago", ago(400 * 86_400).relativeDescription(now))
        assertEquals("in 1 hr.", now.plus(Duration.ofMinutes(90)).relativeDescription(now))
        assertEquals("in 2 days", now.plus(Duration.ofDays(2)).relativeDescription(now))
        assertEquals("12 min. ago", "2026-09-22T16:28:00.000Z".relativeDescription(now))
        assertEquals("yesterday-ish", "yesterday-ish".relativeDescription(now))
    }

    @Test
    fun dayHeaders() {
        val utc = ZoneOffset.UTC
        assertEquals("Today", Instant.parse("2026-09-22T01:00:00Z").dayHeader(now, utc))
        assertEquals("Yesterday", Instant.parse("2026-09-21T23:59:00Z").dayHeader(now, utc))
        assertEquals("Sep 15", Instant.parse("2026-09-15T12:00:00Z").dayHeader(now, utc))
    }

    @Test
    fun isoParsingAndStringHelpers() {
        assertEquals(Instant.parse("2026-09-22T16:37:00.123Z"), "2026-09-22T16:37:00.123Z".isoInstant())
        assertEquals(Instant.parse("2026-09-22T16:37:00Z"), "2026-09-22T16:37:00Z".isoInstant())
        assertEquals(Instant.parse("2026-09-22T16:37:00Z"), "2026-09-22T18:37:00+02:00".isoInstant())
        assertEquals(Instant.parse("2026-09-22T16:37:00.601836Z"), "2026-09-22T16:37:00.601836+00:00".isoInstant())
        assertNull("not a date".isoInstant())
        assertEquals("optio/web", "/Users/dev/optio/web".pathTail())
        assertEquals("web", "web".pathTail())
        assertEquals("/", "/".pathTail())
        assertEquals("Waiting on you", "waiting on you".capitalizedFirst())
    }
}
