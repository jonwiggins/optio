/**
 * `:core:workfeed`: the merged Work feed (port of iOS `WorkFeed` / `WorkFeedModel`, web
 * `lib/work-feed.ts` + `use-work-feed.ts`), shared by the Work list, the Overview board and the
 * glanceable surfaces. [WorkFeed] projects the per-kind rows, [workFeedSources] fetches the six
 * endpoints, [WorkFeedModel] polls them for a screen, and [WorkDestination] maps a row to the
 * route of its detail screen. Owned by Agent A1 (PLAN §5).
 */
package dev.optio.core.workfeed
