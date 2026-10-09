import SwiftUI

/// A compact session card, following the web session rail: runtime mark with a
/// status dot, title and place, then status and recency. Shared by Work,
/// Overview and Machines.
struct WorkRowView: View {
    @Environment(SessionStore.self) private var session
    @Environment(\.dynamicTypeSize) private var typeSize
    @ScaledMetric(relativeTo: .body) private var runtimeSize: CGFloat = 40
    let row: WorkRow
    /// Machines already names the host around its rows.
    var whereLabel: String? = nil

    private var privateTag: PrivateTag {
        PrivateTag(ownerUserId: row.ownerUserId, ownerName: row.ownerName,
                   viewerId: session.user?.id, isAdmin: session.user?.isAdmin ?? false)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: Spacing.s) {
            HStack(alignment: .top, spacing: Spacing.m) {
                GlyphView(glyph: row.whoGlyph, size: 36)
                    .foregroundStyle(AppTheme.secondaryText)
                    .frame(width: runtimeSize, height: runtimeSize)
                    .overlay(alignment: .bottomTrailing) {
                        StateDot(tone: row.status.tone, size: 8)
                            .padding(2)
                            .background(Surface.card, in: Circle())
                            .offset(x: 3, y: 3)
                    }
                    .padding(.top, 2)
                VStack(alignment: .leading, spacing: Spacing.xs) {
                    HStack(alignment: .firstTextBaseline, spacing: Spacing.s) {
                        Text(row.name.isEmpty ? "Untitled" : row.name)
                            .font(.subheadline.weight(.semibold))
                            .foregroundStyle(.primary)
                            .lineLimit(typeSize.isAccessibilitySize ? nil : 2)
                            .frame(maxWidth: .infinity, alignment: .leading)
                        if row.pinned {
                            Image(systemName: "pin.fill")
                                .font(.caption2)
                                .foregroundStyle(AppTheme.secondaryText)
                                .accessibilityHidden(true)
                        }
                    }
                    Text(placeLabel)
                        .font(.caption.monospaced())
                        .foregroundStyle(AppTheme.mutedText)
                        .lineLimit(typeSize.isAccessibilitySize ? nil : 1)
                        .truncationMode(.middle)
                }
            }

            ViewThatFits(in: .horizontal) {
                HStack(spacing: Spacing.s) {
                    location
                    Spacer(minLength: 0)
                    recency
                }
                VStack(alignment: .leading, spacing: Spacing.xs) {
                    location
                    recency
                }
            }

            status

            if let note = row.note, !note.isEmpty, !note.hasPrefix("PR ") {
                Text(note)
                    .font(.caption)
                    .foregroundStyle(row.status == .needsYou || row.status == .failed
                        ? row.status.tone.textStyle : AnyShapeStyle(AppTheme.mutedText))
                    .lineLimit(typeSize.isAccessibilitySize ? nil : 2)
            }

            // Interactive sessions need no repeated "now / waits for me" grid.
            // Definitions and PR work retain the trigger and exit condition.
            if row.recurring || row.then == .untilMerged || row.then == .waitsForMessages || row.when != "now" {
                ViewThatFits(in: .horizontal) {
                    HStack(spacing: Spacing.m) { attributes }
                    VStack(alignment: .leading, spacing: Spacing.xs) { attributes }
                }
                .font(.caption)
                .foregroundStyle(AppTheme.mutedText)
            }
            SessionLinkBadges(links: row.links, primaryPR: row.prUrl, prState: row.prState)
            privateTag
        }
        .padding(.vertical, Spacing.row)
        .accessibilityElement(children: .contain)
        .accessibilityLabel([
            row.name.isEmpty ? "Untitled" : row.name,
            row.whoLabel, row.pinned ? "pinned" : nil, privateTag.text,
            whereLabel ?? row.where.label, row.statusLabel, row.note,
            row.origin.map { "from \($0.label)" } ?? row.when, row.then.label,
            row.lastActivity.map { $0.relativeDescription },
            row.links.isEmpty ? nil : "\(row.links.count) linked tickets and pull requests",
        ].compactMap { $0 }.joined(separator: ", "))
    }

    private var placeLabel: String {
        if let whereLabel { return whereLabel }
        if let dir = row.where.dir {
            return dir.split(separator: "/").suffix(2).joined(separator: "/")
        }
        return row.where.label
    }

    private var location: some View {
        Label(row.where.hostName ?? (row.where.target == .pod ? "Optio pod" : "Machine"),
              systemImage: row.where.systemImage)
            .font(.caption)
            .foregroundStyle(AppTheme.mutedText)
            .lineLimit(typeSize.isAccessibilitySize ? nil : 1)
    }

    private var status: some View {
        Text(row.statusLabel)
            .font(.caption.weight(.medium))
            .foregroundStyle(row.status == .needsYou || row.status == .failed || row.status == .running
                ? row.status.tone.textStyle : AnyShapeStyle(AppTheme.secondaryText))
            .fixedSize(horizontal: false, vertical: true)
    }

    private var recency: some View {
        HStack(spacing: Spacing.s) {
            if let last = row.lastActivity {
                Text(last.relativeDescription)
                    .font(.caption)
                    .foregroundStyle(AppTheme.mutedText)
                    .monospacedDigit()
                    .fixedSize()
            }
        }
    }

    @ViewBuilder private var attributes: some View {
        HStack(spacing: 6) {
            GlyphView(glyph: row.whenGlyph, size: 13)
            Text(row.origin?.label ?? row.when)
        }
        Label(row.then.label, systemImage: row.then.systemImage)
    }
}

