package dev.optio.feature.tasks.job

import dev.optio.core.model.OptioJson
import dev.optio.feature.tasks.data.JobSummary
import dev.optio.feature.tasks.data.TriggerDraft
import dev.optio.feature.tasks.data.TriggerKind
import dev.optio.feature.tasks.data.TriggerRow
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonObject

/** The Job form (iOS `JobFormView`) and Run Job sheet (iOS `RunJobSheet`) rules. */
class JobFormLogicTest {
    private val schemaJob = OptioJson.decodeFromString<JobSummary>(
        """
        {
          "id": "j1", "name": "Triage", "promptTemplate": "Triage {{ALERT}} in {{REPO}} ({{DRY_RUN}}, {{LIMIT}}, {{MODE}})",
          "paramsSchema": {
            "type": "object",
            "properties": {
              "REPO": {"type": "string", "description": "owner/name", "default": "acme/web"},
              "ALERT": {"type": "string", "description": "Sentry alert"},
              "DRY_RUN": {"type": "boolean", "default": true},
              "LIMIT": {"type": "integer", "default": 5},
              "MODE": {"type": "string", "enum": ["quick", "deep"]}
            },
            "required": ["ALERT", "MODE"]
          }
        }
        """,
    )

    @Test
    fun paramFieldsComeFromTheSchemaSortedByName() {
        val fields = schemaJob.paramFields
        assertEquals(listOf("ALERT", "DRY_RUN", "LIMIT", "MODE", "REPO"), fields.map { it.name })
        val mode = fields.single { it.name == "MODE" }
        assertEquals(listOf("quick", "deep"), mode.options)
        assertTrue(mode.required)
        assertEquals("5", fields.single { it.name == "LIMIT" }.defaultText)
        assertEquals("acme/web", fields.single { it.name == "REPO" }.defaultText)
        assertEquals("owner/name", fields.single { it.name == "REPO" }.description)
    }

    @Test
    fun runSheetRequiresRequiredFields() {
        val fields = schemaJob.paramFields
        assertTrue(RunJobForm.missingRequired(fields, emptyMap()))
        assertTrue(RunJobForm.missingRequired(fields, mapOf("ALERT" to "boom")))
        assertFalse(RunJobForm.missingRequired(fields, mapOf("ALERT" to "boom", "MODE" to "deep")))
    }

    @Test
    fun runSheetBuildsTypedParamsWithDefaults() {
        val fields = schemaJob.paramFields
        val params = RunJobForm.buildParams(fields, mapOf("ALERT" to "boom", "MODE" to "deep", "LIMIT" to "12"), emptyMap())!!
        assertEquals(JsonPrimitive("boom"), params["ALERT"])
        assertEquals(JsonPrimitive(true), params["DRY_RUN"], "untouched boolean sends its default")
        assertEquals(JsonPrimitive(12L), params["LIMIT"])
        assertEquals(JsonPrimitive("deep"), params["MODE"])
        assertEquals(JsonPrimitive("acme/web"), params["REPO"], "untouched string sends its default")

        val decimals = RunJobForm.buildParams(fields, mapOf("LIMIT" to "2.5"), mapOf("DRY_RUN" to false))!!
        assertEquals(JsonPrimitive(2.5), decimals["LIMIT"])
        assertEquals(JsonPrimitive(false), decimals["DRY_RUN"])
        assertEquals(JsonPrimitive(5), RunJobForm.buildParams(fields, mapOf("LIMIT" to "x"), emptyMap())!!["LIMIT"], "garbage falls back to the default")

        assertNull(RunJobForm.buildParams(emptyList(), emptyMap(), emptyMap()), "no fields, no params")
    }

    @Test
    fun detectedParamsAreUniqueInOrder() {
        val draft = JobDraft(promptTemplate = "{{B}} then {{A}} and {{B}} again; {{ not_a_param }}, {{C_1}}")
        assertEquals(listOf("B", "A", "C_1"), draft.detectedParams)
    }

