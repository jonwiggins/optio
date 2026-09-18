# Optio iOS — UI review and design system spec

_Status: review, September 2026. Scope: `apps/ios/Optio`. Screens shot on iPhone 17 Pro, iOS 26, light and dark, against a live local API. Screenshots: `docs/design/screens/before-*.png`._

## 1. Diagnosis

Today the app reads as **a competent SwiftUI port of the web dashboard, built by five engineers who never agreed on a vocabulary**. Every screen is structurally fine and uses stock text styles, but the surface is loud: every stat tile has its own hue (blue running, orange queued, yellow attention, red failed, green done, purple CI _and_ review), so an idle system with all zeros still shows six colours; the `.fill.tertiary` grey card is stacked three deep (tiles inside a card, a chip row, then rows) so nothing has depth; purple is spent on chips, tab tint, "Running", CI, PR links, avatars and the "review" word, so it no longer means anything; and there are four stat-tile designs, five filter idioms, three state→colour maps, three vocabularies for "enabled", and two extra-keys bars. The target is the opposite: **quiet, monochrome, editorial — near-black type on flat grouped surfaces, one purple signal reserved for "needs you", semantic colour only for terminal outcomes (red failed, green merged), mono type only where it names a thing (path, branch, `#519`, slug), and depth from material and spacing rather than borders and tinted fills.** It is the language already written for the Live Activity in `ios-glanceable-surfaces.md` §3: the app should feel like the island grew a body, not like the web sidebar shrank.

## 2. Design system spec (implement in `Core/UI`)

### Type scale

| Role            | Style                                                      | Notes                                                                                                                                              |
| --------------- | ---------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| Large nav title | system (`.large`)                                          | Only on the five tab roots. Detail screens are `.inline`.                                                                                          |
| Row title       | `.body` regular, `.primary`                                | Not `.headline`, not `.medium`. Weight comes from colour contrast, not boldness. `lineLimit(2)` everywhere.                                        |
| Row meta        | `.subheadline`, `.secondary`                               | One meta line per row, `·`-joined, never icon-per-field.                                                                                           |
| Row tertiary    | `.footnote`, `.tertiary`                                   | Only when a third line is genuinely needed (error text, subtask count).                                                                            |
| Section header  | `.footnote.weight(.semibold)`, `.secondary`, sentence case | Kill `.textCase(.uppercase)` everywhere except badges.                                                                                             |
| Stat value      | `.title2.weight(.semibold).monospacedDigit()`              | `.contentTransition(.numericText())` mandatory.                                                                                                    |
| Stat label      | `.caption`, `.secondary`                                   | No icon.                                                                                                                                           |
| Badge           | `.caption2.weight(.semibold)`, uppercase                   | The **only** uppercase text in the app.                                                                                                            |
| Mono            | `.system(.subheadline/.footnote, design: .monospaced)`     | Only paths, branches, PR numbers, slugs, cron, JSON, logs. Never for prose, never for status words, never for cost. Truncate head-first for paths. |

Drop `.system(size:)` (three uses: `LocalTerminalScreen.swift:397` keys, the keyboard toggle, and the 40pt welcome sparkle).

### Spacing and radius tokens (`enum Spacing`, `enum Radius`)

- Spacing: `xs 4 · s 8 · m 12 · l 16 · xl 24`. Screen gutter 16. Row vertical padding 6 (currently 2, 4, 6 and 8). Stack spacing inside a row: 4.
- Radius: `small 8` (badge-shaped rects, icon tiles) · `card 12` (all cards, tiles, code blocks) · `capsule` (badges, chips, toasts). That replaces the current 5/6/7/8/10/12 set.

### Surfaces

- **Lists are plain or inset-grouped, never cards-in-a-list.** Rule: root list screens = `.plain` with system separators; settings/detail/config = `.insetGrouped`. Remove the `RecentTaskRow` / `ActiveSessionsSection` hand-rolled `.fill.tertiary` cards in Overview and make them list rows.
- One card surface: `Color(.secondarySystemGroupedBackground)` on a `.systemGroupedBackground` page (this is what iOS itself does). `.fill.tertiary` becomes the _inset_ surface only (code blocks, tool-call bodies) — never nested inside another `.fill.tertiary`.
- `.regularMaterial` only for things that float over content: the toast, the pinned composer bar, the terminal key bar, the detail header when content scrolls under it. Never as a card background.
- No stroked borders on cards. The two current stroke usages (`NeedsYouCard`, Costs banners) become a 3pt leading accent bar.

