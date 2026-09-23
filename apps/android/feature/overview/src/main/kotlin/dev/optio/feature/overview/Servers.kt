package dev.optio.feature.overview

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.KeyboardArrowRight
import androidx.compose.material.icons.outlined.Laptop
import androidx.compose.material.icons.outlined.SwapHoriz
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import dev.optio.core.data.ServerProfile
import dev.optio.core.network.ApiClient
import dev.optio.core.network.ApiError
import dev.optio.core.network.OptioHttp
import dev.optio.core.ui.components.ServerDot
import dev.optio.core.ui.components.metaText
import dev.optio.core.ui.theme.OptioTheme
import dev.optio.core.ui.theme.Radius
import dev.optio.core.ui.theme.Spacing
import dev.optio.core.ui.theme.Tone
import dev.optio.core.ui.theme.semibold
import java.time.Clock
import java.time.Instant
import java.util.concurrent.TimeUnit
import kotlin.coroutines.cancellation.CancellationException
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import okhttp3.OkHttpClient

// The Overview's server surfaces (iOS `Features/Servers/OtherServersSection.swift`): the card
// naming the active server, and headline counts for every other paired server, fetched straight
// from each one with its own token.

/**
 * Headline numbers for a server the app is *not* pointed at (iOS `ServerGlance`): enough to
 * answer "is anything waiting on me over there?" without switching.
 */
internal data class ServerGlance(
    val server: ServerProfile,
    val state: State = State.LOADING,
    val running: Int = 0,
    val needsYou: Int = 0,
    val failed: Int = 0,
    val hostsOnline: Int = 0,
    val hostsTotal: Int = 0,
    val asOf: Instant? = null,
) {
    enum class State { LOADING, ONLINE, UNAUTHORIZED, UNREACHABLE }
}

/**
 * Local work waiting / running on another server, from its needs-you snapshot (the glance data the
 * widgets read, `NeedsYouSnapshot` in `:core:glance`). Null when it could not be loaded.
 */
internal data class GlanceCounts(
    val needsYou: Int,
    val running: Int,
    val hostsOnline: Int,
    val hostsTotal: Int,
)

internal object ServerGlances {
    /** Other servers get 6 s (iOS `timeout: 6`): one dead laptop must not hold the card up. */
    val http: OkHttpClient by lazy { OptioHttp.client.newBuilder().callTimeout(6, TimeUnit.SECONDS).build() }

    /** [client] re-pointed at [http]. */
    fun withGlanceTimeout(client: ApiClient): ApiClient = ApiClient(client.baseUrl?.toString(), client.token, client.workspaceId, http)

    /**
     * iOS `ServerGlance.load`: task stats and the needs-you snapshot in parallel; when both fail,
     * one `/api/auth/me` tells a dead token (401) from a dead network. A null [client] means no
     * usable token.
     */
    suspend fun load(
        server: ServerProfile,
        client: ApiClient?,
        snapshot: suspend (ApiClient) -> GlanceCounts? = { null },
        clock: Clock = Clock.systemUTC(),
    ): ServerGlance {
        client ?: return ServerGlance(server, ServerGlance.State.UNAUTHORIZED)
        val (stats, counts) = coroutineScope {
            val stats = async { attempt { client.dashTaskStats() } }
            val counts = async { attempt { snapshot(client) } }
            stats.await() to counts.await()
        }
        if (stats == null && counts == null) {
            val state = try {
                client.raw("GET", "/api/auth/me")
                ServerGlance.State.ONLINE
            } catch (e: ApiError) {
                if (e.status == ApiError.UNAUTHORIZED) ServerGlance.State.UNAUTHORIZED else ServerGlance.State.UNREACHABLE
            }
            return ServerGlance(server, state)
        }
        return ServerGlance(
            server = server,
            state = ServerGlance.State.ONLINE,
            running = (stats?.running ?: 0) + (counts?.running ?: 0),
            needsYou = (stats?.needsAttention ?: 0) + (counts?.needsYou ?: 0),
            failed = stats?.failed ?: 0,
            hostsOnline = counts?.hostsOnline ?: 0,
            hostsTotal = counts?.hostsTotal ?: 0,
            asOf = clock.instant(),
        )
    }

    private suspend fun <T> attempt(block: suspend () -> T): T? = try {
        block()
    } catch (e: CancellationException) {
        throw e
    } catch (_: Exception) {
        null
    }
}

/** The other servers' glances (iOS `OtherServersModel`), refreshed while the Overview shows them. */
internal class OtherServersModel(
    private val loader: suspend (ServerProfile) -> ServerGlance,
) {
    private val _glances = MutableStateFlow<List<ServerGlance>>(emptyList())
    val glances: StateFlow<List<ServerGlance>> = _glances.asStateFlow()

    /** Reloads every server in [servers]: stale numbers stay visible, new servers show "Checking…". */
    suspend fun refresh(servers: List<ServerProfile>) {
        _glances.update { current ->
            val byId = current.associateBy { it.server.id }
            servers.map { server -> byId[server.id]?.copy(server = server) ?: ServerGlance(server) }
        }
        coroutineScope {
            servers.forEach { server ->
                launch {
                    val glance = loader(server)
                    _glances.update { list -> list.map { if (it.server.id == glance.server.id) glance else it } }
                }
            }
        }
    }
}

/** The Settings-style icon tile: a rounded square in the server colour with a white laptop. */
@Composable
internal fun ServerIconTile(
    color: Color,
    modifier: Modifier = Modifier,
    size: Dp = 36.dp,
) {
    Box(
        modifier.size(size).clip(RoundedCornerShape(size * 0.24f)).background(color),
        contentAlignment = Alignment.Center,
    ) {
        Icon(Icons.Outlined.Laptop, contentDescription = null, tint = Color.White, modifier = Modifier.size(size * 0.55f))
    }
}

