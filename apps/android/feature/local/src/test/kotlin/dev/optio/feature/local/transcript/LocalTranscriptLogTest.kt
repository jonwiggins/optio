package dev.optio.feature.local.transcript

import dev.optio.core.model.AgentLogEntry
import dev.optio.core.model.LocalTranscriptEntry
import dev.optio.core.model.LocalTranscriptKind
import dev.optio.core.model.LocalTranscriptRole
import dev.optio.core.model.boolValue
import dev.optio.core.model.stringValue
import dev.optio.core.testing.Fixtures
import dev.optio.feature.local.api.LocalTranscriptPage
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue
import org.junit.Test

/** [LocalTranscriptLog]: the web's `transcript-view.test.ts` vectors plus the DevLab recorded session. */
class LocalTranscriptLogTest {
    private fun e(
        seq: Int,
        role: LocalTranscriptRole = LocalTranscriptRole.ASSISTANT,
        kind: LocalTranscriptKind = LocalTranscriptKind.TEXT,
        toolName: String? = null,
        toolUseId: String? = null,
        isError: Boolean = false,
    ) = LocalTranscriptEntry(
        seq = seq.toDouble(),
        role = role,
        kind = kind,
        text = "t$seq",
        detail = if (kind == LocalTranscriptKind.TOOL_USE) "{\"n\":$seq}" else null,
        toolName = toolName,
        toolUseId = toolUseId,
        isError = isError,
    )

    /** "e:<text>" for a plain row, "tool:<summary>-><result>" for a call with its folded result. */
    private fun shape(rows: List<AgentLogEntry>): List<String> =
        rows.map { row ->
            when (row.type) {
                AgentLogEntry.TypeValue.TOOL_USE -> "tool:${row.metadata?.get("summary")?.stringValue}->${row.metadata?.get("result")?.stringValue}"
                else -> "e:${row.content}"
            }
        }

    @Test
    fun foldsEachToolResultUnderItsCallAndKeepsDocumentOrder() {
        val rows =
            LocalTranscriptLog.entries(
                listOf(
                    e(1, LocalTranscriptRole.USER),
                    e(2, kind = LocalTranscriptKind.TOOL_USE, toolName = "Bash", toolUseId = "a"),
                    e(3, kind = LocalTranscriptKind.TOOL_USE, toolName = "Read", toolUseId = "b"),
                    e(4, LocalTranscriptRole.TOOL, LocalTranscriptKind.TOOL_RESULT, toolUseId = "b"),
                    e(5, LocalTranscriptRole.TOOL, LocalTranscriptKind.TOOL_RESULT, toolUseId = "a"),
                    e(6),
                ),
                terminalId = "t1",
            )
        assertEquals(listOf("e:t1", "tool:t2->t5", "tool:t3->t4", "e:t6"), shape(rows))
    }

    @Test
    fun leavesAnOrphanResultAndACallWithoutAResultStanding() {
        val rows =
            LocalTranscriptLog.entries(
                listOf(
                    e(1, kind = LocalTranscriptKind.TOOL_USE, toolUseId = "x"),
                    e(2, LocalTranscriptRole.TOOL, LocalTranscriptKind.TOOL_RESULT, toolUseId = "gone"),
                ),
                terminalId = "t1",
            )
        assertEquals(listOf("tool:t1->null", "e:t2"), shape(rows))
        assertEquals(AgentLogEntry.TypeValue.TOOL_RESULT, rows[1].type)
    }

    @Test
    fun marksPromptsThinkingAndFailedResultsTheWayAgentLogRowReadsThem() {
        val rows =
            LocalTranscriptLog.entries(
                listOf(
                    e(1, LocalTranscriptRole.USER),
                    e(2, kind = LocalTranscriptKind.THINKING),
                    e(3, kind = LocalTranscriptKind.TOOL_USE, toolName = "Bash", toolUseId = "a"),
                    e(4, LocalTranscriptRole.TOOL, LocalTranscriptKind.TOOL_RESULT, toolUseId = "a", isError = true),
                ),
                terminalId = "t1",
            )
        assertEquals("user", rows[0].metadata?.get("role")?.stringValue)
        assertEquals(AgentLogEntry.TypeValue.THINKING, rows[1].type)
        assertNull(rows[1].metadata)
        val call = rows[2]
        assertEquals("Bash", call.metadata?.get("toolName")?.stringValue)
        assertEquals("{\"n\":3}", call.content, "the body is the call's full input")
        assertEquals(true, call.metadata?.get("resultIsError")?.boolValue)
        assertEquals(3, rows.size)
    }

    @Test
    fun theRecordedDevLabSessionReadsAsNineRows() {
        val page = Fixtures.decode<LocalTranscriptPage>("local-transcript.json")
        assertEquals(14, page.entries.size)
        val rows = LocalTranscriptLog.entries(page.entries, terminalId = "t1")
        assertEquals(9, rows.size, "five calls fold their results")
        assertEquals("user", rows.first().metadata?.get("role")?.stringValue)
        assertTrue(rows.last().content.startsWith("## Fixed the flaky test"))
        val failing = rows.first { it.metadata?.get("resultIsError")?.boolValue == true }
        assertEquals("npm test -- format-date", failing.metadata?.get("summary")?.stringValue)
    }
}
