package dev.optio.feature.local.transcript

import dev.optio.core.model.AgentLogEntry
import dev.optio.core.model.LocalTranscriptEntry
import dev.optio.core.model.LocalTranscriptKind
import dev.optio.core.model.LocalTranscriptRole
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonPrimitive

/**
 * Projects a Local transcript onto [AgentLogEntry] rows so core:ui's `AgentLogView` renders it like
 * every other agent log in the app. A port of iOS `LocalTranscriptLog` (the web's
 * `groupTranscript()` in `transcript-view.tsx`): every `tool_use` is joined with the `tool_result`
 * that answers it (by `toolUseId`) so the result folds under its call, in document order.
 */
object LocalTranscriptLog {
    /** Metadata keys `AgentLogRow` understands beyond the shared `toolName`. */
    const val ROLE_KEY = "role"
    const val SUMMARY_KEY = "summary"
    const val RESULT_KEY = "result"
    const val RESULT_IS_ERROR_KEY = "resultIsError"
    private const val TOOL_NAME_KEY = "toolName"

    fun entries(
        transcript: List<LocalTranscriptEntry>,
        terminalId: String,
    ): List<AgentLogEntry> {
        val results = HashMap<String, LocalTranscriptEntry>()
        for (e in transcript) {
            if (e.kind != LocalTranscriptKind.TOOL_RESULT) continue
            val id = e.toolUseId ?: continue
            results.putIfAbsent(id, e)
        }
        val claimed = HashSet<Double>()
        for (e in transcript) {
            if (e.kind != LocalTranscriptKind.TOOL_USE) continue
            val result = e.toolUseId?.let(results::get) ?: continue
            claimed += result.seq
        }

        val out = ArrayList<AgentLogEntry>(transcript.size)
        for (e in transcript) {
            val at = e.at.orEmpty()
            when (e.kind) {
                LocalTranscriptKind.TOOL_USE -> {
                    val result = e.toolUseId?.let(results::get)
                    val meta = LinkedHashMap<String, JsonElement>()
                    meta[SUMMARY_KEY] = JsonPrimitive(e.text)
                    e.toolName?.let { meta[TOOL_NAME_KEY] = JsonPrimitive(it) }
                    if (result != null) {
                        meta[RESULT_KEY] = JsonPrimitive(result.text)
                        meta[RESULT_IS_ERROR_KEY] = JsonPrimitive(result.isError)
                    }
                    out += AgentLogEntry(terminalId, at, type = AgentLogEntry.TypeValue.TOOL_USE, content = e.detail.orEmpty(), metadata = meta)
                }
                LocalTranscriptKind.TOOL_RESULT -> {
                    // Unmatched results (a call whose entry was capped away) stay as their own rows.
                    if (e.seq in claimed) continue
                    val meta = LinkedHashMap<String, JsonElement>()
                    e.toolName?.let { meta[TOOL_NAME_KEY] = JsonPrimitive(it) }
                    if (e.isError) meta[RESULT_IS_ERROR_KEY] = JsonPrimitive(true)
                    out += AgentLogEntry(terminalId, at, type = AgentLogEntry.TypeValue.TOOL_RESULT, content = e.text, metadata = meta)
                }
                LocalTranscriptKind.THINKING ->
                    out += AgentLogEntry(terminalId, at, type = AgentLogEntry.TypeValue.THINKING, content = e.text)
                LocalTranscriptKind.TEXT, LocalTranscriptKind.UNKNOWN -> {
                    val meta = if (e.role == LocalTranscriptRole.USER) mapOf<String, JsonElement>(ROLE_KEY to JsonPrimitive("user")) else null
                    out += AgentLogEntry(terminalId, at, type = AgentLogEntry.TypeValue.TEXT, content = e.text, metadata = meta)
                }
            }
        }
        return out
    }
}
