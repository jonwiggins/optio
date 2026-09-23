package dev.optio.feature.widgets.work

import dev.optio.core.data.DeepLink
import dev.optio.core.data.ServerColor
import dev.optio.core.data.ServerProfile
import dev.optio.core.glance.GlanceEntry
import dev.optio.core.glance.GlanceItem
import dev.optio.core.glance.GlancePolicy
import dev.optio.core.glance.GlanceSlice
import dev.optio.core.glance.InFlightTask
import dev.optio.core.glance.NeedsYouSnapshot
import dev.optio.core.glance.SessionTileCounts
import dev.optio.core.model.WatchItemKind
import dev.optio.core.model.WatchThen
import dev.optio.core.model.WatchWhere
import dev.optio.core.model.WatchWhereTarget
import java.time.Duration
import java.time.Instant

/**
 * The iOS `GlanceFixtures`, for the widget picker's generated previews, screenshots and tests:
 * two laptops, two terminals waiting on you, an agent whose turn failed, two running sessions and
 * two Repo Tasks in flight. Every entry is built around [now].
 */
object WidgetSamples {
    val laptop = ServerProfile(id = "srv-laptop", name = "MacBook Pro", url = "http://laptop.tailnet.ts.net:30400", color = ServerColor.SLATE)
    val studio = ServerProfile(id = "srv-studio", name = "Studio", url = "http://studio.tailnet.ts.net:30400", color = ServerColor.TEAL)

    private fun ago(
        now: Instant,
        minutes: Long,
    ): Instant = now.minus(Duration.ofMinutes(minutes))

    fun web(now: Instant) =
        GlanceItem(
            kind = WatchItemKind.LOCAL, id = "t-web", title = "claude-code · web", mono = "optio/apps/web",
            reason = "Waiting on a permission", since = ago(now, 4), state = "needs_you",
            link = DeepLink.Local("t-web", compose = true).url(server = laptop.id), serverId = laptop.id, serverName = laptop.shortName,
            `when` = "now", where = WatchWhere(WatchWhereTarget.MACHINE, "MacBook Pro · ~/repos/optio/apps/web"), who = "claude-code",
            then = WatchThen.WAITS_FOR_ME, statusLabel = "needs you",
        )

    fun api(now: Instant) =
        GlanceItem(
            kind = WatchItemKind.LOCAL, id = "t-api", title = "claude-code · api", mono = "optio/apps/api",
            reason = "Claude stopped — reply to continue", since = ago(now, 11), state = "needs_you",
            link = DeepLink.Local("t-api", compose = true).url(server = laptop.id), serverId = laptop.id, serverName = laptop.shortName,
            `when` = "github", where = WatchWhere(WatchWhereTarget.MACHINE, "MacBook Pro · ~/repos/optio/apps/api"), who = "claude-code",
            then = WatchThen.WAITS_FOR_ME, statusLabel = "needs you",
        )

    fun forge(now: Instant) =
        GlanceItem(
            kind = WatchItemKind.AGENT, id = "a-vesper", title = "Vesper", mono = "@vesper",
            reason = "Turn failed — resume?", since = ago(now, 38), state = "failed",
            link = DeepLink.Agent("a-vesper", compose = true).url(server = studio.id), serverId = studio.id, serverName = studio.shortName,
            `when` = "messages", where = WatchWhere(WatchWhereTarget.POD, "@vesper"), who = "claude-code",
            then = WatchThen.WAITS_FOR_MESSAGES, statusLabel = "failed",
        )

    fun cli(now: Instant) =
        GlanceItem(
            kind = WatchItemKind.LOCAL, id = "t-cli", title = "codex · cli", mono = "optio/apps/cli", since = ago(now, 23), state = "working",
            link = DeepLink.Local("t-cli").url(server = laptop.id), serverId = laptop.id, serverName = laptop.shortName,
            `when` = "job", where = WatchWhere(WatchWhereTarget.MACHINE, "MacBook Pro · ~/repos/optio/apps/cli"), who = "codex",
            then = WatchThen.EXITS, statusLabel = "working",
        )

    fun docs(now: Instant) =
        GlanceItem(
            kind = WatchItemKind.LOCAL, id = "t-docs", title = "claude-code · docs", mono = "optio/docs", since = ago(now, 2), state = "working",
            link = DeepLink.Local("t-docs").url(server = studio.id), serverId = studio.id, serverName = studio.shortName,
            `when` = "now", where = WatchWhere(WatchWhereTarget.MACHINE, "Studio · ~/repos/optio/docs"), who = "claude-code",
            then = WatchThen.WAITS_FOR_ME, statusLabel = "working",
        )

