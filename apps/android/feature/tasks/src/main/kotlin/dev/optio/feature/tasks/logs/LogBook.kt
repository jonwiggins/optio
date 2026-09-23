package dev.optio.feature.tasks.logs

import dev.optio.core.model.AgentLogEntry
import dev.optio.core.ui.format.isoInstant
import dev.optio.core.ui.log.TaskLogRow
import java.time.Instant
import kotlin.math.abs

/**
 * The lines of one log, merged from the three places they come from (not thread-safe: one owner
 * thread, the stream's scope):
 *
 * - **stored** rows from REST (`GET …/logs`), canonical and typed, each with an id;
 * - **live** frames from the WebSocket, which may arrive before or after the same row is fetched
 *   and, for task logs, carry no `logType` (the server publishes `task:log` without it);
 * - **local** lines the user typed (the message they just sent).
 *
 * A stored row and a live frame are the same line when the content is equal and the timestamps are
 * equal or within [windowMs] (the server stamps a task's live frame with its own clock, a few ms
 * after the row's database time). Each stored row absorbs at most one live frame, so a line the
 * agent really printed twice stays twice. A stored row replaces its live twin in place (upgrading
 * an untyped frame to a typed row); a stored row nobody saw live (a gap while the socket was down)
 * is inserted where its timestamp puts it.
 */
internal class LogBook(
    private val ownerId: String,
    private val windowMs: Long = MATCH_WINDOW_MS,
) {
    enum class Origin { STORED, LIVE, LOCAL }

    private class Line(
        var entry: AgentLogEntry,
        var origin: Origin,
        val id: String?,
        val at: Instant?,
        /** A stored row that has already absorbed its live twin. */
        var seenLive: Boolean,
    )

    private val lines = ArrayList<Line>()
    private val storedIds = HashSet<String>()
    private var liveCount = 0

    /** How many stored rows the book holds: the offset of the next tail fetch. */
    var storedCount: Int = 0
        private set

    /** Every line, in order. */
    val entries: List<AgentLogEntry>
        get() = lines.map { it.entry }

    val size: Int
        get() = lines.size

    fun origins(): List<Origin> = lines.map { it.origin }

    /** Forgets everything (a force redo deleted the logs). */
    fun clear() {
        lines.clear()
        storedIds.clear()
        storedCount = 0
        liveCount = 0
    }

    /**
     * Merges REST rows (oldest first, a tail or the whole log): rows already held are skipped;
     * a row that matches a pending live frame replaces it in place; others are inserted by time.
     * Returns true when the lines changed.
     */
    fun addStored(rows: List<TaskLogRow>): Boolean {
        var changed = false
        for (row in rows) {
            val id = row.id
            if (id != null && !storedIds.add(id)) continue
            val entry = row.asEntry(ownerId)
            val at = entry.timestamp.isoInstant()
            if (id == null && lines.any { it.origin == Origin.STORED && it.entry.timestamp == entry.timestamp && it.entry.content == entry.content }) continue
            storedCount++
            changed = true
            val twin = if (liveCount > 0) lines.indexOfFirst { it.origin == Origin.LIVE && sameLine(it, entry.content, entry.timestamp, at) } else -1
            if (twin >= 0) {
                lines[twin] = Line(entry, Origin.STORED, id, at ?: lines[twin].at, seenLive = true)
                liveCount--
            } else {
                lines.add(insertIndex(at), Line(entry, Origin.STORED, id, at, seenLive = false))
            }
        }
        return changed
    }

    /**
     * Appends a live frame unless the book already has it: a stored row that hasn't absorbed its
     * live twin yet, or an exact repeat of the last line (the web's rule). Returns true when added.
     */
    fun addLive(entry: AgentLogEntry): Boolean {
        val at = entry.timestamp.isoInstant()
        for (i in lines.indices.reversed()) {
            if (lines.size - i > RECENT_LINES) break
            val line = lines[i]
            if (line.origin == Origin.STORED && !line.seenLive && sameLine(line, entry.content, entry.timestamp, at)) {
                line.seenLive = true
                return false
            }
        }
        val last = lines.lastOrNull()?.entry
        if (last != null && last.content == entry.content && last.type == entry.type && last.timestamp == entry.timestamp) return false
        lines += Line(entry, Origin.LIVE, null, at, seenLive = false)
        liveCount++
        return true
    }

    /** Appends a line the user typed (never matched against the server's rows). */
    fun addLocal(entry: AgentLogEntry) {
        lines += Line(entry, Origin.LOCAL, null, entry.timestamp.isoInstant(), seenLive = false)
    }

    /** Whether some live frames are still untyped stand-ins waiting for their stored rows. */
    val hasPendingLive: Boolean
        get() = liveCount > 0

    private fun sameLine(line: Line, content: String, timestamp: String, at: Instant?): Boolean {
        if (line.entry.content != content) return false
        if (line.entry.timestamp == timestamp) return true
        val a = line.at ?: return false
        val b = at ?: return false
        return abs(a.toEpochMilli() - b.toEpochMilli()) <= windowMs
    }

    /** After the last server-timed line at or before [at]; at the end when [at] is unknown. */
    private fun insertIndex(at: Instant?): Int {
        if (at == null) return lines.size
        for (i in lines.indices.reversed()) {
            val line = lines[i]
            if (line.origin == Origin.LOCAL) continue
            val t = line.at ?: continue
            if (!t.isAfter(at)) return i + 1
        }
        return 0
    }

    companion object {
        /** How far apart a stored row and its live frame may be stamped. */
        const val MATCH_WINDOW_MS = 3_000L

        /** How far back a live frame looks for its stored twin. */
        const val RECENT_LINES = 500
    }
}
