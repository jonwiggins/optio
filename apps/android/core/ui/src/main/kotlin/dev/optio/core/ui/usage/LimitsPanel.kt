package dev.optio.core.ui.usage

import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Check
import androidx.compose.material.icons.outlined.KeyOff
import androidx.compose.material.icons.outlined.Refresh
import androidx.compose.material.icons.outlined.Schedule
import androidx.compose.material.icons.outlined.Speed
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp
import dev.optio.core.navigation.LocalNavigator
import dev.optio.core.navigation.Section
import dev.optio.core.ui.components.MeterBar
import dev.optio.core.ui.components.NoticeBanner
import dev.optio.core.ui.components.NumericText
import dev.optio.core.ui.components.cardSurface
import dev.optio.core.ui.format.relativeDescription
import dev.optio.core.ui.format.rememberNow
import dev.optio.core.ui.theme.OptioTheme
import dev.optio.core.ui.theme.Radius
import dev.optio.core.ui.theme.Spacing
import dev.optio.core.ui.theme.Tone
import dev.optio.core.ui.theme.medium
import dev.optio.core.ui.theme.semibold
import dev.optio.core.ui.theme.tabularNums
import dev.optio.core.ui.toast.LocalToaster
import java.time.Duration
import java.time.Instant
import kotlin.time.Duration.Companion.seconds
import kotlinx.coroutines.launch

/**
 * "How far along am I?" for every agent subscription Optio can see (iOS `LimitsPanelView`, web
 * `limits-panel.tsx`): Claude live from the account, Codex from the last snapshot a daemon read
 * off its machine (it only moves when Codex runs). A card with a header (status + refresh) and one
 * block of meters per provider. Renders nothing without a store or without providers. Test tag:
 * `limits-panel`.
 */
@Composable
fun LimitsPanel(
    modifier: Modifier = Modifier,
    store: UsageStore? = LocalUsageStore.current,
) {
    store ?: return
    val providers = store.providerLimits
    if (providers.isEmpty()) return
    val navigator = LocalNavigator.current
    // Tick so "updated 12s ago" stays honest while on screen.
    val now = rememberNow(every = 5.seconds)
    val dim by animateFloatAsState(if (store.refreshing) 0.5f else 1f, label = "limits-refreshing")
    Column(
        modifier = modifier.fillMaxWidth().cardSurface().testTag("limits-panel"),
        verticalArrangement = Arrangement.spacedBy(Spacing.m),
    ) {
        LimitsHeader(store, now)
        Column(Modifier.alpha(dim), verticalArrangement = Arrangement.spacedBy(Spacing.l)) {
            providers.forEach { provider ->
                ProviderLimitsBlock(provider, now) { navigator.open(Section.MACHINES) }
            }
        }
    }
}

@Composable
private fun LimitsHeader(store: UsageStore, now: Instant) {
    val colors = OptioTheme.colors
    val type = OptioTheme.type
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(Spacing.s)) {
        Icon(Icons.Outlined.Speed, contentDescription = null, tint = colors.secondaryLabel, modifier = Modifier.size(16.dp))
        Text("Usage limits", style = type.sectionHeader, color = colors.label, maxLines = 1)
        Row(Modifier.weight(1f), verticalAlignment = Alignment.CenterVertically) {
            val error = store.refreshError
            val at = store.refreshedAt
            when {
                error != null -> Text(error, style = type.caption2, color = colors.red, maxLines = 1, overflow = TextOverflow.Ellipsis)
                store.refreshing -> Text("checking with Anthropic…", style = type.caption2, color = colors.tertiaryLabel, maxLines = 1)
                at != null -> {
                    Icon(Icons.Outlined.Check, contentDescription = null, tint = colors.green, modifier = Modifier.size(12.dp))
                    Text(
                        if (Duration.between(at, now).seconds < 10) "updated just now" else "updated ${at.relativeDescription(now)}",
                        style = type.caption2,
                        color = colors.green,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                        modifier = Modifier.padding(start = 3.dp),
                    )
                }
            }
        }
        UsageRefreshButton(store = store)
    }
}

/**
 * The limits header's refresh (iOS `UsageRefreshButton`): re-reads Claude from Anthropic (bypassing
 * the server cache) and refetches hosts so a fresh Codex snapshot shows up. Paced: a second tap
 * within 15 s explains itself in a toast. Test tag: `usage-refresh`.
 */
@Composable
fun UsageRefreshButton(
    modifier: Modifier = Modifier,
    store: UsageStore? = LocalUsageStore.current,
) {
    store ?: return
    val colors = OptioTheme.colors
    val scope = rememberCoroutineScope()
    val toaster = LocalToaster.current
    Row(
        modifier = modifier
            .clip(Radius.capsuleShape)
            .background(colors.fillTertiary)
            .clickable(enabled = !store.refreshing, role = Role.Button, onClickLabel = "Refresh usage") {
                scope.launch {
                    if (!store.refreshFresh()) toaster.toast("Usage was refreshed a moment ago — try again in a few seconds")
                }
            }
            .padding(horizontal = Spacing.s, vertical = 4.dp)
            .testTag("usage-refresh"),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(4.dp),
    ) {
        if (store.refreshing) {
            CircularProgressIndicator(Modifier.size(11.dp), strokeWidth = 1.5.dp, color = colors.secondaryLabel)
        } else {
            Icon(Icons.Outlined.Refresh, contentDescription = null, tint = colors.secondaryLabel, modifier = Modifier.size(13.dp))
        }
        Text(if (store.refreshing) "refreshing" else "refresh", style = OptioTheme.type.caption2, color = colors.secondaryLabel)
    }
}

