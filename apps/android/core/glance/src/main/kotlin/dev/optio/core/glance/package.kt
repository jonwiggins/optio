/**
 * `:core:glance`: the data behind every glanceable surface (widgets, Quick Settings tiles, the
 * ongoing Watch notification, needs-you notifications, the background check), shared by
 * `:feature:glance` and the widget module. Ports of iOS `Shared/NeedsYouSnapshot.swift`,
 * `Shared/WatchActivity.swift`, `OptioWidgets/Widgets/{GlancePolicy,GlanceCopy,GlanceStore}.swift`
 * and `Core/LiveActivity/WatchSources.swift`. Owned by Agent A9 (PLAN §5).
 *
 * - [dev.optio.core.glance.NeedsYouSnapshot]: load one server / every paired server.
 * - [dev.optio.core.glance.GlanceLoader] + [dev.optio.core.glance.GlanceEntry]: per-server slices
 *   with the offline cache ([dev.optio.core.glance.GlanceStore]).
 * - [dev.optio.core.glance.GlanceWatchState]: the Watch content, merged across servers.
 * - [dev.optio.core.glance.WatchSources]: followed tasks, recent agent messages.
 * - [dev.optio.core.glance.PushStatus]: notification permission and push delivery.
 * - [dev.optio.core.glance.GlanceRefresh]: hooks run after new data is cached.
 * - [dev.optio.core.glance.RunTarget]: blueprints and Jobs a widget / tile can fire.
 */
package dev.optio.core.glance
