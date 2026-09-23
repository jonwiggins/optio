package dev.optio.feature.tasks.job

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Text
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp
import dev.optio.core.model.boolValue
import dev.optio.core.ui.components.ErrorRow
import dev.optio.core.ui.theme.OptioTheme
import dev.optio.core.ui.theme.ProvideElevatedSurfaces
import dev.optio.core.ui.theme.Spacing
import dev.optio.feature.tasks.common.FormPicker
import dev.optio.feature.tasks.common.FormSwitch
import dev.optio.feature.tasks.common.FormTextField
import dev.optio.feature.tasks.data.JobParamField
import dev.optio.feature.tasks.data.JobRun
import dev.optio.feature.tasks.data.JobSummary
import dev.optio.feature.tasks.task.SheetHeader
import kotlin.coroutines.cancellation.CancellationException
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonPrimitive

/**
 * The Run Job sheet's rules (iOS `RunJobSheet`, web `RunWorkflowDialog` + `WorkflowParamsForm`):
 * which fields are missing, and the `params` a run is posted with.
 */
object RunJobForm {
    /** A required non-boolean field with neither a value nor a default. */
    fun missingRequired(fields: List<JobParamField>, values: Map<String, String>): Boolean =
        fields.any { f -> f.required && f.type != "boolean" && (values[f.name] ?: f.defaultText ?: "").isEmpty() }

    /**
     * `params` for `POST /api/jobs/:id/runs`: booleans as booleans, numbers as numbers (whole when
     * they are), strings as typed; an untouched field sends its default; null when nothing is set.
     */
    fun buildParams(fields: List<JobParamField>, values: Map<String, String>, bools: Map<String, Boolean>): Map<String, JsonElement>? {
        val out = LinkedHashMap<String, JsonElement>()
        for (f in fields) {
            when (f.type) {
                "boolean" -> (bools[f.name] ?: f.defaultValue?.boolValue)?.let { out[f.name] = JsonPrimitive(it) }
                "number", "integer" -> {
                    val raw = values[f.name].orEmpty().trim()
                    val int = raw.toLongOrNull()
                    val double = raw.toDoubleOrNull()
                    when {
                        int != null -> out[f.name] = JsonPrimitive(int)
                        double != null -> out[f.name] = JsonPrimitive(double)
                        f.defaultValue != null -> out[f.name] = f.defaultValue
                    }
                }
                else -> {
                    val raw = values[f.name].orEmpty()
                    when {
                        raw.isNotEmpty() -> out[f.name] = JsonPrimitive(raw)
                        f.defaultValue != null -> out[f.name] = f.defaultValue
                    }
                }
            }
        }
        return out.ifEmpty { null }
    }
}

/**
 * "Run Job" (iOS `RunJobSheet`): one input per `paramsSchema` property — string, number, boolean
 * or enum — then Run. [onRun] starts the run; an error stays in the sheet.
 */
@Composable
fun RunJobSheet(
    job: JobSummary,
    onRun: suspend (Map<String, JsonElement>?) -> JobRun,
    onDismiss: () -> Unit,
) {
    val sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)
    ModalBottomSheet(onDismissRequest = onDismiss, sheetState = sheetState, modifier = Modifier.testTag("run-job-sheet")) {
        RunJobForm(job = job, onRun = { params ->
            onRun(params)
            sheetState.hide()
            onDismiss()
        }, onCancel = onDismiss)
    }
}

/** The sheet's body, also rendered on its own in screenshots. */
@Composable
fun RunJobForm(
    job: JobSummary,
    onRun: suspend (Map<String, JsonElement>?) -> Unit,
    onCancel: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val fields = remember(job) { job.paramFields }
    val values = remember { mutableStateMapOf<String, String>() }
    val bools = remember { mutableStateMapOf<String, Boolean>() }
    var submitting by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<Throwable?>(null) }
    val scope = rememberCoroutineScope()
    val missing = RunJobForm.missingRequired(fields, values)
    ProvideElevatedSurfaces {
        Column(
            modifier.fillMaxWidth().verticalScroll(rememberScrollState()).padding(horizontal = Spacing.l).navigationBarsPadding().imePadding(),
            verticalArrangement = Arrangement.spacedBy(Spacing.m),
        ) {
            SheetHeader(
                title = "Run Job",
                confirmLabel = if (submitting) "Starting…" else "Run",
                canConfirm = !missing,
                busy = submitting,
                onCancel = onCancel,
                onConfirm = {
                    submitting = true
                    error = null
                    scope.launch {
                        try {
                            onRun(RunJobForm.buildParams(fields, values, bools))
                        } catch (e: CancellationException) {
                            throw e
                        } catch (e: Exception) {
                            error = e
                        } finally {
                            submitting = false
                        }
                    }
                },
                confirmTag = "run-job-confirm",
            )
            Text(
                buildAnnotatedString {
                    append("Start a new run of ")
                    withStyle(SpanStyle(fontWeight = FontWeight.SemiBold)) { append(job.name) }
                },
                style = OptioTheme.type.subheadline,
                color = OptioTheme.colors.label,
            )
            if (fields.isEmpty()) {
                Text("This job takes no parameters.", style = OptioTheme.type.footnote, color = OptioTheme.colors.secondaryLabel)
            } else {
                Text("Parameters", style = OptioTheme.type.sectionHeader, color = OptioTheme.colors.secondaryLabel)
                fields.forEach { field -> ParamField(field, values, bools) }
            }
            error?.let { ErrorRow(it, contentPadding = PaddingValues(0.dp)) }
            Spacer(Modifier.height(Spacing.l))
        }
    }
}

@Composable
private fun ParamField(
    field: JobParamField,
    values: MutableMap<String, String>,
    bools: MutableMap<String, Boolean>,
) {
    val label = if (field.required) "${field.name} *" else field.name
    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
        when {
            field.type == "boolean" -> FormSwitch(
                label = label,
                checked = bools[field.name] ?: field.defaultValue?.boolValue ?: false,
                onCheckedChange = { bools[field.name] = it },
                testTag = "param-${field.name}",
            )
            field.options.isNotEmpty() -> FormPicker(
                label = label,
                selection = values[field.name] ?: field.defaultText.orEmpty(),
                options = listOf("" to "Select…") + field.options.map { it to it },
                onSelect = { values[field.name] = it },
                testTag = "param-${field.name}",
            )
            else -> FormTextField(
                value = values[field.name].orEmpty(),
                onValueChange = { values[field.name] = it },
                label = label,
                placeholder = field.defaultText,
                keyboardType = if (field.type == "number" || field.type == "integer") KeyboardType.Decimal else KeyboardType.Text,
                capitalization = KeyboardCapitalization.None,
                testTag = "param-${field.name}",
            )
        }
        field.description?.takeIf { it.isNotEmpty() }?.let {
            Text(it, style = OptioTheme.type.caption2, color = OptioTheme.colors.secondaryLabel)
        }
    }
}
