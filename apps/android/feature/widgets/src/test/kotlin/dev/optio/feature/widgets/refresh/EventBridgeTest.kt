package dev.optio.feature.widgets.refresh

import dev.optio.core.network.EventHub
import kotlin.test.assertFalse
import kotlin.test.assertTrue
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import org.junit.Test

/** Which `/ws/events` frames reload the Work widget's task rows (the Watch handles Local changes). */
class EventBridgeTest {
    private fun event(json: String) = EventHub.decode(Json.parseToJsonElement(json) as JsonObject)

    @Test
    fun taskAndRunChangesReloadTaskRows() {
        assertTrue(EventBridge.isTaskEvent(event("""{"type":"task:state_changed","taskId":"t","fromState":"running","toState":"pr_opened","timestamp":"2026-09-22T16:40:00Z"}""")))
        assertTrue(EventBridge.isTaskEvent(event("""{"type":"task:created","taskId":"t","title":"x","timestamp":"2026-09-22T16:40:00Z"}""")))
    }

    @Test
    fun logsMessagesAndLocalChangesDoNot() {
        assertFalse(EventBridge.isTaskEvent(event("""{"type":"task:log","taskId":"t","content":"hi","timestamp":"2026-09-22T16:40:00Z"}""")))
        assertFalse(EventBridge.isTaskEvent(event("""{"type":"local:changed","terminalId":"x"}""")), "the Watch follows Local changes")
        assertFalse(EventBridge.isTaskEvent(event("""{"type":"something:new"}""")))
    }
}
