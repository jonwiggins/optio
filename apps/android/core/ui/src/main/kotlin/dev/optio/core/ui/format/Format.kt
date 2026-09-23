package dev.optio.core.ui.format

import java.time.Instant
import java.time.LocalDate
import java.time.OffsetDateTime
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.time.format.DateTimeParseException
import java.util.Locale
import kotlin.math.abs
import kotlin.math.floor
import kotlin.math.roundToLong

/** Money (iOS `Cost`, `Core/UI/Tokens.swift`). */
object Cost {
    /** "$0.78", "$12": two decimals under $10, none above. Zero, negative, NaN and null → "$0". */
    fun format(value: Double?): String {
        if (value == null || !value.isFinite() || value <= 0) return "$0"
        if (value < 10) return String.format(Locale.US, "$%.2f", value)
        return "$" + value.roundToLong()
    }

    /** [format] for the API's string costs (`costUsd: "0.4210"`). */
    fun format(value: String?): String = format(value?.toDoubleOrNull())

    /** Null when there is nothing worth showing (rows hide zero cost). */
    fun formatIfNonZero(value: Double?): String? =
        if (value == null || !value.isFinite() || value <= 0) null else format(value)

    fun formatIfNonZero(value: String?): String? = formatIfNonZero(value?.toDoubleOrNull())
}

/**
 * Formatting shared by Overview and Insights (iOS `InsightsFormat`, which mirrors the helpers at the
 * top of the web analytics / costs / cluster pages).
 */
object InsightsFormat {
    /** "owner/repo" from a git URL (`https://github.com/acme/web.git` → `acme/web`). */
    fun repoShortName(repoUrl: String): String {
        val s = repoUrl.removeSuffix(".git")
        val parts = s.split('/').filter { it.isNotEmpty() }
        if (parts.size < 2) return repoUrl
        return "${parts[parts.size - 2]}/${parts[parts.size - 1]}"
    }

    fun cost(value: Double?): String = Cost.format(value)

    fun cost(value: String?): String = Cost.format(value)

    /** Seconds → "45s", "12m", "2h 5m", "3h"; null / zero / negative → "—". */
    fun duration(seconds: Double?): String {
        val s = seconds ?: return "—"
        if (!(s > 0)) return "—"
        if (s < 60) return "${s.toInt()}s"
        if (s < 3600) return "${(s / 60).roundHalfAwayFromZero()}m"
        val h = (s / 3600).toInt()
        val m = ((s % 3600) / 60).roundHalfAwayFromZero()
        return if (m > 0) "${h}h ${m}m" else "${h}h"
    }

    /** Compact counts: "0", "950", "12.3K", "1.2M". */
    fun tokens(count: Double?): String {
        val c = count ?: return "0"
        if (!(c > 0)) return "0"
        if (c >= 1_000_000) return String.format(Locale.US, "%.1fM", c / 1_000_000)
        if (c >= 1_000) return String.format(Locale.US, "%.1fK", c / 1_000)
        return c.toInt().toString()
    }

    /** "Opus" / "Sonnet" / "Haiku" from a model id; null, empty or "unknown" → "Unknown". */
    fun modelShortName(model: String?): String {
        if (model.isNullOrEmpty() || model == "unknown") return "Unknown"
        val l = model.lowercase()
        return when {
            "opus" in l -> "Opus"
            "sonnet" in l -> "Sonnet"
            "haiku" in l -> "Haiku"
            else -> model
        }
    }

    /** "42%" (rounded); null → "—". */
    fun percent(value: Double?): String = value?.let { "${it.roundHalfAwayFromZero()}%" } ?: "—"

    /** Kubernetes quantities: "32813152Ki" → "31.3 Gi", "512Mi" → "512 Mi", bytes → Mi / Gi. */
    fun k8sResource(value: String?): String {
        if (value.isNullOrEmpty()) return "—"
        if (value.endsWith("Ki")) {
            value.dropLast(2).toDoubleOrNull()?.let { ki ->
                if (ki >= 1_048_576) return String.format(Locale.US, "%.1f Gi", ki / 1_048_576)
                if (ki >= 1024) return String.format(Locale.US, "%.0f Mi", ki / 1024)
                return "${ki.toInt()} Ki"
            }
        }
        if (value.endsWith("Mi")) {
            value.dropLast(2).toDoubleOrNull()?.let { mi ->
                if (mi >= 1024) return String.format(Locale.US, "%.1f Gi", mi / 1024)
                return "${mi.toInt()} Mi"
            }
        }
        if (value.endsWith("Gi")) {
            value.dropLast(2).toDoubleOrNull()?.let { gi -> return "${gi.toInt()} Gi" }
        }
        value.toDoubleOrNull()?.let { bytes ->
            if (bytes >= 1_073_741_824) return String.format(Locale.US, "%.1f Gi", bytes / 1_073_741_824)
            if (bytes >= 1_048_576) return String.format(Locale.US, "%.0f Mi", bytes / 1_048_576)
        }
        return value
    }

    /** Parses the analytics `date` buckets ("2026-09-17" or a full ISO timestamp) as a local day. */
    fun day(value: String?, zone: ZoneId = ZoneId.systemDefault()): LocalDate? {
        if (value == null) return null
        runCatching { LocalDate.parse(value.take(10)) }.getOrNull()?.let { return it }
        return value.isoInstant()?.atZone(zone)?.toLocalDate()
    }

