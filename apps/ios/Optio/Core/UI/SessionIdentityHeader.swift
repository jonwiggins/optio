import SwiftUI

/// Session identity stays above the conversation controls; links never compete
/// with the view switcher for the same horizontal space.
struct SessionIdentityHeader<Controls: View>: View {
    let title: String
    let runtime: String
    let status: String
    let tone: Tone
    let location: String
    var facts: Text? = nil
    var message: String? = nil
    var links: [WorkLink] = []
    var usageAgent: String? = nil
    var hostId: String? = nil
    @ViewBuilder var controls: Controls
    @Environment(\.dynamicTypeSize) private var typeSize

    var body: some View {
        VStack(alignment: .leading, spacing: Spacing.s) {
            HStack(alignment: .top, spacing: Spacing.m) {
                GlyphView(glyph: .agent(runtime), size: 32)
                    .foregroundStyle(AppTheme.secondaryText)
                    .overlay(alignment: .bottomTrailing) {
                        StateDot(tone: tone, size: 8)
                            .padding(2)
                            .background(Surface.card, in: Circle())
                            .offset(x: 4, y: 4)
                    }
                    .padding(.top, 3)
                    .accessibilityLabel(WorkFeed.runtimeLabel(runtime))
                VStack(alignment: .leading, spacing: 4) {
                    Text(title)
                        .font(.headline)
                        .lineLimit(typeSize.isAccessibilitySize ? nil : 2)
                    Text(location)
                        .font(.monoCaption)
                        .foregroundStyle(AppTheme.secondaryText)
                        .lineLimit(typeSize.isAccessibilitySize ? nil : 1)
                        .truncationMode(.middle)
                        .textSelection(.enabled)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            ViewThatFits(in: .horizontal) {
                HStack(alignment: .firstTextBaseline, spacing: Spacing.s) {
                    statusLabel
                    Spacer(minLength: 0)
                    usage
                }
                VStack(alignment: .leading, spacing: Spacing.xs) {
                    statusLabel
                    usage
                }
            }
            if let facts {
                facts.font(.caption).foregroundStyle(AppTheme.secondaryText)
            }
            if let message {
                Text(message).font(.caption).foregroundStyle(tone.textStyle)
                    .lineLimit(typeSize.isAccessibilitySize ? nil : 2)
            }
            SessionLinkBadges(links: links, expandedHeight: 160)
            controls
        }
        .padding(.horizontal, Spacing.l)
        .padding(.vertical, Spacing.m)
        .background(Surface.card)
        .overlay(alignment: .bottom) { Divider() }
    }

    private var statusLabel: some View {
        Text(status).font(.subheadline.weight(.medium)).foregroundStyle(tone.textStyle)
    }

    @ViewBuilder private var usage: some View {
        if UsageLimits.providerKey(for: usageAgent) != nil {
            AccountUsagePill(agent: usageAgent, hostId: hostId)
        }
    }
}
