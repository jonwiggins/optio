package dev.optio.feature.local.machines

import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.KeyboardArrowRight
import androidx.compose.material.icons.outlined.AccountTree
import androidx.compose.material.icons.outlined.Folder
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import dev.optio.core.model.LocalBlueprint
import dev.optio.core.model.LocalBlueprintSpawnMode
import dev.optio.core.model.LocalAgentSessionMode
import dev.optio.core.model.LocalHost
import dev.optio.core.model.LocalHostDir
import dev.optio.core.model.LocalHostState
import dev.optio.core.ui.components.OptioRow
import dev.optio.core.ui.components.StateDot
import dev.optio.core.ui.components.cardSurface
import dev.optio.core.ui.components.metaText
import dev.optio.core.ui.components.mono
import dev.optio.core.ui.format.LocalClock
import dev.optio.core.ui.format.relativeDescription
import dev.optio.core.ui.theme.OptioTheme
import dev.optio.core.ui.theme.Spacing
import dev.optio.core.ui.theme.Tone
import dev.optio.core.ui.theme.mono
import dev.optio.core.ui.theme.semibold
import dev.optio.feature.local.api.LocalTrigger
import dev.optio.feature.local.model.LocalPresentation
import dev.optio.feature.local.model.Triggers

/** "online" / "seen 3 min. ago" / "offline" (iOS `MachineCard.seen`). */
@Composable
internal fun hostSeen(host: LocalHost): String {
    if (host.state == LocalHostState.ONLINE) return "online"
    val now = LocalClock.current.instant()
    return host.lastSeenAt?.let { "seen ${it.relativeDescription(now)}" } ?: "offline"
}

/** `hostname · platform · arch · daemon 0.6.3` (iOS `MachineCard.facts`). */
internal fun hostFacts(host: LocalHost): String =
    listOfNotNull(host.hostname, host.platform, host.arch, host.daemonVersion?.let { "daemon $it" })
        .filter { it.isNotEmpty() }
        .joinToString(" · ")

/**
 * One machine (iOS `MachineCard`): the online dot and name, when it was last seen, the facts line,
 * and its directories with detected checkouts marked. A tap opens the machine; a long press offers
 * Forget.
 */
@OptIn(ExperimentalFoundationApi::class)
@Composable
internal fun MachineCard(
    host: LocalHost,
    modifier: Modifier = Modifier,
    onClick: (() -> Unit)? = null,
    onLongClick: (() -> Unit)? = null,
) {
    val colors = OptioTheme.colors
    val type = OptioTheme.type
    val online = host.state == LocalHostState.ONLINE
    val clickable =
        if (onClick != null || onLongClick != null) {
            Modifier.combinedClickable(onClick = onClick ?: {}, onLongClick = onLongClick, role = Role.Button, onClickLabel = "Open ${host.name}")
        } else {
            Modifier
        }
    Column(
        modifier
            .fillMaxWidth()
            .cardSurface(padding = 0.dp)
            .then(clickable)
            .padding(Spacing.m)
            .testTag("machine-${host.id}"),
        verticalArrangement = Arrangement.spacedBy(Spacing.s),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(Spacing.s)) {
            StateDot(if (online) Tone.SUCCESS else Tone.IDLE, pulse = false)
            Text(host.name, style = type.body.semibold(), color = colors.label, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f, fill = false))
            Spacer(Modifier.weight(1f))
            Text(hostSeen(host), style = type.footnote, color = if (online) Tone.SUCCESS.textColor else colors.tertiaryLabel, maxLines = 1)
            if (onClick != null) {
                Icon(Icons.AutoMirrored.Filled.KeyboardArrowRight, contentDescription = null, tint = colors.tertiaryLabel, modifier = Modifier.size(18.dp))
            }
        }
        Text(hostFacts(host), style = type.footnote, color = colors.secondaryLabel, maxLines = 1, overflow = TextOverflow.MiddleEllipsis)
        if (host.dirs.isEmpty()) {
            Text("No directories exposed — `optio local add <dir>` on the machine.", style = type.footnote, color = colors.tertiaryLabel)
        } else {
            Column(Modifier.padding(top = 2.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                host.dirs.forEach { DirLine(it) }
            }
        }
    }
}