    /** "task.state_changed" → "Task State Changed". */
    fun action(action: String): String =
        action.replace(Regex("[._]"), " ").split(' ').joinToString(" ") { word ->
            word.lowercase().replaceFirstChar { it.titlecase(Locale.US) }
        }

    /** Swift's `.rounded()` (half away from zero), as an Int. */
    private fun Double.roundHalfAwayFromZero(): Int = (if (this < 0) -floor(-this + 0.5) else floor(this + 0.5)).toInt()
}

/**
 * Elapsed times for runs and stalls (iOS `RunFormatting.duration`, web `formatDuration`):
 * "45s", "3m 12s", "1h 4m".
 */
object Durations {
    fun elapsedMs(ms: Double): String {
        val s = (ms / 1000).toLong().coerceAtLeast(0)
        if (s >= 3600) return "${s / 3600}h ${(s % 3600) / 60}m"
        if (s >= 60) return "${s / 60}m ${s % 60}s"
        return "${s}s"
    }

    /** [elapsedMs] between two instants (end defaults to [now]). */
    fun between(start: Instant, end: Instant? = null, now: Instant = Instant.now()): String =
        elapsedMs((((end ?: now).toEpochMilli()) - start.toEpochMilli()).toDouble())
}

/** Token and dollar formats of the Local usage chips (`@optio/shared` `formatTokens` / `formatUsd`). */
object UsageFormat {
    /** "950", "9.5k", "12k", "1.2M". */
    fun tokens(n: Long): String = when {
        n < 1000 -> n.toString()
        n < 1_000_000 -> String.format(Locale.US, if (n < 10_000) "%.1fk" else "%.0fk", n / 1000.0)
        else -> String.format(Locale.US, "%.1fM", n / 1_000_000.0)
    }

    /** "$0.42", "$12.30"; sub-cent shows "<$0.01". */
    fun usd(value: Double): String =
        if (value > 0 && value < 0.01) "<$0.01" else String.format(Locale.US, "$%.2f", value)
}

/**
 * Relative dates the way iOS `RelativeDateTimeFormatter` (`unitsStyle = .short`) writes them, which
 * every "2 min. ago" / "in 3 hr." in the app uses: seconds, minutes, hours, days, weeks, months,
 * years, truncated to the largest whole unit.
 */
object RelativeTime {
    fun describe(date: Instant, now: Instant = Instant.now()): String {
        val deltaSeconds = (now.toEpochMilli() - date.toEpochMilli()) / 1000.0
        val past = deltaSeconds >= 0
        val s = abs(deltaSeconds)
        // A server clock a few seconds ahead of the phone's makes "just happened" read as the
        // future ("in 5 sec."); under a minute ahead is skew, not a schedule.
        if (!past && s < 60) return "now"
        val amount: String = when {
            s < 1 -> return "now"
            s < 60 -> "${s.toInt()} sec."
            s < 3_600 -> "${(s / 60).toInt()} min."
            s < 86_400 -> "${(s / 3_600).toInt()} hr."
            s < 7 * 86_400 -> (s / 86_400).toInt().let { if (it == 1) "1 day" else "$it days" }
            s < 30 * 86_400 -> "${(s / (7 * 86_400)).toInt()} wk."
            s < 365 * 86_400 -> "${(s / (30 * 86_400)).toInt()} mo."
            else -> "${(s / (365 * 86_400)).toInt()} yr."
        }
        return if (past) "$amount ago" else "in $amount"
    }

    private val monthDay: DateTimeFormatter = DateTimeFormatter.ofPattern("MMM d", Locale.US)

    /** "Today", "Yesterday", "Sep 15" for day section headers. */
    fun dayHeader(date: Instant, now: Instant = Instant.now(), zone: ZoneId = ZoneId.systemDefault()): String {
        val day = date.atZone(zone).toLocalDate()
        val today = now.atZone(zone).toLocalDate()
        return when (day) {
            today -> "Today"
            today.minusDays(1) -> "Yesterday"
            else -> monthDay.format(day)
        }
    }
}

/** "2 min. ago" / "in 3 hr." (iOS `Date.relativeDescription`). */
fun Instant.relativeDescription(now: Instant = Instant.now()): String = RelativeTime.describe(this, now)

/** "Today" / "Yesterday" / "Sep 15" (iOS `Date.dayHeader`). */
fun Instant.dayHeader(now: Instant = Instant.now(), zone: ZoneId = ZoneId.systemDefault()): String =
    RelativeTime.dayHeader(this, now, zone)

/**
 * Parses an ISO-8601 timestamp string (many API rows carry dates as strings): with or without
 * fractional seconds, `Z` or an offset. Null when unparseable (iOS `String.isoDate`).
 */
fun String.isoInstant(): Instant? = try {
    OffsetDateTime.parse(this, DateTimeFormatter.ISO_OFFSET_DATE_TIME).toInstant()
} catch (_: DateTimeParseException) {
    null
}

/** [relativeDescription] of an ISO string, or the string itself when it isn't a date. */
fun String.relativeDescription(now: Instant = Instant.now()): String = isoInstant()?.relativeDescription(now) ?: this

/** First letter uppercased (iOS `capitalizedFirst`). */
fun String.capitalizedFirst(): String = replaceFirstChar { it.titlecase(Locale.US) }

/** The last two path components (`/Users/dev/optio/web` → `optio/web`), for tight rows. */
fun String.pathTail(): String {
    val tail = split('/').filter { it.isNotEmpty() }.takeLast(2).joinToString("/")
    return tail.ifEmpty { this }
}
