package dev.optio.feature.local.automations

import dev.optio.core.model.LocalAgentKind
import dev.optio.core.model.LocalAgentSessionMode
import dev.optio.core.model.LocalBlueprint
import dev.optio.core.model.LocalBlueprintSpawnMode
import dev.optio.feature.local.api.LocalBlueprintBody

/**
 * The automation form's answers (iOS `BlueprintFormSheet`'s state, plus the web editor's "the
 * event's repo" location and Then): pure, so the save rules are unit-tested.
 */
data class AutomationForm(
    val name: String = "",
    val description: String = "",
    /** "" = any online host. */
    val hostId: String = "",
    val location: Location = Location.DIR,
    val dir: String = "",
    val repoUrl: String = "",
    /** Null = a shell command. */
    val agent: LocalAgentKind? = LocalAgentKind.CLAUDE_CODE,
    val commandTemplate: String = "",
    val sessionMode: LocalAgentSessionMode = LocalAgentSessionMode.INTERACTIVE,
    val spawnMode: LocalBlueprintSpawnMode = LocalBlueprintSpawnMode.HOLD,
) {
    /** How the directory is found (`resolveBlueprintDir` on the server). */
    enum class Location(val label: String) {
        DIR("Directory"),
        REPO("Repo URL"),
        EVENT("Event's repo"),
    }

    val canSave: Boolean
        get() =
            name.isNotBlank() &&
                commandTemplate.isNotBlank() &&
                when (location) {
                    Location.DIR -> dir.isNotBlank()
                    Location.REPO -> repoUrl.isNotBlank()
                    Location.EVENT -> true
                }

    /** Why Save is off, in words (null when it's on). */
    val problem: String?
        get() =
            when {
                name.isBlank() -> "Give it a name."
                commandTemplate.isBlank() -> if (agent == null) "Write the command it runs." else "Write the prompt."
                location == Location.DIR && dir.isBlank() -> "Pick a directory."
                location == Location.REPO && repoUrl.isBlank() -> "Enter the repo URL."
                else -> null
            }

    /**
     * The request body. Creating omits what's unset; [editing] also sends explicit nulls for what
     * was cleared (any host, no description, the other location field, a shell command), so the
     * PATCH really moves the row.
     */
    fun body(editing: Boolean): LocalBlueprintBody =
        LocalBlueprintBody(
            name = name.trim(),
            description = description.trim().ifEmpty { null },
            hostId = hostId.ifEmpty { null },
            dir = if (location == Location.DIR) dir.trim() else null,
            repoUrl = if (location == Location.REPO) repoUrl.trim() else null,
            commandTemplate = commandTemplate.trim(),
            agent = agent,
            spawnMode = spawnMode,
            sessionMode = if (agent != null) sessionMode else null,
            clearAgent = editing && agent == null,
            clearHost = editing && hostId.isEmpty(),
            clearDescription = editing && description.isBlank(),
            clearLocation = editing,
        )

    companion object {
        /** The form for an existing automation (iOS `onAppear`, web `formFromBlueprint`). */
        fun from(bp: LocalBlueprint): AutomationForm =
            AutomationForm(
                name = bp.name,
                description = bp.description.orEmpty(),
                hostId = bp.hostId.orEmpty(),
                location =
                    when {
                        bp.dir != null -> Location.DIR
                        bp.repoUrl != null -> Location.REPO
                        else -> Location.EVENT
                    },
                dir = bp.dir.orEmpty(),
                repoUrl = bp.repoUrl.orEmpty(),
                agent = bp.agent?.takeIf { it != LocalAgentKind.UNKNOWN },
                commandTemplate = bp.commandTemplate,
                sessionMode = if (bp.sessionMode == LocalAgentSessionMode.HEADLESS) LocalAgentSessionMode.HEADLESS else LocalAgentSessionMode.INTERACTIVE,
                spawnMode = if (bp.spawnMode == LocalBlueprintSpawnMode.AUTO) LocalBlueprintSpawnMode.AUTO else LocalBlueprintSpawnMode.HOLD,
            )

        /** iOS placeholder for the template field. */
        fun placeholder(agent: LocalAgentKind?): String = if (agent == null) "claude {{prompt}}" else "Investigate {{ticketTitle}}"

        /** iOS hint under the template field. */
        fun hint(agent: LocalAgentKind?): String =
            if (agent == null) {
                "Runs as a raw shell command. Params are pre-shell-quoted: write `claude {{prompt}}`, not `claude \"{{prompt}}\"`."
            } else {
                "The template renders as ${dev.optio.feature.local.model.LocalPresentation.agentLabel(agent)}'s prompt. " +
                    "Params are substituted plainly (not shell-quoted): write {{ticketTitle}} as-is."
            }
    }
}
