package dev.optio.feature.tasks.job

import dev.optio.core.model.objectValue
import dev.optio.feature.tasks.data.JobSummary
import dev.optio.feature.tasks.data.TriggerDraft
import dev.optio.feature.tasks.data.TriggerRow
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

/**
 * The Job form's answers (iOS `JobFormView`'s state; web `WorkflowForm`): basics, agent, limits,
 * the prompt template with `{{PARAM}}` detection, and the triggers, diffed on save. Pure: the
 * ViewModel holds one and replaces it on every edit.
 */
data class JobDraft(
    val name: String = "",
    val description: String = "",
    val enabled: Boolean = true,
    val agentRuntime: String = "claude-code",
    val modelName: String = "",
    val maxTurns: String = "",
    val budgetUsd: String = "",
    val maxConcurrent: Int = 2,
    val maxRetries: Int = 1,
    val warmPoolSize: Int = 0,
    val maxPodInstances: Int = 1,
    val maxAgentsPerPod: Int = 2,
    val promptTemplate: String = "",
    val triggers: List<TriggerDraft> = emptyList(),
    /** The saved job being edited (null while creating). */
    val original: JobSummary? = null,
) {
    val isEdit: Boolean get() = original != null

    /** `{{PARAM}}` names in the template, first occurrence first. */
    val detectedParams: List<String>
        get() = PARAM.findAll(promptTemplate).map { it.groupValues[1] }.distinct().toList()

    /** Max turns: empty, or a positive whole number. */
    val maxTurnsValid: Boolean get() = maxTurns.isBlank() || (maxTurns.trim().toIntOrNull() ?: 0) > 0

    /** Budget: empty, or a positive decimal ("5.00"). */
    val budgetValid: Boolean get() = budgetUsd.isBlank() || (budgetUsd.trim().toDoubleOrNull() ?: 0.0) > 0

    /** The triggers still on the form. */
    val visibleTriggers: List<TriggerDraft> get() = triggers.filter { !it.deleted }

    val canSave: Boolean
        get() = name.isNotBlank() && promptTemplate.isNotBlank() && maxTurnsValid && budgetValid &&
            visibleTriggers.all { it.isValid }

    /**
     * `{ type: object, properties, required }` from the `{{PARAM}}`s, keeping any existing
     * per-param definitions (web `buildParamsSchemaFromPrompt`). With none detected an edit keeps
     * the saved schema and a new job sends none.
     */
    fun paramsSchema(): JsonObject? {
        val detected = detectedParams
        val existing = original?.paramsSchema
        if (detected.isEmpty()) return existing?.let(::JsonObject)
        val existingProps = existing?.get("properties")?.objectValue.orEmpty()
        val props = detected.associateWith { p ->
            existingProps[p] ?: JsonObject(mapOf("type" to JsonPrimitive("string"), "description" to JsonPrimitive("")))
        }
        return JsonObject(
            mapOf(
                "type" to JsonPrimitive("object"),
                "properties" to JsonObject(props),
                "required" to JsonArray(detected.map(::JsonPrimitive)),
            ),
        )
    }

    private fun common(): MutableMap<String, Any?> = linkedMapOf(
        "name" to name.trim(),
        "enabled" to enabled,
        "promptTemplate" to promptTemplate,
        "agentRuntime" to agentRuntime,
        "maxConcurrent" to maxConcurrent,
        "maxRetries" to maxRetries,
        "warmPoolSize" to warmPoolSize,
        "maxPodInstances" to maxPodInstances,
        "maxAgentsPerPod" to maxAgentsPerPod,
    )

    /** `POST /api/jobs`: optional fields only when set (the create schema doesn't take nulls). */
    fun createBody(): Map<String, Any?> = common().apply {
        description.trim().takeIf { it.isNotEmpty() }?.let { put("description", it) }
        modelName.trim().takeIf { it.isNotEmpty() }?.let { put("model", it) }
        maxTurns.trim().toIntOrNull()?.let { put("maxTurns", it) }
        budgetUsd.trim().takeIf { it.isNotEmpty() }?.let { put("budgetUsd", it) }
        paramsSchema()?.let { put("paramsSchema", it) }
    }

    /**
     * `PATCH /api/jobs/:id`: everything the form shows, and explicit nulls for the optional
     * values the user cleared, so clearing the model / turn cap / budget sticks (iOS omits nil
     * fields and can't clear them). A cleared description is sent empty (that field takes no null).
     */
    fun updateBody(): Map<String, Any?> = common().apply {
        put("description", description.trim())
        put("model", modelName.trim().ifEmpty { null })
        put("maxTurns", maxTurns.trim().toIntOrNull())
        put("budgetUsd", budgetUsd.trim().ifEmpty { null })
        paramsSchema()?.let { put("paramsSchema", it) }
    }

    fun withTrigger(key: String, transform: (TriggerDraft) -> TriggerDraft): JobDraft =
        copy(triggers = triggers.map { if (it.key == key) transform(it) else it })

    /** Removes a trigger: a saved one is marked for deletion on save, a new one just goes. */
    fun removeTrigger(key: String): JobDraft = copy(
        triggers = triggers.mapNotNull {
            when {
                it.key != key -> it
                it.existingId != null -> it.copy(deleted = true)
                else -> null
            }
        },
    )

    fun addTrigger(): JobDraft = copy(triggers = triggers + TriggerDraft.new())

    companion object {
        private val PARAM = Regex("\\{\\{(\\w+)\\}\\}")

        /** The form for an existing job (iOS `seed()`). */
        fun of(job: JobSummary, triggers: List<TriggerRow>): JobDraft = JobDraft(
            name = job.name,
            description = job.description.orEmpty(),
            enabled = job.isEnabled,
            agentRuntime = job.runtime,
            modelName = job.model.orEmpty(),
            maxTurns = job.maxTurns?.toString().orEmpty(),
            budgetUsd = job.budgetUsd.orEmpty(),
            maxConcurrent = job.maxConcurrent ?: 2,
            maxRetries = job.maxRetries ?: 1,
            warmPoolSize = job.warmPoolSize ?: 0,
            maxPodInstances = job.maxPodInstances ?: 1,
            maxAgentsPerPod = job.maxAgentsPerPod ?: 2,
            promptTemplate = job.promptTemplate.orEmpty(),
            triggers = triggers.map(TriggerDraft::of),
            original = job,
        )
    }
}

/** A JSON value as the run sheet and details show it. */
internal fun JsonElement.displayText(): String = (this as? JsonPrimitive)?.content ?: toString()
