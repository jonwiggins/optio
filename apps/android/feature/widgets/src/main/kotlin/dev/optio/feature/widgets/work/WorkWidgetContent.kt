package dev.optio.feature.widgets.work

import androidx.compose.runtime.Composable
import androidx.compose.ui.unit.DpSize
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.glance.GlanceModifier
import androidx.glance.ImageProvider
import androidx.glance.LocalContext
import androidx.glance.LocalSize
import androidx.glance.action.Action
import androidx.glance.action.actionParametersOf
import androidx.glance.action.clickable
import androidx.glance.appwidget.action.actionRunCallback
import androidx.glance.appwidget.action.actionStartActivity
import androidx.glance.appwidget.appWidgetBackground
import androidx.glance.appwidget.cornerRadius
import androidx.glance.background
import androidx.glance.layout.Alignment
import androidx.glance.layout.Box
import androidx.glance.layout.Column
import androidx.glance.layout.Row
import androidx.glance.layout.Spacer
import androidx.glance.layout.fillMaxSize
import androidx.glance.layout.fillMaxWidth
import androidx.glance.layout.height
import androidx.glance.layout.padding
import androidx.glance.layout.width
import androidx.glance.semantics.contentDescription
import androidx.glance.semantics.semantics
import androidx.glance.semantics.testTag
import androidx.glance.text.FontWeight
import androidx.glance.text.Text
import dev.optio.core.data.ServerProfile
import dev.optio.core.glance.GlanceCopy
import dev.optio.core.glance.GlanceEntry
import dev.optio.core.glance.GlanceItem
import dev.optio.core.glance.GlancePolicy
import dev.optio.core.glance.icon
import dev.optio.core.glance.label
import dev.optio.core.model.WatchItemKind
import dev.optio.feature.widgets.Links
import dev.optio.feature.widgets.R
import dev.optio.feature.widgets.model.boardLink
import dev.optio.feature.widgets.model.boardTiles
import dev.optio.feature.widgets.model.headSession
import dev.optio.feature.widgets.model.kind
import dev.optio.feature.widgets.model.needsYouCount
import dev.optio.feature.widgets.model.runningCount
import dev.optio.feature.widgets.model.serverProfile
import dev.optio.feature.widgets.model.sessionRows
import dev.optio.feature.widgets.model.statusKind
import dev.optio.feature.widgets.model.statusWord
import dev.optio.feature.widgets.model.tileLink
import dev.optio.feature.widgets.ui.ChipFit
import dev.optio.feature.widgets.ui.Dot
import dev.optio.feature.widgets.ui.Glyph
import dev.optio.feature.widgets.ui.WidgetColors
import dev.optio.feature.widgets.ui.WidgetType
import dev.optio.feature.widgets.ui.drawable
import dev.optio.feature.widgets.ui.shortTime

/** The Work widget's three layouts (iOS systemSmall / systemMedium / systemLarge). */
enum class WorkFamily(
    /** The smallest size this layout is designed for. */
    val breakpoint: DpSize,
    /** Session rows shown before "+N more". */
    val budget: Int,
) {
    SMALL(DpSize(110.dp, 110.dp), budget = 1),
    MEDIUM(DpSize(250.dp, 110.dp), budget = 2),
    LARGE(DpSize(250.dp, 250.dp), budget = 6),
    ;

    companion object {
        fun forSize(size: DpSize): WorkFamily =
            when {
                size.width < MEDIUM.breakpoint.width -> SMALL
                size.height < LARGE.breakpoint.height -> MEDIUM
                else -> LARGE
            }
    }
}

/**
 * "Work": the one status widget, a slice of the app's Work board (iOS `WorkWidgetView`). Small
 * shows the number that matters (needs you, else running) and the head session with its Where;
 * medium the board tiles and the top two active sessions; large the tiles and up to six sessions
 * as two-line rows (name · status, then the When / Where / Who / Then chips) with **Later** on
 * needs-you rows. Every row deep-links into its session on its server.
 */
