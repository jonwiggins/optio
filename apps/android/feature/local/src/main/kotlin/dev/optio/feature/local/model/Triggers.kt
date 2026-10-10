package dev.optio.feature.local.model

import androidx.compose.ui.graphics.vector.ImageVector
import dev.optio.core.ui.components.triggerIcon
import dev.optio.core.ui.triggers.EventTriggerType
import dev.optio.core.ui.triggers.WhenType
import dev.optio.core.ui.triggers.string
import dev.optio.core.ui.triggers.triggerSummary
import dev.optio.feature.local.api.LocalTrigger
import kotlinx.serialization.json.JsonObject

/**
 * How a Local automation's trigger rows read. The vocabulary, the editor and the summaries are
 * the app's one trigger model (`core.ui.triggers`: every one of the fourteen types, the same as
 * the New work form and a persistent agent's triggers); this keeps only the row-level helpers.
 */
object Triggers {
    /** The type as its row names it ("Schedule", "GitHub", "Manual"); an unknown type reads capitalized. */
    fun label(trigger: LocalTrigger): String = WhenType.fromRaw(trigger.type)?.typeLabel ?: trigger.type.replaceFirstChar { it.uppercase() }

    /** The row's mark: the brand it listens to, a ticket source's logo, else the type's icon. */
    fun icon(trigger: LocalTrigger): ImageVector = triggerIcon(trigger.type, trigger.config?.string("source"))

    /** One line describing what fires it. */
    fun summary(trigger: LocalTrigger): String = summary(trigger.type, trigger.config)

    fun summary(
        type: String,
        config: JsonObject?,
    ): String = triggerSummary(type, config)

    /**
     * The shared secret a just-created Pylon / Alertmanager / Datadog trigger carries (the create
     * response is the only read that has it; later reads say `hasSecret`).
     */
    fun createdSecret(trigger: LocalTrigger): String? {
        EventTriggerType.fromRaw(trigger.type)?.takeIf { it.selfSecret } ?: return null
        return trigger.config?.string("secret")?.takeIf { it.isNotEmpty() }
    }
}