/** One provider's block: name, plan, source / as-of, then its windows side by side. */
@Composable
private fun ProviderLimitsBlock(provider: ProviderLimits, now: Instant, onOpenMachines: () -> Unit) {
    val colors = OptioTheme.colors
    val type = OptioTheme.type
    Column(verticalArrangement = Arrangement.spacedBy(Spacing.s)) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            Text(provider.name, style = type.footnote.semibold(), color = colors.label)
            provider.planType?.let { plan ->
                Text(plan.uppercase(), style = type.caption2.copy(letterSpacing = type.badge.letterSpacing), color = colors.tertiaryLabel)
            }
            Spacer(Modifier.weight(1f))
            Text(
                provider.observedAt?.let { "as of ${it.relativeDescription(now)}" } ?: provider.source,
                style = type.caption2,
                color = colors.tertiaryLabel,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
        }
        // Two meters per row on a phone; a third (7d <Model>) wraps under them.
        BoxWithConstraints(Modifier.fillMaxWidth()) {
            val columns = ((maxWidth + Spacing.l) / (120.dp + Spacing.l)).toInt().coerceAtLeast(1)
            Column(verticalArrangement = Arrangement.spacedBy(Spacing.s)) {
                provider.windows.chunked(columns).forEach { row ->
                    Row(horizontalArrangement = Arrangement.spacedBy(Spacing.l)) {
                        row.forEach { w -> LimitMeter(w.label, w.window, Modifier.weight(1f), now) }
                        repeat(columns - row.size) { Spacer(Modifier.weight(1f)) }
                    }
                }
            }
        }
        if (provider.observedAt != null) {
            Text(
                buildAnnotatedString {
                    append("${provider.source} — updates when Codex runs; ")
                    withStyle(SpanStyle(textDecoration = TextDecoration.Underline)) { append("daemon must be online") }
                },
                style = type.caption2,
                color = colors.tertiaryLabel,
                modifier = Modifier.clickable(role = Role.Button, onClickLabel = "Open Machines", onClick = onOpenMachines),
            )
        }
    }
}

/** Label + percent over a thin bar, "resets in …" under it (iOS `LimitMeter`). */
@Composable
fun LimitMeter(
    label: String,
    window: LimitWindow,
    modifier: Modifier = Modifier,
    now: Instant = rememberNow(),
) {
    val colors = OptioTheme.colors
    val type = OptioTheme.type
    val pct = UsageLimits.percent(window.usedPercent)
    val severity = UsageSeverity.of(pct)
    Column(
        modifier.clearAndSetSemantics { contentDescription = "$label window $pct percent used" },
        verticalArrangement = Arrangement.spacedBy(Spacing.xs),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(label, style = type.caption.medium(), color = colors.secondaryLabel, maxLines = 1, modifier = Modifier.weight(1f))
            NumericText(
                "$pct%",
                style = type.subheadline.semibold().tabularNums(),
                color = if (severity.isElevated) severity.tone.textColor else colors.label,
            )
        }
        MeterBar(fraction = pct / 100.0, color = severity.tone.color)
        Row(Modifier.height(14.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(3.dp)) {
            UsageLimits.resetsIn(window.resetsAt, now)?.let { reset ->
                Icon(Icons.Outlined.Schedule, contentDescription = null, tint = colors.tertiaryLabel, modifier = Modifier.size(10.dp))
                Text("resets in $reset", style = type.caption2, color = colors.tertiaryLabel, maxLines = 1)
            }
        }
    }
}

/**
 * The token-refresh banners (iOS `UsageTokenBanners`, web `usage-panel.tsx`): one per failing
 * token (Claude expired, GitHub failing), each with Re-check. Renders nothing while both work.
 */
@Composable
fun UsageTokenBanners(
    modifier: Modifier = Modifier,
    store: UsageStore? = LocalUsageStore.current,
) {
    val usage = store?.usage ?: return
    if (!usage.claudeAuthFailed && !usage.githubAuthFailed) return
    val scope = rememberCoroutineScope()
    Column(modifier.fillMaxWidth().testTag("usage-token-banners"), verticalArrangement = Arrangement.spacedBy(Spacing.s)) {
        if (usage.claudeAuthFailed) {
            TokenBanner(
                title = "Claude token expired",
                message = "Agents are failing to authenticate. Renew the Claude OAuth token from the web UI " +
                    "(Settings → Secrets), or run scripts/update-claude-auth.sh on the host.",
            ) { scope.launch { store.refresh(fresh = true) } }
        }
        if (usage.githubAuthFailed) {
            TokenBanner(
                title = "GitHub token failing",
                message = "Recent tasks hit GitHub auth errors. Rotate GITHUB_TOKEN in Settings → Secrets.",
            ) { scope.launch { store.refresh(fresh = true) } }
        }
    }
}

@Composable
private fun TokenBanner(title: String, message: String, onRecheck: () -> Unit) {
    NoticeBanner(tone = Tone.DANGER, icon = Icons.Outlined.KeyOff, title = title) {
        Text(message)
        Text(
            "Re-check",
            style = OptioTheme.type.footnote.semibold(),
            color = OptioTheme.colors.accent,
            modifier = Modifier
                .clip(Radius.smallShape)
                .clickable(role = Role.Button, onClick = onRecheck)
                .padding(vertical = Spacing.xs, horizontal = 2.dp)
                .testTag("usage-recheck"),
        )
    }
}