@Composable
fun WorkWidgetContent(
    entry: GlanceEntry,
    family: WorkFamily,
) {
    WidgetSurface {
        when {
            entry.reachability == GlancePolicy.Reachability.SIGNED_OUT -> SignedOutBody()
            family == WorkFamily.SMALL -> SmallBody(entry)
            else -> BoardBody(entry, family)
        }
    }
}

/** The widget background: the neutral card, the system's widget corner radius, content margins. */
@Composable
internal fun WidgetSurface(
    modifier: GlanceModifier = GlanceModifier,
    content: @Composable () -> Unit,
) {
    Box(
        modifier =
            GlanceModifier
                .fillMaxSize()
                .appWidgetBackground()
                .background(ImageProvider(R.drawable.widget_surface))
                .cornerRadius(android.R.dimen.system_app_widget_background_radius)
                .then(modifier)
                .padding(horizontal = 14.dp, vertical = 12.dp),
        contentAlignment = Alignment.TopStart,
    ) {
        content()
    }
}

// region Small

/** The number that matters on top, the head session and its Where underneath. Opens the board. */
@Composable
private fun SmallBody(entry: GlanceEntry) {
    val context = LocalContext.current
    val needs = entry.needsYouCount
    Column(
        modifier = GlanceModifier.fillMaxSize().clickable(actionStartActivity(Links.view(context, entry.boardLink))),
    ) {
        Row(modifier = GlanceModifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
            HeaderGlyph(needs, size = 18)
            Spacer(GlanceModifier.width(6.dp))
            val server = entry.server
            if (entry.showsServerName && server != null) {
                ServerTag(server)
            } else if (entry.isMulti) {
                Text(
                    "${entry.slices.size} servers",
                    style = WidgetType.style(WidgetType.caption2, WidgetColors.secondary, FontWeight.Medium),
                    maxLines = 1,
                )
            }
            Spacer(GlanceModifier.defaultWeight())
            HonestyFooter(entry)
        }
        Spacer(GlanceModifier.defaultWeight())
        val headline = GlanceCopy.headlineCount(needs, entry.runningCount)
        if (headline != null) {
            val (count, noun) = headline
            Text(
                "$count",
                style = WidgetType.style(WidgetType.count, if (needs > 0) WidgetColors.needsYou else WidgetColors.working, FontWeight.Medium),
                maxLines = 1,
                modifier = GlanceModifier.semantics { testTag = "work-headline" },
            )
            Text(noun, style = WidgetType.style(WidgetType.footnote, WidgetColors.secondary, FontWeight.Medium), maxLines = 1)
        } else {
            Text(
                "Quiet",
                style = WidgetType.style(WidgetType.title, WidgetColors.secondary, FontWeight.Medium),
                maxLines = 1,
                modifier = GlanceModifier.semantics { testTag = "work-headline" },
            )
            Text("no sessions running", style = WidgetType.style(WidgetType.footnote, WidgetColors.tertiary), maxLines = 1)
        }
        entry.headSession?.let { head ->
            Spacer(GlanceModifier.height(4.dp))
            Row(verticalAlignment = Alignment.CenterVertically) {
                Dot(WidgetColors.forState(head.state), size = 6.dp)
                Spacer(GlanceModifier.width(5.dp))
                RowName(head, size = WidgetType.footnote)
                if (entry.isMulti) ServerDotFor(entry, head, leading = 4)
            }
            val place = head.whereValue
            Row(modifier = GlanceModifier.padding(start = 11.dp), verticalAlignment = Alignment.CenterVertically) {
                Chip(place.icon.drawable(), GlanceCopy.whereLabel(place.detail, place.target.raw, short = true), mono = true)
            }
        }
    }
}

// endregion

// region Medium / large

// Glance lays a Row or Column out with at most 10 children (the rest are dropped), so rows and
// strips nest their parts and space them with padding rather than Spacers.

