import SwiftUI

// MARK: - Limits panel (dashboard/limits-panel.tsx)

/// "How far along am I?" for every agent subscription Optio can see. Claude is
/// live from the account; Codex is the last snapshot the daemon read from its
/// session log (it only moves when Codex runs). Renders nothing with no providers.
struct LimitsPanelView: View {
    @Environment(UsageStore.self) private var store
    @Environment(AppRouter.self) private var router
    /// Tick so "updated 12s ago" stays honest while on screen.
    @State private var now = Date.now

    var body: some View {
        let providers = store.providerLimits
        if !providers.isEmpty {
            VStack(alignment: .leading, spacing: Spacing.m) {
                header
                ForEach(providers) { provider in
                    ProviderLimitsView(provider: provider, now: now) { router.open(.machines) }
                }
            }
            .cardSurface()
            .opacity(store.refreshing ? 0.5 : 1)
            .animation(.snappy, value: store.refreshing)
            .task {
                while !Task.isCancelled {
                    try? await Task.sleep(for: .seconds(5))
                    now = .now
                }
            }
        }
    }

    private var header: some View {
        HStack(spacing: Spacing.s) {
            Image(systemName: "gauge.with.dots.needle.33percent").font(.caption).foregroundStyle(.secondary)
            Text("Usage limits").font(.sectionHeader).foregroundStyle(.primary)
            status
            Spacer(minLength: Spacing.s)
            UsageRefreshButton()
        }
    }

    @ViewBuilder private var status: some View {
        if let error = store.refreshError {
            Text(error).font(.caption2).foregroundStyle(Tone.danger.textStyle).lineLimit(1)
        } else if store.refreshing {
            Text("checking with Anthropic…").font(.caption2).foregroundStyle(.tertiary)
        } else if let at = store.refreshedAt {
            Label(now.timeIntervalSince(at) < 10 ? "updated just now" : "updated \(at.relativeDescription)", systemImage: "checkmark")
                .font(.caption2).foregroundStyle(Tone.success.textStyle).lineLimit(1)
        }
    }
}

/// The header's refresh: re-reads Claude from Anthropic (bypassing the server
/// cache) and refetches hosts so a fresh Codex snapshot shows up.
struct UsageRefreshButton: View {
    @Environment(UsageStore.self) private var store
    @State private var paced = false

    var body: some View {
        Button {
            Task {
                let ok = await store.refreshFresh()
                if !ok { paced = true }
            }
        } label: {
            HStack(spacing: 4) {
                if store.refreshing {
                    ProgressView().controlSize(.mini)
                } else {
                    Image(systemName: "arrow.clockwise").font(.caption2.weight(.semibold))
                }
                Text(store.refreshing ? "refreshing" : "refresh").font(.caption2)
            }
            .foregroundStyle(.secondary)
            .padding(.horizontal, Spacing.s)
            .padding(.vertical, 4)
            .background(.fill.tertiary, in: Capsule())
        }
        .buttonStyle(.plain)
        .disabled(store.refreshing)
        .accessibilityLabel("Refresh usage")
        .alert("Usage was refreshed a moment ago", isPresented: $paced) {
            Button("OK", role: .cancel) {}
        } message: {
            Text("Try again in a few seconds.")
        }
    }
}

/// One provider's block: name, plan, source / as-of, then its windows side by side.
private struct ProviderLimitsView: View {
    let provider: ProviderLimits
    let now: Date
    var onOpenLocal: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: Spacing.s) {
            HStack(spacing: 6) {
                Text(provider.name).font(.footnote.weight(.semibold))
                if let plan = provider.planType {
                    Text(plan.uppercased()).font(.caption2).foregroundStyle(.tertiary).tracking(0.5)
                }
                Spacer(minLength: Spacing.s)
                Text(provider.observedAt.map { "as of \($0.relativeDescription)" } ?? provider.source)
                    .font(.caption2).foregroundStyle(.tertiary).lineLimit(1)
            }
            // Two meters per row on a phone; a third (7d <Model>) wraps under them.
            LazyVGrid(columns: [GridItem(.adaptive(minimum: 120), spacing: Spacing.l, alignment: .top)], alignment: .leading, spacing: Spacing.s) {
                ForEach(provider.windows) { w in
                    LimitMeter(label: w.label, window: w.window, now: now)
                }
            }
            if provider.observedAt != nil {
                Button(action: onOpenLocal) {
                    (Text("\(provider.source) — updates when Codex runs; ") + Text("daemon must be online").underline())
                        .font(.caption2).foregroundStyle(.tertiary)
                        .multilineTextAlignment(.leading)
                }
                .buttonStyle(.plain)
            }
        }
    }
}

/// Label + percent over a thin bar, "resets in …" under it.
struct LimitMeter: View {
    let label: String
    let window: LimitWindow
    var now: Date = .now

    private var pct: Int { UsageLimits.percent(window.usedPercent) }
    private var tone: Tone { UsageSeverity(percent: pct).tone }

    var body: some View {
        VStack(alignment: .leading, spacing: Spacing.xs) {
            HStack(alignment: .firstTextBaseline) {
                Text(label).font(.caption.weight(.medium)).foregroundStyle(.secondary)
                Spacer(minLength: 4)
                Text("\(pct)%")
                    .font(.subheadline.weight(.semibold).monospacedDigit())
                    .foregroundStyle(UsageSeverity(percent: pct).isElevated ? tone.textStyle : AnyShapeStyle(.primary))
                    .contentTransition(.numericText())
            }
            GeometryReader { geo in
                ZStack(alignment: .leading) {
                    Capsule().fill(.fill.secondary)
                    Capsule().fill(tone.color).frame(width: geo.size.width * CGFloat(pct) / 100)
                }
            }
            .frame(height: 5)
            .animation(.snappy, value: pct)
            HStack(spacing: 3) {
                if let reset = UsageLimits.resetsIn(window.resetsAt, now: now) {
                    Image(systemName: "clock").font(.system(size: 9))
                    Text("resets in \(reset)").font(.caption2)
                }
            }
            .foregroundStyle(.tertiary)
            .frame(height: 12)
        }
        .frame(maxWidth: .infinity)
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(label) window \(pct) percent used")
    }
}