/// The same bounded, expandable link list in cards and session headers.
struct SessionLinkBadges: View {
    let links: [WorkLink]
    var primaryPR: String? = nil
    var prState: String? = nil
    var expandedHeight: CGFloat? = nil
    @State var expanded = false
    @Environment(\.dynamicTypeSize) private var typeSize

    var body: some View {
        if !links.isEmpty {
            if expanded, let expandedHeight {
                ScrollView { badgeGrid }
                    .frame(height: expandedHeight)
            } else {
                badgeGrid
            }
            if links.count > 2 {
                Button {
                    withAnimation(.snappy) { expanded.toggle() }
                } label: {
                    Label(expanded ? "Show fewer links" : "+\(links.count - 2) more links",
                          systemImage: expanded ? "chevron.up" : "chevron.down")
                        .font(.caption.weight(.medium))
                        .padding(.vertical, 4)
                }
                .buttonStyle(.borderless)
                .accessibilityIdentifier("session-links-disclosure")
                .accessibilityValue(expanded ? "Expanded" : "Collapsed")
            }
        }
    }

    private var badgeGrid: some View {
        // Adaptive columns keep long ticket references and Dynamic Type from
        // pushing the card outside a narrow phone screen.
        LazyVGrid(columns: [GridItem(.adaptive(minimum: typeSize.isAccessibilitySize ? 220 : 120), alignment: .leading)], alignment: .leading, spacing: 6) {
            ForEach(expanded ? links : Array(links.prefix(2)), id: \.url) { link in
                if let url = URL(string: link.url) {
                    Link(destination: url) {
                        HStack(spacing: 5) {
                            GlyphView(glyph: link.url == primaryPR ? .pr(PRGlyphState(prState)) : WorkLinkBadges.glyph(link), size: 14)
                            Text(WorkLinkBadges.shortLabel(link))
                                .lineLimit(1)
                                .truncationMode(.middle)
                        }
                        .font(.caption.monospaced())
                        .foregroundStyle(AppTheme.secondaryText)
                        .padding(.horizontal, 8)
                        .padding(.vertical, 6)
                        .background(Surface.inset, in: Radius.smallShape)
                        .overlay { Radius.smallShape.strokeBorder(Surface.border, lineWidth: 1) }
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("\(link.kind == .pr ? "Pull request" : "Ticket") \(link.label)")
                }
            }
        }
    }
}
