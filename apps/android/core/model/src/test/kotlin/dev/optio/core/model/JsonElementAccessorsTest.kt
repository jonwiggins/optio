package dev.optio.core.model

import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonPrimitive
import org.junit.Test

/** The AnyCodable accessors (apps/ios/Optio/Generated/AnyCodable.swift), on `JsonElement`. */
class JsonElementAccessorsTest {
    private val json: JsonElement = OptioJson.parseToJsonElement(
        """{"s":"text","t":"true","n":"42","i":3,"f":3.0,"d":3.5,"big":9007199254740993,
           "b":false,"z":null,"a":[1,"x"],"o":{"k":"v"}}""",
    )

    @Test
    fun readsValuesLikeAnyCodable() {
        assertEquals("text", json["s"]?.stringValue)
        assertNull(json["i"]?.stringValue)

        assertEquals(false, json["b"]?.boolValue)
        assertNull(json["t"]?.boolValue) // a string, not a boolean

        assertEquals(3, json["i"]?.intValue)
        assertEquals(3, json["f"]?.intValue) // whole doubles count
        assertNull(json["d"]?.intValue)
        assertNull(json["n"]?.intValue) // a numeric string is still a string
        assertEquals(9007199254740993L, json["big"]?.longValue)

        assertEquals(3.5, json["d"]?.doubleValue)
        assertEquals(3.0, json["i"]?.doubleValue)
        assertNull(json["b"]?.doubleValue)
        assertNull(json["z"]?.doubleValue)

        assertTrue(json["z"]?.isNull == true)
        assertFalse(json["s"]?.isNull == true)
    }

    @Test
    fun subscriptsAreNullSafe() {
        assertEquals(JsonPrimitive(1), json["a"]?.get(0))
        assertEquals("x", json["a"]?.get(1)?.stringValue)
        assertNull(json["a"]?.get(2))
        assertNull(json["s"]?.get(0))
        assertEquals("v", json["o"]?.get("k")?.stringValue)
        assertNull(json["o"]?.get("missing"))
        assertNull(json["a"]?.get("k"))
        assertEquals(2, json["a"]?.arrayValue?.size)
        assertEquals(setOf("k"), json["o"]?.objectValue?.keys)
        assertNull(json["o"]?.arrayValue)
    }

    @Test
    fun readsGeneratedAnyFields() {
        val task = Fixtures.decode<Map<String, JsonElement>>("task.json").getValue("task")
        val metadata = OptioJson.decodeFromJsonElement(OptioTask.serializer(), task).metadata
        assertEquals("c7a04b1e-3f55-4d0a-a0d3-6f1e2b9c8d77", metadata?.get("taskConfigId")?.stringValue)
        assertEquals(2, metadata?.get("attempt")?.intValue)
        assertEquals(true, metadata?.get("nested")?.get("ok")?.boolValue)
        assertEquals("flaky", metadata?.get("labels")?.get(1)?.stringValue)
    }
}