extension UsageSeverity {
    /// The web's `tone`: success under 50, primary to 80, warning to 95, error above.
    var tone: Tone {
        switch self {
        case .low: return .success
        case .normal: return .working
        case .warning: return .accent
        case .critical: return .danger
        }
    }
}

// MARK: - Token banners (usage-panel.tsx, banners only)

/// The web's `UsagePanel` now only carries the token-refresh banners; the
/// meters live in `LimitsPanelView`. Renders nothing while both tokens work.
struct UsageTokenBanners: View {
    @Environment(UsageStore.self) private var store

    var body: some View {
        if let usage = store.usage, usage.claudeAuthFailed || usage.githubAuthFailed {
            VStack(spacing: Spacing.s) {
                if usage.claudeAuthFailed {
                    banner(
                        title: "Claude token expired",
                        message: "Agents are failing to authenticate. Renew the Claude OAuth token from the web UI (Settings → Secrets), or run scripts/update-claude-auth.sh on the host."
                    )
                }
                if usage.githubAuthFailed {
                    banner(
                        title: "GitHub token failing",
                        message: "Recent tasks hit GitHub auth errors. Rotate GITHUB_TOKEN in Settings → Secrets."
                    )
                }
            }
        }
    }

    private func banner(title: String, message: String) -> some View {
        NoticeBanner(tone: .danger, systemImage: "key.slash", title: title) {
            Text(message)
            Button("Re-check") { Task { await store.refresh(fresh: true) } }
                .font(.footnote.weight(.semibold))
                .buttonStyle(.plain)
                .foregroundStyle(AppTheme.accent)
        }
    }
}

// MARK: - Account usage pill (local/usage-chips.tsx `AccountUsagePill`)

/// Compact "Claude 5h 31% · 7d 52%" for session headers. Tinted by the worst
/// window; tap for the full breakdown. Hidden until the store has numbers.
struct AccountUsagePill: View {
    @Environment(UsageStore.self) private var store
    @State private var showBreakdown = false

    var body: some View {
        let buckets = store.claudeBuckets
        if !buckets.isEmpty {
            let worst = UsageLimits.percent(buckets.map(\.window.usedPercent).max())
            let severity = UsageSeverity(percent: worst)
            let stale = store.usage?.stale == true
            Button { showBreakdown = true } label: {
                HStack(spacing: 6) {
                    Image(systemName: "gauge.with.dots.needle.33percent")
                        .font(.system(size: 10, weight: .semibold))
                        .foregroundStyle(severity.isElevated ? severity.tone.textStyle : AnyShapeStyle(.secondary))
                    Text("Claude").foregroundStyle(.secondary)
                    ForEach(buckets) { b in
                        HStack(spacing: 3) {
                            Text(b.label).foregroundStyle(.tertiary)
                            let pct = UsageLimits.percent(b.window.usedPercent)
                            let s = UsageSeverity(percent: pct)
                            Text("\(pct)%")
                                .fontWeight(.medium)
                                .foregroundStyle(s.isElevated ? s.tone.textStyle : AnyShapeStyle(.primary))
                                .contentTransition(.numericText())
                        }
                    }
                }
                .font(.monoCaption)
                .lineLimit(1)
                .padding(.horizontal, Spacing.s)
                .padding(.vertical, 4)
                .background(severity.isElevated ? AnyShapeStyle(severity.tone.color.opacity(0.14)) : AnyShapeStyle(.fill.tertiary), in: Capsule())
                .overlay {
                    if severity.isElevated {
                        Capsule().strokeBorder(severity.tone.color.opacity(0.4), style: StrokeStyle(lineWidth: 1, dash: stale ? [3, 3] : []))
                    } else if stale {
                        Capsule().strokeBorder(.tertiary, style: StrokeStyle(lineWidth: 1, dash: [3, 3]))
                    }
                }
                .opacity(stale ? 0.7 : 1)
                .contentShape(Capsule())
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Claude usage: worst window \(worst) percent. Tap for details.")
            .sheet(isPresented: $showBreakdown) { UsageBreakdownSheet() }
        }
    }
}

/// The pill's expansion: the full limits panel plus the account footnote.
struct UsageBreakdownSheet: View {
    @Environment(UsageStore.self) private var store
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: Spacing.m) {
                    UsageTokenBanners()
                    LimitsPanelView()
                    if let usage = store.usage, usage.stale == true {
                        Text("Last known values\(usage.asOf.map { " from \(UsageLimits.staleAge($0)) ago" } ?? "") — the latest read failed (\(usage.error ?? "unavailable")); retrying automatically")
                            .font(.caption).foregroundStyle(Tone.accent.textStyle)
                            .padding(.horizontal, Spacing.xs)
                    } else {
                        Text("Account-wide, refreshed every few minutes.")
                            .font(.caption).foregroundStyle(.tertiary)
                            .padding(.horizontal, Spacing.xs)
                    }
                }
                .padding(Spacing.l)
            }
            .background(Surface.page)
            .navigationTitle("Usage limits")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
            .observesUsage()
        }
        .presentationDetents([.medium, .large])
        .presentationDragIndicator(.visible)
    }
}