/** Header, the board tiles, then session rows within the family's budget. */
@Composable
private fun BoardBody(
    entry: GlanceEntry,
    family: WorkFamily,
) {
    val expanded = family == WorkFamily.LARGE
    val gap = if (expanded) 6.dp else 5.dp
    val rows = entry.sessionRows
    Column(modifier = GlanceModifier.fillMaxSize()) {
        BoardHeader(entry)
        TileStrip(entry, compact = !expanded, modifier = GlanceModifier.padding(top = gap))
        if (rows.isEmpty()) {
            EmptyBoard(entry, modifier = GlanceModifier.defaultWeight())
        } else {
            SessionRows(entry, rows, family, modifier = GlanceModifier.padding(top = gap))
        }
    }
}

/** No sessions: a centred moon (or the unreachable glyph) and one line. */
@Composable
private fun EmptyBoard(
    entry: GlanceEntry,
    modifier: GlanceModifier,
) {
    val unreachable = entry.reachability == GlancePolicy.Reachability.UNREACHABLE
    Box(modifier = modifier.fillMaxWidth(), contentAlignment = Alignment.Center) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Glyph(if (unreachable) R.drawable.widget_ic_wifi_off else R.drawable.widget_ic_moon, WidgetColors.tertiary, 14.dp)
            Text(
                if (unreachable) "Unreachable" else "No sessions running",
                style = WidgetType.style(WidgetType.footnote, WidgetColors.tertiary),
                maxLines = 1,
                modifier = GlanceModifier.padding(start = 6.dp).semantics { testTag = "work-empty" },
            )
        }
    }
}

/** Up to the family's budget of rows, then "+N more" (a link to the board). */
@Composable
private fun SessionRows(
    entry: GlanceEntry,
    rows: List<GlanceItem>,
    family: WorkFamily,
    modifier: GlanceModifier,
) {
    val context = LocalContext.current
    val expanded = family == WorkFamily.LARGE
    val shown = rows.take(family.budget)
    val overflow = rows.size - shown.size
    Column(modifier = modifier.fillMaxWidth()) {
        shown.forEachIndexed { index, item ->
            SessionRow(
                entry,
                item,
                showsServer = entry.isMulti,
                showsLater = expanded,
                expanded = expanded,
                modifier = if (index > 0) GlanceModifier.padding(top = if (expanded) 6.dp else 5.dp) else GlanceModifier,
            )
        }
        if (overflow > 0) {
            Text(
                "+$overflow more",
                style = WidgetType.style(WidgetType.caption2, WidgetColors.tertiary, FontWeight.Medium),
                maxLines = 1,
                modifier =
                    GlanceModifier
                        .padding(top = 4.dp)
                        .clickable(actionStartActivity(Links.view(context, entry.boardLink)))
                        .semantics { testTag = "work-overflow" },
            )
        }
    }
}

/** `[bot] 3 need you · 2 running [server]      [footer]`, or `Quiet` when nothing is on. */
@Composable
private fun BoardHeader(entry: GlanceEntry) {
    val context = LocalContext.current
    val needs = entry.needsYouCount
    val running = entry.runningCount
    val size = WidgetType.subheadline
    Row(
        modifier =
            GlanceModifier
                .fillMaxWidth()
                .clickable(actionStartActivity(Links.view(context, entry.boardLink)))
                .semantics { testTag = "work-header" },
        verticalAlignment = Alignment.CenterVertically,
    ) {
        HeaderGlyph(needs, size = 16)
        Row(modifier = GlanceModifier.padding(start = 5.dp), verticalAlignment = Alignment.CenterVertically) {
            if (needs > 0) {
                Text("$needs", style = WidgetType.style(size, WidgetColors.needsYou, FontWeight.Medium), maxLines = 1)
                Text(if (needs == 1) " needs you" else " need you", style = WidgetType.style(size, WidgetColors.secondary, FontWeight.Medium), maxLines = 1)
            }
            if (running > 0) {
                if (needs > 0) Text(" · ", style = WidgetType.style(size, WidgetColors.tertiary, FontWeight.Medium), maxLines = 1)
                Text("$running", style = WidgetType.style(size, WidgetColors.working, FontWeight.Medium), maxLines = 1)
                Text(" running", style = WidgetType.style(size, WidgetColors.secondary, FontWeight.Medium), maxLines = 1)
            }
            if (needs == 0 && running == 0) {
                Text("Quiet", style = WidgetType.style(size, WidgetColors.secondary, FontWeight.Medium), maxLines = 1)
            }
        }
        val server = entry.server
        if (entry.showsServerName && server != null) ServerTag(server, modifier = GlanceModifier.padding(start = 5.dp))
        Spacer(GlanceModifier.defaultWeight())
        HonestyFooter(entry)
    }
}