### Colour tokens (`enum Tone`)

```
accent    = #6d28d9   → "needs you": attention badges, the Needs-you count, composer send, selected tab. Nothing else.
danger    = .red      → failed, error, destructive actions.
success   = .green    → completed, merged, healthy, CI passing. Text only, never a fill.
working   = .secondary→ running / provisioning / active / online (per surfaces.md §3).
idle      = .tertiary → queued / pending / idle / sticky / exited / archived.
muted     = .quaternary fills for skeletons and disabled.
```

State → tone: one function, `Tone.forState(_:)`, replacing `StateColor`, `ReviewFormat.stateColor`, `LocalPresentation`, `ClusterView.statusColor`, `ConnectionIcons.statusColor` and the three inline threshold rules. `needs_attention / needs_you / stalled / paused / review_requested / waiting_for_off_peak → accent`. `pr_opened → success`? No — `pr_opened` is _working_ (secondary) with the PR number in accent only if a review is requested of the user. Blue, orange, yellow, gray, teal disappear from the app (`.blue` 22 uses, `.orange` 23, `.yellow` 34, `.gray` 18). Charts get their own 4-step categorical palette (accent, `.primary.opacity(0.55)`, `.primary.opacity(0.3)`, `.primary.opacity(0.15)`) — one sequence, defined once, used by Analytics, Costs and Overview.

### Row anatomy (`OptioRow`)

```
[leading 6pt state dot, only when state ≠ done]  Title (body, 2 lines)             [trailing meta: relative time, footnote, tertiary]
                                                  repo · agent · PR #519 (subheadline, secondary; #519 mono)
                                                  optional: error / subtask line (footnote, tertiary; danger if failed)
```

- No badge in list rows. State lives in the dot (accent = needs you, red = failed, secondary = working, none = done) and in the trailing meta when it's terminal ("Merged", "Failed 2h ago"). Badges move to detail headers only.
- No 32×32 icon tiles (Sessions, JobTrigger, Activity). No per-field SF Symbols in meta lines.
- Chevron from `NavigationLink`; Reviews and Issues must become real `NavigationLink`s.
- Swipe actions everywhere a list item has a primary verb (Run now / Cancel / Retry), via one `rowActions` modifier.

### Badge

One `StatusBadge`: capsule, `tone.opacity(0.12)` fill, tone text, uppercase `.caption2.semibold`, padding 8/3. Only tones: accent, danger, success, secondary. Delete the ad-hoc pills in `IssuesListView.swift:129`, `NotificationsDevicesView.swift:167`, `ActiveSessionsSection`.

### Stat tile (`StatTile` v2) and `StatStrip`

