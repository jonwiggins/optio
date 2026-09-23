package dev.optio.feature.agents

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.ExpandMore
import androidx.compose.material.icons.outlined.Description
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.rotate
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.unit.dp
import dev.optio.core.model.PersistentAgentTurn
import dev.optio.core.model.PersistentAgentTurnHaltReason
import dev.optio.core.model.PersistentAgentWakeSource
import dev.optio.core.navigation.LocalNavigator
import dev.optio.core.network.LocalApiClient
import dev.optio.core.ui.components.EmptyState
import dev.optio.core.ui.components.ErrorRow
import dev.optio.core.ui.components.InsetDivider
import dev.optio.core.ui.components.OptioRow
import dev.optio.core.ui.components.PullRefresh
import dev.optio.core.ui.components.SkeletonRows
import dev.optio.core.ui.components.metaText
import dev.optio.core.ui.format.Cost
import dev.optio.core.ui.format.rememberNow
import dev.optio.core.ui.format.relativeDescription
import dev.optio.core.ui.log.AgentLogView
import dev.optio.core.ui.state.LoadState
import dev.optio.core.ui.state.Loadable
import dev.optio.core.ui.theme.OptioTheme
import dev.optio.core.ui.theme.Radius
import dev.optio.core.ui.theme.Spacing
import dev.optio.core.ui.theme.Tone
import dev.optio.core.ui.theme.mono
import dev.optio.core.ui.theme.semibold
import java.time.Instant
import kotlinx.coroutines.launch

/** The agent's turns, newest first (iOS `AgentTurnsSection`); a row opens the turn. */
@Composable
internal fun AgentTurnsSection(
    turns: LoadState<List<PersistentAgentTurn>>,
    onRefresh: suspend () -> Unit,
    onOpen: (PersistentAgentTurn) -> Unit,
    modifier: Modifier = Modifier,
) {
    val list = turns.value
    val now = rememberNow()
    val scope = rememberCoroutineScope()
    PullRefresh(onRefresh = onRefresh, modifier = modifier) {
        LazyColumn(Modifier.fillMaxSize().testTag("agent-turns")) {
            when {
                list == null && turns is LoadState.Failed ->
                    item { ErrorRow(error = turns.error, what = "turns", retry = { scope.launch { onRefresh() } }) }
                list == null -> item { SkeletonRows() }
                list.isEmpty() ->
                    item {
                        Text(
                            "No turns yet.",
                            style = OptioTheme.type.body,
                            color = OptioTheme.colors.secondaryLabel,
                            modifier = Modifier.padding(horizontal = Spacing.l, vertical = Spacing.m),
                        )
                    }
            }
            itemsIndexed(list.orEmpty(), key = { _, turn -> turn.id }) { index, turn ->
                AgentTurnRow(turn, now, onClick = { onOpen(turn) }, modifier = Modifier.testTag("turn-${turn.turnNumber.toInt()}"))
                if (index < list.orEmpty().lastIndex) InsetDivider()
            }
        }
    }
}

/**
 * One turn (iOS `AgentTurnRow`): its summary (else "Turn #n"), `#n · wake source · when · cost ·
 * tokens`, why it halted (Running while it hasn't), and its error.
 */
@Composable
internal fun AgentTurnRow(
    turn: PersistentAgentTurn,
    now: Instant,
    modifier: Modifier = Modifier,
    onClick: (() -> Unit)? = null,
) {
    val number = turn.turnNumber.toInt()
    val halt = turn.haltReason
    val tokens =
        if (turn.inputTokens != null && turn.outputTokens != null) {
            "${turn.inputTokens!!.toInt()}↑ ${turn.outputTokens!!.toInt()}↓"
        } else {
            null
        }
    OptioRow(
        title = turn.summary?.takeIf { it.isNotEmpty() } ?: "Turn #$number",
        tone =
            when (halt) {
                null -> Tone.WORKING
                PersistentAgentTurnHaltReason.ERROR -> Tone.DANGER
                else -> null
            },
        meta =
            metaText(
                "#$number",
                turn.wakeSource.label,
                (turn.startedAt ?: turn.createdAt).relativeDescription(now),
                Cost.formatIfNonZero(turn.costUsd),
                tokens,
            ),
        trailing = halt?.label ?: "Running",
        trailingTone =
            when (halt) {
                null -> Tone.WORKING
                PersistentAgentTurnHaltReason.ERROR -> Tone.DANGER
                else -> null
            },
        footer = turn.errorMessage?.takeIf { it.isNotEmpty() }?.let(::AnnotatedString),
        onClick = onClick,
        modifier = modifier,
    )
}