/** The board's tiles in one row: count over label, each a link into the matching Work view. */
@Composable
private fun TileStrip(
    entry: GlanceEntry,
    compact: Boolean,
    modifier: GlanceModifier,
) {
    val context = LocalContext.current
    Row(modifier = modifier.fillMaxWidth()) {
        entry.boardTiles.forEachIndexed { index, tile ->
            val color =
                when {
                    tile.count == 0 -> WidgetColors.secondary
                    tile.id == GlanceCopy.Tile.Id.NEEDS_YOU -> WidgetColors.needsYou
                    tile.id == GlanceCopy.Tile.Id.RUNNING -> WidgetColors.working
                    else -> WidgetColors.label
                }
            // The gap is the tile's own leading padding (a Box), so the strip stays at five children.
            Box(modifier = GlanceModifier.defaultWeight().padding(start = if (index > 0) 6.dp else 0.dp)) {
                Column(
                    modifier =
                        GlanceModifier
                            .fillMaxWidth()
                            .background(ImageProvider(R.drawable.widget_tile))
                            .padding(horizontal = 7.dp, vertical = 4.dp)
                            .clickable(actionStartActivity(Links.view(context, entry.tileLink(tile))))
                            .semantics {
                                testTag = "work-tile-${tile.id.name.lowercase()}"
                                contentDescription = "${tile.count} ${tile.label}"
                            },
                ) {
                    Text("${tile.count}", style = WidgetType.style(if (compact) 16.sp else 20.sp, color, FontWeight.Medium), maxLines = 1)
                    Text(tile.label, style = WidgetType.style(9.sp, WidgetColors.secondary, FontWeight.Medium), maxLines = 1)
                }
            }
        }
    }
}

/**
 * A session as a widget row: one line (`● name [where] … symbol word 4m`) or, [expanded], two
 * with the four chips underneath. The row is a deep link; the moon is **Later** on needs-you rows.
 */
@Composable
private fun SessionRow(
    entry: GlanceEntry,
    item: GlanceItem,
    showsServer: Boolean,
    showsLater: Boolean,
    expanded: Boolean,
    modifier: GlanceModifier = GlanceModifier,
) {
    val context = LocalContext.current
    val open = actionStartActivity(Links.view(context, item.link))
    Column(modifier = modifier.fillMaxWidth().clickable(open).semantics { testTag = "work-row-${item.id}" }) {
        Row(modifier = GlanceModifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
            Dot(WidgetColors.forState(item.state), size = 7.dp)
            // Name, server dot and (one-line rows) the Where chip share what the trailing edge leaves.
            Row(modifier = GlanceModifier.defaultWeight().padding(start = 6.dp), verticalAlignment = Alignment.CenterVertically) {
                RowName(item, size = WidgetType.footnote)
                if (showsServer) ServerDotFor(entry, item, leading = 4)
                if (!expanded) {
                    val place = item.whereValue
                    Chip(
                        place.icon.drawable(),
                        GlanceCopy.whereLabel(place.detail, place.target.raw, short = true),
                        mono = true,
                        modifier = GlanceModifier.padding(start = 6.dp),
                    )
                }
            }
            Row(modifier = GlanceModifier.padding(start = 4.dp), verticalAlignment = Alignment.CenterVertically) {
                val badge = item.badge
                if (badge != null) Glyph(badge.icon.drawable(), WidgetColors.status(badge.status.kind), 11.dp)
                Text(
                    item.statusWord,
                    style = WidgetType.style(WidgetType.caption2, WidgetColors.status(item.statusKind), FontWeight.Medium),
                    maxLines = 1,
                    modifier = GlanceModifier.padding(start = if (badge != null) 3.dp else 0.dp),
                )
                Text(
                    GlancePolicy.waitText(item.since, entry.date),
                    style = WidgetType.style(WidgetType.caption2, WidgetColors.tertiary),
                    maxLines = 1,
                    modifier = GlanceModifier.padding(start = 6.dp),
                )
                if (showsLater && item.state == "needs_you") {
                    Glyph(
                        R.drawable.widget_ic_moon,
                        WidgetColors.tertiary,
                        16.dp,
                        modifier = GlanceModifier.padding(start = 6.dp).clickable(laterAction(item)).semantics { testTag = "work-later-${item.id}" },
                        contentDescription = "Later",
                    )
                }
            }
        }
        if (expanded) SessionChips(item, modifier = GlanceModifier.padding(start = 13.dp, top = 2.dp))
    }
}