Tiles are flat, not carded: value over label, left-aligned, in a single `StatStrip` card (one `.secondarySystemGroupedBackground` container with hairline column dividers). Value colour is `.primary` when non-zero, `.tertiary` when zero; only Attention/Needs-you is accent when non-zero and only Failed is danger when non-zero. This removes the rainbow at rest. Max five tiles; the Tasks strip collapses CI and Review into "In review". Tiles can be tappable filters (Local's idea) — selected = `.primary` underline 2pt, not a stroke.

### Chip row (`ChipPicker` v2) vs segmented

- Section switching inside a tab (Tasks/Jobs/…; Agents/Sessions/Local; Analytics/…) becomes a **native segmented control in the nav bar** (`ToolbarItem(placement: .principal)`) or, for five items, an iOS 26 bottom-search-style toolbar `Picker` — not a chip row under a large title that then restates the title.
- Chips remain for **filters only** (stage, state, repo). Selected chip = `.primary` fill with inverted text (black pill, white text; the Things/Linear look), unselected = `.fill.tertiary`. Purple leaves the chip.
- One chip row per screen. A second filter goes in the toolbar `Menu`.

### Section headers, empty, loading, errors

- Headers: `Text` `.footnote.semibold` `.secondary`, sentence case, with optional trailing `chevron.right` when tappable. Delete the six variants.
- Empty: `ContentUnavailableView` with a thin-weight symbol, title `.title3`, one sentence, and **one** `.borderedProminent` action when creation is possible (Tasks, Jobs, Agents, Sessions, Scheduled). Copy must respect the active filter ("No closed issues").
- Loading: never a bare spinner in a list. Use `.redacted(reason: .placeholder)` on three placeholder rows plus the strip; a spinner is allowed only in the toolbar slot while refreshing. Filter changes keep the old content dimmed (`.opacity(0.5)`) instead of blanking.
- Errors: inline `ErrorBanner` becomes a one-line `.footnote` `.secondary` row with a "Retry" text button; danger red only for the leading symbol. Humanise messages: "Couldn't load jobs" not `Decoding JobListResponse failed: DecodingError.dataCorrupted… (HTTP 0)` (`before-light-jobs.png`), "Slow down — retrying in 5 s" not `Too Many Requests (HTTP 429)`. Action failures use the toast, never `.alert`.

### Motion and haptics

- `contentTransition(.numericText())` on every number that polls.
- `.animation(.snappy, value:)` on filter changes and list diffs; `.symbolEffect(.pulse)` allowed **only** on the needs-you dot, nowhere else (no pulsing "working").
- `sensoryFeedback(.success/.error)` on action completion; `.selection` on segment/chip change; `.warning` on terminal bell (already in Local — extend to Sessions).
- Toast: the `transientMessage` capsule from `JobsListView.swift:186` promoted to `Core/UI/Toast.swift`, used app-wide.

### Iconography

SF Symbols, `.regular` weight in rows, `.medium` in toolbars, `.hierarchical` rendering for the tab bar and empty states, `.monochrome` elsewhere. Tab bar icons: `square.grid.2x2`, `play`, `dot.radiowaves.left.and.right`, `chart.bar`, `ellipsis` — use the outline variant unselected and `.fill` selected via `symbolVariant`. Never the same symbol for two meanings (`waveform.path.ecg` is currently "running", "agents" and "activity").

## 3. Screen-by-screen

**Overview** (`OverviewView.swift`). The `OverviewStatsStrip` 2pt top rule (`:259-263`) renders _between_ grid rows, so the green "Done" indicator visually underlines "CI" (`before-light-overview.png`). Replace with the `StatStrip`. Five section idioms on one screen (uppercase Label header, plain `.subheadline` "Recent Tasks", card rows, bordered banners). The Recent Tasks cards duplicate `TaskRowView` in a third layout; use `OptioRow` in a plain list section. Cluster line hides its most important number (cost) off the right edge of a horizontal scroll (`:419`). The subtitle "0 active tasks" is fine; make it the whole header story: "0 active · 2 need you" with only the second half in accent.

**Tasks list** (`TasksListView.swift`). Seven coloured tiles + chip row + search + agent Menu = four control rows before the first result (`before-light-tasks.png`). Cut to `StatStrip` (Running · Queued · In review · Needs you · Failed) and one chip row. Row: three icon-laden meta lines (`:175-187`) → one `subheadline` line `jonwiggins/optio · Claude Code · #519 · $0.78` with `#519` mono; CI state moves to the trailing meta; drop the badge for the dot. `.body.weight(.medium)` → `.body`. Cost `$%.2f` here vs `$%.4f` in detail (`TaskDetailView.swift:210`): standardise on `Tone`-agnostic `Cost.format()` — 2 decimals under $10, otherwise 0.

**Task detail** (`TaskDetailView.swift`). Header (`:198-242`) is a `.bar` block of badges, three tertiary meta rows and a PR row; make it a `.regularMaterial` header with title-less state line (`Running · 3m 12s · claude-sonnet`) and a single accent row only when the task needs you. Banners (`:244-272`) use a fourth tint opacity (0.08) — replace with the leading-bar banner. Mixed `.plain` and `.insetGrouped` lists across tabs (`:329-394`); make all `.plain`. Success notices via `.alert` → toast. `ChatComposer` `.roundedBorder` field → capsule field with `.regularMaterial` bar and accent send.

**Jobs** (`JobsListView.swift`, `JobDetailView.swift`). Hand-rolled 2-column tiles with icons (`:27-32`) → `StatStrip`. "Active/Off" badge (`:150`) vs "enabled/disabled" in detail vs "enabled/paused" in Scheduled — pick "Paused" as the only badge and show nothing when active. Remove the `.bordered .mini` "Run now" button inside a `NavigationLink` row (`:167-175`); it's a swipe action. Detail's `StatTile("Last Run", relativeDate)` puts prose in a numeric tile (`:110-115`); make it a meta line. Two stacked chip rows with different count formats (`:127-131` vs `:172-177`).

**Reviews** (`ReviewsListView.swift`, `ReviewDetailView.swift`). Rows are `onTapGesture` with a fake `View Review ›` label (`:90-93`) — use `NavigationLink`. Up to four badges per row plus a scrolling label row plus two buttons (`:145-205`): reduce to dot + title + `#n · repo · author · 2h` + one trailing verdict badge; "Review with Optio" is a swipe/primary action. `ReviewFormat.stateColor` (`ReviewsAPI.swift:123`) contradicts `StateColor` — delete it. The URL-paste launcher as the first list row is good; restyle as a capsule field with a trailing accent icon button. Detail's pipeline strip (`:175-198`) is the best custom element in the app — keep it, monochrome it (done = primary, current = accent, future = quaternary). Green "Merge PR" / orange "Merge anyway" (`:286-293`) → `.borderedProminent` primary with a confirmation for the CI-failing case.

**Issues** (`IssuesListView.swift`). Repo chip row appears only with >1 repo (`:45-49`) so layout jumps; keep it always or move to Menu. Empty-state title ignores the state filter (`:55`). Custom label pills with `Color(.tertiarySystemFill)` (`:129-133`) → `StatusBadge`. Detail is a sheet (`:144`) while every sibling pushes — push.

**Scheduled** (`ScheduledListView.swift`, `ScheduledDetailView.swift`). Only list with no strip and no filter — fine, but its row grows one line per trigger with mono cron (`:112-125`); cap at one line "Every day 09:00 · next 3h · 12 runs". Detail has no header (`:60`) so state is buried in Config; add the standard header. Unframed `ProgressView` (`:72`) pins top-left.

**Agents** (`AgentsListView.swift`, `AgentDetailView.swift`). Six-tile strip of zeros in five colours (`before-light-agents.png`) → `StatStrip` (Running · Idle · Needs you · Failed). Row title `.headline` (`:106`) → `.body`. Message bubbles are full-width tinted bordered cards with blue for the agent (`:211-250`) while Sessions uses right-aligned accent pills (`SessionDetailView.swift:188`) — one `MessageBubble`: user = trailing, `.fill.secondary`, agent = leading plain prose (no bubble), metadata `.caption2.tertiary`. "Pending" orange → secondary. `$%.5f` (`:292`) → `Cost.format()`.

**Sessions** (`SessionsListView.swift`, `SessionTerminalView.swift`). Raw `HStack` of three tiles (`:20-27`) doesn't wrap. 32pt icon tile (`:101`) → dot. `SessionTerminalView.swift:112` hard-codes `Color.black` behind a terminal whose theme is `#fafafa` in light mode — use `TerminalTheme` background. Its key bar (`:184-243`) differs from Local's in key set, font, radius and background; extract one `TerminalKeyBar`. Toolbar has a bare destructive "End" button — move into the `ellipsis` Menu like its siblings.

**Local hub / terminal** (`LocalHubView.swift`, `LocalTerminalScreen.swift`). Closest to the target language already (dot + mono dir + attention semantics) and the "Needs you" concept is right — but it's yellow (`:120`, `:272-292`, `LocalAPI.swift:221-261`) where the surfaces spec says purple. Make needs-you accent, working secondary, and drop the "Host online 1" green tile for a host chip. Tiles are fixed 128pt with a stroke on selection (`:213-237`); use the strip with underline. Nested `.large` "Local" title under the "Live" stack (`:30`) makes the header jump between sections; with an error and no hosts the chip row floats mid-screen with 400pt of nothing above it (`before-dark-local.png`) — remove the inner title and the `minHeight: 400` scroll wrapper (`:200-208`). Terminal chrome hard-codes `#09090b`/`#0e0e11` in four places (`:136,151,267,315,397`) regardless of appearance; move to `TerminalTheme.chrome`. Keep the bell haptic; give the attention dot the only `symbolEffect(.pulse)` in the app.

**Insights** (`AnalyticsView`, `CostsView`, `ActivityView`, `ClusterView`). Three time-range idioms (segmented, Menu, none); standardise on the segmented `PeriodPicker` in the toolbar. Analytics tiles hang a `.caption2` subline off `StatTile` (`:68-81`) — fold into the tile. Charts: heights 220/200/28/44 and four palettes (`AnalyticsView.swift:101`, `CostsView.swift:224,230`, `OverviewView.swift:447`) → one `ChartPalette`, heights 160 (primary) / 96 (secondary). Activity's 30pt icon tiles and `dateStyle: .full` day headers (`:196`) → dot rows, "Today / Yesterday / Sep 15" headers. Cluster nests a chip row inside a chip-navigated tab (`:126-134`) → segmented; its yellow restart count and green "Running" (`:186`) → secondary text, danger only for CrashLoop. Node bars (`before-light-cluster.png`) are the right idea; make CPU and memory the same tone.

**More / Settings** (`MoreHubView.swift`, `SettingsView.swift`). Structurally the most iOS-native screens; leave the grouped list. Fix: purple on every row icon (tint) makes purple decorative — set `.foregroundStyle(.primary)` on list icons and keep tint for interactive controls only. Account card avatar in 70% purple (`:941`) → `.secondary`. `SettingsView` is a `List` not a `Form`; appearance picker should be segmented. Ten sheets with three different confirm verbs (Create/Add/Save) — "Save" for edits, "Create" for new, no "Add".

**Sign-in** (`SignInView.swift`). A bare `Form` with no identity. Add a top block: the terminal-caret glyph from the widget, "Optio" `.largeTitle.bold`, one line "Remote control for your agents", then the two fields with the URL field defaulting to the last host and a `.borderedProminent` full-width Connect. Error as inline `.footnote` under the token field, not a red section.

## 4. Implementation plan

**Tier 1 — tokens and shared components (≈3 days; biggest lift, touches every screen).** Add `Core/UI/Tokens.swift` (`Tone`, `Spacing`, `Radius`, `Cost.format`, `ChartPalette`), `Tone.forState` replacing the five colour maps; rewrite `StatTile`/`StatStrip`, `ChipPicker` (primary-fill selection), `StatusBadge`, `SectionHeader`, `OptioRow`, `Toast`, `Skeleton`, `TerminalKeyBar`, `MessageBubble`; add `sensoryFeedback` in the shared components. Remove the `.blue/.orange/.yellow/.gray/.teal` literals (≈130 sites) by compile error. Move hub section switching to a `.principal` segmented control in `RunHubView`, `LiveHubView`, `InsightsHubView` and delete the inner `navigationTitle` in `LocalHubView`.

**Tier 2 — lists and rows (≈3 days).** Convert every list row (Tasks, Jobs, Reviews, Issues, Scheduled, Agents, Sessions, Local, Activity, Pods, Repos, Prompts, Connections, Webhooks) to `OptioRow`; make Reviews/Issues push; move row buttons to swipe actions; unify empty states and error copy; add skeleton loading; fix Local's no-host layout; Overview's Recent Tasks and Active Sessions become list sections.

**Tier 3 — detail screens, forms, polish (≈4 days).** Standard `DetailHeader` (material, state line, accent needs-you row) on Task, Job, Run, Review, Agent, Session, Scheduled, Pod; single composer style; terminal chrome through `TerminalTheme`; Insights chart palette/heights and segmented period picker; sign-in identity block; sheets get consistent verbs and inline validation; `numericText` transitions and the single pulse on needs-you; tab bar symbol variants; final pass in dark mode for the `.secondarySystemGroupedBackground` surfaces.

## Screenshots

`before-light-overview.png`, `before-dark-overview.png`, `before-light-tasks.png`, `before-dark-tasks.png`, `before-light-local.png`, `before-dark-local.png`, `before-light-jobs.png`, `before-light-reviews.png`, `before-light-analytics.png`, `before-light-cluster.png`, `before-dark-cluster.png`, `before-light-more.png` — all in `docs/design/screens/`.