    fun tasks(now: Instant) =
        listOf(
            InFlightTask(
                id = "task-1", title = "fix: login redirect loops on expired PAT", state = "pr_opened", repoBranch = "fix/login-redirect",
                repoUrl = "https://github.com/jonwiggins/optio", agentType = "claude-code", prNumber = 581,
                prUrl = "https://github.com/jonwiggins/optio/pull/581", prChecksStatus = "pending", startedAt = ago(now, 52).toString(),
                serverId = laptop.id, serverName = laptop.shortName,
            ),
            InFlightTask(
                id = "task-2", title = "feat(ios): widgets and controls", state = "running", repoBranch = "feat/ios-widgets",
                repoUrl = "https://github.com/jonwiggins/optio", agentType = "codex", startedAt = ago(now, 12).toString(),
                serverId = studio.id, serverName = studio.shortName,
            ),
        )

    val counts = SessionTileCounts(waiting = 2, recurring = 4, agents = 3)

    fun slice(
        server: ServerProfile,
        now: Instant,
        needs: List<GlanceItem>,
        running: List<GlanceItem>,
        tasks: List<InFlightTask> = emptyList(),
        asOf: Instant = now,
        reachability: GlancePolicy.Reachability = GlancePolicy.Reachability.LIVE,
        unreachableSince: Instant? = null,
        counts: SessionTileCounts? = WidgetSamples.counts,
    ) = GlanceSlice(
        server = server,
        reachability = reachability,
        snapshot = NeedsYouSnapshot(needsYou = needs, running = running, hostsOnline = 1, hostsTotal = 1, counts = counts, asOf = asOf),
        tasks = tasks,
        unreachableSince = unreachableSince,
    )

    /** Two servers: three sessions need you, two running, two tasks. */
    fun waiting(now: Instant) =
        GlanceEntry(
            now,
            listOf(
                slice(laptop, now, needs = listOf(api(now), web(now)), running = listOf(cli(now)), tasks = listOf(tasks(now)[0])),
                slice(studio, now, needs = listOf(forge(now)), running = listOf(docs(now)), tasks = listOf(tasks(now)[1])),
            ),
        )

    /** One server shown while another is paired. */
    fun one(now: Instant) = GlanceEntry(now, listOf(slice(laptop, now, needs = listOf(web(now)), running = listOf(cli(now)), tasks = tasks(now))), othersPaired = true)

    fun single(now: Instant) = GlanceEntry(now, listOf(slice(laptop, now, needs = listOf(api(now), web(now)), running = listOf(cli(now)), tasks = tasks(now))))

    fun quiet(now: Instant) =
        GlanceEntry(
            now,
            listOf(slice(laptop, now, needs = emptyList(), running = listOf(cli(now)), tasks = tasks(now)), slice(studio, now, needs = emptyList(), running = listOf(docs(now)))),
        )

    fun idle(now: Instant) = GlanceEntry(now, listOf(slice(laptop, now, needs = emptyList(), running = emptyList())))

    /** A server that predates `/api/glance/watch`: two tiles only. */
    fun legacy(now: Instant) = GlanceEntry(now, listOf(slice(laptop, now, needs = listOf(web(now)), running = listOf(cli(now)), tasks = tasks(now), counts = null)))

    fun offline(now: Instant) =
        GlanceEntry(
            now,
            listOf(
                slice(
                    laptop, now, needs = listOf(web(now)), running = listOf(cli(now)), tasks = tasks(now), asOf = ago(now, 47),
                    reachability = GlancePolicy.Reachability.UNREACHABLE, unreachableSince = ago(now, 41),
                ),
            ),
        )

    /** Two servers, the second unreachable: only its rows are flagged. */
    fun partial(now: Instant) =
        GlanceEntry(
            now,
            listOf(
                slice(laptop, now, needs = listOf(web(now)), running = listOf(cli(now)), tasks = listOf(tasks(now)[0])),
                slice(
                    studio, now, needs = emptyList(), running = emptyList(), asOf = ago(now, 20),
                    reachability = GlancePolicy.Reachability.UNREACHABLE, unreachableSince = ago(now, 9),
                ),
            ),
        )

    fun stale(now: Instant) = GlanceEntry(now, listOf(slice(laptop, now, needs = listOf(api(now), web(now)), running = listOf(cli(now)), tasks = tasks(now), asOf = ago(now, 35))))

    fun signedOut(now: Instant) = GlanceEntry.signedOut(now)
}