/** "Later" on a needs-you row: snooze it for 15 minutes without opening the app. */
private fun laterAction(item: GlanceItem): Action =
    actionRunCallback<LaterAction>(
        actionParametersOf(
            LaterAction.itemId to item.id,
            LaterAction.kind to item.kind.raw,
            LaterAction.serverId to (item.serverId ?: ""),
        ),
    )

/**
 * The four chips of a session, in order: `▷ when  💻 where  ⚡ who  ⎋ then`. iOS shrinks Where
 * first; Glance text only ellipsizes at the end, so Where is fitted up front ([ChipFit]): the
 * host and leaf when they fit, else the leaf, else the leaf cut from the front.
 */
@Composable
private fun SessionChips(
    item: GlanceItem,
    modifier: GlanceModifier = GlanceModifier,
) {
    val context = LocalContext.current
    val place = item.whereValue
    val whenLabel = item.whenLabel
    val whoLabel = GlanceCopy.whoLabel(item.whoValue)
    val thenLabel = item.thenValue.label
    // The widget's width, less its content margins and this row's indent.
    val room = LocalSize.current.width.value - 2 * 14 - 13
    val whereLabel =
        ChipFit.where(
            context,
            roomDp = room,
            others = listOf(whenLabel, whoLabel, thenLabel),
            full = GlanceCopy.whereLabel(place.detail, place.target.raw, short = true),
        )
    Row(modifier = modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
        Chip(item.whenIcon.drawable(), whenLabel)
        Chip(place.icon.drawable(), whereLabel, mono = true, modifier = GlanceModifier.padding(start = ChipFit.GAP.dp))
        Chip(item.whoIcon.drawable(), whoLabel, modifier = GlanceModifier.padding(start = ChipFit.GAP.dp))
        Chip(item.thenValue.icon.drawable(), thenLabel, modifier = GlanceModifier.padding(start = ChipFit.GAP.dp))
    }
}

// endregion

// region Pieces

/** One attribute chip: `[icon] label`, the same icons as the app's Work rows. */
@Composable
private fun Chip(
    icon: Int,
    label: String,
    mono: Boolean = false,
    modifier: GlanceModifier = GlanceModifier,
) {
    Row(modifier = modifier, verticalAlignment = Alignment.CenterVertically) {
        Glyph(icon, WidgetColors.tertiary, ChipFit.ICON.dp)
        Text(
            label,
            style = WidgetType.style(WidgetType.caption2, WidgetColors.secondary, mono = mono),
            maxLines = 1,
            modifier = GlanceModifier.padding(start = ChipFit.ICON_GAP.dp),
        )
    }
}

/**
 * What a row is called, in the label colour. Directory leaves and branches are mono (the brief's
 * "monospace is earned" rule, as the iOS design references draw them); agent names are not.
 */
@Composable
private fun RowName(
    item: GlanceItem,
    size: androidx.compose.ui.unit.TextUnit,
) {
    Text(
        item.rowName,
        style = WidgetType.style(size, WidgetColors.label, FontWeight.Medium, mono = item.kind != WatchItemKind.AGENT),
        maxLines = 1,
    )
}