/** "max_duration" → "Max Duration" (Swift `capitalized`). */
internal val PersistentAgentTurnHaltReason.label: String
    get() =
        if (this == PersistentAgentTurnHaltReason.UNKNOWN) {
            "Halted"
        } else {
            raw.split('_').joinToString(" ") { word -> word.replaceFirstChar { it.titlecase() } }
        }

/** "webhook", "schedule", … (underscores as spaces). */
internal val PersistentAgentWakeSource.label: String
    get() = if (this == PersistentAgentWakeSource.UNKNOWN) "unknown" else raw.replace('_', ' ')

/**
 * One turn with its prompt and logs (iOS `AgentTurnDetailView`): the turn's row, the prompt it was
 * given behind a disclosure, then its log in the shared transcript renderer.
 */
@Composable
fun AgentTurnScreen(
    agentId: String,
    turnId: String,
    turnNumber: Int = 0,
    modifier: Modifier = Modifier,
) {
    val api = LocalApiClient.current
    val navigator = LocalNavigator.current
    Scaffold(
        modifier = modifier.testTag("agent-turn"),
        topBar = {
            TopAppBar(
                title = { Text(if (turnNumber > 0) "Turn #$turnNumber" else "Turn") },
                navigationIcon = {
                    IconButton(onClick = navigator::pop, modifier = Modifier.testTag("back")) {
                        Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Back")
                    }
                },
            )
        },
    ) { padding ->
        Loadable(
            load = { api.getPersistentAgentTurn(agentId, turnId) },
            key = turnId,
            what = "turn",
            modifier = Modifier.padding(padding),
        ) { detail -> AgentTurnContent(detail, agentId) }
    }
}

/** The body of [AgentTurnScreen] for a loaded turn. */
@Composable
internal fun AgentTurnContent(
    detail: PersistentAgentTurnDetail,
    agentId: String,
    modifier: Modifier = Modifier,
) {
    val now = rememberNow()
    Column(modifier.fillMaxSize()) {
        Column(Modifier.fillMaxWidth().padding(bottom = Spacing.s)) {
            AgentTurnRow(detail.turn, now)
            val prompt = detail.turn.promptUsed
            if (!prompt.isNullOrEmpty()) PromptDisclosure(prompt)
        }
        HorizontalDivider(color = OptioTheme.colors.separator)
        if (detail.logs.isEmpty()) {
            EmptyState(
                title = "No logs",
                icon = Icons.Outlined.Description,
                message = "This turn produced no log output.",
            )
        } else {
            AgentLogView(entries = detail.logs.map { it.asLogEntry(agentId) }, autoScroll = false)
        }
    }
}

/** "Prompt used", collapsed until tapped (iOS `DisclosureGroup`). */
@Composable
private fun PromptDisclosure(prompt: String) {
    var expanded by rememberSaveable { mutableStateOf(false) }
    val chevron by animateFloatAsState(if (expanded) 180f else 0f, label = "chevron")
    val colors = OptioTheme.colors
    Column(Modifier.fillMaxWidth().padding(horizontal = Spacing.l)) {
        Row(
            Modifier
                .fillMaxWidth()
                .clickable(role = Role.Button, onClickLabel = if (expanded) "Hide prompt" else "Show prompt") { expanded = !expanded }
                .padding(vertical = Spacing.s)
                .testTag("prompt-used"),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(Spacing.xs),
        ) {
            Text("Prompt used", style = OptioTheme.type.caption.semibold(), color = colors.label, modifier = Modifier.weight(1f))
            Icon(Icons.Filled.ExpandMore, contentDescription = null, tint = colors.tertiaryLabel, modifier = Modifier.size(18.dp).rotate(chevron))
        }
        AnimatedVisibility(expanded) {
            SelectionContainer {
                Text(
                    prompt,
                    style = OptioTheme.type.caption.mono(),
                    color = colors.label,
                    modifier =
                        Modifier
                            .fillMaxWidth()
                            .heightIn(max = 320.dp)
                            .background(colors.fillTertiary, Radius.smallShape)
                            .verticalScroll(rememberScrollState())
                            .padding(Spacing.s),
                )
            }
        }
    }
}