/**
 * The card at the top of the Overview naming the active server (iOS `ActiveServerCard`): its
 * colour tile, name, host and "who · local hosts" line, "1 of N" when several are paired, and a
 * chevron into Manage servers. Test tag: `active-server`.
 */
@Composable
internal fun ActiveServerCard(
    server: ServerProfile,
    userLabel: String?,
    switching: Boolean,
    serverCount: Int,
    hostsOnline: Int?,
    hostsTotal: Int?,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val colors = OptioTheme.colors
    val type = OptioTheme.type
    val who = userLabel ?: if (switching) "Connecting…" else null
    val hosts = if (hostsTotal != null && hostsTotal > 0 && hostsOnline != null) {
        if (hostsOnline == 0) "local host offline" else "$hostsOnline/$hostsTotal local host${if (hostsTotal == 1) "" else "s"} online"
    } else {
        null
    }
    val detail = metaText(who, hosts)
    Row(
        modifier
            .fillMaxWidth()
            .clip(Radius.cardShape)
            .background(colors.card)
            .clickable(role = Role.Button, onClickLabel = "Manage servers", onClick = onClick)
            .padding(vertical = Spacing.m, horizontal = Spacing.l)
            .testTag("active-server"),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(Spacing.m),
    ) {
        ServerIconTile(Color(server.color.argb))
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Text(server.name, style = type.body.semibold(), color = colors.label, maxLines = 1, overflow = TextOverflow.Ellipsis)
            Text(server.host, style = type.monoFootnote, color = colors.secondaryLabel, maxLines = 1, overflow = TextOverflow.MiddleEllipsis)
            if (detail != null) Text(detail, style = type.caption, color = colors.secondaryLabel, maxLines = 1, overflow = TextOverflow.Ellipsis)
        }
        if (serverCount > 1) Text("1 of $serverCount", style = type.footnote, color = colors.tertiaryLabel, maxLines = 1)
        Icon(Icons.AutoMirrored.Filled.KeyboardArrowRight, contentDescription = null, tint = colors.tertiaryLabel, modifier = Modifier.size(20.dp))
    }
}

/**
 * One other server (iOS `OtherServerRow`): its dot, name and host, then "Checking…",
 * "Unreachable", "Token rejected — re-pair in Servers" or its counts. Tapping switches to it.
 * Test tag: `other-server-<id>`.
 */
@Composable
internal fun OtherServerRow(
    glance: ServerGlance,
    onSwitch: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val colors = OptioTheme.colors
    val type = OptioTheme.type
    Row(
        modifier
            .fillMaxWidth()
            .clickable(role = Role.Button, onClickLabel = "Switch to ${glance.server.name}", onClick = onSwitch)
            .padding(horizontal = Spacing.l, vertical = Spacing.m)
            .testTag("other-server-${glance.server.id}"),
        horizontalArrangement = Arrangement.spacedBy(Spacing.m),
    ) {
        ServerDot(Color(glance.server.color.argb), size = 10.dp, modifier = Modifier.padding(top = 7.dp))
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(Spacing.xs)) {
            Row(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically) {
                Text(glance.server.name, style = type.body, color = colors.label, maxLines = 1)
                Text(
                    glance.server.host,
                    style = type.monoCaption,
                    color = colors.tertiaryLabel,
                    maxLines = 1,
                    overflow = TextOverflow.MiddleEllipsis,
                    modifier = Modifier.weight(1f, fill = false),
                )
            }
            GlanceLine(glance)
        }
        Icon(
            Icons.Outlined.SwapHoriz,
            contentDescription = null,
            tint = colors.tertiaryLabel,
            modifier = Modifier.padding(top = 4.dp).size(18.dp),
        )
    }
}

@Composable
private fun GlanceLine(glance: ServerGlance) {
    val colors = OptioTheme.colors
    val style = OptioTheme.type.subheadline
    when (glance.state) {
        ServerGlance.State.LOADING -> Text("Checking…", style = style, color = colors.tertiaryLabel)
        ServerGlance.State.UNREACHABLE -> Text("Unreachable", style = style, color = colors.secondaryLabel)
        ServerGlance.State.UNAUTHORIZED -> Text("Token rejected — re-pair in Servers", style = style, color = colors.red)
        ServerGlance.State.ONLINE -> {
            val dot = SpanStyle(color = colors.tertiaryLabel)
            val text = buildAnnotatedString {
                if (glance.needsYou > 0) {
                    withStyle(SpanStyle(color = Tone.ACCENT.textColor, fontWeight = FontWeight.Medium)) {
                        append("${glance.needsYou} need${if (glance.needsYou == 1) "s" else ""} you")
                    }
                    withStyle(dot) { append(" · ") }
                }
                append("${glance.running} running")
                if (glance.failed > 0) {
                    withStyle(dot) { append(" · ") }
                    withStyle(SpanStyle(color = colors.red)) { append("${glance.failed} failed") }
                }
                if (glance.hostsTotal > 0) {
                    withStyle(dot) { append(" · ") }
                    append(
                        if (glance.hostsOnline == 0) {
                            "host offline"
                        } else {
                            "${glance.hostsOnline}/${glance.hostsTotal} host${if (glance.hostsTotal == 1) "" else "s"} online"
                        },
                    )
                }
            }
            Text(text, style = style, color = colors.secondaryLabel, maxLines = 1, overflow = TextOverflow.Ellipsis)
        }
    }
}