/** The bot: yellow when something needs you, else grey. */
@Composable
private fun HeaderGlyph(
    needsYou: Int,
    size: Int,
) {
    Glyph(R.drawable.widget_ic_bot, if (needsYou > 0) WidgetColors.needsYou else WidgetColors.secondary, size.dp)
}

/** "● MacBook": the server a single-server widget shows, when others are paired too. */
@Composable
private fun ServerTag(
    server: ServerProfile,
    modifier: GlanceModifier = GlanceModifier,
) {
    Row(modifier = modifier, verticalAlignment = Alignment.CenterVertically) {
        Dot(WidgetColors.server(server.color), size = 6.dp)
        Text(
            server.shortName,
            style = WidgetType.style(WidgetType.caption2, WidgetColors.secondary, FontWeight.Medium),
            maxLines = 1,
            modifier = GlanceModifier.padding(start = 3.dp).semantics { contentDescription = "on ${server.shortName}" },
        )
    }
}

/** A row's server dot in a multi-server widget. */
@Composable
private fun ServerDotFor(
    entry: GlanceEntry,
    item: GlanceItem,
    leading: Int,
) {
    val profile = entry.serverProfile(item.serverId) ?: return
    Spacer(GlanceModifier.width(leading.dp))
    Dot(WidgetColors.server(profile.color), size = 6.dp, contentDescription = "on ${profile.shortName}")
}

/**
 * Compact honesty (iOS `HonestyFooter`): `⌀ 10:42` (every server unreachable since), a coloured dot
 * and `⌀` (one of several servers down), `as of 10:42` (stale). Nothing when live and fresh.
 */
@Composable
private fun HonestyFooter(entry: GlanceEntry) {
    val context = LocalContext.current
    val since = entry.unreachableSince
    val down = entry.unreachableSlices.firstOrNull()
    when {
        entry.reachability == GlancePolicy.Reachability.UNREACHABLE && since != null -> {
            val time = context.shortTime(since)
            Row(
                verticalAlignment = Alignment.CenterVertically,
                modifier = GlanceModifier.semantics { contentDescription = "unreachable since $time" },
            ) {
                Glyph(R.drawable.widget_ic_wifi_off, WidgetColors.secondary, 11.dp)
                Spacer(GlanceModifier.width(3.dp))
                Text(time, style = WidgetType.style(WidgetType.caption2, WidgetColors.secondary), maxLines = 1, modifier = GlanceModifier.semantics { testTag = "work-footer" })
            }
        }
        entry.isMulti && down != null ->
            Row(
                verticalAlignment = Alignment.CenterVertically,
                modifier = GlanceModifier.semantics { contentDescription = "${down.server.shortName} unreachable"; testTag = "work-footer" },
            ) {
                Dot(WidgetColors.server(down.server.color), size = 5.dp)
                Spacer(GlanceModifier.width(3.dp))
                Glyph(R.drawable.widget_ic_wifi_off, WidgetColors.secondary, 11.dp)
            }
        entry.isStale ->
            Text(
                "as of ${context.shortTime(entry.asOf)}",
                style = WidgetType.style(WidgetType.caption2, WidgetColors.tertiary),
                maxLines = 1,
                modifier = GlanceModifier.semantics { testTag = "work-footer" },
            )
        else -> Unit
    }
}

/** Signed-out body shared by every widget: one line; a tap opens the app (its sign-in screen). */
@Composable
internal fun SignedOutBody() {
    val context = LocalContext.current
    Column(modifier = GlanceModifier.fillMaxSize().clickable(actionStartActivity(Links.launch(context))).semantics { testTag = "signed-out-body" }) {
        Glyph(R.drawable.widget_ic_bot, WidgetColors.secondary, 18.dp)
        Spacer(GlanceModifier.height(6.dp))
        Text(
            "Sign in to Optio",
            style = WidgetType.style(WidgetType.subheadline, WidgetColors.secondary),
            maxLines = 2,
            modifier = GlanceModifier.semantics { testTag = "signed-out" },
        )
    }
}

// endregion