/** One allowlisted directory: a branch icon for a checkout, its `~/…` path, and the repo. */
@Composable
internal fun DirLine(
    dir: LocalHostDir,
    modifier: Modifier = Modifier,
) {
    val colors = OptioTheme.colors
    val type = OptioTheme.type
    val repo = LocalPresentation.shortRepo(dir.repoUrl)
    Row(modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
        Icon(
            if (dir.repoUrl == null) Icons.Outlined.Folder else Icons.Outlined.AccountTree,
            contentDescription = if (dir.repoUrl == null) "Directory" else "Git checkout",
            tint = if (dir.repoUrl == null) colors.tertiaryLabel else colors.accent,
            modifier = Modifier.size(14.dp),
        )
        Text(
            LocalPresentation.shortDir(dir.path) ?: dir.path,
            style = type.caption.mono(),
            color = colors.label,
            maxLines = 1,
            overflow = TextOverflow.StartEllipsis,
            modifier = Modifier.weight(1f),
        )
        if (repo != null) {
            Spacer(Modifier.width(Spacing.s))
            Text(repo, style = type.caption2, color = colors.secondaryLabel, maxLines = 1, overflow = TextOverflow.StartEllipsis, modifier = Modifier.widthIn(max = 180.dp))
        }
    }
}

/** Where an automation runs, in words: its directory, repo, or "the event's repo". */
internal fun automationWhere(bp: LocalBlueprint): String =
    bp.dir?.let { LocalPresentation.shortDir(it) } ?: LocalPresentation.shortRepo(bp.repoUrl) ?: "the event's repo"

/** [automationWhere] for a meta line: the path or repo in mono, "on <machine>" plain. */
internal fun whereText(
    bp: LocalBlueprint,
    hostName: String?,
): AnnotatedString =
    buildAnnotatedString {
        if (bp.dir != null || bp.repoUrl != null) append(mono(automationWhere(bp))) else append(automationWhere(bp))
        if (hostName != null) append(" on $hostName")
    }

/**
 * One automation (iOS `BlueprintRow`, web `AutomationRow`): name, who runs it and how it ends, where,
 * the template's first line, and its triggers. Paused ones say so.
 */
@Composable
internal fun AutomationRow(
    automation: LocalBlueprint,
    /** Null while they are unknown (not loaded yet, or the fetch failed): then no trigger line. */
    triggers: List<LocalTrigger>?,
    hosts: List<LocalHost>,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    onLongClick: (() -> Unit)? = null,
) {
    val bp = automation
    val who = bp.agent?.let(LocalPresentation::agentLabel) ?: "shell"
    val then =
        when {
            bp.agent == null -> null
            bp.sessionMode == LocalAgentSessionMode.HEADLESS -> "exit when done"
            else -> "keeps session open"
        }
    val host = bp.hostId?.let { id -> hosts.firstOrNull { it.id == id }?.name }
    val meta =
        metaText(
            who,
            then,
            if (bp.spawnMode == LocalBlueprintSpawnMode.HOLD) "hold" else null,
            whereText(bp, host),
        )
    val triggerLine =
        when {
            triggers == null -> null
            triggers.isEmpty() -> "Runs when you press Run"
            else -> triggers.joinToString("  ·  ") { t -> "${Triggers.label(t)}: ${Triggers.summary(t)}" + if (!t.enabled) " (paused)" else "" }
        }
    OptioRow(
        title = bp.name,
        modifier = modifier.testTag("automation-${bp.id}"),
        meta = meta,
        footer = metaText(bp.commandTemplate.lineSequence().firstOrNull()?.takeIf { it.isNotBlank() }?.let { mono(it) }, triggerLine),
        trailing = if (!bp.enabled) "Paused" else null,
        titleMaxLines = 1,
        onClick = onClick,
        onLongClick = onLongClick,
    )
}

/** The iOS empty-state copy for no machines. */
internal const val NO_MACHINES_MESSAGE =
    "On your machine, run `optio login`, then `optio local add <dir>` for each directory to expose, and `optio local up` to connect. It will appear here."

/** The footer under the automations (iOS `MachinesView`). */
internal const val AUTOMATIONS_FOOTER =
    "Agents and terminals that start on one of these machines when something happens — a schedule, a webhook, a ticket, or a GitHub / Slack / Linear event."

/** A centred box for small inline states inside lists. */
@Composable
internal fun Centered(content: @Composable () -> Unit) {
    Box(Modifier.fillMaxWidth().padding(Spacing.l), contentAlignment = Alignment.Center) { content() }
}