    @Test
    fun paramsSchemaKeepsExistingDefinitions() {
        val draft = JobDraft.of(schemaJob, emptyList()).copy(promptTemplate = "Look at {{REPO}} and {{NEW}}")
        val schema = draft.paramsSchema()!!
        val props = schema["properties"]!!.jsonObject
        assertEquals(setOf("REPO", "NEW"), props.keys)
        assertEquals(JsonPrimitive("owner/name"), props["REPO"]!!.jsonObject["description"])
        assertEquals(JsonObject(mapOf("type" to JsonPrimitive("string"), "description" to JsonPrimitive(""))), props["NEW"])
        assertEquals(JsonArray(listOf(JsonPrimitive("REPO"), JsonPrimitive("NEW"))), schema["required"])

        // No placeholders: an edit keeps the saved schema, a new job sends none.
        assertEquals(JsonObject(schemaJob.paramsSchema!!), JobDraft.of(schemaJob, emptyList()).copy(promptTemplate = "plain").paramsSchema())
        assertNull(JobDraft(promptTemplate = "plain").paramsSchema())
    }

    @Test
    fun createBodyOmitsUnsetOptionals() {
        val body = JobDraft(name = " Nightly ", promptTemplate = "Go").createBody()
        assertEquals("Nightly", body["name"])
        assertEquals(false, body.containsKey("model"))
        assertEquals(false, body.containsKey("maxTurns"))
        assertEquals(false, body.containsKey("budgetUsd"))
        assertEquals(false, body.containsKey("description"))
        assertEquals(false, body.containsKey("paramsSchema"))
        assertEquals(2, body["maxConcurrent"])

        val full = JobDraft(name = "N", promptTemplate = "{{X}}", modelName = "opus", maxTurns = "20", budgetUsd = "5.00", description = "d").createBody()
        assertEquals("opus", full["model"])
        assertEquals(20, full["maxTurns"])
        assertEquals("5.00", full["budgetUsd"])
        assertTrue(full["paramsSchema"] is JsonObject)
    }

    @Test
    fun updateBodyClearsWhatTheUserCleared() {
        val saved = OptioJson.decodeFromString<JobSummary>("""{"id":"j1","name":"N","promptTemplate":"Go","model":"opus","maxTurns":10,"budgetUsd":"2.00","description":"old"}""")
        val body = JobDraft.of(saved, emptyList()).copy(modelName = "", maxTurns = "", budgetUsd = "", description = "").updateBody()
        assertTrue(body.containsKey("model") && body["model"] == null)
        assertTrue(body.containsKey("maxTurns") && body["maxTurns"] == null)
        assertTrue(body.containsKey("budgetUsd") && body["budgetUsd"] == null)
        assertEquals("", body["description"], "description takes no null: an empty string clears it")
    }

    @Test
    fun canSaveNeedsNamePromptValidLimitsAndValidTriggers() {
        val ok = JobDraft(name = "N", promptTemplate = "Go")
        assertTrue(ok.canSave)
        assertFalse(ok.copy(name = " ").canSave)
        assertFalse(ok.copy(promptTemplate = "").canSave)
        assertFalse(ok.copy(maxTurns = "0").canSave)
        assertFalse(ok.copy(budgetUsd = "0").canSave)
        assertTrue(ok.copy(maxTurns = "30", budgetUsd = "1.5").canSave)
        assertFalse(ok.copy(triggers = listOf(TriggerDraft.new(TriggerKind.SCHEDULE).withString("cronExpression", "nope"))).canSave)
        assertTrue(ok.copy(triggers = listOf(TriggerDraft.new(TriggerKind.SCHEDULE).withString("cronExpression", "nope").copy(deleted = true))).canSave)
    }

    @Test
    fun removingTriggers() {
        val saved = TriggerDraft.of(TriggerRow(id = "t1", type = "manual"))
        val fresh = TriggerDraft.new(TriggerKind.WEBHOOK)
        val draft = JobDraft(triggers = listOf(saved, fresh))
        val removed = draft.removeTrigger(saved.key).removeTrigger(fresh.key)
        assertEquals(1, removed.triggers.size, "a new trigger just goes")
        assertTrue(removed.triggers.single().deleted, "a saved one is deleted on save")
        assertTrue(removed.visibleTriggers.isEmpty())
        assertEquals(TriggerKind.MANUAL, draft.addTrigger().triggers.last().type)
    }
}
